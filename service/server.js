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
function createServer({store,token,scope='pipeline'}) {
  if(typeof token!=='string'||token.length<32)throw problem('SERVICE_TOKEN_REQUIRED',500);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    const send=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/health'&&req.method==='GET')return send(200,{status:'ok',schema_version:VERSION,live_adapters:false});
      if(req.headers.origin)throw problem('DIRECT_BROWSER_ACCESS_DENIED',403);
      if(!authenticated(req,token))throw problem('UNAUTHORIZED',401);
      if(url.pathname==='/v1/capabilities'&&req.method==='GET')return send(200,{operations:OPERATIONS,devices:store.devices().map(d=>({device_id:d.id,capabilities:d.capabilities}))});
      if(url.pathname==='/v1/devices'&&req.method==='GET')return send(200,{devices:store.devices()});
      if(url.pathname==='/v1/queue'&&req.method==='GET')return send(200,{counts:store.db.prepare('SELECT state,count(*) count FROM requests WHERE scope=? GROUP BY state').all(scope)});
      if(url.pathname==='/v1/requests'&&req.method==='POST')return send(202,store.submit(await body(req),scope));
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
      send(error.status||500,{error:{code:error.status?error.code:'INTERNAL_ERROR',scope:'service'}});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
if(require.main===module){
  const root=path.resolve(process.env.CRAWLER_RUNTIME_DIR||'runtime');fs.mkdirSync(root,{recursive:true,mode:0o700});
  const tokenFile=process.env.CRAWLER_SERVICE_TOKEN_FILE;
  if(!tokenFile)throw new Error('CRAWLER_SERVICE_TOKEN_FILE is required');
  const token=fs.readFileSync(tokenFile,'utf8').trim(),store=new Store(path.join(root,'queue.db'));
  const server=createServer({store,token});
  const port=Number(process.env.CRAWLER_PORT||18323);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid CRAWLER_PORT');
  server.listen(port,'127.0.0.1',()=>process.stdout.write(`Crawler backend listening on 127.0.0.1:${port}; live adapters are not enabled\n`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{store.close();process.exit(0);}));
}
module.exports={createServer};
