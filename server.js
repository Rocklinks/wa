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
const { create, ev } = require('@open-wa/wa-automate');

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

// ── State ─────────────────────────────────────────────────────────────────────
let waClient = null, waReady = false, myInfo = null;
const picCache = {}, chatHistory = {};

// ── 3-day idle logout ─────────────────────────────────────────────────────────
let lastActivity = Date.now();
const touch = () => lastActivity = Date.now();
cron.schedule('0 * * * *', async () => {
  if (!waReady) return;
  if (Date.now() - lastActivity > 3 * 24 * 60 * 60 * 1000) {
    await waClient.kill();
    waReady = false; waClient = null;
    io.emit('wa:disconnected', 'idle_3days');
    initWA();
  }
});

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.diskStorage({
  destination: path.join(DATA_DIR, 'uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
})});
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ path: 'uploads/' + req.file.filename, name: req.file.originalname, mime: req.file.mimetype });
});

// ── Export ────────────────────────────────────────────────────────────────────
app.get('/export', (req, res) => {
  const { jid, from, to, limit = 500 } = req.query;
  let msgs = chatHistory[jid] || [];
  if (from) msgs = msgs.filter(m => m.timestamp >= parseInt(from));
  if (to) msgs = msgs.filter(m => m.timestamp <= parseInt(to));
  msgs = msgs.slice(-parseInt(limit));
  const rows = msgs.map(m => ({
    Time: new Date(m.timestamp * 1000).toLocaleString(),
    From: m.fromMe ? 'Me' : m.name,
    Message: m.body || (m.hasMedia ? '[Media]' : ''),
    Type: m.hasMedia ? 'media' : 'text'
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Chat');
  const fname = path.join(DATA_DIR, `exports/chat_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, fname);
  res.download(fname);
});

// ── openwa QR event — fires before client is ready ───────────────────────────
ev.on('qr.**', async qrData => {
  const url = await qrcode.toDataURL(qrData, {width:256,margin:2,color:{dark:'#111827',light:'#fff'}});
  io.emit('wa:qr', url);
});

// ── Init WhatsApp ─────────────────────────────────────────────────────────────
async function initWA() {
  try {
    waClient = await create({
      sessionId: 'sathya',
      sessionDataPath: path.join(DATA_DIR, 'sessions'),
      headless: true,
      multiDevice: true,
      blockCrashLogs: true,
      disableSpins: true,
      logConsole: false,
      qrTimeout: 0,
      authTimeout: 0,
      qrRefreshS: 15,
      autoRefresh: true,
      throwOnExpiredSessionData: false,
      onQr: async (qr) => {
        const url = await qrcode.toDataURL(qr, {width:256,margin:2,color:{dark:'#111827',light:'#fff'}});
        io.emit('wa:qr', url);
      },
      puppeteerOptions: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
          '--no-sandbox', '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', '--disable-gpu',
          '--no-zygote', '--single-process',
        ]
      }
    });

    waReady = true;
    touch();
    myInfo = await waClient.getMe();
    try {
      const pic = await waClient.getProfilePicFromServer(myInfo.id);
      if (pic) picCache['me'] = pic;
    } catch(e) {}

    io.emit('wa:ready', { name: myInfo.pushname || myInfo.formattedName, pic: picCache['me'] || null });
    loadPics();

    // incoming messages
    waClient.onMessage(async msg => {
      touch();
      const jid = msg.from;
      const out = {
        id: msg.id, jid, fromMe: msg.fromMe,
        body: msg.body || msg.caption || '',
        timestamp: msg.t,
        name: msg.sender?.pushname || msg.from,
        hasMedia: msg.hasMedia || false,
        mediaData: msg.mimetype ? { mimetype: msg.mimetype } : null,
        ack: msg.ack
      };
      // download media inline
      if (msg.hasMedia) {
        try {
          const media = await waClient.decryptMedia(msg);
          out.mediaData = { data: media.toString('base64'), mimetype: msg.mimetype, filename: msg.filename };
        } catch(e) {}
      }
      if (!chatHistory[jid]) chatHistory[jid] = [];
      chatHistory[jid].push(out);
      if (chatHistory[jid].length > 500) chatHistory[jid].shift();
      io.emit('wa:msg', out);
      if (!msg.fromMe) io.emit('wa:toast', { name: out.name, body: out.body.substring(0, 60) });
    });

    // read receipts / ticks
    waClient.onAck(ack => {
      io.emit('wa:ack', { id: ack.id._serialized || ack.id, ack: ack.ack });
    });

    // disconnected
    waClient.onStateChanged(state => {
      if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
        waReady = false;
        io.emit('wa:disconnected', state);
        setTimeout(initWA, 5000);
      }
    });

  } catch(e) {
    console.error('WA init error:', e.message);
    io.emit('wa:error', e.message);
    setTimeout(initWA, 8000);
  }
}

async function loadPics() {
  const BATCH = 6;
  for (let i = 0; i < allContacts.length; i += BATCH) {
    await Promise.all(allContacts.slice(i, i + BATCH).map(async c => {
      const jid = c.phone.replace('+', '') + '@c.us';
      if (picCache[jid]) { io.emit('wa:pic', { id: c.id, url: picCache[jid] }); return; }
      try {
        const url = await waClient.getProfilePicFromServer(jid);
        if (url) { picCache[jid] = url; io.emit('wa:pic', { id: c.id, url }); }
      } catch(e) {}
    }));
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('init', () => {
    socket.emit('contacts', contacts);
    allContacts.forEach(c => {
      const jid = c.phone.replace('+', '') + '@c.us';
      if (picCache[jid]) socket.emit('wa:pic', { id: c.id, url: picCache[jid] });
    });
    if (waReady) socket.emit('wa:ready', { name: myInfo?.pushname || '', pic: picCache['me'] || null });
  });

  socket.on('wa:send', async ({ to, message, mediaPath, mime }) => {
    if (!waReady) return socket.emit('err', 'Not connected');
    touch();
    const jid = to.replace('+', '') + '@c.us';
    try {
      let id;
      if (mediaPath) {
        const base64 = fs.readFileSync(path.join(DATA_DIR, mediaPath)).toString('base64');
        const mt = mime || 'application/octet-stream';
        if (mt.startsWith('image/')) id = await waClient.sendImage(jid, `data:${mt};base64,${base64}`, 'media', message || '');
        else if (mt.startsWith('video/')) id = await waClient.sendVideo(jid, `data:${mt};base64,${base64}`, message || '');
        else id = await waClient.sendFile(jid, `data:${mt};base64,${base64}`, path.basename(mediaPath), message || '');
      } else {
        id = await waClient.sendText(jid, message);
      }
      socket.emit('wa:sent', { to, success: true, id });
    } catch(e) { socket.emit('wa:sent', { to, success: false, error: e.message }); }
  });

  socket.on('wa:bulk', async ({ recipients, message, mediaPath, mime, delay }) => {
    if (!waReady) return;
    for (const phone of recipients) {
      touch();
      const jid = phone.replace('+', '') + '@c.us';
      try {
        if (mediaPath) {
          const base64 = fs.readFileSync(path.join(DATA_DIR, mediaPath)).toString('base64');
          const mt = mime || 'application/octet-stream';
          if (mt.startsWith('image/')) await waClient.sendImage(jid, `data:${mt};base64,${base64}`, 'media', message || '');
          else if (mt.startsWith('video/')) await waClient.sendVideo(jid, `data:${mt};base64,${base64}`, message || '');
          else await waClient.sendFile(jid, `data:${mt};base64,${base64}`, path.basename(mediaPath), message || '');
        } else {
          await waClient.sendText(jid, message);
        }
        socket.emit('wa:bulk_prog', { phone, success: true });
      } catch(e) { socket.emit('wa:bulk_prog', { phone, success: false, error: e.message }); }
      await new Promise(r => setTimeout(r, delay || cfg.wa_message_delay_ms));
    }
    socket.emit('wa:bulk_done');
  });

  socket.on('wa:schedule', ({ recipients, message, datetime, mediaPath, mime }) => {
    const d = new Date(datetime);
    const job = cron.schedule(`${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`, async () => {
      for (const phone of recipients) {
        const jid = phone.replace('+', '') + '@c.us';
        try {
          if (mediaPath) {
            const base64 = fs.readFileSync(path.join(DATA_DIR, mediaPath)).toString('base64');
            const mt = mime || 'application/octet-stream';
            if (mt.startsWith('image/')) await waClient.sendImage(jid, `data:${mt};base64,${base64}`, 'media', message || '');
            else await waClient.sendFile(jid, `data:${mt};base64,${base64}`, path.basename(mediaPath), message || '');
          } else await waClient.sendText(jid, message);
          io.emit('wa:sched_sent', { phone });
        } catch(e) {}
      }
      job.stop();
    }, { scheduled: true });
    socket.emit('wa:scheduled', { datetime, count: recipients.length });
  });

  socket.on('wa:logout', async () => {
    try { await waClient.kill(); } catch(e) {}
    waReady = false; waClient = null;
    io.emit('wa:disconnected', 'manual');
    setTimeout(initWA, 1000);
  });

  socket.on('sms:send', async ({ to, message, gw }) => {
    if (!gw?.url) return socket.emit('sms:sent', { to, success: false, error: 'No SMS gateway set' });
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
        try {
          await axios.post(`${gw.url}/message`, { phoneNumber: phone, message }, { auth: { username: gw.user || '', password: gw.pass || '' } });
          io.emit('sms:sched_sent', { phone });
        } catch(e) {}
      }
      job.stop();
    }, { scheduled: true });
    socket.emit('sms:scheduled', { datetime, count: recipients.length });
  });
});

const PORT = process.env.PORT || cfg.server_port || 7860;
server.listen(PORT, () => {
  console.log(`\n✅ Sathya Messenger → http://localhost:${PORT}\n`);
  initWA();
});

// Keep Render free tier awake — ping self every 10 min
const APP_URL = process.env.RENDER_EXTERNAL_URL;
if (APP_URL) {
  setInterval(() => {
    require('https').get(APP_URL, () => {}).on('error', () => {});
    console.log('[ping]', APP_URL);
  }, 10 * 60 * 1000);
}
