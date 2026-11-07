// Foreground Android Chrome clipboard bridge. No desktop clipboard access.
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { DevicePause, LABELS } = require('./android_adb');
// A fixed origin lets Chrome remember the clipboard permission after its first
// grant; a random port was a new site for every note and asked every time.
const HELPER_PORT = Number(process.env.PARSE_LINKS_CLIPBOARD_PORT || 38617);
async function readAndroidClipboard(adb, { port = adb.clipboardPort || HELPER_PORT, writeText = null } = {}) {
  const writing = writeText !== null;
  if (writing && (typeof writeText !== 'string' || !writeText || writeText.length > 8192)) throw new Error('Provide 1–8192 characters');
  const buttonLabel = writing ? '写入搜索文字' : '读取分享链接';
  const safeText = writing ? JSON.stringify(writeText).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') : 'null';
  const token = randomBytes(24).toString('hex');
  let text;
  const server = http.createServer((req, res) => {
    if (req.url !== `/${token}` || !['GET', 'POST'].includes(req.method)) { res.writeHead(404).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 32768) req.destroy(); });
      req.on('end', () => { text = body; res.end('OK'); }); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>HandyGadgets</title>
      <style>body{font:20px sans-serif;padding:24px}textarea,button{width:100%;font:20px sans-serif;margin:16px 0;padding:16px}</style>
      <p>HandyGadgets · 手机剪贴板</p><button id="read">${buttonLabel}</button>
      <textarea aria-label="分享链接" placeholder="也可粘贴分享链接"></textarea><p id="status"></p>
      <script>const input=document.querySelector('textarea');const save=async value=>{if(value){await fetch(location.pathname,{method:'POST',body:value});document.querySelector('#status').textContent='已取得分享链接';}};
      const read=async()=>{try{${writing ? `await navigator.clipboard.writeText(${safeText});await save('written');` : 'await save(await navigator.clipboard.readText());'}}catch{input.focus();}};
      input.addEventListener('input',()=>save(input.value));document.querySelector('#read').onclick=read;
      </script>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(error.code === 'EADDRINUSE'
      ? new DevicePause('CLIPBOARD_PORT_BUSY', `Local port ${port} is in use; free it or set PARSE_LINKS_CLIPBOARD_PORT`) : error));
    server.listen(port, '127.0.0.1', resolve);
  });
  port = server.address().port;
  try {
    await adb.command(['reverse', `tcp:${port}`, `tcp:${port}`]);
    await adb.shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://127.0.0.1:${port}/${token}`, '-p', 'com.android.chrome');
    // Chrome can return its previous foreground clipboard on an automatic
    // focus/load read. A real button gesture reads the current Android clipboard.
    let ready = false;
    for (let attempt = 0; attempt < 8 && !ready; attempt++) {
      await adb.wait(500);
      ready = await adb.tapLabel([buttonLabel], { optional: true });
    }
    if (!ready) throw new DevicePause('CLIPBOARD_REQUIRED', 'Wait for the Android Chrome helper to load, then continue');
    for (let attempt = 0; attempt < 10 && !text; attempt++) {
      await adb.wait(500);
      if (text) break;
      // Chrome asks in the phone's language; grant it without the owner.
      if (attempt <= 2) await adb.tapLabel(LABELS.allow, { optional: true });
      if (!writing && attempt === 3) {
        const node = (await adb.ui()).find((n) => n['content-desc'] === '分享链接' || (n.class === 'android.widget.EditText' && !/url_bar|search_box/.test(n['resource-id'] || '')));
        if (node) { await adb.tap(node); await adb.shell('input', 'keyevent', '279'); }
      }
    }
    if (!text) throw new DevicePause('CLIPBOARD_REQUIRED', 'Allow clipboard access in Android Chrome and retry this item');
    return text;
  } finally {
    const cleanup = new (require('./android_adb').AndroidAdb)(adb.serial, { executable: adb.executable, execute: adb.execute, worker: adb.worker, queueClient: adb.queueClient });
    await cleanup.command(['reverse', '--remove', `tcp:${port}`]).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}
async function writeAndroidClipboard(adb, text, options = {}) {
  await readAndroidClipboard(adb, { ...options, writeText: text });
}
module.exports = { readAndroidClipboard, writeAndroidClipboard };
