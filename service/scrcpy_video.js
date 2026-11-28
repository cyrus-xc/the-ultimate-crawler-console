'use strict';
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {randomBytes,createHash}=require('node:crypto');
const fs=require('node:fs/promises');
const net=require('node:net');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {problem}=require('./contract');
const VERSION='3.3.3',SHA256='7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0';
// One owned encoder and forward per device. Closing the video socket ends the
// server; the PID fallback is guarded by this invocation's unique classpath.
const quote=text=>"'"+String(text).replace(/'/g,"'\\''")+"'";
// With control the server also accepts a control socket for live touch. Phones
// whose shell user may not inject input (MIUI) run the server as root.
async function startVideo(serial,{adbPath='adb',serverPath=process.env.CRAWLER_SCRCPY_SERVER||path.resolve(__dirname,'../runtime/scrcpy-server-v'+VERSION),signal,control=false,root=false}={}){
 const jar=await fs.readFile(serverPath).catch(()=>{throw problem('DISPLAY_ENCODER_MISSING',503);});
 if(createHash('sha256').update(jar).digest('hex')!==SHA256)throw problem('DISPLAY_ENCODER_INVALID',503);
 const scid=(randomBytes(4).readUInt32BE()&0x7fffffff).toString(16).padStart(8,'0');
 const remote='/data/local/tmp/console-video-'+scid+'.jar';
 const execute=promisify(execFile),adb=(args)=>execute(adbPath,['-s',serial,...args],{timeout:10000,maxBuffer:1024*1024});
 let port,child,socket,controlSocket,pid,closing;
 const close=()=>closing||(closing=(async()=>{
  socket?.destroy();controlSocket?.destroy();
  const guard=pid&&`if [ -r /proc/${pid}/environ ] && tr '\\0' '\\n' < /proc/${pid}/environ | grep -Fxq 'CLASSPATH=${remote}'; then kill ${pid}; fi`;
  if(pid)await adb(['shell',root?'su -c '+quote(guard):guard]).catch(()=>{});
  child?.kill();
  if(port)await adb(['forward','--remove','tcp:'+port]).catch(()=>{});
  await adb(['shell','rm','-f',remote]).catch(()=>{});
 })());
 try{
  signal?.throwIfAborted();await adb(['push',serverPath,remote]);signal?.throwIfAborted();
  port=(await adb(['forward','tcp:0','localabstract:scrcpy_'+scid])).stdout.trim();
  if(!/^\d+$/.test(port))throw Error('invalid forward');
  const server=`echo CONSOLE_PID=$$; CLASSPATH=${remote} exec app_process / com.genymobile.scrcpy.Server ${VERSION} scid=${scid} tunnel_forward=true audio=false control=${control} cleanup=false power_on=false clipboard_autosync=false send_device_meta=false send_dummy_byte=${control} video_codec=h264 max_fps=30 video_bit_rate=4000000 video_codec_options=i-frame-interval=1`;
  child=spawn(adbPath,['-s',serial,'shell',root?'su -c '+quote(server):server],{stdio:['ignore','pipe','pipe']});
  let exited=false,output='';child.on('error',()=>{exited=true;});child.on('exit',()=>{exited=true;socket?.destroy();});
  child.stdout.on('data',chunk=>{output=(output+chunk.toString()).slice(-4096);const m=output.match(/CONSOLE_PID=(\d+)/);if(m)pid=m[1];});child.stderr.resume();
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
   signal?.throwIfAborted();if(exited)throw Error('encoder exited');
   // ADB accepts forward connections before the Android listener is ready.
   // Require the first codec metadata bytes, not just a successful TCP connect.
   socket=net.connect({host:'127.0.0.1',port:Number(port)});socket.on('error',()=>{});
   if(await readable(socket,500)){
    if(!control)return {stream:socket,close};
    // The dummy byte proves the server accepted the video socket; it then
    // accepts the control socket and only then sends codec metadata.
    if(socket.read(1)?.[0]===0){
     controlSocket=net.connect({host:'127.0.0.1',port:Number(port)});controlSocket.on('error',()=>{});
     controlSocket.on('data',()=>{});   // device messages (clipboard) are not used
     if(await readable(socket,5000))return {stream:socket,control:controlSocket,close};
     controlSocket.destroy();
    }
   }
   socket.destroy();await delay(100,undefined,{signal});
  }
  throw Error('encoder timeout');
 }catch(error){await close();if(error.code?.startsWith('DISPLAY_'))throw error;throw problem('DISPLAY_UNAVAILABLE',503);}
}
function readable(socket,ms){
 if(socket.readableLength>0)return Promise.resolve(true);
 return new Promise(resolve=>{const done=ok=>{clearTimeout(timer);socket.removeListener('readable',ready);socket.removeListener('error',failed);socket.removeListener('close',failed);resolve(ok&&socket.readableLength>0);};
  const ready=()=>done(true),failed=()=>done(false);const timer=setTimeout(()=>done(false),ms);socket.once('readable',ready);socket.once('error',failed);socket.once('close',failed);});
}
// scrcpy 3.x INJECT_TOUCH_EVENT for one finger. x/y are pixels of the video
// size the server streams; it drops events made for another size.
const ACTIONS={down:0,up:1,move:2};
function touchMessage(action,x,y,width,height){
 const b=Buffer.alloc(32);
 b.writeUInt8(2,0);b.writeUInt8(ACTIONS[action],1);b.writeBigInt64BE(-2n,2);   // POINTER_ID_GENERIC_FINGER
 b.writeInt32BE(x,10);b.writeInt32BE(y,14);b.writeUInt16BE(width,18);b.writeUInt16BE(height,20);
 b.writeUInt16BE(action==='up'?0:0xffff,22);b.writeUInt32BE(0,24);b.writeUInt32BE(0,28);
 return b;
}
module.exports={startVideo,touchMessage,VERSION,SHA256};
