// Reusable Android transport. Every device action uses an explicit serial.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);
class DevicePause extends Error {
  constructor(code, message) { super(message); this.code = code; this.pause = true; }
}
// Phone controls in Chinese, English and Korean (the phone language is the
// owner's, not ours). Each entry is matched exactly against text/content-desc.
const LABELS = {
  copyLink: ['复制链接', 'Copy link', 'Copy Link', '링크 복사', '링크 복사하기'],
  share: ['分享', 'Share', '공유', '更多', 'More', '더보기'],
  allow: ['允许', 'Allow', '허용', '始终允许', 'Always allow', '항상 허용'],
};
const ACCOUNT = /验证码|安全验证|请先登录|登录后|账号(?:已退出登录|下线提示)|Sign in|Log in|Verification code|로그인|보안 인증|인증 코드/i;
const NOTE_GONE = /笔记不存在|笔记已删除|无法浏览|内容不存在|Note (?:not found|unavailable|has been deleted)|content (?:is )?unavailable|게시물을 찾을 수 없|삭제된 게시물|볼 수 없는 게시물/i;
const NOTE_ID = /^[a-f0-9]{24}$/;
function decode(value) {
  // uiautomator writes emoji as numeric references (&#127861;), decoded before &amp;
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function nodesFromXml(xml) {
  return [...xml.matchAll(/<node\b([^>]+)>/g)].map((match) => {
    const node = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]));
    const bounds = (node.bounds || '').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (bounds) {
      node.center = [(+bounds[1] + +bounds[3]) >> 1, (+bounds[2] + +bounds[4]) >> 1];
      node.width = +bounds[3] - +bounds[1]; node.height = +bounds[4] - +bounds[2];
    }
    return node;
  });
}
class AndroidAdb {
  constructor(serial, { executable = process.env.ADB_PATH || 'adb', execute = run, signal } = {}) {
    if (serial && !/^[\w.:-]+$/.test(serial)) throw new Error('Invalid device serial');
    if (/[\\/]/.test(executable)) executable = path.resolve(__dirname, '..', executable);
    this.serial = serial; this.executable = executable; this.execute = execute; this.signal = signal;
  }
  async command(args, { device = true } = {}) {
    if (device && !this.serial) throw new DevicePause('DEVICE_REQUIRED', 'Select an Android device');
    // One transient adb failure (busy uiautomator, USB hiccup) is retried once
    // before the whole batch pauses; a missing adb is never retried.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.execute(this.executable, [...(device ? ['-s', this.serial] : []), ...args], {
          timeout: 15000, maxBuffer: 2 * 1024 * 1024, signal: this.signal, windowsHide: true,
        });
        return String(result.stdout || '');
      } catch (error) {
        if (this.signal?.aborted) throw this.signal.reason || error;
        if (['LEASE_LOST', 'DEVICE_CONTROL_LOST'].includes(error.code)) throw error;
        // An authorized USB connection can still lack Android's input-control
        // permission (for example MIUI's separate USB debugging security option).
        // Reconnecting or retrying cannot grant it; keep stderr private.
        if (/SecurityException:[^\r\n]*requires INJECT_EVENTS permission/.test(String(error.stderr || ''))) {
          throw new DevicePause('INPUT_PERMISSION_REQUIRED',
            'Allow USB debugging input control in the phone Developer options, then retry');
        }
        if (error.code !== 'ENOENT' && attempt === 0) { await this.wait(1000); continue; }
        // Never forward adb stderr: it can contain share URLs or clipboard data.
        throw new DevicePause(error.code === 'ENOENT' ? 'ADB_MISSING' : 'DEVICE_UNAVAILABLE',
          error.code === 'ENOENT' ? 'Install Android platform-tools or set ADB_PATH' : 'Unlock and reconnect the authorized Android device');
      }
    }
  }
  async devices() {
    const output = await this.command(['devices', '-l'], { device: false });
    return output.split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter((v) => v.length >= 2)
      .map(([serial, state, ...details]) => ({ serial, state, model: details.find((v) => v.startsWith('model:'))?.slice(6) || serial }));
  }
  async shell(...args) {
    // adb shell reparses arguments remotely. Restrict each argument rather than
    // trusting execFile to protect the remote shell too.
    if (args.some((arg) => !/^[\w/.:%?=&+@,-]+$/.test(String(arg)))) throw new Error('Unsafe Android shell argument');
    return this.command(['shell', ...args.map((arg) => `'${String(arg)}'`)]);
  }
  async ui() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.shell('uiautomator', 'dump', '/sdcard/handygadgets-ui.xml');
      const xml = await this.shell('cat', '/sdcard/handygadgets-ui.xml');
      const nodes = nodesFromXml(xml);
      if (nodes.some((n) => ACCOUNT.test(n.text || ''))) {
        throw new DevicePause('ACCOUNT_REQUIRED', 'Complete login or verification on the phone, then continue');
      }
      // A transition may expose many layout wrappers, including resource IDs
      // and a generic whole-page description, before actual controls arrive.
      // Wrapper metadata alone is not ready; meaningful wrong screens still
      // return immediately for the caller's expected-control check.
      if (nodes.some(n => n.text || n.clickable === 'true'
          || (!/(?:Layout|ViewGroup|ScrollView|ViewPager|WebView)$/.test(n.class || '')
              && (n['content-desc'] || n['resource-id'] || n.focusable === 'true')))) return nodes;
      if (attempt < 2) await this.wait(350);
    }
    throw new DevicePause('UI_CHANGED', 'The phone interface did not finish loading; try again');
  }
  async tap(node) {
    if (!node?.center) throw new DevicePause('UI_CHANGED', 'The expected phone control was not found');
    await this.shell('input', 'tap', ...node.center);
  }
  async tapLabel(labels, { optional = false } = {}) {
    const nodes = await this.ui();
    const node = nodes.find((n) => labels.some((label) => [n.text, n['content-desc']].includes(label)) && n.center);
    if (!node && optional) return false;
    await this.tap(node); return true;
  }
  async wait(ms = 700) {
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(this.signal.reason || new Error('Stopped')); };
      const timer = setTimeout(() => { this.signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      if (this.signal?.aborted) return onAbort();
      this.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  async openNote(noteId) {
    if (!NOTE_ID.test(String(noteId))) throw new Error('Invalid note id');
    // The app's own note address opens the exact note by id: no web page, QR,
    // album or scanner (verified on Android 16 / XHS 9.48, 2026-10-09).
    const result = await this.shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `xhsdiscover://item/${noteId}`, '-p', 'com.xingin.xhs');
    if (/Error:|unable to resolve/i.test(result)) return false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.wait(800);
      const nodes = await this.ui();
      if (nodes.some(n => NOTE_GONE.test(n.text || ''))) return false;
      if (nodes.some(n => n['resource-id'] === 'com.xingin.xhs:id/moreOperateIV')) return true;
    }
    return false;
  }
  async copyShare() {
    const nodes = await this.ui();
    if (nodes.some((n) => NOTE_GONE.test(n.text || ''))) {
      return null;
    }
    const share = nodes.find(n => n['resource-id'] === 'com.xingin.xhs:id/moreOperateIV');
    if (share) await this.tap(share);
    else await this.tapLabel(LABELS.share);
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.wait(700);
      if (await this.tapLabel(LABELS.copyLink, { optional: true })) { await this.wait(); return true; }
      if (attempt === 1) {
        const retry = (await this.ui()).find(n => n['resource-id'] === 'com.xingin.xhs:id/moreOperateIV');
        if (retry) await this.tap(retry);
      }
    }
    throw new DevicePause('SHARE_REQUIRED', 'The note share panel did not open; check the phone and continue');
  }
}
module.exports = { AndroidAdb, DevicePause, nodesFromXml, LABELS };
