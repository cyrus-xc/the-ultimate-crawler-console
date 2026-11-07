// Venue discovery is a local phone operation. The location page ID and a
// note's POI ID are different namespaces; only an observed note supplies poi_id.
const { AndroidAdb, DevicePause } = require('../douyin-phone/android_adb');
const { readAndroidClipboard, writeAndroidClipboard } = require('../douyin-phone/android_clipboard');
const { XhsNavigation } = require('../xhs-phone/navigation');
const { shareUrls, expandLink, noteId, verifyOnPhone } = require('./link_recovery');

const label = n => String(n.text || n['content-desc'] || '').trim();
const normalized = value => String(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
const pause = code => { throw new DevicePause(code, code); };

function validate(request) {
  const {platform, serial, venue_name, query = venue_name, aliases = []} = request || {};
  if (platform !== 'xiaohongshu') pause('VENUE_LOOKUP_PLATFORM_UNVERIFIED');
  if (typeof serial !== 'string' || !/^[\w.:-]+$/.test(serial)) pause('DEVICE_REQUIRED');
  if (typeof venue_name !== 'string' || !venue_name.trim() || venue_name.length > 200 ||
      typeof query !== 'string' || !query.trim() || query.length > 256 ||
      !Array.isArray(aliases) || aliases.some(x => typeof x !== 'string' || x.length > 200)) pause('VENUE_QUERY_INVALID');
  return {platform, serial, venue_name: venue_name.trim(), query: query.trim(), aliases: aliases.filter(Boolean)};
}

function candidates(nodes, names) {
  if (nodes.some(n => /无相关搜索结果|No results/.test(label(n)))) return [];
  const wanted = names.map(normalized).filter(Boolean);
  return nodes.filter(n => n.text && n.class === 'android.widget.TextView' &&
    !n['resource-id'] && n.center && n.center[1] > 350 &&
    wanted.some(name => normalized(n.text).includes(name)));
}

function place(nodes, expectedName) {
  const found = nodes.find(n => n.text === expectedName);
  if (!found || !['打卡', '笔记'].every(t => nodes.some(n => label(n) === t))) pause('VENUE_PAGE_UNCONFIRMED');
  const address = nodes.find(n => n.text && /(?:路|街|道|弄|号|广场|商场)/.test(n.text) &&
    n.text !== expectedName && n.center[1] > found.center[1] && n.center[1] < 1000 &&
    !/驾车|分钟|公里|来自笔记/.test(n.text));
  return {name: expectedName, address: address?.text || null};
}

// XHS's location header has unlabeled share SVGs. Select only its rightmost
// square control in the actual header row; never fall back to screen coordinates.
function placeShare(nodes) {
  const width = Math.max(...nodes.map(n => n.center ? n.center[0] + n.width / 2 : 0));
  const controls = nodes.filter(n => n.clickable === 'true' && !label(n) && n.center &&
    n.width >= width * .045 && n.width <= width * .09 && Math.abs(n.width - n.height) < 3 &&
    n.center[0] > width * .74 && n.center[1] > 80 && n.center[1] < 260).sort((a,b) => b.center[0] - a.center[0]);
  if (controls.length < 2 || controls.length > 3) pause('VENUE_SHARE_UI_CHANGED');
  return controls[0];
}

async function lookup(request, {
  adbFactory = serial => new AndroidAdb(serial), worker,
  readClipboard = readAndroidClipboard, writeClipboard = writeAndroidClipboard,
  expand = expandLink, verify = verifyOnPhone, guard = () => {},
  navigationFactory = (adb, options) => new XhsNavigation(adb, options),
} = {}) {
  const cfg = validate(request), adb = adbFactory(cfg.serial);
  const devices = await adb.devices();
  if (!devices.some(d => d.serial === cfg.serial && d.state === 'device')) pause('DEVICE_UNAVAILABLE');
  await worker.acquire(cfg.serial); adb.worker = worker;
  try {
    // Share the response collector's semantic UI navigation. App resource IDs
    // are obfuscated in 9.51; verified text and structural matches remain usable.
    await navigationFactory(adb, {guard, writeClipboard, clipboardPort:worker.clipboardPort}).search(cfg.query);
    let nodes = await adb.ui();
    const tab = nodes.find(n => label(n) === '地点');
    if (!tab) pause('VENUE_SEARCH_TAB_MISSING');
    await adb.tap(tab); await adb.wait(500); nodes = await adb.ui();
    const matches = candidates(nodes,[cfg.venue_name,...cfg.aliases]);
    if (matches.length !== 1) return {status: 'needs_review',reason: matches.length ? 'VENUE_SEARCH_AMBIGUOUS' : 'VENUE_NOT_FOUND',
      candidates: matches.map(n => ({name:n.text})), observed_at:new Date().toISOString()};
    const name = matches[0].text;
    await adb.tap(matches[0]); await adb.wait(500); nodes = await adb.ui();
    const venue = place(nodes,name);
    await adb.tap(placeShare(nodes)); await adb.wait(350); await adb.tapLabel(['复制链接']);
    const share = shareUrls(await readClipboard(adb))[0];
    if (!share) pause('VENUE_SHARE_LINK_MISSING');
    const expanded = await expand(share);
    const pageId = new URL(expanded).pathname.match(/^\/apps\/sns-poi\/detail\/([A-Za-z0-9]{6,64})\/?$/)?.[1];
    if (!pageId) pause('VENUE_SHARE_ID_UNCONFIRMED');
    // Read one actual post from this venue to observe the note-compatible POI ID.
    await adb.shell('monkey','-p','com.xingin.xhs','-c','android.intent.category.LAUNCHER','1');
    nodes = await adb.ui(); place(nodes,name);
    const checkin = nodes.find(n => n.clickable === 'true' && label(n) === '打卡');
    if (checkin) { await adb.tap(checkin); await adb.wait(300); }
    nodes = await adb.ui();
    const source = nodes.find(n => n.clickable === 'true' && /^来自笔记[：:]/.test(label(n)));
    if (!source) return {status:'needs_review',reason:'VENUE_NOTE_POI_UNCONFIRMED',candidate:{...venue,
      platform:cfg.platform,poi_id:null,place_page_id:pageId,share_url:share,observed_at:new Date().toISOString()}};
    await adb.tap(source); await adb.wait(500);
    if (!await adb.copyShare()) pause('VENUE_NOTE_UNAVAILABLE');
    const noteShare = shareUrls(await readClipboard(adb))[0];
    const noteUrl = noteShare && await expand(noteShare);
    const nid = noteUrl && noteId(noteUrl);
    const proof = nid && await verify(noteShare,nid);
    if (!proof || proof.status !== 'verified' || !proof.poi_id || normalized(proof.poi_name) !== normalized(name)) {
      return {status:'needs_review',reason:'VENUE_NOTE_POI_UNCONFIRMED',candidate:{...venue,platform:cfg.platform,
        poi_id:null,place_page_id:pageId,share_url:share,observed_at:new Date().toISOString()}};
    }
    return {status:'observed',candidate:{...venue,platform:cfg.platform,poi_id:String(proof.poi_id),
      place_page_id:pageId,share_url:share,source_note_id:nid,source:'android_venue_search_and_observed_note_poi',
      observed_at:new Date().toISOString()}};
  } finally { await worker.release(); }
}
module.exports = {lookup, validate, candidates, place, placeShare};
