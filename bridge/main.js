#!/usr/bin/env node
// Car Thing bridge: macOS Now Playing, volume, weather and calendar ⇄ the Car Thing's screen,
// knob and buttons. Also serves the Mac-side settings page.
//   npm start          run the bridge
//   npm run dev        …and redeploy the device UI whenever ui/ changes

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Volume } from './audio/volume.js';
import { config, paths } from './config.js';
import { listCarThings, listDevices, onUsbBus, restartServer, trackDevices } from './device/adb.js';
import { listTargets } from './device/cdp.js';
import { DeviceLink } from './device/link.js';
import { log } from './log.js';
import { AppInfo, kindOf } from './nowplaying/apps.js';
import { ArtworkCache } from './nowplaying/artwork.js';
import { largerBrowserArt } from './nowplaying/browser-art.js';
import { MediaRemoteSource } from './nowplaying/mediaremote.js';
import { MacAppearance } from './mac/appearance.js';
import { MacHelper } from './mac/helper.js';
import { MacPower } from './mac/power.js';
import { settings } from './settings.js';
import { startSettingsPage } from './settings-page/server.js';
import { Calendar } from './widgets/calendar.js';
import { Weather } from './widgets/weather.js';

const source = new MediaRemoteSource(paths.bin);
const volume = new Volume(paths.bin);
const apps = new AppInfo(paths.bin);
const artwork = new ArtworkCache();
const helper = new MacHelper(paths.bin);
const weather = new Weather(helper, settings);
const calendar = new Calendar(helper, settings);
const appearance = new MacAppearance();
const power = new MacPower(paths.bin);

/** @type {DeviceLink|null} */
let link = null;
let connecting = false;

// ---- Now Playing ----------------------------------------------------------

// Latest snapshot with its artwork and app info resolved (both async, both cached).
let current = { np: source.snapshot, art: null, app: null };
let resolveSeq = 0;
let lastLogged = '';

async function onNowPlaying(snapshot) {
  const seq = ++resolveSeq;
  const [art, app] = await Promise.all([
    snapshot.artwork ? artwork.get(snapshot.artwork) : null,
    snapshot.bundleId ? apps.get(snapshot.bundleId) : null,
  ]);
  if (seq !== resolveSeq) return; // superseded by a newer update
  current = { np: snapshot, art, app };

  const summary = snapshot.active
    ? `${snapshot.playing ? '▶' : '❚❚'} ${snapshot.artist || '—'} · ${snapshot.title} [${app?.name || snapshot.bundleId}]`
    : 'nothing playing';
  if (summary !== lastLogged) log.info(`[now playing] ${(lastLogged = summary)}`);

  if (link) pushNowPlaying(link);
  if (!art || !snapshot.artwork || Math.min(art.width || 0, art.height || 0) >= 360) return;
  const bigger = await largerBrowserArt(snapshot.bundleId, snapshot.title);
  if (seq !== resolveSeq || !bigger) return;
  const mime = bigger.buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const hi = await artwork.get({ key: `${snapshot.artwork.key}:hi`, mime, base64: bigger.buf.toString('base64') });
  if (seq !== resolveSeq || !hi || Math.min(hi.width || 0, hi.height || 0) < 360) return;
  current = { np: snapshot, art: hi, app };
  log.info(`[artwork] ${hi.width}×${hi.height} from the playing tab`);
  if (link) pushNowPlaying(link);
}

function nowPlayingMessage() {
  const { np, art, app } = current;
  if (!np.active) return { type: 'nowPlaying', np: { active: false } };

  let elapsed = null;
  if (np.elapsed != null) {
    elapsed = np.elapsed + ((Date.now() - np.elapsedAt) / 1000) * np.rate;
    if (np.duration) elapsed = Math.min(elapsed, np.duration);
    elapsed = Math.max(0, elapsed);
  }
  return {
    type: 'nowPlaying',
    np: {
      active: true,
      playing: np.playing,
      title: np.title,
      artist: np.artist,
      album: np.album,
      duration: np.duration,
      elapsed,
      rate: np.rate,
      kind: kindOf(np.bundleId),
      source: {
        bundleId: np.bundleId,
        name: app?.name || '',
        icon: config.unbadgedApps.includes(np.bundleId) ? null : app?.icon || null,
      },
      artworkKey: art?.key || null,
    },
  };
}

function pushNowPlaying(target) {
  const { art } = current;
  if (art && target.sentArtKey !== art.key) {
    target.send({ type: 'artwork', key: art.key, dataUrl: art.dataUrl, width: art.width, height: art.height });
    target.sentArtKey = art.key;
  }
  target.send(nowPlayingMessage());
}

const tickMessage = () => ({ type: 'tick', now: Date.now(), tzMinutes: -new Date().getTimezoneOffset() });

function pushAll(target) {
  target.sentArtKey = null; // page (re)loaded: it has no artwork cached
  target.send({
    type: 'config',
    config: {
      buttons: config.buttons,
      knobClicks: config.knobClicks,
      buttonClicks: config.buttonClicks,
      multiClickMs: config.multiClickMs,
      buttonHolds: config.buttonHolds,
      holdMs: config.holdMs,
      offlineSleepMs: config.deviceSleepSeconds * 1000,
      screenWakeMs: config.screenWakeMs,
      volumeStep: config.volumeStep,
      knobDirection: config.knobDirection,
      debug: Boolean(process.env.DEBUG), // page reports raw key/wheel events to the log
    },
  });
  target.send(tickMessage());
  target.send({ type: 'settings', settings: settings.get() });
  target.send({ type: 'appearance', dark: appearance.dark });
  if (volume.state) target.send({ type: 'volume', volume: volume.state });
  pushNowPlaying(target);
  target.send({ type: 'weather', weather: weather.state });
  target.send({ type: 'calendar', calendar: calendar.state });
  target.send({ type: 'screen', on: screenOn !== false }); // the page may have gone dark by itself
  target.send({ type: 'display', asleep: config.sleepWithMac && power.displayAsleep });
}

// ---- Screen sleep ---------------------------------------------------------

let manualSleep = false; // held down the sleep button; any input clears it
let screenOn = null; // unknown until applied to the current device link

// Holding the sleep button, or the Mac lock screen, turns the panel off. Display sleep leaves it
// lit: the page switches to the screensaver and dims the backlight itself.
function screenShouldBeOn() {
  if (manualSleep) return false;
  if (config.sleepWithMac && power.locked) return false;
  return true;
}

async function applyScreen() {
  const on = screenShouldBeOn();
  if (!link || on === screenOn) return;
  screenOn = on;
  log.info(`[screen] ${on ? 'on' : 'off'}`);
  await link.setScreen(on).catch((err) => {
    screenOn = null;
    log.warn('[screen]', err.message);
  });
  heartbeat(); // tell the device's watchdog what the screen is doing now, not in ten seconds
}

// The Mac says "still here" every few seconds. When it stops — the Mac was shut down, or the
// cable now only carries power — the device puts itself to sleep. See device/sleepd.sh.
function heartbeat() {
  link?.heartbeat(screenOn !== false).catch((err) => log.debug('[heartbeat]', err.message));
}

async function macStatus() {
  const s = await helper.status().catch(() => ({}));
  // The list is for the settings page's calendar checkboxes; it's empty until access is granted.
  const cals = await helper.calendars().catch(() => ({}));
  return {
    location: { status: s.location || 'unknown', name: weather.auto?.name || null },
    calendar: { status: s.calendar || 'unknown', list: cals.ok ? cals.calendars : [] },
  };
}

function openSettingsPage(section) {
  const hash = /^[a-z]+$/.test(section || '') ? `#${section}` : '';
  execFile('/usr/bin/open', [`http://127.0.0.1:${config.settingsPort}/${hash}`]);
}

// ---- Input from the device ------------------------------------------------

/** Apple Music actions via native/bin/musicctl (macOS asks once to let "musicctl" control Music). */
function musicctl(command) {
  return new Promise((resolve) =>
    // Long timeout: the first run waits on the Automation permission prompt.
    execFile(path.join(paths.bin, 'musicctl'), [command], { timeout: 60000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: err?.message || 'musicctl failed' });
      }
    }),
  );
}

async function runCommand(action) {
  log.info(`[input] ${action}`);
  if (action === 'favorite' || action === 'unfavorite') return setFavorite(action);
  try {
    if (!current.np.active && (action === 'playpause' || action === 'play')) {
      const r = await musicctl('play'); // nothing playing: start Apple Music
      if (!r.ok) log.warn('[input] starting Music failed:', r.error);
    } else {
      await source.command(action);
    }
  } catch (err) {
    log.warn(`[input] ${action} failed:`, err.message);
  }
}

async function setFavorite(command) {
  const { np } = current;
  if (np.active && !np.playing) return; // paused: the back button does nothing
  if (np.bundleId !== 'com.apple.Music') {
    return link?.send({ type: 'toast', text: np.active ? 'Favorites work with Apple Music' : 'Nothing playing' });
  }
  const r = await musicctl(command);
  if (r.ok) {
    log.info(`[favorite] ${np.title}: ${r.favorited ? 'added' : 'removed'}`);
    link?.send({ type: 'favorite', favorited: r.favorited });
  } else {
    log.warn('[favorite]', r.error);
    // -1743: the user said no to "musicctl wants to control Music".
    link?.send({ type: 'toast', text: r.code === -1743 ? 'Allow musicctl to control Music' : 'Couldn’t favorite this song' });
  }
}

function changeVolume(delta) {
  if (!Number.isFinite(delta) || delta === 0) return;
  if (config.macVolumeIndicator && volume.state?.keys) {
    const steps = Math.round(Math.abs(delta) / config.volumeStep);
    for (let i = 0; i < steps; i++) volume.pressKey(delta > 0);
  } else {
    volume.delta(delta);
  }
}

let askedForKeyAccess = false;
function checkKeyAccess(state) {
  if (!config.macVolumeIndicator || state.keys || askedForKeyAccess) return;
  askedForKeyAccess = true;
  log.warn(
    '[volume] to show the macOS volume indicator, allow "volumectl" in System Settings → ' +
      'Privacy & Security → Accessibility, then restart the bridge. Until then the knob sets the volume silently.',
  );
  volume.requestKeyAccess();
}

function onDeviceMessage(msg) {
  if (msg.type === 'command' || msg.type === 'volume' || msg.type === 'wake') {
    manualSleep = false;
    applyScreen();
  }
  switch (msg.type) {
    case 'sleep':
      log.info('[screen] sleep requested from the device');
      manualSleep = true;
      return applyScreen();
    case 'command':
      return runCommand(msg.action);
    case 'volume':
      return changeVolume(Number(msg.delta));
    case 'setting':
      return settings.update({ [msg.key]: msg.value });
    case 'openSettingsPage':
      return openSettingsPage(msg.section);
    case 'retryWeather':
      return retryWeather(msg.quiet);
    case 'log':
      return log.info('[device]', msg.message);
    case 'brightness':
      return link?.setBrightness(msg.level)?.catch((err) => log.warn('[screen]', err.message));
  }
}

/** The weather button on an unavailable forecast: try again, or say how long until it can. */
async function retryWeather(quiet) {
  const r = await weather.retry();
  if (typeof r === 'number' && !quiet) link?.send({ type: 'toast', text: `Try again in ${r}s` });
}

// ---- Device lifecycle -----------------------------------------------------

// After the Mac sleeps, adb's server can keep an empty device list while the Car Thing is sitting
// on the USB bus perfectly happy — `ioreg -p IOUSB` shows it, `adb devices` doesn't, and no
// track-devices event ever arrives to say otherwise. Restarting the server fixes it at once, so
// treat a device-shaped silence as a stale server rather than an absent device.
let lastSeen = Date.now();
let lastServerRestart = 0;
let usbHinted = false;

async function refreshDevices() {
  let all;
  try {
    all = await listDevices();
  } catch (err) {
    return log.warn('[adb]', err.message);
  }
  let devices = all.filter((d) => d.carThing).map(({ serial }) => ({ serial }));

  if (!devices.length && !connecting && !all.length && Date.now() - lastServerRestart > config.adbRestartMs) {
    // Only when the server lists nothing at all AND the hardware is really on the bus. Anything
    // else on the list means the list isn't stale, and kill-server would drop someone else's
    // session; nothing on the bus means the device is unplugged and there's nothing to fix.
    if (await onUsbBus()) {
      lastServerRestart = Date.now();
      log.info('[adb] the Car Thing is on the USB bus but adb cannot see it — restarting the adb server');
      await restartServer();
      devices = await listCarThings().catch(() => []);
      if (devices.length) log.info('[adb] the server had gone stale; the device was there all along');
    }
  }
  if (!devices.length) {
    const usb = await usbDevice();
    if (usb) devices = [usb];
    else if (!usbHinted && (await onUsbBus())) {
      usbHinted = true;
      log.info(`[device] Car Thing is on USB but ${config.usbHost}:${config.usbCdpPort} is not reachable. Give the Mac's USB interface 172.16.42.1, and flash an image whose Chromium listens on that port.`);
    }
  } else usbHinted = false;
  if (devices.length) lastSeen = Date.now();

  if (link && !devices.some((d) => d.serial === link.serial)) link.close();
  if (!link && !connecting && devices.length) await connect(devices[0]);
}

async function usbDevice() {
  try {
    const pages = await listTargets(config.usbCdpPort, config.usbHost);
    if (!pages.some((p) => p.type === 'page')) return null;
    return { serial: `usb:${config.usbHost}`, host: config.usbHost };
  } catch {
    return null;
  }
}

async function connect(device) {
  connecting = true;
  const l = new DeviceLink(device.serial, { host: device.host });
  l.on('ready', () => {
    l.applyMacClock().then(() => pushAll(l));
  });
  l.on('message', onDeviceMessage);
  l.on('close', () => {
    if (link !== l) return;
    link = null;
    log.info('[device] disconnected');
    setTimeout(refreshDevices, 1500);
  });
  link = l;
  try {
    log.info(`[device] connecting to ${device.serial}…`);
    await l.connect();
    log.info('[device] connected');
    screenOn = null;
    manualSleep = false;
    await applyScreen();
    heartbeat();
  } catch (err) {
    log.warn('[device] connect failed:', err.message);
    if (link === l) link = null;
    l.close();
    setTimeout(refreshDevices, 3000);
  } finally {
    connecting = false;
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- Start ----------------------------------------------------------------

log.info('Car Thing bridge starting');
source.on('change', (s) => onNowPlaying(s).catch((err) => log.warn('[now playing]', err.message)));
volume.on('change', (v) => {
  checkKeyAccess(v);
  link?.send({ type: 'volume', volume: v });
});
settings.on('change', (values) => link?.send({ type: 'settings', settings: values }));
weather.on('change', (state) => link?.send({ type: 'weather', weather: state }));
calendar.on('change', (state) => link?.send({ type: 'calendar', calendar: state }));
appearance.on('change', (dark) => link?.send({ type: 'appearance', dark }));
power.on('display', (asleep) => {
  if (!config.sleepWithMac) return;
  log.info(`[screen] Mac display ${asleep ? 'asleep' : 'awake'}`);
  link?.send({ type: 'display', asleep });
});
power.on('lock', (locked) => {
  log.info(`[screen] Mac ${locked ? 'locked' : 'unlocked'}`);
  applyScreen();
});
power.on('willSleep', () => {
  if (config.sleepWithMac) link?.send({ type: 'display', asleep: true });
  power.ack(); // let the Mac go to sleep; the panel stays lit on the screensaver
});
power.on('didWake', () => {
  if (config.sleepWithMac) link?.send({ type: 'display', asleep: power.displayAsleep });
  applyScreen();
  // Waking is exactly when adb's list goes stale, so look now and again once USB has settled,
  // instead of waiting out the timer that exists for ordinary unplugs.
  refreshDevices();
  setTimeout(refreshDevices, 8000);
});
source.start();
volume.start();
helper.start();
weather.start();
calendar.start();
appearance.start();
power.start();
startSettingsPage({ port: config.settingsPort, settings, status: macStatus });

trackDevices(debounce(refreshDevices, 400));
setInterval(refreshDevices, 30 * 1000); // a stale adb server sends no events; look anyway
refreshDevices();

setInterval(() => link?.send(tickMessage()), 2000);
setInterval(() => applyScreen(), 5000); // lock and the held sleep button, if an event was missed
setInterval(heartbeat, config.heartbeatMs);
setInterval(() => link?.send(nowPlayingMessage()), 15000); // re-anchor the device's progress clock

if (process.argv.includes('--watch')) {
  log.info(`[dev] watching Vue source in ${paths.uiSource}`);
  let building = false;
  let pending = false;
  const rebuild = async () => {
    if (building) { pending = true; return; }
    building = true;
    try {
      do {
        pending = false;
        await new Promise((resolve, reject) => {
          execFile(process.execPath, [path.join(paths.root, 'node_modules/vite/bin/vite.js'), 'build'],
            { cwd: paths.root }, (err, stdout, stderr) => err ? reject(new Error(stderr || stdout || err.message)) : resolve());
        });
      } while (pending);
      await link?.redeploy();
    } catch (err) { log.warn('[dev] build/deploy failed:', err.message); }
    finally {
      building = false;
      if (pending) { pending = false; rebuild(); }
    }
  };
  const redeploy = debounce(rebuild, 300);
  fs.watch(paths.uiSource, { recursive: true }, redeploy);
  fs.watch(path.join(paths.root, 'vite.config.js'), redeploy);
}

async function shutdown() {
  log.info('shutting down');
  // Don't leave the Car Thing dark with nothing to wake it — unless its own watchdog is there,
  // which wakes the screen on any button or knob press and would only turn it off again anyway.
  if (link && screenOn === false && !link.sleepd) {
    await Promise.race([link.setScreen(true).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  }
  link?.send({ type: 'bye' });
  source.stop();
  volume.stop();
  helper.stop();
  power.stop();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
