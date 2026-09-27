import { execFile } from 'node:child_process';
import { log } from '../log.js';

/** bundle id → AppleScript application name, for reading the playing tab. */
const BROWSER_APPS = {
  'com.google.Chrome': 'Google Chrome',
  'com.google.Chrome.canary': 'Google Chrome Canary',
  'com.brave.Browser': 'Brave Browser',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'com.apple.Safari': 'Safari',
  'com.vivaldi.Vivaldi': 'Vivaldi',
  'com.operasoftware.Opera': 'Opera',
  'company.thebrowser.Browser': 'Arc',
};

const YT_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/;
const warned = new Set();

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

function fold(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** JPEG size from the SOF marker, or null. */
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

async function browserTabs(bundleId) {
  const app = BROWSER_APPS[bundleId];
  if (!app) return null;
  const source = `tell application ${JSON.stringify(app)}
set rows to {}
repeat with w in windows
repeat with t in tabs of w
set end of rows to (title of t) & (character id 9) & (URL of t)
end repeat
end repeat
set AppleScript's text item delimiters to linefeed
return rows as text
end tell`;
  try {
    return await run('/usr/bin/osascript', ['-e', source], { timeout: 5000, maxBuffer: 4 << 20 });
  } catch (err) {
    if (!warned.has(bundleId)) {
      warned.add(bundleId);
      log.warn(`[artwork] could not read ${app} tabs (${err.message.trim()})`);
    }
    return null;
  }
}

function matchingUrl(listing, title) {
  const want = fold(title);
  if (!want || !listing) return null;
  let youtube = null;
  let other = null;
  for (const line of listing.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const tabTitle = fold(line.slice(0, tab));
    const url = line.slice(tab + 1).trim();
    if (!tabTitle.includes(want)) continue;
    if (YT_ID.test(url)) youtube = url;
    else if (!other) other = url;
  }
  return youtube || other;
}

async function fetchBytes(url, accept) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { Accept: accept } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
}

async function youtubeImage(url) {
  const id = YT_ID.exec(url)?.[1];
  if (!id) return null;
  for (const name of ['maxresdefault', 'sddefault', 'hqdefault']) {
    const buf = await fetchBytes(`https://i.ytimg.com/vi/${id}/${name}.jpg`, 'image/jpeg').catch(() => null);
    const size = buf && jpegSize(buf);
    if (size && Math.min(size.width, size.height) >= 360) return { buf, width: size.width, height: size.height };
  }
  return null;
}

async function pageImage(url) {
  const html = await fetchBytes(url, 'text/html').catch(() => null);
  if (!html) return null;
  const head = html.subarray(0, 200000).toString('utf8');
  const tag = head.match(/<meta[^>]+property=["']og:image["'][^>]*>/i) || head.match(/<meta[^>]+name=["']twitter:image["'][^>]*>/i);
  const content = tag && tag[0].match(/content=["']([^"']+)["']/i);
  if (!content) return null;
  const imageUrl = new URL(content[1], url).href;
  const buf = await fetchBytes(imageUrl, 'image/*').catch(() => null);
  const size = buf && imageSize(buf);
  if (size && Math.min(size.width, size.height) >= 360) return { buf, width: size.width, height: size.height };
  return null;
}

function imageSize(buf) {
  const jpeg = jpegSize(buf);
  if (jpeg) return jpeg;
  if (buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

/**
 * MediaRemote's browser artwork is often a tiny thumbnail. When the playing tab is visible
 * to AppleScript, prefer that page's larger image (a YouTube thumbnail, or og:image).
 * @returns {Promise<{buf: Buffer, width: number, height: number}|null>}
 */
export async function largerBrowserArt(bundleId, title) {
  const listing = await browserTabs(bundleId);
  const url = matchingUrl(listing, title);
  if (!url) return null;
  return (await youtubeImage(url)) || pageImage(url);
}
