const test = require('node:test');
const assert = require('node:assert/strict');
const { AndroidAdb } = require('../adapters/douyin-phone/android_adb');
const path = require('node:path');

test('ADB paths resolve against the checkout while command names retain PATH lookup', async () => {
  const root = path.resolve(__dirname, '..');
  for (const [executable, expected] of [['adb', 'adb'], ['adb.exe', 'adb.exe'],
      ['runtime/platform-tools/adb.exe', path.join(root, 'runtime/platform-tools/adb.exe')],
      [path.join(root, 'custom tools/adb.exe'), path.join(root, 'custom tools/adb.exe')]]) {
    let launched;
    const adb = new AndroidAdb('fixture-device', { executable, execute: async bin => { launched = bin; return { stdout: 'device' }; } });
    await adb.command(['get-state']);
    assert.equal(launched, expected);
  }
});

test('connected phone input permission denial pauses distinctly without leaking adb stderr', async () => {
  let calls = 0;
  const adb = new AndroidAdb('authorized-device', { execute: async () => {
    calls++;
    throw Object.assign(new Error('private command'), {
      code: 1,
      stderr: 'java.lang.SecurityException: Injecting to another application requires INJECT_EVENTS permission\n' +
        'https://www.xiaohongshu.com/explore/private?xsec_token=private-token',
    });
  }});
  adb.wait = async () => {};
  await assert.rejects(adb.shell('input', 'keyevent', '4'), error => {
    assert.equal(error.code, 'INPUT_PERMISSION_REQUIRED');
    assert.equal(error.pause, true);
    assert.match(error.message, /USB debugging.*input control/i);
    assert.doesNotMatch(error.message, /private|xsec_token|xiaohongshu|INJECT_EVENTS/);
    return true;
  });
  assert.equal(calls, 1, 'permission denial cannot recover by retrying the same command');
});

test('ordinary transport failure keeps its existing retry and safe device-unavailable pause', async () => {
  let calls = 0;
  const adb = new AndroidAdb('authorized-device', { execute: async () => {
    calls++;
    throw Object.assign(new Error('private command'), { code: 1, stderr: 'device offline' });
  }});
  adb.wait = async () => {};
  await assert.rejects(adb.command(['get-state']), error => error.code === 'DEVICE_UNAVAILABLE');
  assert.equal(calls, 2);
});

test('XHS account-offline dialog pauses before venue navigation instead of reporting changed UI', async () => {
  const calls = [];
  const xml = '<node resource-id="com.xingin.xhs:id/tv_title" text="账号下线提示" />' +
    '<node resource-id="com.xingin.xhs:id/tv_desc" text="账号已退出登录，请尝试重新登录" />' +
    '<node resource-id="com.xingin.xhs:id/mTvExit" text="重新登录" />';
  const adb = new AndroidAdb('authorized-device', { execute: async (_, args) => {
    calls.push(args);
    return { stdout: args.includes("'cat'") ? xml : '' };
  }});
  await assert.rejects(adb.ui(), error => error.code === 'ACCOUNT_REQUIRED' && error.pause);
  assert.equal(calls.length, 2);
  assert.equal(calls.some(args => args.includes("'input'")), false);
});

test('a note mentioning sign-in again alone does not establish an account-offline state', async () => {
  const adb = new AndroidAdb('authorized-device', { execute: async () => ({ stdout: '<node text="重新登录" />' }) });
  assert.equal((await adb.ui()).length, 1);
});

const emptyRoot = '<node text="" resource-id="" class="android.widget.FrameLayout" clickable="false" />';
function uiSequence(snapshots, signal) {
  let reads = 0;
  const adb = new AndroidAdb('authorized-device', { signal, execute: async (_, args) => ({
    stdout: args.includes("'cat'") ? snapshots[Math.min(reads++, snapshots.length - 1)] : '',
  }) });
  return { adb, reads: () => reads };
}

test('UI waits through a transient empty root before exposing the ready share sheet', async () => {
  const {adb, reads} = uiSequence([emptyRoot, '<node text="复制链接" />']);
  let waits = 0; adb.wait = async () => { waits++; };
  assert.equal((await adb.ui())[0].text, '复制链接');
  assert.equal(reads(), 2); assert.equal(waits, 1);
});

test('captured 32-node layout waits for the 59-node accessible share sheet before copying', async () => {
  const fixture = require('./fixtures/android-share-readiness.json');
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const snapshots = fixture.snapshots.map(rows => rows.map(row => '<node ' + fixture.fields.map((key, i) => `${key}="${escape(row[i])}"`).join(' ') + ' />').join(''));
  const {adb, reads} = uiSequence(snapshots);
  let taps = 0; adb.wait = async () => {};
  const tap = adb.tap.bind(adb);
  adb.tap = async node => { await tap(node); assert.ok([node.text, node['content-desc']].includes('复制链接')); taps++; };
  await adb.tapLabel(['复制链接']);
  assert.equal(reads(), 2); assert.equal(taps, 1);
});

test('a meaningful wrong screen pauses Copy without retrying or tapping', async () => {
  const {adb, reads} = uiSequence(['<node text="Search results" />']);
  adb.wait = async () => { assert.fail('Do not retry a meaningful unrelated screen'); };
  await assert.rejects(adb.tapLabel(['复制链接']), error => error.code === 'UI_CHANGED');
  assert.equal(reads(), 1);
});

test('a persistently empty UI pauses after three snapshots without tapping', async () => {
  const {adb, reads} = uiSequence([emptyRoot]);
  let waits = 0; adb.wait = async () => { waits++; };
  await assert.rejects(adb.ui(), error => error.code === 'UI_CHANGED' && error.pause);
  assert.equal(reads(), 3); assert.equal(waits, 2);
});

test('UI readiness keeps abort handling and does not read again after cancellation', async () => {
  const controller = new AbortController();
  const {adb, reads} = uiSequence([emptyRoot], controller.signal);
  const wait = adb.wait.bind(adb), stopped = new Error('Stopped');
  adb.wait = async ms => { controller.abort(stopped); await wait(ms); };
  await assert.rejects(adb.ui(), error => error === stopped);
  assert.equal(reads(), 1);
});

test('a real authentication wall after an empty transition pauses immediately', async () => {
  const {adb, reads} = uiSequence([emptyRoot, '<node text="请先登录" />', '<node text="复制链接" />']);
  let waits = 0; adb.wait = async () => { waits++; };
  await assert.rejects(adb.ui(), error => error.code === 'ACCOUNT_REQUIRED');
  assert.equal(reads(), 2); assert.equal(waits, 1);
});

test('a meaningful wrong screen returns immediately for its caller to classify', async () => {
  const {adb, reads} = uiSequence(['<node resource-id="android:id/content" />']);
  adb.wait = async () => { assert.fail('A valid screen must not be retried'); };
  assert.equal((await adb.ui())[0]['resource-id'], 'android:id/content');
  assert.equal(reads(), 1);
});
