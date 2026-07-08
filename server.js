'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const axios      = require('axios');
const qrcode     = require('qrcode');
const XLSX       = require('xlsx');
const cron       = require('node-cron');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
for (const d of ['sessions','uploads','exports'])
  fs.mkdirSync(path.join(DATA, d), { recursive: true });

// ── Config / Contacts ─────────────────────────────────────────────────────────
const cfg      = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
const contacts = JSON.parse(fs.readFileSync(path.join(__dirname,'contacts.json'),'utf8'));
const ALL      = [...contacts.agms, ...contacts.bms];

// ── Express / Socket.io ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingTimeout: 60000 });

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(DATA,'uploads')));

// ── Upload ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA,'uploads'),
    filename: (_,f,cb) => cb(null, Date.now() + path.extname(f.originalname))
  })
});
app.post('/upload', upload.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({error:'no file'});
  res.json({ path: 'uploads/'+req.file.filename, name: req.file.originalname, mime: req.file.mimetype });
});

// ── Export ────────────────────────────────────────────────────────────────────
app.get('/export', (req,res) => {
  const { jid, from, to, limit=500 } = req.query;
  let msgs = (chatHistory[jid]||[]);
  if (from) msgs = msgs.filter(m => m.ts >= +from);
  if (to)   msgs = msgs.filter(m => m.ts <= +to);
  msgs = msgs.slice(-+limit);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    msgs.map(m => ({
      Time: new Date(m.ts*1000).toLocaleString(),
      From: m.fromMe?'Me':m.name,
      Message: m.body||(m.hasMedia?'[Media]':''),
    }))
  ), 'Chat');
  const out = path.join(DATA, `exports/chat_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, out);
  res.download(out);
});

// ── WhatsApp state ────────────────────────────────────────────────────────────
let wa         = null;   // Client instance
let waReady    = false;
let waMeta     = null;   // { name, pic }
let lastActive = Date.now();
const picCache    = {};  // jid → url
const chatHistory = {};  // jid → msg[]

function storeMsg(jid, msg) {
  if (!chatHistory[jid]) chatHistory[jid] = [];
  chatHistory[jid].push(msg);
  if (chatHistory[jid].length > 500) chatHistory[jid].shift();
}

// 3-day idle auto-logout
cron.schedule('0 * * * *', async () => {
  if (!waReady) return;
  if (Date.now() - lastActive > 3*24*3600*1000) {
    console.log('[WA] 3-day idle → logout');
    try { await wa.logout(); } catch(_){}
    waReady = false;
    io.emit('wa:disconnected', 'idle');
    setTimeout(startWA, 1000);
  }
});

// ── Start WhatsApp ────────────────────────────────────────────────────────────
function startWA() {
  const chrome = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  const exists = fs.existsSync(chrome);
  console.log(`[WA] Chrome: ${chrome} ${exists?'✓':'✗ NOT FOUND'}`);

  wa = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA,'sessions') }),
    puppeteer: {
      headless: true,
      executablePath: chrome,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-translate',
        '--metrics-recording-only',
        '--safebrowsing-disable-auto-update',
      ]
    }
  });

  wa.on('qr', async qr => {
    console.log('[WA] QR generated');
    const dataUrl = await qrcode.toDataURL(qr, {
      width: 260, margin: 2,
      color: { dark: '#111827', light: '#ffffff' }
    });
    io.emit('wa:qr', dataUrl);
  });

  wa.on('authenticated', () => {
    console.log('[WA] Authenticated — loading session');
    io.emit('wa:loading', 'Authenticated ✓ — loading…');
  });

  wa.on('ready', async () => {
    waReady    = true;
    lastActive = Date.now();
    const info = wa.info;
    let pic = null;
    try { pic = await wa.getProfilePicUrl(info.wid._serialized); } catch(_){}
    waMeta = { name: info.pushname, pic };
    picCache['me'] = pic;
    console.log(`[WA] Ready as ${info.pushname}`);
    io.emit('wa:ready', waMeta);
    loadPics();
  });

  wa.on('disconnected', reason => {
    console.log('[WA] Disconnected:', reason);
    waReady = false;
    io.emit('wa:disconnected', reason);
    if (reason === 'LOGOUT') {
      // clear session so QR appears fresh
      fs.rmSync(path.join(DATA,'sessions'), { recursive:true, force:true });
      fs.mkdirSync(path.join(DATA,'sessions'), { recursive:true });
      setTimeout(startWA, 1500);
    } else {
      setTimeout(startWA, 5000);
    }
  });

  wa.on('auth_failure', msg => {
    console.error('[WA] Auth failure:', msg);
    fs.rmSync(path.join(DATA,'sessions'), { recursive:true, force:true });
    fs.mkdirSync(path.join(DATA,'sessions'), { recursive:true });
    setTimeout(startWA, 3000);
  });

  wa.on('message', async msg => {
    lastActive = Date.now();
    let media = null;
    if (msg.hasMedia) {
      try {
        const m = await msg.downloadMedia();
        if (m) media = { data: m.data, mimetype: m.mimetype, filename: m.filename||'' };
      } catch(_){}
    }
    const contact = await msg.getContact().catch(()=>null);
    const out = {
      id:      msg.id._serialized,
      jid:     msg.from,
      fromMe:  msg.fromMe,
      body:    msg.body||'',
      ts:      msg.timestamp,
      name:    contact?.pushname || contact?.name || msg.from,
      media,
      ack:     msg.ack
    };
    storeMsg(msg.from, out);
    io.emit('wa:msg', out);
    if (!msg.fromMe) io.emit('wa:notify', { name: out.name, body: out.body.substring(0,60) });
  });

  wa.on('message_ack', (msg, ack) => {
    io.emit('wa:ack', { id: msg.id._serialized, ack });
    const h = chatHistory[msg.from];
    if (h) { const m = h.find(x=>x.id===msg.id._serialized); if(m) m.ack=ack; }
  });

  wa.initialize().catch(e => {
    console.error('[WA] init error:', e.message);
    setTimeout(startWA, 8000);
  });
}

async function loadPics() {
  const BATCH = 6;
  for (let i=0; i<ALL.length; i+=BATCH) {
    await Promise.all(ALL.slice(i,i+BATCH).map(async c => {
      const jid = c.phone.replace('+','')+'@c.us';
      if (picCache[jid]) { io.emit('wa:pic',{id:c.id,url:picCache[jid]}); return; }
      try {
        const url = await wa.getProfilePicUrl(jid);
        if (url) { picCache[jid]=url; io.emit('wa:pic',{id:c.id,url}); }
      } catch(_){}
    }));
    await new Promise(r=>setTimeout(r,400));
  }
}

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[Socket] client connected');

  // always send contacts immediately on connect
  socket.emit('contacts', contacts);

  // send cached pics
  ALL.forEach(c => {
    const jid = c.phone.replace('+','')+'@c.us';
    if (picCache[jid]) socket.emit('wa:pic',{id:c.id,url:picCache[jid]});
  });

  // send current WA state
  if (waReady && waMeta) {
    socket.emit('wa:ready', waMeta);
  }
  // (if not ready, client waits for qr/loading/ready events broadcast by initWA)

  // ── WA send ──
  socket.on('wa:send', async ({to,message,mediaPath,mime}) => {
    if (!waReady) return socket.emit('err','WhatsApp not connected');
    lastActive = Date.now();
    const cid = to.replace('+','')+'@c.us';
    try {
      let sent;
      if (mediaPath) {
        const m = MessageMedia.fromFilePath(path.join(DATA, mediaPath));
        sent = await wa.sendMessage(cid, m, { caption: message||'' });
      } else {
        sent = await wa.sendMessage(cid, message);
      }
      socket.emit('wa:sent', { to, success:true, id:sent.id._serialized });
    } catch(e) {
      socket.emit('wa:sent', { to, success:false, error:e.message });
    }
  });

  // ── WA bulk ──
  socket.on('wa:bulk', async ({recipients,message,mediaPath,delay}) => {
    if (!waReady) return;
    for (const phone of recipients) {
      lastActive = Date.now();
      const cid = phone.replace('+','')+'@c.us';
      try {
        if (mediaPath) {
          const m = MessageMedia.fromFilePath(path.join(DATA, mediaPath));
          await wa.sendMessage(cid, m, { caption: message||'' });
        } else {
          await wa.sendMessage(cid, message);
        }
        socket.emit('wa:bulk_prog', { phone, success:true });
      } catch(e) {
        socket.emit('wa:bulk_prog', { phone, success:false, error:e.message });
      }
      await new Promise(r=>setTimeout(r, delay||cfg.wa_message_delay_ms||2000));
    }
    socket.emit('wa:bulk_done');
  });

  // ── WA schedule ──
  socket.on('wa:schedule', ({recipients,message,datetime,mediaPath}) => {
    const d = new Date(datetime);
    const job = cron.schedule(
      `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth()+1} *`,
      async () => {
        for (const phone of recipients) {
          const cid = phone.replace('+','')+'@c.us';
          try {
            if (mediaPath) {
              const m = MessageMedia.fromFilePath(path.join(DATA,mediaPath));
              await wa.sendMessage(cid,m,{caption:message||''});
            } else {
              await wa.sendMessage(cid,message);
            }
            io.emit('wa:sched_sent',{phone});
          } catch(_){}
        }
        job.stop();
      },
      { scheduled:true }
    );
    socket.emit('wa:scheduled', { datetime, count:recipients.length });
  });

  // ── WA logout ──
  socket.on('wa:logout', async () => {
    try { await wa.logout(); } catch(_){}
    waReady = false;
    io.emit('wa:disconnected','LOGOUT');
  });

  // ── SMS send ──
  socket.on('sms:send', async ({to,message,gw}) => {
    if (!gw?.url) return socket.emit('sms:sent',{to,success:false,error:'No gateway configured'});
    try {
      await axios.post(`${gw.url}/message`,
        { phoneNumber:to, message },
        { auth:{username:gw.user||'',password:gw.pass||''}, timeout:12000 }
      );
      socket.emit('sms:sent',{to,success:true});
    } catch(e) {
      socket.emit('sms:sent',{to,success:false,error:e.message});
    }
  });

  // ── SMS bulk ──
  socket.on('sms:bulk', async ({recipients,message,delay,gw}) => {
    if (!gw?.url) return socket.emit('sms:bulk_done');
    for (const phone of recipients) {
      try {
        await axios.post(`${gw.url}/message`,
          { phoneNumber:phone, message },
          { auth:{username:gw.user||'',password:gw.pass||''}, timeout:12000 }
        );
        socket.emit('sms:bulk_prog',{phone,success:true});
      } catch(e) {
        socket.emit('sms:bulk_prog',{phone,success:false,error:e.message});
      }
      await new Promise(r=>setTimeout(r,delay||cfg.sms_message_delay_ms||3000));
    }
    socket.emit('sms:bulk_done');
  });

  // ── SMS schedule ──
  socket.on('sms:schedule', ({recipients,message,datetime,gw}) => {
    if (!gw?.url) return;
    const d = new Date(datetime);
    const job = cron.schedule(
      `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth()+1} *`,
      async () => {
        for (const phone of recipients) {
          try {
            await axios.post(`${gw.url}/message`,
              { phoneNumber:phone, message },
              { auth:{username:gw.user||'',password:gw.pass||''} }
            );
            io.emit('sms:sched_sent',{phone});
          } catch(_){}
        }
        job.stop();
      },
      { scheduled:true }
    );
    socket.emit('sms:scheduled',{datetime,count:recipients.length});
  });

  socket.on('disconnect', () => console.log('[Socket] client disconnected'));
});

// ── Keep Render alive ─────────────────────────────────────────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  console.log('[Ping] Keep-alive active →', RENDER_URL);
  setInterval(() => {
    require('https').get(RENDER_URL, ()=>{}).on('error', ()=>{});
  }, 10*60*1000);
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || cfg.server_port || 10000;
server.listen(PORT, () => {
  console.log(`\n✅  Sathya Messenger running on port ${PORT}\n`);
  startWA();
});
