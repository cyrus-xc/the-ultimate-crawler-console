'use strict';
// Authorized normal App scanner/gallery login. No internal App calls, no OCR.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {nodesFromXml}=require('../android/android_adb');
const {spawnSync}=require('node:child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const problem=code=>Object.assign(Error(code),{code});
const packages={xiaohongshu:'com.xingin.xhs',douyin:'com.ss.android.ugc.aweme'};
class LoginClient{
 constructor({env=process.env,fetcher=fetch}={}){this.env=env;this.fetcher=fetcher;this.base=env.CRAWLER_SERVICE_URL||'http://127.0.0.1:18323';const u=new URL(this.base);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password)throw problem('INVALID_SERVICE_URL');this.token=fs.readFileSync(env.CRAWLER_SERVICE_TOKEN_FILE,'utf8').trim();this.leases=[];this.lost=null;}
 async call(route,body){const response=await this.fetcher(new URL(route,this.base),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(40000)});const value=await response.json();if(!response.ok)throw problem(/^[A-Z][A-Z0-9_]+$/.test(value.error?.code)?value.error.code:'LOGIN_SERVICE_FAILED');return value;}
 async acquire(device_id){const r=await this.call('/v1/device-leases',{device_id,owner:'phone-web-login:'+randomUUID()});this.leases.push(r.lease);return r.lease;}
 startHeartbeat(){let pending=false;this.timer=setInterval(async()=>{if(pending||this.lost)return;pending=true;try{for(const l of this.leases)await this.call('/v1/device-leases/heartbeat',{lease:l});}catch(e){this.lost=e;}finally{pending=false;}},4000);}
 async command(lease,args){if(this.lost)throw this.lost;return this.call('/v1/device-leases/command',{lease,args});}
 async close(){clearInterval(this.timer);let failed=false;for(const lease of [...this.leases].reverse()){try{await this.call('/v1/device-leases/release',{lease});}catch{failed=true;}}this.leases=[];if(failed)throw problem('LOGIN_LEASE_RELEASE_FAILED');}
}
const label=n=>[n.text,n['content-desc']].filter(Boolean).join(' ');
const bounds=n=>n.center&&n.width>0&&n.height>0;
function findLabel(nodes,labels){for(const s of labels){const node=nodes.find(n=>bounds(n)&&[n.text,n['content-desc']].includes(s));if(node)return node;}return null;}
function scanEntry(nodes){return findLabel(nodes,['扫一扫','扫码','Scan','扫一扫，打开扫一扫','扫一扫按钮']);}
function galleryEntry(nodes){return findLabel(nodes,['相册','从相册选取','从相册选择','从相册选择二维码','选择相册','Album','Photos']);}
function loginConfirmation(nodes){const all=nodes.map(label).join('\n');if(!/登录|Log in|Login/.test(all)||!/电脑|网页|浏览器|设备|Web|Browser|PC/i.test(all))return null;return findLabel(nodes,['确认登录','确认登陆','授权登录','登录','Confirm login','Log in']);}
function ensureNoChallenge(nodes){if(nodes.some(n=>/验证码|安全验证|身份验证|滑动验证|短信验证|Security verification|Verification code/i.test(label(n))))throw problem('VERIFICATION_REQUIRED');}
class PhoneLogin{
 constructor(client,lease,{platform,runtime}={}){this.client=client;this.lease=lease;this.platform=platform;this.runtime=runtime;}
 async tap(node){if(!bounds(node))throw problem('LOGIN_CONTROL_NOT_FOUND');await this.client.command(this.lease,['shell','input','tap',...node.center.map(String)]);await sleep(1500);}
 async ui(){let dumped=false;for(let i=0;i<3;i++){const dump=await this.client.command(this.lease,['shell','uiautomator','dump','/sdcard/handygadgets-ui.xml']);if(/dumped to:/.test(dump.stdout||'')){dumped=true;break;}if(this.platform==='douyin'&&i===0){await this.screenshot();const fallback=this.scannerFallback();if(fallback)return fallback;}await sleep(1000);}if(!dumped){await this.screenshot();const fallback=this.scannerFallback();if(fallback)return fallback;throw problem('UI_DUMP_UNAVAILABLE');}const r=await this.client.command(this.lease,['shell','cat','/sdcard/handygadgets-ui.xml']);const nodes=nodesFromXml(r.stdout||'');fs.writeFileSync(path.join(this.runtime,'phone-ui.xml'),r.stdout||'',{mode:0o600});ensureNoChallenge(nodes);return nodes;}
 scannerFallback(){
  if(this.platform!=='douyin')return null;
  const match=spawnSync(this.client.env.CRAWLER_PYTHON||'python3',[path.join(__dirname,'login_ui_match.py'),path.join(this.runtime,'phone-screen.png'),path.join(__dirname,'../adapters/douyin-web/ui/scanner_album.png')],{encoding:'utf8',timeout:10000});
  let node;try{node=JSON.parse(match.stdout);}catch{}
  return match.status===0&&node?[node,{text:'扫一扫'}]:null;
 }
 async screenshot(){const r=await this.client.command(this.lease,['exec-out','screencap','-p']);fs.writeFileSync(path.join(this.runtime,'phone-screen.png'),Buffer.from(r.stdout_base64||'','base64'),{mode:0o600});}
 async openScanner(){
  await this.client.command(this.lease,['shell','monkey','-p',packages[this.platform],'-c','android.intent.category.LAUNCHER','1']);await sleep(1000);
  for(let attempt=0;attempt<14;attempt++){
   const nodes=await this.ui();const confirm=loginConfirmation(nodes);if(confirm)return;
   if(nodes.some(n=>['全部','所有照片'].includes(n.text))&&nodes.filter(n=>n.clickable==='true'&&['android.widget.ImageView','android.widget.FrameLayout'].includes(n.class)).length>3){await this.client.command(this.lease,['shell','input','keyevent','4']);await sleep(1000);continue;}
   if(galleryEntry(nodes)&&nodes.some(n=>/扫码|扫一扫|二维码|Scan/i.test(label(n))))return nodes;
   // Calibrated from a single frame: XHS 点点 modal close is the top-left LinearLayout.
   const aiClose=this.platform==='xiaohongshu'&&nodes.some(n=>n.text==='点点')&&nodes.find(n=>n.clickable==='true'&&n.class==='android.widget.LinearLayout'&&n.center?.[0]<200&&n.center?.[1]<400);if(aiClose){await this.tap(aiClose);continue;}
   const scan=scanEntry(nodes);if(scan){await this.tap(scan);continue;}
   const homeProfile=nodes.some(n=>n.text==='首页')&&nodes.some(n=>n.text==='发现')&&findLabel(nodes,['我']);if(homeProfile){await this.tap(homeProfile);continue;}
   const menu=findLabel(nodes,['菜单','侧边栏','打开侧边栏','侧边栏按钮','更多','我的','我','More','Me']);if(menu){await this.tap(menu);continue;}
   if(attempt<10){await this.client.command(this.lease,['shell','input','keyevent','4']);await sleep(500);continue;}
   await this.screenshot();throw problem('SCANNER_ENTRY_UNVERIFIED');
  }
  await this.screenshot();throw problem('SCANNER_ENTRY_UNVERIFIED');
 }
 async chooseQR(initial){
  let nodes=initial||await this.ui();let album=galleryEntry(nodes);if(album)await this.tap(album);else if(!nodes.some(n=>['全部','所有照片'].includes(n.text))){await this.screenshot();throw problem('SCANNER_ALBUM_UNVERIFIED');}
  for(let attempt=0;attempt<4;attempt++){
   nodes=await this.ui();const permission=findLabel(nodes,['允许','允许访问所有照片','允许所有','Allow','Allow all']);if(permission){await this.tap(permission);continue;}
   await this.screenshot();
   const candidates=nodes.filter(n=>n.clickable==='true'&&['android.widget.ImageView','android.widget.FrameLayout'].includes(n.class)&&bounds(n)&&n.width>80);
   const regions=candidates.map(n=>[n.center[0]-n.width/2,n.center[1]-n.height/2,n.width,n.height].map(Math.round));
   const match=spawnSync(this.client.env.CRAWLER_PYTHON||'python3',[path.join(__dirname,'login_qr_match.py'),path.join(this.runtime,'phone-screen.png'),path.join(this.runtime,'login-qr.png')],{input:JSON.stringify(regions),encoding:'utf8',timeout:10000});
   const index=Number((match.stdout||'').trim());if(match.status===0&&Number.isInteger(index)&&index>=0&&candidates[index]){await this.tap(candidates[index]);return;}
   // A gallery without a filename must be calibrated from its UI tree/single
   // screenshot. Never blindly select an unrelated personal image.
   await this.screenshot();throw problem('QR_GALLERY_ITEM_UNVERIFIED');
  }
  throw problem('QR_GALLERY_ITEM_UNVERIFIED');
 }
 async confirm(){for(let i=0;i<8;i++){const nodes=await this.ui(),button=loginConfirmation(nodes);if(button){await this.tap(button);return;}await sleep(700);}await this.screenshot();throw problem('LOGIN_CONFIRMATION_UNVERIFIED');}
}
async function run({platform,serial,env=process.env,inspect=false,directQR=false}={}){
 if(!packages[platform]||!/^[-\w.:]+$/.test(serial||''))throw problem('INVALID_LOGIN_TARGET');
 const runtime=path.join(path.resolve(env.CRAWLER_RUNTIME_DIR||'runtime'),'phone-web-login',platform+'-'+Date.now());fs.mkdirSync(runtime,{recursive:true,mode:0o700});const client=new LoginClient({env});let phone;
 try{
  const devices=(await client.call('/v1/devices')).devices;const device=devices.find(d=>d.kind==='android'&&d.serial===serial);if(!device)throw problem('DEVICE_NOT_FOUND');
  const web=await client.acquire(platform==='xiaohongshu'?'web:xhs:default':'web:douyin:default');phone=await client.acquire(device.id);client.startHeartbeat();
  const ui=new PhoneLogin(client,phone,{platform,runtime});
  if(inspect){await ui.ui();await ui.screenshot();return {status:'inspected',runtime};}
  const qr=await client.call('/v1/desktop/qr',{lease:web});if(qr.authenticated){await client.call('/v1/desktop/resume',{lease:web,confirmed:true});return {status:'already_authenticated'};}
  const png=Buffer.from(qr.png_base64||'','base64');if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw problem('LOGIN_QR_INVALID');fs.writeFileSync(path.join(runtime,'login-qr.png'),png,{mode:0o600});
  if(directQR){
   if(platform!=='douyin')throw problem('DIRECT_QR_UNSUPPORTED');
   const decoded=spawnSync(env.CRAWLER_PYTHON||'python3',[path.join(__dirname,'login_qr_url.py'),path.join(runtime,'login-qr.png')],{encoding:'utf8',timeout:10000});
   if(decoded.status!==0||!decoded.stdout)throw problem('LOGIN_QR_DESTINATION_UNVERIFIED');
   await client.command(phone,['shell','am','start','-a','android.intent.action.VIEW','-d',decoded.stdout,'-p',packages[platform]]);await sleep(1500);
  }else{
   await client.call('/v1/device-login-qr',{lease:phone,png_base64:qr.png_base64});
   const scanner=await ui.openScanner();await ui.chooseQR(scanner);
  }
  await ui.confirm();await sleep(1500);await client.call('/v1/desktop/resume',{lease:web,confirmed:true});return {status:'authenticated',platform};
 }catch(e){e.runtime=runtime;throw e;}finally{if(phone)await client.call('/v1/device-login-qr',{lease:phone,action:'remove'}).catch(()=>{});await client.close();}
}
if(require.main===module){const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];run({platform:get('--platform'),serial:get('--serial'),inspect:args.includes('--inspect'),directQR:args.includes('--direct-qr')}).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(e=>{process.stdout.write(JSON.stringify({status:'blocked',code:/^[A-Z][A-Z0-9_]+$/.test(e.code||'')?e.code:'LOGIN_FAILED',...(e.runtime?{runtime:e.runtime}:{})})+'\n');process.exitCode=1;});}
module.exports={LoginClient,PhoneLogin,findLabel,scanEntry,galleryEntry,loginConfirmation,ensureNoChallenge,run};
