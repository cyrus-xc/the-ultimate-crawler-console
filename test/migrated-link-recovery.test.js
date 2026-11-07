const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AndroidAdb, DevicePause, nodesFromXml, LABELS } = require('../adapters/douyin-phone/android_adb');
const { allowedUrl, noteId, profileId, normalizeLinks, initialState, noteAuthor, verifyOnPhone, recoverLink } = require('../adapters/android-ui/link_recovery');
const NOTE = '6a6d801f000000002701f4f0';
const LINK = `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=fixture%3D`;
const available = { adb: () => ({ devices: async () => [{ serial: 'test-device', state: 'device' }] }), launch: async () => ({ close: async () => {} }) };
function manager(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-links-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ParseLinkTasks(dir, { ...available, ...options });
}
test('ADB always selects explicit serial, parses accessibility bounds, and sanitizes failures', async () => {
  const calls = [];
  const adb = new AndroidAdb('device:5555', { execute: async (exe, args) => { calls.push(args); return { stdout: '<node text="复制链接" content-desc="a&amp;b" bounds="[10,20][30,60]" />' }; } });
  const node = (await adb.ui())[0];
  assert.deepEqual(node.center, [20, 40]); assert.equal(node['content-desc'], 'a&b');
  await adb.tap(node); assert.deepEqual(calls[2].slice(0, 2), ['-s', 'device:5555']);
  await assert.rejects(adb.shell('echo', '$(secret)'), /Unsafe/);
  await assert.rejects(new AndroidAdb('device', { execute: async () => { throw new Error(LINK); } }).command(['get-state']), (e) => e.pause && !e.message.includes('xsec_token'));
});
test('phone opens the exact note by id through the app note link, without web page, QR or album', async () => {
  const calls = []; let dumps = 0;
  const adb = new AndroidAdb('fixture-device', { execute: async (_, args) => {
    calls.push(args);
    if (args.includes("'cat'")) return { stdout: dumps++ ? '<node resource-id="com.xingin.xhs:id/moreOperateIV" bounds="[0,0][100,100]" />' : '<node text="loading" />' };
    return { stdout: '' };
  } });
  adb.wait = async () => {};
  assert.equal(await adb.openNote(NOTE), true);
  const start = calls.find((args) => args.includes("'start'"));
  assert.ok(start.includes(`'xhsdiscover://item/${NOTE}'`)); assert.ok(start.includes("'com.xingin.xhs'"));
  assert.equal(calls.some((args) => args.includes('push') || args.some((v) => String(v).includes('Pictures'))), false);
  await assert.rejects(adb.openNote('../x'), /Invalid note id/);
  const gone = new AndroidAdb('fixture-device', { execute: async (_, args) => ({ stdout: args.includes("'cat'") ? '<node text="笔记不存在" />' : '' }) });
  gone.wait = async () => {};
  assert.equal(await gone.openNote(NOTE), false);
});
test('Korean, English and Chinese phone controls are all recognized', async () => {
  for (const label of ['링크 복사', 'Copy link', '复制链接']) {
    const adb = new AndroidAdb('mock-phone'); let copied = false;
    adb.wait = async () => {}; adb.tap = async () => {};
    adb.ui = async () => [{ 'resource-id': 'com.xingin.xhs:id/moreOperateIV', center: [1, 1] }, { text: label, center: [5, 5] }];
    adb.tapLabel = async (labels) => { copied = labels.includes(label); return copied; };
    assert.equal(await adb.copyShare(), true); assert.equal(copied, true);
  }
  for (const label of ['허용', 'Allow', '允许']) assert.ok(LABELS.allow.includes(label));
  const adb = new AndroidAdb('mock-phone', { execute: async () => ({ stdout: '<node text="로그인 후 이용하세요" />' }) });
  await assert.rejects(adb.ui(), (e) => e.code === 'ACCOUNT_REQUIRED');
});
test('one transient adb failure is retried before the batch pauses', async () => {
  let calls = 0;
  const adb = new AndroidAdb('mock-phone', { execute: async () => { if (++calls === 1) throw new Error('busy'); return { stdout: 'ok' }; } });
  adb.wait = async () => {};
  assert.equal(await adb.command(['get-state']), 'ok'); assert.equal(calls, 2);
  const missing = new AndroidAdb('mock-phone', { execute: async () => { calls++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  calls = 0; await assert.rejects(missing.command(['get-state']), (e) => e.code === 'ADB_MISSING'); assert.equal(calls, 1);
});
test('phone clipboard waits for the newly opened Chrome helper rather than failing on its loading screen', async () => {
  const { readAndroidClipboard } = require('../adapters/douyin-phone/android_clipboard');
  let target; let attempts = 0;
  const adb = {
    serial: 'mock-phone', executable: 'mock-adb', execute: async () => ({ stdout: '' }),
    command: async () => '', wait: async () => {},
    shell: async (...args) => { target = args.find(value => String(value).startsWith('http://127.0.0.1:')); return ''; },
    tapLabel: async (labels, options) => {
      if (labels[0] !== '读取分享链接') return false;
      attempts++;
      if (attempts < 3) {
        if (!options?.optional) throw new DevicePause('UI_CHANGED', 'Chrome loading');
        return false;
      }
      await fetch(target, { method: 'POST', body: LINK }); return true;
    },
  };
  assert.equal(await readAndroidClipboard(adb, { port: 0 }), LINK);
  assert.equal(attempts, 3);
});

test('clipboard is read by a foreground user gesture, never by a stale focus/load callback', async () => {
  const { readAndroidClipboard } = require('../adapters/douyin-phone/android_clipboard');
  let target, taps = 0;
  const adb = {
    serial: 'mock-phone', executable: 'mock-adb', execute: async () => ({ stdout: '' }),
    command: async () => '', wait: async () => {},
    shell: async (...args) => {
      target = args.find(value => String(value).startsWith('http://127.0.0.1:'));
      if (target) {
        const html = await (await fetch(target)).text();
        assert.ok(!html.includes('document.hasFocus()'));
        assert.ok(!html.includes("addEventListener('focus'"));
        assert.ok(html.includes("document.querySelector('#read').onclick=read"));
      }
      return '';
    },
    tapLabel: async labels => {
      assert.equal(labels[0], '读取分享链接'); taps++;
      await fetch(target, { method: 'POST', body: LINK }); return true;
    },
  };
  assert.equal(await readAndroidClipboard(adb, { port: 0 }), LINK);
  assert.equal(taps, 1);
});

test('clipboard helper keeps one origin so Chrome remembers its grant, and grants it in the phone language', async () => {
  const { readAndroidClipboard } = require('../adapters/douyin-phone/android_clipboard');
  const origins = []; let granted;
  const probe = require('node:net').createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  for (let run = 0; run < 2; run++) {
    let target; let ready = false;
    const adb = { serial: 'mock-phone', executable: 'mock-adb', execute: async () => ({ stdout: '' }), command: async () => '', wait: async () => {},
      shell: async (...args) => { target = args.find(value => String(value).startsWith('http://127.0.0.1:')); return ''; },
      tapLabel: async (labels) => {
        if (labels[0] === '读取分享链接') { ready = true; return true; }
        if (ready && labels.includes('허용')) { granted = labels; await fetch(target, { method: 'POST', body: LINK }); return true; }
        return false;
      } };
    assert.equal(await readAndroidClipboard(adb, { port }), LINK); origins.push(new URL(target).origin);
  }
  assert.equal(origins[0], origins[1]); assert.equal(origins[0], `http://127.0.0.1:${port}`);
  assert.ok(granted.includes('Allow') && granted.includes('允许'));
});

test('unlabelled XHS note share button uses its real resource ID', async () => {
  const adb = new AndroidAdb('mock-phone'); const node = { 'resource-id': 'com.xingin.xhs:id/moreOperateIV', center: [1324, 258] };
  adb.ui = async () => [node]; adb.wait = async () => {}; let tapped;
  adb.tap = async (value) => { tapped = value; };
  adb.tapLabel = async (labels) => { assert.deepEqual(labels, LABELS.copyLink); return true; };
  assert.equal(await adb.copyShare(), true); assert.equal(tapped, node);
});

test('share capture retries an ignored first tap after the Android note transition', async () => {
  const adb = new AndroidAdb('mock-phone'); const node = { 'resource-id': 'com.xingin.xhs:id/moreOperateIV', center: [1324, 258] };
  let taps = 0;
  adb.ui = async () => [node]; adb.wait = async () => {}; adb.tap = async () => { taps++; };
  adb.tapLabel = async (_labels, options) => {
    if (taps > 1) return true;
    if (options?.optional) return false;
    throw new DevicePause('UI_CHANGED', 'Share panel not open');
  };
  assert.equal(await adb.copyShare(), true); assert.equal(taps, 2);
});

test('mobile share page state is parsed without evaluation and names only the expected note author', async (t) => {
  const page = `<script>window.__INITIAL_STATE__={"global":{"x":undefined,"y":"text with } and undefined"},"noteData":{"data":{"noteData":{"noteId":"${NOTE}","user":{"userId":"5CCEA8610000000016024193","nickName":"豆勒个豆"}}}}}</script>`;
  const state = initialState(page);
  assert.equal(state.global.x, null); assert.equal(state.global.y, 'text with } and undefined');
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push([url, options.headers['User-Agent'], options.redirect]);
    if (url.includes('xhslink')) return new Response(null, { status: 302, headers: { location: LINK } });
    return new Response(page, { status: 200 });
  };
  assert.deepEqual(await noteAuthor('http://xhslink.cn/o/abc', NOTE), { user_id: '5ccea8610000000016024193', nickname: '豆勒个豆' });
  assert.equal(await noteAuthor(LINK, '6a6d801f000000002701f4f1'), null);
  assert.ok(seen.every(([, agent, redirect]) => /iPhone/.test(agent) && redirect === 'manual'));
  global.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/explore/' + NOTE } });
  assert.equal(await noteAuthor(LINK, NOTE), null);
});
test('a profile short link becomes the creator without opening the web or the phone', async () => {
  const touched = [];
  const result = await recoverLink({ input: 'https://xhslink.cn/o/profile' }, {
    verify: async () => { touched.push('web'); return { status: 'failed' }; }, serial: 'mock-phone',
    adbFactory: () => ({ openNote: async () => { touched.push('phone'); } }),
    expand: async () => 'https://www.xiaohongshu.com/user/profile/5bb9872718d7e3000196be15?xsec_token=x',
  });
  assert.deepEqual(result, { status: 'profile', reason: null, author_uid: '5bb9872718d7e3000196be15', author_nickname: null, method: 'profile_link' });
  assert.deepEqual(touched, []);
});

const OTHER = '6a6d801f000000002701f4f1';
const phonePage = (id, extra = {}) => `<script>window.__INITIAL_STATE__=${JSON.stringify({ noteData: { data: { noteData: {
  noteId: id, user: { userId: '5CCEA8610000000016024193', nickName: '豆勒个豆' }, ...extra } } } })}</script>`;
function stubFetch(t, routes) {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url, agent: options.headers['User-Agent'], redirect: options.redirect });
    for (const [match, reply] of routes) if (url.includes(match)) return reply();
    throw new Error('unexpected ' + url);
  };
  return seen;
}
test('the phone share page verifies the exact note anonymously and names its author and location', async (t) => {
  const seen = stubFetch(t, [['xsec_token=ok', () => new Response(phonePage(NOTE, { poi: { poiId: 'B0MRK94UG3', name: '泓0871·普洱山野菜' } }))]]);
  const result = await verifyOnPhone(`https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=ok`, NOTE);
  assert.equal(result.status, 'verified'); assert.equal(result.identity_confirmed, true);
  assert.equal(result.author_uid, '5ccea8610000000016024193'); assert.equal(result.author_nickname, '豆勒个豆');
  assert.equal(result.poi_id, 'B0MRK94UG3');
  assert.ok(seen.every((v) => /iPhone/.test(v.agent) && v.redirect === 'manual'));
});
test('the phone page check keeps expired, login-only, restricted and foreign results apart', async (t) => {
  stubFetch(t, [
    ['token=expired', () => new Response(null, { status: 302, headers: { location: `/404/sec_x?redirectPath=${encodeURIComponent(LINK)}` } })],
    ['/404/', () => new Response('<p>gone</p>')],
    ['token=login', () => new Response(null, { status: 302, headers: { location: '/login?redirectPath=x' } })],
    ['/login', () => new Response('<p>login</p>')],
    ['token=risk', () => new Response(null, { status: 302, headers: { location: '/website-login/error?error_code=300012' } })],
    ['token=other', () => new Response(phonePage(OTHER))],
  ]);
  const at = (token) => verifyOnPhone(`https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=${token}`, NOTE);
  assert.deepEqual(await at('expired'), { status: 'captured', reason: 'WEB_UNAVAILABLE', identity_confirmed: true });
  assert.equal((await at('login')).reason, 'CONTENT_NOT_CONFIRMED');
  assert.equal((await at('risk')).reason, 'WEB_ACCESS_RESTRICTED');
  assert.deepEqual(await at('other'), { status: 'failed', reason: 'NOTE_MISMATCH' });
});
test('recovery skips the phone for a readable input and otherwise opens the note on the phone by id', async () => {
  const valid = await recoverLink({ input: LINK, note_id: NOTE }, { serial: 'mock-phone',
    verify: async () => ({ status: 'verified', reason: null, identity_confirmed: true, author_uid: 'a'.repeat(24) }),
    adbFactory: () => ({ openNote: async () => assert.fail('A readable input needs no phone') }) });
  assert.equal(valid.method, 'already_valid'); assert.equal(valid.share_url, LINK); assert.equal(valid.author_uid, 'a'.repeat(24));
  const share = `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=new`;
  let opened; const phases = [];
  const recovered = await recoverLink({ input: LINK, note_id: NOTE }, { serial: 'mock-phone', progress: (p) => phases.push(p),
    verify: async (url) => url === share ? { status: 'verified', reason: null, identity_confirmed: true, author_uid: 'b'.repeat(24) }
      : { status: 'captured', reason: 'WEB_UNAVAILABLE', identity_confirmed: true },
    adbFactory: () => ({ openNote: async (id) => { opened = id; return true; }, copyShare: async () => true }),
    clipboard: async () => `分享 ${share}` });
  assert.equal(opened, NOTE); assert.equal(recovered.status, 'verified'); assert.equal(recovered.method, 'android_note_link');
  assert.equal(recovered.share_url, share); assert.equal(recovered.author_uid, 'b'.repeat(24));
  assert.deepEqual(phases, ['opening', 'phone', 'sharing', 'verifying']);
  await assert.rejects(recoverLink({ input: LINK, note_id: NOTE }, { serial: 'mock-phone',
    verify: async () => ({ status: 'captured', reason: 'WEB_ACCESS_RESTRICTED' }),
    adbFactory: () => ({ openNote: async () => assert.fail('Restricted network: no phone work') }) }),
  (e) => e.pause && e.code === 'WEB_ACCESS_RESTRICTED');
});
