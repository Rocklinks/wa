const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const qrcode = require('qrcode');
const XLSX = require('xlsx');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(__dirname));

const DATA_DIR = process.env.DATA_DIR || __dirname;
['uploads','sessions','exports'].forEach(d => {
  const p = path.join(DATA_DIR, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const contacts = JSON.parse(fs.readFileSync('contacts.json', 'utf8'));
const allContacts = [...contacts.agms, ...contacts.bms];

let waClient = null, waReady = false, myInfo = null;
const picCache = {}, chatHistory = {};
let lastActivity = Date.now();
const touch = () => lastActivity = Date.now();

// 3-day idle logout
cron.schedule('0 * * * *', async () => {
  if (!waReady) return;
  if (Date.now() - lastActivity > 3*24*60*60*1000) {
    try { await waClient.logout(); } catch(e) {}
    waReady = false; waClient = null;
    io.emit('wa:disconnected', 'idle_3days');
    initWA();
  }
});

// Multer
const upload = multer({ storage: multer.diskStorage({
  destination: path.join(DATA_DIR, 'uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
})});
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ path: 'uploads/' + req.file.filename, name: req.file.originalname, mime: req.file.mimetype });
});

// Export
app.get('/export', (req, res) => {
  const { jid, from, to, limit = 500 } = req.query;
  let msgs = chatHistory[jid] || [];
  if (from) msgs = msgs.filter(m => m.timestamp >= parseInt(from));
  if (to) msgs = msgs.filter(m => m.timestamp <= parseInt(to));
  msgs = msgs.slice(-parseInt(limit));
  const rows = msgs.map(m => ({
    Time: new Date(m.timestamp * 1000).toLocaleString(),
    From: m.fromMe ? 'Me' : m.name,
    Message: m.body || (m.media ? '[Media]' : ''),
    Type: m.media ? 'media' : 'text'
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Chat');
  const fname = path.join(DATA_DIR, `exports/chat_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, fname);
  res.download(fname);
});

// WhatsApp init
function initWA() {
  const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  console.log('Chrome:', chromePath, fs.existsSync(chromePath) ? '✓' : '✗ NOT FOUND');

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'sessions') }),
    puppeteer: {
      headless: true,
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
      ]
    }
  });

  waClient.on('qr', async qr => {
    console.log('QR received, sending to browser...');
    const url = await qrcode.toDataURL(qr, { width: 256, margin: 2, color: { dark: '#111827', light: '#fff' } });
    io.emit('wa:qr', url);
  });

  waClient.on('ready', async () => {
    waReady = true; touch();
    myInfo = waClient.info;
    try { picCache['me'] = await waClient.getProfilePicUrl(myInfo.wid._serialized); } catch(e) {}
    io.emit('wa:ready', { name: myInfo.pushname, pic: picCache['me'] || null });
    loadPics();
  });

  waClient.on('disconnected', reason => {
    waReady = false;
    io.emit('wa:disconnected', reason);
    if (reason !== 'LOGOUT') setTimeout(initWA, 5000);
    else {
      fs.rmSync(path.join(DATA_DIR, 'sessions'), { recursive: true, force: true });
      fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });
      setTimeout(initWA, 1000);
    }
  });

  waClient.on('message', async msg => {
    touch();
    const jid = msg.from;
    let media = null;
    if (msg.hasMedia) {
      try { const m = await msg.downloadMedia(); if (m) media = { data: m.data, mimetype: m.mimetype, filename: m.filename }; } catch(e) {}
    }
    const contact = await msg.getContact();
    const out = { id: msg.id._serialized, jid, fromMe: msg.fromMe, body: msg.body, timestamp: msg.timestamp, name: contact.pushname || contact.name || jid, media, ack: msg.ack };
    if (!chatHistory[jid]) chatHistory[jid] = [];
    chatHistory[jid].push(out);
    if (chatHistory[jid].length > 500) chatHistory[jid].shift();
    io.emit('wa:msg', out);
    if (!msg.fromMe) io.emit('wa:toast', { name: out.name, body: (msg.body || '').substring(0, 60) });
  });

  waClient.on('message_ack', (msg, ack) => {
    io.emit('wa:ack', { id: msg.id._serialized, ack });
    const h = chatHistory[msg.from];
    if (h) { const m = h.find(x => x.id === msg.id._serialized); if (m) m.ack = ack; }
  });

  waClient.initialize().catch(e => {
    console.error('WA init error:', e.message);
    setTimeout(initWA, 8000);
  });
}

async function loadPics() {
  const BATCH = 6;
  for (let i = 0; i < allContacts.length; i += BATCH) {
    await Promise.all(allContacts.slice(i, i + BATCH).map(async c => {
      const cid = c.phone.replace('+', '') + '@c.us';
      if (picCache[cid]) { io.emit('wa:pic', { id: c.id, url: picCache[cid] }); return; }
      try { const url = await waClient.getProfilePicUrl(cid); if (url) { picCache[cid] = url; io.emit('wa:pic', { id: c.id, url }); } } catch(e) {}
    }));
    await new Promise(r => setTimeout(r, 500));
  }
}

// Socket
io.on('connection', socket => {
  socket.on('init', () => {
    socket.emit('contacts', contacts);
    allContacts.forEach(c => { const cid = c.phone.replace('+', '') + '@c.us'; if (picCache[cid]) socket.emit('wa:pic', { id: c.id, url: picCache[cid] }); });
    if (waReady) socket.emit('wa:ready', { name: myInfo?.pushname || '', pic: picCache['me'] || null });
  });

  socket.on('wa:send', async ({ to, message, mediaPath, mime }) => {
    if (!waReady) return socket.emit('err', 'Not connected');
    touch();
    const cid = to.replace('+', '') + '@c.us';
    try {
      let sent;
      if (mediaPath) { const m = MessageMedia.fromFilePath(path.join(DATA_DIR, mediaPath)); sent = await waClient.sendMessage(cid, m, { caption: message || '' }); }
      else sent = await waClient.sendMessage(cid, message);
      socket.emit('wa:sent', { to, success: true, id: sent.id._serialized });
    } catch(e) { socket.emit('wa:sent', { to, success: false, error: e.message }); }
  });

  socket.on('wa:bulk', async ({ recipients, message, mediaPath, mime, delay }) => {
    if (!waReady) return;
    for (const phone of recipients) {
      touch();
      const cid = phone.replace('+', '') + '@c.us';
      try {
        if (mediaPath) { const m = MessageMedia.fromFilePath(path.join(DATA_DIR, mediaPath)); await waClient.sendMessage(cid, m, { caption: message || '' }); }
        else await waClient.sendMessage(cid, message);
        socket.emit('wa:bulk_prog', { phone, success: true });
      } catch(e) { socket.emit('wa:bulk_prog', { phone, success: false, error: e.message }); }
      await new Promise(r => setTimeout(r, delay || cfg.wa_message_delay_ms));
    }
    socket.emit('wa:bulk_done');
  });

  socket.on('wa:schedule', ({ recipients, message, datetime, mediaPath }) => {
    const d = new Date(datetime);
    const job = cron.schedule(`${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`, async () => {
      for (const phone of recipients) {
        const cid = phone.replace('+', '') + '@c.us';
        try {
          if (mediaPath) { const m = MessageMedia.fromFilePath(path.join(DATA_DIR, mediaPath)); await waClient.sendMessage(cid, m, { caption: message || '' }); }
          else await waClient.sendMessage(cid, message);
          io.emit('wa:sched_sent', { phone });
        } catch(e) {}
      }
      job.stop();
    }, { scheduled: true });
    socket.emit('wa:scheduled', { datetime, count: recipients.length });
  });

  socket.on('wa:logout', async () => {
    try { await waClient.logout(); } catch(e) {}
    waReady = false;
    io.emit('wa:disconnected', 'manual');
  });

  socket.on('sms:send', async ({ to, message, gw }) => {
    if (!gw?.url) return socket.emit('sms:sent', { to, success: false, error: 'No SMS gateway' });
    try {
      await axios.post(`${gw.url}/message`, { phoneNumber: to, message }, { auth: { username: gw.user || '', password: gw.pass || '' }, timeout: 10000 });
      socket.emit('sms:sent', { to, success: true });
    } catch(e) { socket.emit('sms:sent', { to, success: false, error: e.message }); }
  });

  socket.on('sms:bulk', async ({ recipients, message, delay, gw }) => {
    if (!gw?.url) return socket.emit('sms:bulk_done');
    for (const phone of recipients) {
      try {
        await axios.post(`${gw.url}/message`, { phoneNumber: phone, message }, { auth: { username: gw.user || '', password: gw.pass || '' }, timeout: 10000 });
        socket.emit('sms:bulk_prog', { phone, success: true });
      } catch(e) { socket.emit('sms:bulk_prog', { phone, success: false, error: e.message }); }
      await new Promise(r => setTimeout(r, delay || cfg.sms_message_delay_ms));
    }
    socket.emit('sms:bulk_done');
  });

  socket.on('sms:schedule', ({ recipients, message, datetime, gw }) => {
    if (!gw?.url) return;
    const d = new Date(datetime);
    const job = cron.schedule(`${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`, async () => {
      for (const phone of recipients) {
        try { await axios.post(`${gw.url}/message`, { phoneNumber: phone, message }, { auth: { username: gw.user || '', password: gw.pass || '' } }); io.emit('sms:sched_sent', { phone }); } catch(e) {}
      }
      job.stop();
    }, { scheduled: true });
    socket.emit('sms:scheduled', { datetime, count: recipients.length });
  });
});

const APP_URL = process.env.RENDER_EXTERNAL_URL;
if (APP_URL) setInterval(() => require('https').get(APP_URL, () => {}).on('error', () => {}), 10 * 60 * 1000);

const PORT = process.env.PORT || cfg.server_port || 10000;
server.listen(PORT, () => { console.log(`\n✅ http://localhost:${PORT}\n`); initWA(); });
