'use strict';
const express=require('express'),http=require('http'),{Server}=require('socket.io');
const path=require('path'),fs=require('fs'),multer=require('multer'),axios=require('axios');
const qrcode=require('qrcode'),XLSX=require('xlsx'),cron=require('node-cron'),pino=require('pino');
const{default:makeWASocket,useMultiFileAuthState,DisconnectReason,makeCacheableSignalKeyStore,downloadContentFromMessage}=require('@whiskeysockets/baileys');

const DATA=process.env.DATA_DIR||path.join(__dirname,'data');
['sessions/baileys','uploads','exports'].forEach(d=>fs.mkdirSync(path.join(DATA,d),{recursive:true}));
const cfg=JSON.parse(fs.readFileSync('config.json','utf8'));
const contacts=JSON.parse(fs.readFileSync('contacts.json','utf8'));
const ALL=[...contacts.agms,...contacts.bms];
const log=pino({level:'silent'});

const app=express(),server=http.createServer(app),io=new Server(server,{pingTimeout:60000});
app.use(express.json()).use(express.static(__dirname)).use('/uploads',express.static(path.join(DATA,'uploads')));

const upload=multer({storage:multer.diskStorage({destination:path.join(DATA,'uploads'),filename:(_,f,cb)=>cb(null,Date.now()+path.extname(f.originalname))})});
app.post('/upload',upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'no file'});res.json({path:'uploads/'+req.file.filename,name:req.file.originalname,mime:req.file.mimetype});});
app.get('/export',(req,res)=>{
  const{jid,from,to,limit=500}=req.query;
  let m=(chatHist[jid]||[]);
  if(from)m=m.filter(x=>x.ts>=+from);if(to)m=m.filter(x=>x.ts<=+to);
  m=m.slice(-+limit);
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(m.map(x=>({Time:new Date(x.ts*1000).toLocaleString(),From:x.fromMe?'Me':x.name,Message:x.body||''}))), 'Chat');
  const f=path.join(DATA,`exports/${Date.now()}.xlsx`);XLSX.writeFile(wb,f);res.download(f);
});

let wa=null,waReady=false,waMeta=null,lastActive=Date.now();
const pics={},chatHist={};
const store=(jid,msg)=>{if(!chatHist[jid])chatHist[jid]=[];chatHist[jid].push(msg);if(chatHist[jid].length>500)chatHist[jid].shift();};

cron.schedule('0 * * * *',async()=>{
  if(!waReady||Date.now()-lastActive<3*24*3600*1000)return;
  try{await wa.logout();}catch(_){}waReady=false;wa=null;io.emit('wa:disconnected','idle');setTimeout(startWA,1000);
});

async function startWA(){
  const sessDir=path.join(DATA,'sessions/baileys');
  const{state,saveCreds}=await useMultiFileAuthState(sessDir);
  wa=makeWASocket({
    version:[2,3000,1023596015395],
    auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,log)},
    logger:log,printQRInTerminal:false,
    browser:['Sathya','Chrome','120'],
    syncFullHistory:false,getMessage:async()=>({conversation:''})
  });
  wa.ev.on('creds.update',saveCreds);
  wa.ev.on('connection.update',async({connection,lastDisconnect,qr})=>{
    if(qr){const url=await qrcode.toDataURL(qr,{width:256,margin:2,color:{dark:'#111827',light:'#fff'}});io.emit('wa:qr',url);}
    if(connection==='open'){
      waReady=true;lastActive=Date.now();
      const info=wa.user;let pic=null;
      try{pic=await wa.profilePictureUrl(info.id,'image');}catch(_){}
      waMeta={name:info.name||info.id.split(':')[0],pic};pics['me']=pic;
      io.emit('wa:ready',waMeta);loadPics();
    }
    if(connection==='close'){
      waReady=false;wa=null;
      const code=lastDisconnect?.error?.output?.statusCode;
      const out=code===DisconnectReason.loggedOut||code===401;
      io.emit('wa:disconnected',out?'LOGOUT':'reconnecting');
      if(out){fs.rmSync(sessDir,{recursive:true,force:true});fs.mkdirSync(sessDir,{recursive:true});}
      setTimeout(startWA,out?1000:5000);
    }
  });
  wa.ev.on('messages.upsert',async({messages,type})=>{
    if(type!=='notify')return;
    for(const msg of messages){
      if(!msg.message)continue;lastActive=Date.now();
      const jid=msg.key.remoteJid,fromMe=msg.key.fromMe;
      const mtype=Object.keys(msg.message)[0],content=msg.message[mtype];
      let body='',media=null;
      if(mtype==='conversation'||mtype==='extendedTextMessage')body=typeof content==='string'?content:content?.text||'';
      else if(['imageMessage','videoMessage','audioMessage','documentMessage'].includes(mtype)){
        body=content.caption||'';
        try{const s=await downloadContentFromMessage(content,mtype.replace('Message',''));const c=[];for await(const ch of s)c.push(ch);media={data:Buffer.concat(c).toString('base64'),mimetype:content.mimetype,filename:content.fileName||mtype};}catch(_){}
      }
      const out={id:msg.key.id,jid,fromMe,body,ts:msg.messageTimestamp,name:fromMe?waMeta?.name||'Me':msg.pushName||jid,media,ack:fromMe?1:0};
      store(jid,out);io.emit('wa:msg',out);
      if(!fromMe)io.emit('wa:notify',{name:out.name,body:body.substring(0,60)});
    }
  });
  wa.ev.on('messages.update',us=>{us.forEach(u=>{if(u.update?.status!=null){io.emit('wa:ack',{id:u.key.id,ack:u.update.status});const h=chatHist[u.key.remoteJid];if(h){const m=h.find(x=>x.id===u.key.id);if(m)m.ack=u.update.status;}}});});
}

async function loadPics(){
  for(let i=0;i<ALL.length;i+=6){
    await Promise.all(ALL.slice(i,i+6).map(async c=>{
      const jid=c.phone.replace('+','')+'@s.whatsapp.net';
      if(pics[jid]){io.emit('wa:pic',{id:c.id,url:pics[jid]});return;}
      try{const url=await wa.profilePictureUrl(jid,'image');if(url){pics[jid]=url;io.emit('wa:pic',{id:c.id,url});}}catch(_){}
    }));
    await new Promise(r=>setTimeout(r,400));
  }
}

io.on('connection',socket=>{
  socket.emit('contacts',contacts);
  ALL.forEach(c=>{const j=c.phone.replace('+','')+'@s.whatsapp.net';if(pics[j])socket.emit('wa:pic',{id:c.id,url:pics[j]});});
  if(waReady&&waMeta)socket.emit('wa:ready',waMeta);

  socket.on('wa:send',async({to,message,mediaPath,mime})=>{
    if(!waReady)return socket.emit('err','Not connected');
    lastActive=Date.now();const jid=to.replace('+','')+'@s.whatsapp.net';
    try{
      let sent;
      if(mediaPath){const buf=fs.readFileSync(path.join(DATA,mediaPath));const mt=mime||'application/octet-stream';
        if(mt.startsWith('image/'))sent=await wa.sendMessage(jid,{image:buf,caption:message||''});
        else if(mt.startsWith('video/'))sent=await wa.sendMessage(jid,{video:buf,caption:message||''});
        else if(mt.startsWith('audio/'))sent=await wa.sendMessage(jid,{audio:buf,mimetype:mt});
        else sent=await wa.sendMessage(jid,{document:buf,mimetype:mt,fileName:path.basename(mediaPath),caption:message||''});
      }else sent=await wa.sendMessage(jid,{text:message});
      socket.emit('wa:sent',{to,success:true,id:sent?.key?.id});
    }catch(e){socket.emit('wa:sent',{to,success:false,error:e.message});}
  });

  socket.on('wa:bulk',async({recipients,message,mediaPath,mime,delay})=>{
    if(!waReady)return;
    for(const phone of recipients){
      lastActive=Date.now();const jid=phone.replace('+','')+'@s.whatsapp.net';
      try{
        if(mediaPath){const buf=fs.readFileSync(path.join(DATA,mediaPath));const mt=mime||'application/octet-stream';
          if(mt.startsWith('image/'))await wa.sendMessage(jid,{image:buf,caption:message||''});
          else if(mt.startsWith('video/'))await wa.sendMessage(jid,{video:buf,caption:message||''});
          else await wa.sendMessage(jid,{document:buf,mimetype:mt,fileName:path.basename(mediaPath),caption:message||''});
        }else await wa.sendMessage(jid,{text:message});
        socket.emit('wa:bulk_prog',{phone,success:true});
      }catch(e){socket.emit('wa:bulk_prog',{phone,success:false,error:e.message});}
      await new Promise(r=>setTimeout(r,delay||cfg.wa_message_delay_ms||2000));
    }
    socket.emit('wa:bulk_done');
  });

  socket.on('wa:schedule',({recipients,message,datetime,mediaPath,mime})=>{
    const d=new Date(datetime);
    const job=cron.schedule(`${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth()+1} *`,async()=>{
      for(const phone of recipients){const jid=phone.replace('+','')+'@s.whatsapp.net';
        try{if(mediaPath){const buf=fs.readFileSync(path.join(DATA,mediaPath));const mt=mime||'application/octet-stream';if(mt.startsWith('image/'))await wa.sendMessage(jid,{image:buf,caption:message||''});else await wa.sendMessage(jid,{document:buf,mimetype:mt,fileName:path.basename(mediaPath)});}
          else await wa.sendMessage(jid,{text:message});io.emit('wa:sched_sent',{phone});}catch(_){}
      }job.stop();},{scheduled:true});
    socket.emit('wa:scheduled',{datetime,count:recipients.length});
  });

  socket.on('wa:logout',async()=>{try{await wa.logout();}catch(_){}waReady=false;wa=null;io.emit('wa:disconnected','LOGOUT');});

  const smsPost=async(gw,phone,message)=>axios.post(`${gw.url}/message`,{phoneNumber:phone,message},{auth:{username:gw.user||'',password:gw.pass||''},timeout:12000});

  socket.on('sms:send',async({to,message,gw})=>{
    if(!gw?.url)return socket.emit('sms:sent',{to,success:false,error:'No gateway'});
    try{await smsPost(gw,to,message);socket.emit('sms:sent',{to,success:true});}catch(e){socket.emit('sms:sent',{to,success:false,error:e.message});}
  });

  socket.on('sms:bulk',async({recipients,message,delay,gw})=>{
    if(!gw?.url)return socket.emit('sms:bulk_done');
    for(const phone of recipients){
      try{await smsPost(gw,phone,message);socket.emit('sms:bulk_prog',{phone,success:true});}catch(e){socket.emit('sms:bulk_prog',{phone,success:false,error:e.message});}
      await new Promise(r=>setTimeout(r,delay||cfg.sms_message_delay_ms||3000));
    }socket.emit('sms:bulk_done');
  });

  socket.on('sms:schedule',({recipients,message,datetime,gw})=>{
    if(!gw?.url)return;
    const d=new Date(datetime);
    const job=cron.schedule(`${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth()+1} *`,async()=>{
      for(const phone of recipients){try{await smsPost(gw,phone,message);io.emit('sms:sched_sent',{phone});}catch(_){}}job.stop();},{scheduled:true});
    socket.emit('sms:scheduled',{datetime,count:recipients.length});
  });
});

const RURL=process.env.RENDER_EXTERNAL_URL;
if(RURL)setInterval(()=>require('https').get(RURL,()=>{}).on('error',()=>{}),10*60*1000);

const PORT=process.env.PORT||cfg.server_port||10000;
server.listen(PORT,()=>{console.log(`✅ :${PORT}`);startWA();});
