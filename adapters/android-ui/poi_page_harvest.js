// The notes on a store's XHS location page (地点), read on the owner's Android
// phone (owner decision 2026-10-10). XHS lists every note tagged at a place on
// that page (tabs 笔记 and 打卡), so a CaseStudy can collect the store's posts
// without search ranking. Verified on the S24 / XHS app 2026-10-10: the page is
// reached from a note tagged at the store (its 地点 row, Chinese UI only); a
// note opened from the page hides its id, so each one is shared and its link
// read through the Parse Links clipboard bridge.
//
//   node core/poi_page_harvest.js --seed <note id> [--max 200] [--since 2026-07-01] [--serial <id>]
//
// Prints one JSON object per line: store, note, skip, done | pause | skipped.
const { AndroidAdb, DevicePause } = require('../douyin-phone/android_adb');
const { readAndroidClipboard } = require('../douyin-phone/android_clipboard');
const { shareUrls, expandLink, noteId } = require('./link_recovery');

const HARVEST_VERSION = 'poi_page_harvest_v1';
const ENGLISH_UI = /^(Follow|Say something|Say something\.\.\.|See original)$/;
const TIME_WORDS = /(天前|小时前|分钟前|刚刚|昨天)/;
const label = (n) => String(n.text || n['content-desc'] || '').trim();
const isId = (n, id) => String(n['resource-id'] || '').endsWith(`/${id}`);

async function swipe(adb) {
  await adb.shell('input', 'swipe', '540', '1500', '540', '800', '350');
  await adb.wait(1200);
}

// The note's 地点 row opens the location page; the row only shows in the Chinese UI.
async function openLocationPage(adb, seed) {
  if (!await adb.openNote(seed)) throw new DevicePause('SEED_UNAVAILABLE', 'The seed note did not open on the phone');
  for (let i = 0; i < 10; i++) {
    const nodes = await adb.ui();
    const row = nodes.find((n) => isId(n, 'subTitle') && n.center && label(n));
    if (row && nodes.some((n) => label(n) === '地点')) {
      await adb.tap(row);
      await adb.wait(4000);
      return label(row);
    }
    if (i === 2 && nodes.some((n) => ENGLISH_UI.test(label(n)))) {
      throw new DevicePause('APP_LANGUAGE', 'Switch the XHS app language to 简体中文: the location row shows only in Chinese');
    }
    await swipe(adb);
  }
  throw new DevicePause('NO_LOCATION', 'The seed note shows no 地点 row (is it tagged at the store?)');
}

const onLocationPage = (nodes) => ['打卡', '笔记'].every((t) => nodes.some((n) => label(n) === t));

async function selectTab(adb, tab) {
  const nodes = await adb.ui();
  const node = nodes.find((n) => label(n) === tab && n.clickable === 'true');
  if (!node) throw new DevicePause('UI_CHANGED', `The location page has no ${tab} tab`);
  await adb.tap(node);
  await adb.wait(2500);
}

// Note cards: 笔记 shows "title, author"; 打卡 shows "来自笔记：title" under a check-in.
function cardsOf(nodes, tab) {
  return nodes.filter((n) => n.clickable === 'true' && n.center && (tab === '笔记'
    ? /.+, .+/.test(label(n)) && !TIME_WORDS.test(label(n)) && !label(n).startsWith('更多')
    : label(n).startsWith('来自笔记'))).map((n) => {
    // a 笔记 card may end with its like count: "title, author, 52"
    const text = label(n).replace(/^来自笔记[：:]/, '').replace(/(, [\d.]+[万wk]?)+$/i, '');
    const comma = text.lastIndexOf(', ');
    return { node: n, key: `${tab}|${text}`, title: tab === '笔记' && comma > 0 ? text.slice(0, comma) : text,
             author: tab === '笔记' && comma > 0 ? text.slice(comma + 2) : '' };
  });
}

// After the clipboard bridge (Chrome), bring XHS back and step back to the page.
async function backToPage(adb, seed, tab) {
  await adb.shell('monkey', '-p', 'com.xingin.xhs', '-c', 'android.intent.category.LAUNCHER', '1');
  await adb.wait(1500);
  for (let i = 0; i < 3; i++) {
    if (onLocationPage(await adb.ui())) return false;
    await adb.shell('input', 'keyevent', '4');
    await adb.wait(1200);
  }
  await openLocationPage(adb, seed);  // lost: reopen; seen cards are skipped by key
  await selectTab(adb, tab);
  return true;
}

async function harvest(adb, { seed, max = 200, since = '', emit = () => {}, clipboard = readAndroidClipboard, expand = expandLink }) {
  const store = await openLocationPage(adb, seed);
  emit({ event: 'store', name: store, version: HARVEST_VERSION });
  const sinceMs = since ? Date.parse(`${since}T00:00:00+08:00`) : 0;
  const seen = new Set(); const ids = new Set(); const notes = []; let opened = 0;
  for (const tab of ['笔记', '打卡']) {
    await selectTab(adb, tab);
    let idle = 0;
    while (opened < max && idle < 3) {
      const card = cardsOf(await adb.ui(), tab).find((c) => !seen.has(c.key));
      if (!card) { idle++; await swipe(adb); continue; }
      idle = 0; seen.add(card.key); opened++;
      await adb.tap(card.node);
      await adb.wait(2500);
      let text = null;
      try { if (await adb.copyShare()) text = await clipboard(adb); } catch (error) { if (error.code !== 'SHARE_REQUIRED') throw error; }
      await backToPage(adb, seed, tab);
      const url = text ? shareUrls(text)[0] : null;
      const link = url ? await expand(url) : '';
      const nid = noteId(link);
      if (!nid) { emit({ event: 'skip', tab, title: card.title, reason: 'NO_LINK' }); continue; }
      if (ids.has(nid)) continue;
      ids.add(nid);
      const published = parseInt(nid.slice(0, 8), 16) * 1000;
      if (sinceMs && published < sinceMs) { emit({ event: 'skip', tab, note_id: nid, reason: 'BEFORE_WINDOW' }); continue; }
      const note = { note_id: nid, link, title: card.title, author: card.author, tab,
                     published_at: new Date(published).toISOString() };
      notes.push(note);
      emit({ event: 'note', ...note });
    }
  }
  emit({ event: 'done', store, notes: notes.length, opened });
  return { store, notes, opened };
}

module.exports = { HARVEST_VERSION, harvest, cardsOf, openLocationPage };
