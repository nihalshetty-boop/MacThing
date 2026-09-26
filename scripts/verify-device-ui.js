// Smoke-test the compiled UI in the actual Chromium 69 kiosk. Fixture messages
// stay on the page; outgoing messages are captured, never sent to the Mac.
// Reloading in finally restores the live bridge data and input handlers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { config } from '../bridge/config.js';
import { adb, listCarThings } from '../bridge/device/adb.js';
import { CDP, listTargets } from '../bridge/device/cdp.js';

const [device] = await listCarThings();
assert(device, 'Connect a Car Thing first');
await adb(['forward', 'tcp:' + config.cdpPort, 'tcp:2222'], { serial: device.serial });
const target = (await listTargets(config.cdpPort)).find(t => t.type === 'page');
const cdp = await CDP.connect(target.webSocketDebuggerUrl);
const errors = [];
cdp.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.text + ': ' + (e.exceptionDetails.exception?.description || '')));
await cdp.send('Runtime.enable');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const output = await fs.mkdtemp('/tmp/carthing-vue-');
async function capture(name) {
  await pause(400);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(output + '/' + name + '.png', Buffer.from(shot.data, 'base64'));
}
async function message(msg) {
  await evaluate('window.fixtureReceive(' + JSON.stringify(msg) + ')');
  await pause(100);
}
// The page keeps the least-delayed of the last 15 ticks, so set the time with all 15.
async function tick(ms) {
  for (let i = 0; i < 15; i++) await evaluate('window.fixtureReceive(' + JSON.stringify({ type: 'tick', now: ms, tzMinutes: 0 }) + ')');
  await pause(100);
}
// npm run dev puts back the screen and view you were on (the weather's Today, the calendar's
// month…). Start from a fresh page with the default views, and put yours back afterwards.
const devScreen = await evaluate('sessionStorage.getItem("ct-dev-screen")');
await evaluate('sessionStorage.removeItem("ct-dev-screen")');
await cdp.send('Page.reload', { ignoreCache: true });
await pause(500);
try {
  let mounted = false;
  for (let attempt = 0; attempt < 30 && !mounted; attempt++) {
    mounted = await evaluate('!!window.CT && !!document.querySelector("#mount") && !!document.querySelector("#mount").__vue_app__').catch(() => false);
    if (!mounted) await pause(500);
  }
  assert.equal(mounted, true, 'Vue mounted');
  await evaluate('window.fixtureReceive = window.__carthingReceive; window.__carthingReceive = function(){}; window.fixtureSent = []; CT.send = function(msg){window.fixtureSent.push(msg)}');
  const settings = { theme: 'dark', clock24h: false, artBackground: false, clockFace: 'analog', calendarDays: 2, location: { mode: 'auto' } };
  await message({ type: 'settings', settings });
  await message({ type: 'screen', on: true });
  await tick(Date.UTC(2026, 8, 22, 14, 35));
  const now = Date.UTC(2026, 8, 22, 14, 35);
  await message({ type: 'nowPlaying', np: { active: true, title: 'A very long title that needs to fit within the available left rail without hiding the album or the progress bar', artist: 'Example artist', album: 'Example album', duration: 300, elapsed: 100, playing: true, rate: 1, artworkKey: null } });
  await evaluate("CT.show('nowplaying')");
  await capture('nowplaying-long');
  assert.equal(await evaluate('(function(){var c=document.querySelector("#screen-nowplaying .left-rail-content");return c.lastElementChild.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 1})()'), true, 'Long track fits rail');
  const artwork = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#15536b"/><circle cx="320" cy="160" r="130" fill="#d89951"/></svg>').toString('base64');
  await message({ type: 'settings', settings: { ...settings, artBackground: true } });
  await message({ type: 'nowPlaying', np: { active: true, artist: 'Example artist', title: 'A short title', album: 'Example album', artworkKey: 'fixture-art', duration: 300, elapsed: 60, rate: 0, playing: false } });
  await message({ type: 'artwork', key: 'fixture-art', dataUrl: artwork });
  await capture('artwork-paused');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("ambient-on")'), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".paused-glyph")).opacity'), '1');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter'}))");
  await pause(450);
  assert.equal(await evaluate('window.fixtureSent.some(m => m.type === "command" && m.action === "playpause")'), true, 'Knob press sends playpause');
  assert.equal(await evaluate('document.getElementById("screen-nowplaying").classList.contains("paused")'), false);
  await message({ type: 'favorite', favorited: true });
  await capture('favorite');
  assert.match(await evaluate('document.querySelector(".toast").textContent'), /Added to Favorites/);
  await message({ type: 'settings', settings });
  await message({ type: 'nowPlaying', np: { active: false } });
  await capture('idle');
  assert.equal(await evaluate('document.querySelector(".np-title").textContent'), 'Nothing playing');
  await message({ type: 'weather', weather: { status: 'noLocation', reason: 'denied' } });
  await evaluate("CT.show('weather')");
  await capture('weather-denied');
  assert.match(await evaluate('document.querySelector("#screen-weather").textContent'), /Location access is off/);
  await message({ type: 'weather', weather: { status: 'ok', place: 'Falmouth', utcOffset: 0, updatedAt: now, current: { temp: 68, code: 2, isDay: true }, hourly: Array.from({ length: 6 }, (_, i) => ({ t: now + i * 3600000, temp: 68 - i, code: 2, isDay: true, pop: 30 })), daily: Array.from({ length: 5 }, (_, i) => ({ t: now + i * 86400000, lo: 45 + i, hi: 68 + i, code: 3, pop: 40 })) } });
  await capture('weather');
  assert.equal(await evaluate('document.querySelectorAll(".w-day").length'), 4);
  assert.equal(await evaluate('document.querySelector(".w-hourly").children.length'), 5);
  // The weather button on the weather steps through today's hours, the week, and back.
  const weatherButton = () => evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'3'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'3'}))");
  await weatherButton();
  await capture('weather-today');
  assert.equal(await evaluate('document.querySelectorAll("#screen-weather .w-row").length'), 6, 'The weather button lists the hours');
  assert.match(await evaluate('document.querySelector("#screen-weather .w-rows").textContent'), /^2PM\s*30%/);
  await weatherButton();
  await capture('weather-week');
  assert.equal(await evaluate('document.querySelectorAll("#screen-weather .w-week .w-row").length'), 5, 'then the days');
  await weatherButton();
  await pause(400); // the week fades out (0.3 s) before it leaves the page
  assert.equal(await evaluate('!!document.querySelector("#screen-weather .w-rows")'), false, 'and back to the forecast');
  await message({ type: 'calendar', calendar: { status: 'denied' } });
  await evaluate("CT.show('calendar')");
  await capture('calendar-denied');
  assert.match(await evaluate('document.querySelector("#screen-calendar").textContent'), /Calendar access is off/);
  await message({ type: 'calendar', calendar: { status: 'ok', events: Array.from({ length: 14 }, (_, i) => ({ start: now + (i + 1) * 3600000, end: now + (i + 2) * 3600000, title: 'Example event ' + (i + 1), location: 'An event location', color: '#ff8b00', allDay: false })) } });
  await capture('calendar-full');
  assert.equal(await evaluate('(function(){var l=document.querySelector(".k-list");return l.scrollHeight <= l.clientHeight})()'), true, 'Agenda fits stage');
  assert.equal(await evaluate('document.querySelector(".calendar-time").textContent'), '2:35', 'Calendar shows current time');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'2'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'2'}))");
  await capture('calendar-month');
  assert.match(await evaluate('document.querySelector("#screen-calendar .k-month").textContent'), /September.*22.*30/, 'The calendar button shows the month');
  assert.equal(await evaluate('document.querySelector("#screen-calendar .k-today").textContent.trim()'), '22');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'2'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'2'}))");
  await pause(400); // the month fades out (0.3 s) before it leaves the page
  assert.equal(await evaluate('!!document.querySelector("#screen-calendar .k-month")'), false, 'and back to the agenda');
  await evaluate("CT.show('clock')");
  await capture('clock');
  assert.match(await evaluate('document.querySelector("#screen-clock .left-rail").textContent'), /3:35 PM.*Example event 1/);
  // The clock button on the clock swaps in the timer; the knob sets, runs and resets it.
  const press = key => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'${key}'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'${key}'}))`);
  const rail = () => evaluate('document.querySelector("#screen-clock .left-rail-content").textContent');
  while (await evaluate('!!document.querySelector("#screen-clock .t-face")')) await press('4'); // start from the clock
  await press('4');
  await pause(400); // the clock's text fades out (0.3 s) before the timer's is the only one
  await evaluate("window.dispatchEvent(new WheelEvent('wheel', {deltaX:53, cancelable:true}))");
  await pause(100);
  assert.match(await rail(), /30 minute timer30:00/, 'Wheel picks the timer length');
  await press('Enter');
  await tick(now + 754000);
  await pause(1100);
  assert.match(await rail(), /30 minute timer1[67]:\d\d/, 'Timer counts down');
  await capture('timer');
  await press('4');
  await pause(400); // the timer fades out (0.3 s) before it leaves the page
  assert.equal(await evaluate('!!document.querySelector("#screen-clock .t-face")'), false, 'The clock button goes back to the clock');
  await press('4');
  await pause(400);
  await press('Enter'); await press('Enter');
  await pause(100);
  assert.match(await rail(), /30 minute timer30:00/, 'Double press resets');
  await press('4');
  await tick(now);
  // Meeting alerts: a card over the screen before a meeting; any press only dismisses it.
  await evaluate("localStorage.removeItem('ct-dismissed-meetings')");
  await message({ type: 'settings', settings: { ...settings, meetingAlert: 5 } });
  await message({ type: 'calendar', calendar: { status: 'ok', events: [{ start: now + 180000, end: now + 1980000, title: 'Example meeting', location: 'Room 4\n1 Example St', color: '#2d9cdb', allDay: false, calendarId: 'fixture' }] } });
  await capture('meeting-alert');
  assert.match(await evaluate('document.querySelector(".m-card").textContent'), /^\s*Example meeting.*2:38 – 3:08 PM.*Room 4.*In 3 min\s*$/, 'Meeting alert shows the meeting');
  await press('1');
  await pause(400);
  assert.equal(await evaluate('document.querySelector(".meeting-alert").classList.contains("on")'), false, 'A button dismisses the alert');
  assert.equal(await evaluate('CT.current'), 'clock', 'without also acting');
  await message({ type: 'settings', settings });
  await evaluate("CT.show('settings'); CT.screens.settings.turn(3); CT.screens.settings.press()");
  await pause(100);
  assert.equal(await evaluate('window.fixtureSent.some(m => m.type === "setting" && m.key === "clock24h" && m.value === true)'), true);
  await capture('settings');
  await message({ type: 'settings', settings: { ...settings, theme: 'light' } });
  await evaluate("CT.show('clock')");
  await capture('clock-light');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("light")'), true);
  await message({ type: 'volume', volume: { supported: true, volume: 0.4, muted: false } });
  await message({ type: 'volume', volume: { supported: true, volume: 0.6, muted: false } });
  await capture('volume');
  assert.equal(await evaluate('document.querySelector(".vol-value").textContent'), '60');
  await evaluate("window.dispatchEvent(new WheelEvent('wheel', {deltaX:53, cancelable:true}))");
  // The page batches knob turns for 40ms; on the device that can take a few hundred.
  const sentVolume = 'window.fixtureSent.some(m => m.type === "volume" && m.delta > 0)';
  for (let i = 0; i < 10 && !(await evaluate(sentVolume)); i++) await pause(100);
  assert.equal(await evaluate(sentVolume), true, 'Knob rotation sends volume');
  await message({ type: 'volume', volume: { supported: false, device: 'Digital output', volume: 0.6 } });
  await capture('volume-unsupported');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".vol-value")).display'), 'none');
  await message({ type: 'screen', on: false });
  await capture('asleep');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("asleep")'), true);
  await message({ type: 'screen', on: true });
  await message({ type: 'bye' });
  await capture('bridge-gone');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("offline")'), false, 'A dropped bridge leaves the clock up');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("asleep")'), false, 'A dropped bridge does not blank the screen');
  assert.deepEqual(errors, [], 'No runtime exceptions');
  console.log('Device checks passed. Screenshots: ' + output);
} finally {
  await evaluate(devScreen ? 'sessionStorage.setItem("ct-dev-screen", ' + JSON.stringify(devScreen) + ')' : 'sessionStorage.removeItem("ct-dev-screen")');
  await cdp.send('Page.reload', { ignoreCache: true });
  cdp.close();
}
