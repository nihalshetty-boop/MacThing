/**
 * The flashed page still times itself from the device clock. This installs the same
 * Mac-tick offset that ui/js/core.js uses, and does nothing once that page is present.
 * Chromium 69: no optional chaining.
 */
export const macClockExpression = `(function () {
  if (!window.CT || CT.usesMacClock) return 'skip';
  CT.usesMacClock = true;
  var KEY = 'ct-clock';
  var clock = { offset: 0, tz: 0, tzKnown: false };
  var offsets = [];
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }
  function write(macAt, deviceAt) {
    try { localStorage.setItem(KEY, JSON.stringify({ macAt: macAt, deviceAt: deviceAt, tz: clock.tz })); } catch (e) {}
  }
  var saved = read();
  if (saved && typeof saved.macAt === 'number' && typeof saved.deviceAt === 'number') {
    if (typeof saved.tz === 'number') { clock.tz = saved.tz; clock.tzKnown = true; }
    var deviceNow = Date.now();
    if (deviceNow + 2000 < saved.deviceAt) clock.offset = saved.macAt - deviceNow;
    else clock.offset = saved.macAt - saved.deviceAt;
  }
  CT.now = function () { return Date.now() + clock.offset; };
  var parts = CT.parts, dayNumber = CT.dayNumber;
  CT.parts = function (ms, tz) { return parts.call(CT, ms, tz == null ? (clock.tzKnown ? clock.tz : null) : tz); };
  CT.dayNumber = function (ms, tz) { return dayNumber.call(CT, ms, tz == null ? (clock.tzKnown ? clock.tz : null) : tz); };
  var orig = window.__carthingReceive;
  window.__carthingReceive = function (msg) {
    if (msg && msg.type === 'tick' && typeof msg.now === 'number') {
      var deviceAt = Date.now();
      var offset = msg.now - deviceAt;
      if (offsets.length && Math.abs(offset - clock.offset) > 10000) offsets = [];
      offsets.push(offset);
      if (offsets.length > 15) offsets.shift();
      clock.offset = Math.max.apply(null, offsets);
      if (typeof msg.tzMinutes === 'number') { clock.tz = msg.tzMinutes; clock.tzKnown = true; }
      write(msg.now, deviceAt);
    }
    return orig(msg);
  };
  return 'installed';
})()`;
