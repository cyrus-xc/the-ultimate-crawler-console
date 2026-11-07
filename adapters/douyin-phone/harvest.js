// Every post on a Douyin store's 地点内容 list, read on the owner's Android
// phone (owner's flow, 2026-10-11): a video tagged at the store → its location
// line → the 地点内容 sheet (ATELIER玖楼: 127 posts; the POI page's 打卡视频
// strip shows only ~6 of 39). Douyin's keyword search finds a store only in its
// first few results and the PC web has no POI page, so this list is the store's
// own tagged posts. Run by the DouyinCaseStudy collect stage when a phone is
// connected (core/douyin_poi_content.py); no person or assistant drives it.
//
// Open the first location post once. Share → 分享链接 (never a friend, 私信 or
// 转发), deliver through the Parse Links clipboard bridge, then one vertical
// swipe to the next post. Short varied settling waits, no return to the list, no
// swipe from a screen edge (Android's back gesture). A Douyin check on the phone
// stops the harvest and is left on screen for a person.
//
//   node core/douyin_poi_content.js (--video <id|link> | --names '["店名","别名"]') [--max 200] [--since 2026-07-10] [--known-ids ids.json] [--current] [--serial <id>]
//
// Prints one JSON object per line: seed, sheet, post, skip, done | pause | skipped.
const fs = require('node:fs');
const { AndroidAdb, DevicePause, nodesFromXml } = require('./android_adb');
const { readAndroidClipboard } = require('./android_clipboard');

const HARVEST_VERSION = 'douyin_poi_content_v2';
const APP = 'com.ss.android.ugc.aweme';
// 图文 posts share as /share/slides/<id> (run 105: 米米米兰兰兰's post)
const AWEME = /(?:video|note|slides|share\/video|share\/note|share\/slides|aweme\/detail)\/(\d{15,22})(?:\/|$)/;
const LINK_LABELS = ['分享链接', '复制链接'];  // the share sheet also lists friends, 私信 and 转发
const CHECK = /安全验证|完成验证|拖动滑块|滑块|拼图|请完成|captcha|verify/i;
const label = (n) => String(n.text || n['content-desc'] || '').trim();
const desc = (n) => String(n['content-desc'] || '').trim();
const plain = (t) => String(t || '').replace(/[\s·・•.,，。!！?？#@&\-_|｜/\\()（）【】[\]「」"“”'‘’:：;；~～]+/g, '').toLowerCase();
const box = (n) => [n.center[0] - n.width / 2, n.center[1] - n.height / 2, n.center[0] + n.width / 2, n.center[1] + n.height / 2];

function viewport(nodes) {
  const bounded = nodes.filter((n) => n.center && n.width && n.height);
  if (!bounded.length) throw new DevicePause('UI_CHANGED', 'No readable screen bounds');
  const right = Math.max(...bounded.map((n) => box(n)[2]));
  const wide = bounded.filter((n) => n.width >= right * 0.25);
  // Full hierarchy roots name the display edge. Cropped fixtures/list dumps
  // retain symmetric card margins, so infer the missing outer margin there.
  const margin = wide.length ? Math.min(...wide.map((n) => box(n)[0])) : 0;
  return { width: right + margin, height: Math.max(...bounded.map((n) => box(n)[3])) };
}

async function display(adb) {
  if (adb.displaySize) return adb.displaySize;
  const sizes = [...String(await adb.shell('wm', 'size')).matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const size = sizes.at(-1);
  if (!size) throw new DevicePause('DISPLAY_UNREADABLE', 'Android display size could not be read');
  return (adb.displaySize = { width: Number(size[1]), height: Number(size[2]) });
}

// Like a person (owner decisions 2026-10-11).
const rand = (a, b) => a + Math.random() * (b - a);
const human = (adb, min = 180, max = 420) => adb.wait(Math.round(rand(min, max)));
async function touch(adb, node, dy = 0) {
  const [x1, y1, x2, y2] = box(node);
  const x = Math.round(rand(x1 + (x2 - x1) * 0.3, x2 - (x2 - x1) * 0.3));
  const y = Math.round(rand(y1 + (y2 - y1) * 0.3, y2 - (y2 - y1) * 0.3)) + dy;
  await adb.shell('input', 'tap', String(x), String(Math.max(0, y)));
}
async function tapScreen(adb) {
  const { width, height } = await display(adb);
  await adb.shell('input', 'tap', String(Math.round(width * rand(0.40, 0.60))), String(Math.round(height * rand(0.33, 0.42))));
}
async function nextPost(adb, nodes) {
  const { width, height } = viewport(nodes);
  const x = Math.round(width * rand(0.44, 0.54));
  await adb.shell('input', 'swipe', String(x), String(Math.round(height * rand(0.68, 0.72))),
    String(Math.round(x + width * rand(-0.015, 0.015))), String(Math.round(height * rand(0.36, 0.40))),
    String(Math.round(rand(280, 380))));
  await human(adb, 250, 450);
}

async function top(adb) {
  const out = String(await adb.shell('dumpsys', 'activity', 'activities'));
  const m = out.match(/topResumedActivity=.*? ([\w.]+\/[\w.$]+)/);
  return m ? m[1] : '';
}

// A Douyin check stops everything and stays on screen for a person.
function checkFor(nodes, activity = '') {
  if (/verify|captcha/i.test(activity)) return activity;
  const hit = nodes.map(label).find((t) => t.length <= 40 && CHECK.test(t));
  return hit || null;
}

// A fresh dump only: uiautomator leaves the previous file when the screen is
// busy (a playing video), and reading it back showed an old screen.
const DUMP = '/sdcard/douyin-poi-ui.xml';
async function dump(adb) {
  await adb.shell('rm', '-f', DUMP);
  await adb.shell('uiautomator', 'dump', DUMP).catch(() => '');
  const xml = String(await adb.shell('cat', DUMP).catch(() => ''));
  if (!xml.includes('<hierarchy')) throw new Error('UI_BUSY');
  return nodesFromXml(xml);
}

// Reads the screen; a playing video keeps it busy, so the video is paused.
async function screen(adb, { pause = true } = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const activity = await top(adb);
      const activityCheck = checkFor([], activity);
      if (activityCheck) throw new DevicePause('PHONE_CAPTCHA', 'Douyin shows a check on the phone; pass it there, then run collect again');
      const nodes = await dump(adb);
      const hit = checkFor(nodes, activity);
      if (hit) throw new DevicePause('PHONE_CAPTCHA', `Douyin shows a check on the phone (${hit}); pass it there, then run collect again`);
      return nodes;
    } catch (error) {
      if (error.pause) throw error;
      if (pause && i === 0) await tapScreen(adb);
      await human(adb, 180, 350);
    }
  }
  throw new DevicePause('UI_BUSY', 'The phone screen could not be read');
}

// The location line sits just above the author line: 「上海市 | ATELIER玖楼」.
function locationLine(nodes) {
  const author = nodes.find((n) => label(n).startsWith('@') && n.center);
  if (!author) return null;
  // left-hand text only: the like/comment/share counts sit in the right column
  const { width, height } = viewport(nodes);
  return nodes.filter((n) => n.text && n.center && n.center[0] < width * 0.74 && n.center[1] < author.center[1]
    && author.center[1] - n.center[1] < height * 0.08 && !/^[\d.,万wk|]+$/i.test(label(n))
    && !/^[\s·]/.test(label(n)) && !/[市省区]$/.test(label(n))).pop() || null;
}

async function openVideo(adb, id) {
  await adb.shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `snssdk1128://aweme/detail/${id}`, '-p', APP);
  await human(adb, 600, 950);
}

// A CampaignWatch observes only a known author's known post. Do not enter the
// location feed here: that would collect unrelated creators' posts.
async function inspectPost(adb, { videoId, clipboard = readAndroidClipboard, fetchImpl = fetch,
  read = screen, copy = copyLink }) {
  if (!/^\d{15,22}$/.test(String(videoId))) throw new Error('Invalid video id');
  await openVideo(adb, videoId);
  const nodes = await read(adb);
  const line = locationLine(nodes);
  const got = await copy(adb, clipboard, nodes);
  const found = got.text ? await resolve(got.text, fetchImpl).catch(() => null) : null;
  if (!found || found.id !== String(videoId)) {
    throw new DevicePause('PHONE_NOTE_MISMATCH', 'The copied link does not identify the requested post');
  }
  return { note_id: found.id, original: found.link, poi_id: null, poi_name: line ? label(line) : null,
    identity_confirmed: true, author_identity_confirmed: false, source: 'android_known_post',
    observed_at: new Date().toISOString() };
}

// The seed: a given video, or a phone search for the store whose result video
// carries the store's location line (at most 10 tried).
async function seed(adb, { video, names }) {
  const want = (names || []).map(plain).filter((n) => n.length >= 3);
  const matches = (line) => line && (!want.length || want.some((n) => plain(label(line)).includes(n)));
  if (video) {
    await openVideo(adb, video);
    const line = locationLine(await screen(adb));
    if (!matches(line)) throw new DevicePause('NO_LOCATION_LINE', 'The seed video is not tagged at the store');
    return line;
  }
  if (!want.length) throw new DevicePause('SEED_REQUIRED', 'A store name or a video tagged at the store is required');
  await adb.shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `snssdk1128://search?keyword=${encodeURIComponent(names[0])}`, '-p', APP);
  await human(adb, 600, 1000);
  const tab = (await screen(adb, { pause: false })).find((n) => label(n) === '视频');
  if (tab) { await touch(adb, tab); await human(adb, 250, 450); }
  // Only a result whose card writes the store's name is opened, at most 3: an
  // unrelated video is never watched (owner, 2026-10-11).
  const nodes = await screen(adb, { pause: false });
  const { width, height } = viewport(nodes);
  const durations = nodes.filter((n) => /^\d{1,2}:\d{2}$/.test(label(n)) && n.center);
  const named = durations.filter((d) => nodes.some((n) => n.center && Math.abs(n.center[0] - d.center[0]) < width * 0.24
    && n.center[1] > d.center[1] - height * 0.38 && n.center[1] < d.center[1] + height * 0.13 && want.some((w) => plain(label(n)).includes(w))));
  for (const card of named.slice(0, 3)) {
    await touch(adb, card, -height * 0.064);
    await human(adb, 400, 750);
    const line = locationLine(await screen(adb));
    if (matches(line)) return line;
    await adb.shell('input', 'keyevent', '4');
    await human(adb);
  }
  throw new DevicePause('NO_SEED', 'No search result naming the store is tagged at it; add a video link under poi_seed_video');
}

// Sheet cards, found by their author line (always readable; a card's title is
// sometimes blank in the dump). Two columns: the author sits right of its
// avatar, 30-120 px into the column. A card opens from its picture above the
// author line, never from the name (that opens the profile).
function cardsOf(nodes) {
  const { width, height } = viewport(nodes);
  const columns = [[width * 0.042, width * 0.473], [width * 0.527, width * 0.958]];
  const top = height * 0.18;
  const items = nodes.filter((n) => desc(n) && n.center && n.width);
  const out = [];
  for (const author of items) {
    const [ax1, ay1, ax2] = box(author);
    const col = columns.find(([c1, c2]) => ax1 - c1 >= width * 0.027 && ax1 - c1 <= width * 0.112 && ax2 <= c2 + width * 0.011);
    if (!col || author.width >= width * 0.37 || ay1 < top || /^[\d.,万wk]+$/i.test(desc(author))
        || ['返回', '收藏', '点亮门店', '关注', '投稿打卡'].includes(desc(author))) continue;
    const above = items.filter((t) => t.width >= width * 0.277 && box(t)[0] >= col[0] - width * 0.005 && box(t)[2] <= col[1] + width * 0.005
      && ay1 >= box(t)[3] && ay1 - box(t)[3] < height * 0.07);
    const title = above.sort((a, b) => desc(b).length - desc(a).length)[0];
    // Tap the title (as a person does); a blank title: just above the author line.
    const node = title || { center: [Math.round((col[0] + col[1]) / 2), ay1 - height * 0.026], width: width * 0.277, height: height * 0.026 };
    if (box(node)[1] < top) continue;  // still under the header: scroll first
    out.push({ node, title: title ? desc(title) : '', author: desc(author), key: `${desc(author)}|${title ? desc(title) : ''}` });
  }
  return out;
}

function postInfo(nodes) {
  const { width, height } = viewport(nodes);
  const author = nodes.find((n) => label(n).startsWith('@'));
  const caption = nodes.find((n) => /:id\/desc$/.test(n['resource-id'] || ''));
  const body = caption ? label(caption) : nodes.filter((n) => n.text && n.center && author
    && n.center[0] < width * 0.75 && n.center[1] > author.center[1]
    && n.center[1] < author.center[1] + height * 0.11 && !n['content-desc'] && label(n).length > 8).map(label).join('\n');
  return {
    author: author ? label(author).slice(1) : '',
    date: (nodes.map(desc).find((t) => t.startsWith('发布时间')) || '').replace('发布时间：', ''),
    title: body,
    signature: JSON.stringify([author ? label(author) : '', body, nodes.map(desc).find((t) => t.startsWith('发布时间')) || '']),
  };
}

async function dismissCopiedPanel(adb, nodes) {
  const header = nodes.find((n) => /^链接已复制成功|^链接已复制，/.test(label(n)));
  if (!header) return false;
  // The app displays an extra "go paste/share" dialog after Copy link. Match
  // its small close icon beside the header; never tap a social destination.
  const { width, height } = viewport(nodes);
  const close = nodes.find((n) => n.center && n.clickable === 'true' && n.class === 'android.widget.ImageView'
    && n.width <= width * 0.15 && n.height <= height * 0.075 && n.center[0] > box(header)[2]
    && Math.abs(n.center[1] - header.center[1]) < height * 0.04);
  if (!close) throw new DevicePause('SHARE_PANEL_CHANGED', 'The copied-link panel close button was not found');
  await touch(adb, close);
  await human(adb, 100, 200);
  return true;
}

async function copyLink(adb, clipboard, nodes) {
  const share = nodes.find((n) => /^分享/.test(desc(n)));
  if (!share) return { error: 'NO_SHARE' };
  const info = postInfo(nodes);
  await touch(adb, share);
  await human(adb);
  const sharing = await screen(adb, { pause: false });
  const copy = sharing.find((n) => LINK_LABELS.includes(label(n)));
  if (!copy) { await adb.shell('input', 'keyevent', '4'); return { ...info, error: 'NO_LINK_BUTTON' }; }
  // Text labels are not always clickable themselves. Use the smallest
  // clickable container enclosing that exact label, rather than a fixed offset.
  const bounds = box(copy);
  const target = sharing.filter((n) => n.center && n.clickable === 'true'
    && box(n)[0] <= bounds[0] && box(n)[1] <= bounds[1] && box(n)[2] >= bounds[2] && box(n)[3] >= bounds[3])
    .sort((a, b) => a.width * a.height - b.width * b.height)[0] || copy;
  await touch(adb, target);
  await human(adb, 100, 220);
  const copied = await screen(adb, { pause: false });
  if (!await dismissCopiedPanel(adb, copied)) {
    // Do not read the old phone clipboard if a tap was ignored or the UI changed.
    throw new DevicePause('COPY_NOT_CONFIRMED', 'The app did not confirm link copying; retry this post');
  }
  const text = await clipboard(adb);
  await adb.shell('monkey', '-p', APP, '-c', 'android.intent.category.LAUNCHER', '1');  // back from the bridge
  await human(adb, 200, 400);
  return { ...info, text: String(text || '') };
}

async function resolve(text, fetchImpl = fetch) {
  const hosts = new Set(['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com', 'v.douyin.com']);
  const allowed = (value) => {
    try {
      const u = new URL(value);
      return hosts.has(u.hostname) && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.port ? u : null;
    } catch { return null; }
  };
  for (const value of String(text).match(/https?:\/\/[^\s<>"']+/g) || []) {
    const observed = value.replace(/[)）】.,，。]+$/g, '');
    const url = allowed(observed);
    if (!url) continue;
    const direct = url.pathname.match(AWEME);
    if (direct) return { id: direct[1], link: observed };
    if (url.hostname !== 'v.douyin.com') continue;
    const res = await fetchImpl(observed, { redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
    const target = allowed(res.headers.get('location') || '');
    const found = target?.pathname.match(AWEME);
    if (found) return { id: found[1], link: observed };
  }
  return null;
}

// Readiness comes from the actual screen, not a multi-second sleep after each tap.
async function openFeed(adb, { video, names, current }) {
  let line;
  if (current) {
    let nodes = await screen(adb, { pause: false });
    if (await dismissCopiedPanel(adb, nodes)) nodes = await screen(adb);
    line = locationLine(nodes);
    if (line) return { store: label(line), nodes };
    const card = cardsOf(nodes)[0];
    if (!card) throw new DevicePause('NO_LOCATION_FEED', 'Open the store location list or one of its posts');
    await touch(adb, card.node);
    await human(adb, 350, 650);
  } else {
    line = await seed(adb, { video, names });
    await touch(adb, line);
    await human(adb, 350, 650);
    const cards = cardsOf(await screen(adb, { pause: false }));
    if (!cards.length) throw new DevicePause('NO_LOCATION_POST', 'No readable post on the location list');
    await touch(adb, cards[0].node);
    await human(adb, 350, 650);
  }
  const nodes = await screen(adb);
  return { store: line ? label(line) : label(locationLine(nodes)), nodes };
}

async function harvest(adb, { video = '', names = [], max = 200, since = '', knownIds = [], current = false,
  emit = () => {}, clipboard = readAndroidClipboard, fetchImpl = fetch }) {
  if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer');
  let { store, nodes } = await openFeed(adb, { video, names, current });
  const wanted = names.map(plain).filter(Boolean);
  if (!store || (wanted.length && !wanted.some((n) => plain(store).includes(n)))) {
    throw new DevicePause('WRONG_LOCATION', 'The current post is not tagged at the requested store');
  }
  emit({ event: 'seed', location: store });
  emit({ event: 'sheet', store, version: HARVEST_VERSION });
  const sinceMs = since ? Date.parse(`${since}T00:00:00+08:00`) : 0;
  const savedIds = new Set(knownIds.map(String)), ids = new Set(), fingerprints = new Map(), posts = [];
  let opened = 0, lastId = '', stationary = 0;
  while (opened < max) {
    const location = locationLine(nodes);
    if (!location || plain(label(location)) !== plain(store)) {
      throw new DevicePause('LOCATION_FEED_LOST', 'The next post is not tagged at the same store; phone left in place');
    }
    const started = Date.now();
    const info = postInfo(nodes);
    let got, found;
    for (let attempt = 0; attempt < 2; attempt++) {
      got = await copyLink(adb, clipboard, nodes);
      found = got.text ? await resolve(got.text, fetchImpl).catch(() => null) : null;
      if (!found || !fingerprints.has(found.id) || info.signature === fingerprints.get(found.id)) break;
      if (attempt === 0) {
        // Copy can finish with the previous clipboard while this post loads.
        // Re-copy this same post once, with no feed movement or guessed delay.
        emit({ event: 'share_retry', author: info.author, reason: 'STALE_CLIPBOARD' });
        nodes = await screen(adb);
        if (postInfo(nodes).signature !== info.signature) throw new DevicePause('POST_CHANGED', 'Post changed during link delivery');
      }
    }
    if (!found) {
      emit({ event: 'skip', author: info.author, title: info.title, reason: got.error || 'LINK_UNRESOLVED' });
      throw new DevicePause('LINK_UNRESOLVED', 'The current post link was not delivered; phone left on this post to retry');
    }
    if (fingerprints.has(found.id) && fingerprints.get(found.id) !== info.signature) {
      throw new DevicePause('STALE_CLIPBOARD', 'Copied link did not change with the post');
    }
    // A stale clipboard on a visibly changed post is never counted as end-of-feed.
    if (found.id === lastId) {
      if (++stationary >= 2) throw new DevicePause('FEED_STALLED', 'Two swipes did not change the post; check the phone before continuing');
    } else {
      stationary = 0;
      if (ids.has(found.id)) {
        emit({ event: 'done', store, posts: posts.length, opened, reason: 'FEED_CYCLE' });
        return { posts, opened };
      }
      ids.add(found.id); fingerprints.set(found.id, info.signature); opened++;
      const published = Number(BigInt(found.id) >> 32n) * 1000;
      if (sinceMs && published < sinceMs) {
        emit({ event: 'skip', key: found.id, video_id: found.id, author: info.author, reason: 'BEFORE_WINDOW' });
      } else if (!savedIds.has(found.id)) {
        const post = { key: found.id, video_id: found.id, link: found.link, title: info.title, author: info.author,
          date: info.date, published_at: new Date(published).toISOString() };
        posts.push(post);
        emit({ event: 'post', ...post, elapsed_ms: Date.now() - started });
      }
    }
    lastId = found.id;
    // Persist/deliver first. Exactly one swipe, still inside the detail feed.
    if (opened < max) {
      await nextPost(adb, nodes);
      nodes = await screen(adb);
    }
  }
  emit({ event: 'done', store, posts: posts.length, opened, reason: 'MAX_POSTS' });
  return { posts, opened };
}

module.exports = { HARVEST_VERSION, harvest, cardsOf, locationLine, checkFor, resolve, inspectPost };
