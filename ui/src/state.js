import { reactive, ref, computed, watch } from 'vue';
import { initializeRuntime } from '../js/core.js';

export const state = reactive({
  current: 'nowplaying', leaving: '', offline: false, asleep: false, light: false,
  settings: { theme: 'dark', units: 'F', clock24h: false, clockFace: 'analog', meetingAlert: 0, location: { mode: 'auto' } },
  now: Date.now(), np: { active: false }, npAt: 0, artwork: null,
  weather: { status: 'loading' }, calendar: { status: 'loading' },
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
let artClear, artLoad = 0;
function showArt(url) {
  const seq = ++artLoad;
  const img = new Image();
  const done = () => { if (seq === artLoad) shownArt.value = url; };
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
export const artworkUrl = computed(() => state.np.active ? shownArt.value : '');
CT.onSecond(now => { state.now = now; });
CT.on('tick', () => { state.now = CT.now(); });
CT.on('nowPlaying', msg => { state.np = msg.np; state.npAt = performance.now(); });
CT.on('artwork', msg => { state.artwork = msg; });
CT.on('weather', msg => { state.weather = msg.weather; });
CT.on('calendar', msg => { state.calendar = msg.calendar; });

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
