// The store location page harvest (core/poi_page_harvest.js) on a fake phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { harvest, cardsOf } = require('../adapters/android-ui/poi_page_harvest');
const { nodesFromXml } = require('../adapters/douyin-phone/android_adb');

const node = (attrs) => ({ clickable: 'false', center: [10, 10], ...attrs });
const NOTE_A = '6ac8f5c9000000000a0264c9';
const NOTE_B = '6a9ba8cc000000002900ceed';

test('note cards are read from both tabs, never time rows or menus', () => {
  const nodes = [node({ 'content-desc': '沉浸式吃云南菜, momo（入职版）', clickable: 'true' }),
    node({ 'content-desc': '更多, 5天前, 四川', clickable: 'true' }),
    node({ 'content-desc': '在成都远眺双子塔吃普洱山野菜, 2天前, 四川, 42', clickable: 'true' }),
    node({ 'content-desc': '来自笔记：吃到喜欢的滇菜啦', clickable: 'true' }),
    // run 103: a card can end with its like count, and emoji arrive as &#…; in the dump
    ...nodesFromXml('<node content-desc="被问爆的云南小馆&#127861;, 念一, 52" clickable="true" bounds="[0,0][20,20]" />')];
  assert.deepEqual(cardsOf(nodes, '笔记').map((c) => [c.title, c.author]),
    [['沉浸式吃云南菜', 'momo（入职版）'], ['被问爆的云南小馆\u{1F375}', '念一']]);
  assert.deepEqual(cardsOf(nodes, '打卡').map((c) => c.title), ['吃到喜欢的滇菜啦']);
});

test('every card is opened, shared and kept once; old notes and English UI are handled', async () => {
  const page = [node({ text: '打卡', clickable: 'true' }), node({ text: '笔记', clickable: 'true' }),
    node({ 'content-desc': 'A note, creator A', clickable: 'true' }), node({ 'content-desc': 'B note, creator B', clickable: 'true' }),
    node({ 'content-desc': '来自笔记：A note', clickable: 'true' })];
  const seed = [node({ text: '地点' }), node({ 'resource-id': 'com.xingin.xhs:id/subTitle', text: '成都·泓0871·普洱山野菜' })];
  let screen = seed, tapped = null;
  const adb = {
    openNote: async () => true, wait: async () => {}, ui: async () => screen,
    tap: async (n) => { tapped = n; if (n.text === '成都·泓0871·普洱山野菜') screen = page; },
    shell: async () => '', copyShare: async () => true,
  };
  const links = { 'A note, creator A': NOTE_A, '来自笔记：A note': NOTE_A, 'B note, creator B': NOTE_B };
  const events = [];
  const out = await harvest(adb, {
    seed: '6a62e6e4000000001302c2b7', max: 10, since: '2026-09-10', emit: (e) => events.push(e),
    clipboard: async () => `看看 http://xhslink.com/o/${links[tapped['content-desc']]} 复制`,
    expand: async (url) => `https://www.xiaohongshu.com/discovery/item/${url.split('/').pop()}?xsec_token=t`,
  });
  // NOTE_B was created 2026-09-05 (id time), before the window; NOTE_A appears in both tabs once
  assert.deepEqual(out.notes.map((n) => n.note_id), [NOTE_A]);
  assert.equal(out.opened, 3);
  assert.ok(events.some((e) => e.event === 'skip' && e.reason === 'BEFORE_WINDOW'));

  const english = { ...adb, ui: async () => [node({ text: 'Follow' }), node({ text: 'Say something' })] };
  await assert.rejects(harvest(english, { seed: '6a62e6e4000000001302c2b7' }), (e) => e.code === 'APP_LANGUAGE');
});
