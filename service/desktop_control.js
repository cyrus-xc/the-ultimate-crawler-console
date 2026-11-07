'use strict';
const net=require('node:net');
const {WebSocketServer}=require('ws');
const {timingSafeEqual}=require('node:crypto');
class DesktopControl {
 constructor(store,{token,port=15910,scope='pipeline'}={}){this.store=store;this.token=token;this.port=port;this.scope=scope;this.active=null;}
 assert(leases){
  const web=this.store.devices().filter(d=>d.kind==='web');
  if(!web.length||web.some(d=>!leases.some(l=>l.device_id===d.id)))throw Error('ALL_WEB_LEASES_REQUIRED');
  for(const lease of leases){const row=this.store.assertLease(lease,{externalOnly:true});if(!row.owner.startsWith('external:'+this.scope+':'))throw Error('LEASE_NOT_OWNED');const d=web.find(d=>d.id===lease.device_id);if(!d||d.quarantined)throw Error('DEVICE_UNAVAILABLE');}
 }
 attach(server){
  this.wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,handleProtocols:p=>p.has('binary')?'binary':false});
  server.on('upgrade',(req,socket,head)=>{
   if(req.url!=='/v1/desktop/socket')return socket.destroy();
   let leases;try{const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+this.token);if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||req.headers.origin||this.active)throw Error();leases=JSON.parse(req.headers['x-crawler-leases']);if(!Array.isArray(leases))throw Error();this.assert(leases);}catch{return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
   this.wss.handleUpgrade(req,socket,head,ws=>{
    const tcp=net.connect({host:'127.0.0.1',port:this.port});this.active={ws,tcp,leases};let closed=false;
    const close=()=>{if(closed)return;closed=true;clearInterval(timer);tcp.destroy();ws.terminate();this.active=null;};
    const timer=setInterval(()=>{try{this.assert(leases);}catch{for(const l of leases)this.store.quarantine(l.device_id,'CONTROL_LEASE_LOST');close();}},100);timer.unref();
    tcp.on('data',data=>{if(ws.readyState===1&&ws.bufferedAmount<8*1024*1024)ws.send(data);else close();});tcp.on('error',close);tcp.on('close',close);
    ws.on('message',(data,binary)=>{try{this.assert(leases);if(!binary||tcp.writableLength>1024*1024)throw Error();tcp.write(data);}catch{close();}});ws.on('close',close);ws.on('error',close);
   });
  });
 }
 async close(){this.active?.ws.terminate();this.active?.tcp.destroy();if(this.wss)await new Promise(r=>this.wss.close(r));}
}
module.exports={DesktopControl};
