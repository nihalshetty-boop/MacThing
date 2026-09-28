import { reactive, ref, computed, watch } from 'vue';
import { initializeRuntime } from '../js/core.js';

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}
function usableForecast(w) {
  return !!(w && w.status === 'ok' && w.current && Array.isArray(w.hourly) && Array.isArray(w.daily));
}
function usableAgenda(c) {
  return !!(c && c.status === 'ok' && Array.isArray(c.events));
}

const savedWeather = readJson('ct-weather');
const savedCalendar = readJson('ct-calendar');
const savedPlaying = readJson('ct-nowplaying');
function usablePlaying(saved) {
  return !!(saved && saved.np && saved.np.active && saved.np.title);
}
export const state = reactive({
  current: 'nowplaying', leaving: '', offline: false, asleep: false, light: false, dim: false,
  settings: { theme: 'dark', units: 'F', clock24h: false, clockFace: 'analog', meetingAlert: 0, location: { mode: 'auto' } },
  now: Date.now(),
  np: usablePlaying(savedPlaying) ? savedPlaying.np : { active: false },
  npAt: usablePlaying(savedPlaying) ? performance.now() : 0,
  artwork: usablePlaying(savedPlaying) && savedPlaying.artwork && savedPlaying.artwork.dataUrl ? savedPlaying.artwork : null,
  weather: usableForecast(savedWeather) ? savedWeather : { status: 'loading' },
  calendar: usableAgenda(savedCalendar) ? savedCalendar : { status: 'loading' },
  volume: 0, volumeUnsupported: false, volumeNote: '', showVolume: false,
  flash: { icon: 'play', color: '', key: 0 }, toast: ''
});
export const CT = initializeRuntime(state);
state.now = CT.now();
// The art on screen only changes once its replacement is decoded, and a track that arrives
// without art keeps the old art for a moment: players often send the new title first and its art
// a beat later, and dropping to nothing in between flashes the stage and the ambient background.
const ART_GRACE_MS = 1500;
const shownArt = ref('');
// The day number's color. Empty falls back to the theme red. A new cover replaces it; stopping
// playback does not, so the date keeps the color of the art that is (or just was) playing.
export const dateColor = ref('');
let artClear, artLoad = 0;

/** The cover's strongest color, skipping near-black and near-white so a dark border doesn't win. */
function prominentColor(img) {
  try {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const bins = Object.create(null);
    for (let i = 0; i < data.length; i += 16) {
      if (data[i + 3] < 200) continue;
      const r = data[i] >> 4, g = data[i + 1] >> 4, b = data[i + 2] >> 4;
      const key = (r << 8) + (g << 4) + b;
      bins[key] = (bins[key] || 0) + 1;
    }
    let best = '', score = 0;
    for (const key in bins) {
      const k = Number(key);
      const r = ((k >> 8) << 4) + 8, g = (((k >> 4) & 15) << 4) + 8, b = ((k & 15) << 4) + 8;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lum < 0.12 || lum > 0.92) continue;
      const s = bins[key] * (0.2 + sat);
      if (s > score) { score = s; best = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''); }
    }
    return best;
  } catch (e) { return ''; }
}

function showArt(url) {
  const seq = ++artLoad;
  const img = new Image();
  const done = () => {
    if (seq !== artLoad) return;
    shownArt.value = url;
    const color = prominentColor(img);
    if (color) dateColor.value = color;
  };
  // decode() can stay pending while the page is hidden, so it only gets a moment to finish.
  img.onload = () => Promise.race([img.decode && img.decode().catch(() => {}), new Promise(r => setTimeout(r, 250))]).then(done);
  img.onerror = done;
  img.src = url;
}
watch(() => [state.np.artworkKey, state.artwork], () => {
  clearTimeout(artClear);
  if (!state.np.artworkKey) {
    artLoad++;
    artClear = setTimeout(() => { shownArt.value = ''; }, shownArt.value ? ART_GRACE_MS : 0);
  } else if (state.artwork && state.artwork.key === state.np.artworkKey && state.artwork.dataUrl !== shownArt.value) {
    showArt(state.artwork.dataUrl);
  }
});
if (state.artwork && state.artwork.dataUrl) {
  shownArt.value = state.artwork.dataUrl;
  showArt(state.artwork.dataUrl);
}
export const artworkUrl = computed(() => state.np.active ? shownArt.value : '');
CT.onSecond(now => { state.now = now; });
CT.on('tick', () => { state.now = CT.now(); });

function rememberNowPlaying() {
  if (!state.np.active) return;
  const np = Object.assign({}, state.np, { elapsed: elapsed() });
  const artwork = state.artwork && state.artwork.key === np.artworkKey ? state.artwork : null;
  const payload = { np, artwork };
  if (writeJson('ct-nowplaying', payload)) return;
  if (np.source && np.source.icon) {
    payload.np = Object.assign({}, np, { source: Object.assign({}, np.source, { icon: null }) });
    if (writeJson('ct-nowplaying', payload)) return;
  }
  payload.artwork = null;
  writeJson('ct-nowplaying', payload);
}
function forgetNowPlaying() {
  try { localStorage.removeItem('ct-nowplaying'); } catch (e) {}
}
// A quiet bridge sends nothing, so a reload keeps the last track and cover. A real
// "nothing playing" from the Mac still clears the page while the link is up.
CT.on('nowPlaying', msg => {
  state.np = msg.np || { active: false };
  state.npAt = performance.now();
  if (state.np.active) rememberNowPlaying();
  else forgetNowPlaying();
});
CT.on('artwork', msg => {
  state.artwork = msg;
  if (state.np.active) rememberNowPlaying();
});
// The Mac refreshes these while it's connected. A quiet bridge must not blank them: keep the last
// good forecast and agenda, the same way the clock keeps the last Mac time. The weather screen
// already prints when the snapshot was taken.
CT.on('weather', msg => {
  if (usableForecast(msg.weather)) { state.weather = msg.weather; writeJson('ct-weather', msg.weather); }
  else if (!usableForecast(state.weather)) state.weather = msg.weather;
});
CT.on('calendar', msg => {
  if (usableAgenda(msg.calendar)) { state.calendar = msg.calendar; writeJson('ct-calendar', msg.calendar); }
  else if (!usableAgenda(state.calendar)) state.calendar = msg.calendar;
});

export function elapsed() {
  const np = state.np;
  if (!np.active || np.elapsed == null) return 0;
  const value = np.elapsed + (performance.now() - state.npAt) / 1000 * (np.rate || 0);
  return Math.max(0, np.duration ? Math.min(np.duration, value) : value);
}
export function durationText(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = String(n % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}
CT.on('command', action => {
  const np = state.np;
  if (action === 'playpause') {
    if (np.active) {
      np.elapsed = elapsed();
      state.npAt = performance.now();
      np.playing = !np.playing;
      np.rate = np.playing ? 1 : 0;
    }
    if (state.current !== 'nowplaying' || !np.active) CT.flash(!np.active || np.playing ? 'play' : 'pause');
  } else if (action === 'next' || action === 'previous') CT.flash(action);
});
CT.on('favorite', msg => {
  CT.flash(msg.favorited ? 'heart' : 'heart-off', msg.favorited ? '#ff453a' : '');
  CT.toast(msg.favorited ? 'Added to Favorites' : 'Removed from Favorites');
});
