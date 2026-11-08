'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {timingSafeEqual} = require('node:crypto');
const {Store} = require('./store');
const {problem,VERSION,OPERATIONS} = require('./contract');
function authenticated(req,token) {
  const supplied=Buffer.from(req.headers.authorization || ''), expected=Buffer.from('Bearer '+token);
  return supplied.length===expected.length && timingSafeEqual(supplied,expected);
}
async function body(req) {
  if(!(req.headers['content-type']||'').startsWith('application/json'))throw problem('JSON_REQUIRED',415);
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>1024*1024)throw problem('BODY_TOO_LARGE',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem('INVALID_JSON');}
}
function cursor(url) {
  const raw=url.searchParams.get('cursor')??url.searchParams.get('after')??'0';
  if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw problem('INVALID_CURSOR');
  return Number(raw);
}
function createServer({store,token,scope='pipeline',gateway=null,inventory=null,scheduler=null,barrier=null,displays=null,provisioner=null,phoneUtility=require('./phone_utilities').phoneUtility,linkUtility=require('./phone_utilities').linkUtility}) {
  if(typeof token!=='string'||token.length<32)throw problem('SERVICE_TOKEN_REQUIRED',500);
  const discovery=new (require('./discovery_sessions').DiscoverySessions)({store,adapters:scheduler?.worker?.adapters||new Map(),gateway});
  const desktopActions=new Map(),loginUploads=new Map(),phoneActions=new Map(),loginQrs=new Map();
  const drainPhone=async lease=>{const action=phoneActions.get(lease.token);if(action){action.controller.abort(problem('STOP_REQUESTED',409));await action.promise.catch(()=>{});}};
  const drainDesktop=async lease=>{const active=desktopActions.get(lease.token);if(active){await active.adapter.close();await active.promise.catch(()=>{});}};
  const desktopAction=async(lease,action)=>{
    const held=store.assertLease(lease,{externalOnly:true});if(!held.owner.startsWith('external:'+scope+':'))throw problem('LEASE_NOT_OWNED',403);
    const adapter=scheduler?.worker?.adapters?.get(lease.device_id);if(!adapter?.[action])throw problem('DESKTOP_UNAVAILABLE',503);
    if(desktopActions.has(lease.token))throw problem('DEVICE_BUSY',409);
    const controller=new AbortController();const guard=()=>{if(controller.signal.aborted)throw controller.signal.reason;store.assertLease(lease,{externalOnly:true});};
    let stopping=false;const monitor=setInterval(()=>{try{guard();}catch(error){if(stopping)return;stopping=true;controller.abort(error);store.quarantine(lease.device_id,'CONTROL_LEASE_LOST');adapter.close().catch(()=>{});}},100);
    const promise=Promise.resolve().then(()=>adapter[action]({guard,signal:controller.signal}));desktopActions.set(lease.token,{adapter,promise});
    try{const result=await promise;guard();return result;}catch(error){if(/^[A-Z][A-Z0-9_]{0,100}$/.test(error.code||''))error.status=error.status||409;throw error;}finally{clearInterval(monitor);desktopActions.delete(lease.token);}
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    const send=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/health'&&req.method==='GET')return send(200,{status:'ok',schema_version:VERSION,live_adapters:!!scheduler?.worker?.adapters?.size,scheduler:!!scheduler,device_gateway:!!gateway});
      if(req.headers.origin)throw problem('DIRECT_BROWSER_ACCESS_DENIED',403);
      if(!authenticated(req,token))throw problem('UNAUTHORIZED',401);
      if(url.pathname==='/v1/capabilities'&&req.method==='GET')return send(200,{operations:OPERATIONS,devices:store.devices().map(d=>({device_id:d.id,capabilities:d.capabilities}))});
      if(url.pathname==='/v1/devices'&&req.method==='GET')return send(200,{devices:store.devices().map(d=>({...d,...(inventory?inventory.describe(d):{...(d.kind==='android'?{connection_state:d.health==='ready'?'device':'offline'}:{})}),last_error:store.db.prepare("SELECT json_extract(payload,'$.code') code FROM events WHERE type IN ('unit.failed','device.quarantined') AND json_extract(payload,'$.device_id')=? ORDER BY seq DESC LIMIT 1").get(d.id)?.code||null,recovered_at:store.db.prepare("SELECT max(created) at FROM events WHERE type='device.recovered' AND json_extract(payload,'$.device_id')=?").get(d.id).at||null}))});
      if(url.pathname==='/v1/queue'&&req.method==='GET')return send(200,{counts:store.db.prepare('SELECT state,count(*) count FROM requests WHERE scope=? GROUP BY state').all(scope)});
      if(url.pathname==='/v1/discovery-sessions'&&req.method==='POST'){const input=await body(req),controller=new AbortController();const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnect);try{return send(201,await discovery.open(input,scope,controller.signal));}finally{res.removeListener('close',disconnect);}}
      const discoveryRoute=url.pathname.match(/^\/v1\/discovery-sessions\/([0-9a-f-]+)\/(complete|cancel)$/);
      if(discoveryRoute&&req.method==='POST'){const input=await body(req);return send(200,await (discoveryRoute[2]==='complete'?discovery.complete(discoveryRoute[1],input,scope):discovery.cancel(discoveryRoute[1],scope)));}
      if(url.pathname==='/v1/requests'&&req.method==='POST')return send(202,store.submit(await body(req),scope));
      if(url.pathname==='/v1/desktop/close'&&req.method==='POST'){const input=await body(req);if(!['web:xhs:default','web:douyin:default'].includes(input.lease?.device_id))throw problem('WEB_DEVICE_REQUIRED',409);await desktopAction(input.lease,'close');return send(200,{closed:true});}
      if(url.pathname==='/v1/desktop/qr'&&req.method==='POST'){
        const input=await body(req),result=await desktopAction(input.lease,'loginQr'),key=input.lease.device_id;
        if(result.authenticated)loginQrs.delete(key);
        else if(result.png_base64){const previous=loginQrs.get(key);if(previous?.png_base64!==result.png_base64)loginQrs.set(key,{png_base64:result.png_base64,expires_at:Date.now()+600000});}
        return send(200,result);
      }
      if(url.pathname==='/v1/desktop/qr-current'&&req.method==='GET'){
        const key=url.searchParams.get('device_id');if(!['web:xhs:default','web:douyin:default'].includes(key))throw problem('WEB_DEVICE_REQUIRED',400);
        const qr=loginQrs.get(key);if(!qr)throw problem('QR_NOT_AVAILABLE',409);if(Date.now()>=qr.expires_at)throw problem('QR_EXPIRED',409);return send(200,qr);
      }
      if(url.pathname==='/v1/desktop/open'&&req.method==='POST'){
        const input=await body(req),lease=input.lease;
        const held=store.assertLease(lease,{externalOnly:true});if(!held.owner.startsWith('external:'+scope+':'))throw problem('LEASE_NOT_OWNED',403);
        await desktopAction(lease,'desktop');return send(200,{opened:true,device_id:lease.device_id});
      }
      if(url.pathname==='/v1/desktop/resume'&&req.method==='POST'){
        const input=await body(req);if(input.confirmed!==true)throw problem('HUMAN_CONFIRMATION_REQUIRED',409);
        const held=store.assertLease(input.lease,{externalOnly:true});if(!held.owner.startsWith('external:'+scope+':'))throw problem('LEASE_NOT_OWNED',403);
        const device=store.devices().find(d=>d.id===input.lease.device_id);if(device.kind!=='web'||device.quarantined)throw problem('DEVICE_RECOVERY_REQUIRED',409);
        try{await desktopAction(input.lease,'resume');}catch(error){
          if(error.code==='LOGIN_REQUIRED'){store.assertLease(input.lease,{externalOnly:true});const platform=device.id==='web:xhs:default'?'xiaohongshu':'douyin';store.db.prepare('UPDATE devices SET faults=? WHERE id=?').run(JSON.stringify({...device.faults,[platform]:error.code}),device.id);store.event(null,'device.login_required',{device_id:device.id,platform,code:error.code});}
          throw error;
        }
        const platform=device.id==='web:xhs:default'?'xiaohongshu':'douyin',faults={...device.faults};delete faults[platform];
        store.db.prepare("UPDATE devices SET faults=?,health='ready' WHERE id=?").run(JSON.stringify(faults),device.id);store.event(null,'device.recovered',{device_id:device.id,platform});return send(200,{resumed:true});
      }
      if(['/v1/device-provision/chrome','/v1/device-provision/chrome-export'].includes(url.pathname)&&req.method==='POST'){
        if(!provisioner)throw problem('PHONE_PROVISIONING_DISABLED',503);const input=await body(req);const held=store.assertLease(input.lease,{externalOnly:true});if(!held.owner.startsWith('external:'+scope+':'))throw problem('LEASE_NOT_OWNED',403);
        return send(200,await provisioner[url.pathname.endsWith('chrome-export')?'exportChrome':'installChrome'](input.lease));
      }
      if(url.pathname==='/v1/device-login-qr'&&req.method==='POST'){
        if(!gateway)throw problem('DEVICE_GATEWAY_DISABLED',503);const input=await body(req);const held=store.assertLease(input.lease,{externalOnly:true});if(!held.owner.startsWith('external:'+scope+':'))throw problem('LEASE_NOT_OWNED',403);
        gateway.assert(input.lease);const {importLoginQr,removeLoginQr}=require('./login_qr');
        if(input.action==='remove'){await removeLoginQr(gateway,input.lease);loginUploads.delete(input.lease.token);return send(200,{removed:true});}
        loginUploads.set(input.lease.token,input.lease);return send(200,await importLoginQr(gateway,input.lease,input.png_base64));
      }
      if(url.pathname==='/v1/device-resume'&&req.method==='POST'){
        const input=await body(req);if(input.confirmed!==true||!['xiaohongshu','douyin'].includes(input.platform))throw problem('HUMAN_CONFIRMATION_REQUIRED',409);
        const held=store.assertLease(input.lease,{externalOnly:true});if(!held.owner.startsWith('external:'+scope+':'))throw problem('LEASE_NOT_OWNED',403);
        const device=store.devices().find(d=>d.id===input.lease.device_id);if(device.kind!=='android'||device.quarantined)throw problem('DEVICE_RECOVERY_REQUIRED',409);
        store.assertNoCommand(device.id);const faults={...device.faults};delete faults[input.platform];
        store.db.prepare('UPDATE devices SET faults=? WHERE id=?').run(JSON.stringify(faults),device.id);store.event(null,'device.recovered',{device_id:device.id,platform:input.platform,confirmation:'operator'});return send(200,{resumed:true});
      }
      const displayRoute=url.pathname.match(/^\/v1\/displays(?:\/([0-9a-f-]+)(?:\/(frame|stop))?)?$/);
      if(displayRoute){
        if(!displays)throw problem('DISPLAY_DISABLED',503);
        const [,id,action]=displayRoute;
        if(!id&&req.method==='POST'){const input=await body(req);return send(201,displays.open(input.device_id,scope));}
        if(id&&action==='stop'&&req.method==='POST')return send(200,displays.stop(id,scope));
        if(id&&action==='frame'&&req.method==='GET'){const bytes=await displays.frame(id,scope);res.setHeader('Content-Type','image/png');res.writeHead(200);res.end(bytes);return;}
        throw problem('METHOD_NOT_ALLOWED',405);
      }
      if(url.pathname==='/v1/link-utilities'&&req.method==='POST'){
        const input=await body(req);return send(200,await linkUtility(input.operation,input.params,AbortSignal.timeout(65000)));
      }
      if(url.pathname==='/v1/device-utilities'&&req.method==='POST'){
        if(!gateway)throw problem('DEVICE_GATEWAY_DISABLED',503);barrier?.assert();const input=await body(req),lease=input.lease;
        const current=store.assertLease(lease,{externalOnly:true});if(!current.owner.startsWith('external:'+scope+':'))throw problem('LEASE_NOT_OWNED',403);
        if(phoneActions.has(lease.token))throw problem('DEVICE_BUSY',409);
        const controller=new AbortController();const guard=()=>{if(controller.signal.aborted)throw controller.signal.reason;store.assertLease(lease,{externalOnly:true});barrier?.assert();};
        const disconnect=()=>{if(!res.writableEnded)controller.abort(problem('CLIENT_DISCONNECTED',409));};res.once('close',disconnect);
        const timer=setTimeout(()=>controller.abort(problem('UTILITY_TIMEOUT',408)),240000);
        const monitor=setInterval(()=>{try{guard();}catch(e){controller.abort(e);}},250);
        const promise=Promise.resolve().then(()=>phoneUtility({store,gateway,lease,serial:input.serial,operation:input.operation,params:input.params,signal:controller.signal,guard}));
        phoneActions.set(lease.token,{controller,promise});
        try{const result=await promise;guard();if(!res.destroyed)return send(200,result);return;}
        finally{clearTimeout(timer);clearInterval(monitor);res.removeListener('close',disconnect);await gateway.drain(lease);phoneActions.delete(lease.token);}
      }
      const leaseRoute=url.pathname.match(/^\/v1\/device-leases(?:\/(heartbeat|assert|release|command))?$/);
      if(leaseRoute){
        if(req.method!=='POST')throw problem('METHOD_NOT_ALLOWED',405);
        if(leaseRoute[1]==='command'&&!gateway)throw problem('DEVICE_GATEWAY_DISABLED',503);
        barrier?.assert();
        const input=await body(req);
        if(!input||typeof input!=='object'||Array.isArray(input))throw problem('INVALID_REQUEST');
        const action=leaseRoute[1];
        if(!action){
          if(Object.keys(input).some(k=>!['serial','device_id','owner'].includes(k))||(!input.device_id&&(typeof input.serial!=='string'||!/^[-\w.:]+$/.test(input.serial)))||typeof input.owner!=='string'||!/^[-\w.:/]{1,160}$/.test(input.owner))throw problem('INVALID_DEVICE_LEASE');
          let device=store.devices().find(d=>input.device_id?d.id===input.device_id:d.kind==='android'&&d.serial===input.serial);
          if(!device&&inventory){await inventory.refresh();device=store.devices().find(d=>d.kind==='android'&&d.serial===input.serial);}
          if(!device)throw problem('DEVICE_NOT_FOUND',404);
          const lease=store.externalLease(device.id,'external:'+scope+':'+input.owner,{control:device.kind==='web'});
          return send(201,{lease,device:{id:device.id,serial:device.serial,clipboard_port:device.clipboard_port},heartbeat_ms:Math.max(1,Math.floor(store.leaseMs/3))});
        }
        const lease=input.lease;
        if(!lease||typeof lease!=='object'||Array.isArray(lease)||typeof lease.device_id!=='string'||typeof lease.token!=='string'||!Number.isSafeInteger(lease.generation)||lease.generation<1)throw problem('INVALID_DEVICE_LEASE');
        const current=store.assertLease(lease,{externalOnly:true});
        if(!current.owner.startsWith('external:'+scope+':'))throw problem('LEASE_NOT_OWNED',403);
        if(action==='heartbeat')return send(200,{lease:store.heartbeat(lease)});
        if(action==='assert')return send(200,{valid:true,expires:current.expires});
        if(action==='release'){
          await drainPhone(lease);await server.retireDesktopControl?.(lease);await drainDesktop(lease);if(loginUploads.has(lease.token)){await require('./login_qr').removeLoginQr(gateway,lease);loginUploads.delete(lease.token);}if(gateway?.retire)await gateway.retire(lease);else await gateway?.cancel(lease);await gateway?.drain(lease);
          const released=store.releaseExternal(lease);gateway?.forgetReleased?.(lease);return send(200,released);
        }
        if(phoneActions.has(lease.token))throw problem('DEVICE_BUSY',409);
        const controller=new AbortController();
        const disconnect=()=>{if(!res.writableEnded)controller.abort(Object.assign(Error('CLIENT_DISCONNECTED'),{code:'CLIENT_DISCONNECTED'}));};
        res.once('close',disconnect);
        try{
          const result=await gateway.execute(lease,{args:input.args,serial:input.serial},{signal:controller.signal});
          if(!res.destroyed)return send(200,result);
          return;
        }finally{res.removeListener('close',disconnect);}
      }
      const decision=url.pathname.match(/^\/v1\/requests\/([0-9a-f-]+)\/decisions\/([0-9a-f-]+)$/);
      if(decision&&req.method==='POST'){
        store.request(decision[1],scope);const input=await body(req);
        return send(200,store.decide(decision[1],decision[2],input.action,input.capture_share??null));
      }
      const match=url.pathname.match(/^\/v1\/requests\/([0-9a-f-]+)(?:\/(results|events|pause|resume|cancel|retry))?$/);
      if(!match)throw problem('NOT_FOUND',404);
      const [,id,action]=match,r=store.request(id,scope);
      if(req.method==='GET'&&!action)return send(200,r);
      if(req.method==='GET'&&action==='results'){
        const items=store.results(id,cursor(url));return send(200,{items,next_cursor:items.at(-1)?.seq??cursor(url)});
      }
      if(req.method==='GET'&&action==='events'){
        if((req.headers.accept||'').includes('text/event-stream')){
          if(req.headers['last-event-id']&&!url.searchParams.has('after'))url.searchParams.set('after',req.headers['last-event-id']);
          let after=cursor(url);res.setHeader('Content-Type','text/event-stream');res.setHeader('X-Accel-Buffering','no');res.writeHead(200);res.flushHeaders();
          const pump=()=>{
            if(res.destroyed)return;
            if(res.writableLength>1024*1024){res.destroy();return;}
            try{for(const event of store.events(id,after)){res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);after=event.seq;}}
            catch{res.end();}
          };
          const interval=setInterval(pump,250),heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},10000);
          interval.unref();heartbeat.unref();res.on('close',()=>{clearInterval(interval);clearInterval(heartbeat);});pump();return;
        }
        const events=store.events(id,cursor(url));return send(200,{events,next_cursor:events.at(-1)?.seq??cursor(url)});
      }
      if(req.method==='POST'&&['pause','resume','cancel','retry'].includes(action))return send(200,store.transition(id,action));
      throw problem('METHOD_NOT_ALLOWED',405);
    } catch(error) {
      // Never echo exception text, request bodies, access URLs, or credentials.
      if(!res.destroyed&&!res.headersSent)send(error.status||500,{error:{code:error.status?error.code:'INTERNAL_ERROR',scope:'service',...(error.discovery_diagnostics?{diagnostics:error.discovery_diagnostics}:{})}});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.drainDesktop=async()=>{await discovery.close();await Promise.all([...desktopActions.values()].map(async active=>{await active.adapter.close();await active.promise.catch(()=>{});}));};
  return server;
}
module.exports={createServer};
if(require.main===module)require('./main').run();
