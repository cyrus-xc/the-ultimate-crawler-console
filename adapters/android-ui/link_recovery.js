// Parse Links recovery policy and orchestration, independent of the console.
// Sharing is observed; neither a URL format nor HTTP 200 proves recovery.
//
// android_link_recovery_v9 (2026-10-09): no desktop browser at all. Identity,
// "still readable" and verification all use XHS's sign-in-free mobile share
// page over plain HTTP (iPhone user agent, no cookies, hops on XHS hosts only).
// A desktop anonymous check kept hitting XHS captchas on this network and most
// app-shared links open on PC only after login, so it proved the wrong thing
// and made the owner wait; the phone page is what a WeChat/phone reader sees.
const { AndroidAdb, DevicePause } = require('../douyin-phone/android_adb');
const { readAndroidClipboard } = require('../douyin-phone/android_clipboard');
const RECOVERY_VERSION = 'android_link_recovery_v9';
const HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);
const NOTE = /\/(?:explore|discovery\/item)\/([a-f\d]{24})(?:\/|$)/i;
const PROFILE = /^\/user\/profile\/([a-f\d]{24})(?:\/|$)/i;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// XHS serves a sign-in-free share landing page to phones; it names the note and its author.
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
function allowedUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || ['80', '443'].includes(url.port));
  } catch { return false; }
}
function noteId(value) {
  if (!allowedUrl(value)) return null;
  let current = value;
  // Keep the raw query boundaries before decoding redirectPath. In particular
  // never decode the whole source value and then split its nested query.
  for (let depth = 0; depth < 3; depth++) {
    const url = new URL(current);
    const id = url.pathname.match(NOTE)?.[1];
    if (id) return id.toLowerCase();
    const nested = current.match(/(?:[?&]|%3[Ff]|%26)redirectPath=([^&]*)/)?.[1];
    if (!nested) break;
    try { current = decodeURIComponent(nested); } catch { break; }
    if (!allowedUrl(current)) break;
  }
  return null;
}
function shareUrls(text) {
  return [...String(text).matchAll(/https?:\/\/[^\s<>"'，。]+/g)].map((v) => v[0]).filter(allowedUrl);
}
function normalizeLinks(links) {
  if (!Array.isArray(links) || !links.length || links.length > 500) throw Object.assign(new Error('Provide an array of 1–500 links'), { status: 400 });
  const seen = new Set(); const rows = []; let duplicates = 0;
  links.forEach((input, index) => {
    if (typeof input !== 'string' || input.length > 8192) throw Object.assign(new Error(`Invalid input on line ${index + 1}`), { status: 400 });
    const text = input.trim();
    if (!text) return;
    // A pasted share text ("13 【title】😆 code 😆 https://…") is read for its link.
    const url = allowedUrl(text) ? text : (shareUrls(text)[0] || '');
    const key = url || text;
    if (seen.has(key)) { duplicates++; return; } seen.add(key);
    rows.push({ index: index + 1, input: url || text, ...(url && url !== text ? { source_text: text } : {}), note_id: url ? noteId(url) : null,
      status: url ? 'pending' : 'failed', reason: url ? null : 'INVALID_URL', share_url: null, verified_at: null });
  });
  if (!rows.length) throw Object.assign(new Error('Enter at least one link'), { status: 400 });
  return { rows, duplicates };
}
function profileId(value) {
  if (!allowedUrl(value)) return null;
  return new URL(value).pathname.match(PROFILE)?.[1]?.toLowerCase() || null;
}
// Plain HTTP with manual hops: every hop must stay on an XHS host.
async function follow(url, userAgent, { signal, until } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!allowedUrl(current)) return null;
    if (until?.(current)) return { url: current };
    const response = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': userAgent, Accept: 'text/html' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      current = new URL(location, current).href; continue;
    }
    return { url: current, response };
  }
  return null;
}
async function expandLink(url, { signal } = {}) {
  const found = await follow(url, DESKTOP_UA, { signal, until: (value) => noteId(value) || profileId(value) });
  return found?.url || url;
}
// window.__INITIAL_STATE__ is a JS object literal: copy it out by brace depth,
// turning bare undefined (outside strings) into null. Nothing is evaluated.
function initialState(html) {
  const marker = html.search(/(?:window\.)?__INITIAL_STATE__\s*=\s*\{/);
  if (marker < 0) return null;
  let depth = 0; let inString = false; let escaped = false; let out = '';
  for (let i = html.indexOf('{', marker); i < html.length; i++) {
    const c = html[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (html.startsWith('undefined', i) && !/[\w$]/.test(html[i - 1] || '') && !/[\w$]/.test(html[i + 9] || '')) { out += 'null'; i += 8; continue; }
    out += c;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(out); } catch { return null; } }
  }
  return null;
}
// One phone-page check of a link: does it open, without login, on this exact note?
async function verifyOnPhone(url, expectedId, { signal } = {}) {
  let found;
  // A restriction or captcha page is judged by its address and never opened.
  const walled = (value) => /^\/website-login\/(?:error|captcha)/.test(new URL(value).pathname);
  try { found = await follow(url, PHONE_UA, { signal, until: walled }); }
  catch (error) { if (signal?.aborted) throw signal.reason || error; return { status: 'captured', reason: 'WEB_CHECK_FAILED', identity_confirmed: noteId(url) === expectedId }; }
  if (!found) return { status: 'captured', reason: 'WEB_CHECK_FAILED', identity_confirmed: false };
  const finalUrl = new URL(found.url);
  const urlId = noteId(found.url);
  if (walled(found.url)) {
    const risk = /300012/.test(finalUrl.search) || finalUrl.pathname.endsWith('/error');
    return { status: 'captured', reason: risk ? 'WEB_ACCESS_RESTRICTED' : 'WEB_VERIFICATION_REQUIRED', identity_confirmed: urlId === expectedId };
  }
  if (!found.response) return { status: 'captured', reason: 'WEB_CHECK_FAILED', identity_confirmed: false };
  const note = found.response.ok ? initialState((await found.response.text()).slice(0, 2000000))?.noteData?.data?.noteData : null;
  const pageId = String(note?.noteId || '').toLowerCase();
  if ((pageId && pageId !== expectedId) || (urlId && urlId !== expectedId)) return { status: 'failed', reason: 'NOTE_MISMATCH' };
  if (pageId === expectedId) {
    const user = note.user || {};
    const uid = String(user.userId || '').toLowerCase();
    return { status: 'verified', reason: null, identity_confirmed: true, verified_at: new Date().toISOString(),
      author_uid: /^[a-f0-9]{24}$/.test(uid) ? uid : null, author_nickname: String(user.nickName || user.nickname || '') || null,
      poi_id: note.poi?.poiId || null, poi_name: note.poi?.name || null };
  }
  if (finalUrl.pathname.startsWith('/404')) return { status: 'captured', reason: 'WEB_UNAVAILABLE', identity_confirmed: urlId === expectedId };
  return { status: 'captured', reason: 'CONTENT_NOT_CONFIRMED', identity_confirmed: urlId === expectedId };
}
async function noteAuthor(url, expectedId, options) {
  const result = await verifyOnPhone(url, expectedId, options);
  return result.author_uid ? { user_id: result.author_uid, nickname: result.author_nickname || '' } : null;
}
async function recoverLink(row, { serial, signal, worker, progress = () => {}, adbFactory = (id, options) => new AndroidAdb(id, options), clipboard = readAndroidClipboard, expand = expandLink, verify = verifyOnPhone }) {
  const adb = adbFactory(serial, { signal, worker });
  try {
    progress('opening');
    let expectedId = row.note_id || noteId(row.input);
    if (!expectedId) {
      // A short link proves its target only by its own redirect.
      const expanded = await expand(row.input, { signal }).catch(() => row.input);
      const profile = profileId(expanded);
      if (profile && !noteId(expanded)) return { status: 'profile', reason: null, author_uid: profile, author_nickname: null, method: 'profile_link' };
      expectedId = noteId(expanded);
      if (!expectedId) return { status: 'failed', reason: 'NOTE_ID_UNAVAILABLE' };
    }
    // An input that still opens on a phone without login needs no phone work.
    const current = await verify(row.input, expectedId, { signal });
    if (current.reason === 'WEB_ACCESS_RESTRICTED') throw new DevicePause('WEB_ACCESS_RESTRICTED', 'XHS restricts this network');
    if (current.status === 'verified') return { ...current, note_id: expectedId, share_url: row.input, method: 'already_valid' };
    // Expired or unreadable: the phone opens the note by its id.
    progress('phone');
    if (!await adb.openNote(expectedId)) return { status: 'failed', reason: 'PHONE_NOTE_UNAVAILABLE', note_id: expectedId };
    progress('sharing');
    if (!await adb.copyShare()) return { status: 'failed', reason: 'PHONE_NOTE_UNAVAILABLE', note_id: expectedId };
    const urls = shareUrls(await clipboard(adb));
    if (!urls.length) return { status: 'failed', reason: 'SHARE_LINK_MISSING', note_id: expectedId };
    progress('verifying');
    // Each candidate must prove the expected identity after short-link expansion.
    for (const url of urls) {
      const id = noteId(url);
      if (id && id !== expectedId) continue;
      const result = await verify(url, expectedId, { signal });
      if (result.reason === 'NOTE_MISMATCH') continue;
      // Unexpanded short links cannot be assigned to the target without evidence.
      if (!id && !result.identity_confirmed) continue;
      return { ...result, note_id: expectedId, share_url: url, method: 'android_note_link' };
    }
    return { status: 'failed', reason: 'SHARE_ID_NOT_CONFIRMED', note_id: expectedId };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    if (error instanceof DevicePause || error.pause) throw error;
    return { status: 'failed', reason: 'RECOVERY_FAILED' };
  }
}
module.exports = { RECOVERY_VERSION, allowedUrl, noteId, profileId, normalizeLinks, shareUrls, expandLink, initialState, verifyOnPhone, noteAuthor, recoverLink };
