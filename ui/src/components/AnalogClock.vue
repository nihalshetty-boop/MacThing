<script setup>
import { computed } from 'vue';
import { state, CT } from '../state.js';
const props = defineProps({ now: Number, numbers: Boolean });
const light = computed(() => state.light);
// Figma 2003:1580 (dark) and 2003:1699 (light). Assets are the exported vectors;
// markers sit where those frames put them, then each hour is that 12 o'clock mark turned.
const MARK = {
  light: { tri: [33.08, 39.08], dot: [17.4, 17.4], bar: [16.6, 39.16] },
  dark: { tri: [33.08, 39.08], dot: [17.4, 17.4], bar: [13.6, 36.16] },
};
const CENTER = { tri: [192, 59.808], dot: [192, 52.93], bar: [192, 60.81] };
const marks = computed(() => {
  const theme = light.value ? 'light' : 'dark';
  const size = MARK[theme];
  return Array.from({ length: 12 }, (_, i) => {
    const kind = i === 0 ? 'tri' : i % 3 === 0 ? 'bar' : 'dot';
    const [w, h] = size[kind];
    const [cx, cy] = CENTER[kind];
    // Triangle and dots use the light filled marks in both themes. Bars stay theme-specific.
    const fileTheme = kind === 'bar' ? theme : 'light';
    return { i, w, h, x: cx - w / 2, y: cy - h / 2, href: 'images/clock/mark-' + kind + '-' + fileTheme + '.svg' };
  });
});
const track = computed(() => light.value ? 'images/clock/track-light.svg' : 'images/clock/track-dark.svg');
const handStroke = '#222222';
const hubFill = '#111111';
// Hands from the frame, drawn at its sample time. Counter-rotate that pose so
// zero degrees is 12, then the live angle is applied around the hub at the dial center.
const HOUR_D = 'M8.47192 38.3764L1.94692 47.8703C1.04601 49.1812 1.37831 50.9742 2.68915 51.8751L86.5522 109.513C87.8631 110.413 89.6561 110.081 90.557 108.77L97.082 99.2764C97.9829 97.9656 97.6506 96.1726 96.3397 95.2717L12.4767 37.6342C11.1658 36.7333 9.37283 37.0656 8.47192 38.3764Z';
const MINUTE_D = 'M213.39 7.28742L210.004 2.62748C209.069 1.34068 207.268 1.05542 205.982 1.99034L72.3967 99.0454C71.1099 99.9803 70.8246 101.781 71.7595 103.068L75.1451 107.728C76.0801 109.015 77.8811 109.3 79.1679 108.365L212.753 11.3102C214.04 10.3753 214.325 8.57423 213.39 7.28742Z';
const HUB_D = 'M84.3254 113.498C93.162 113.498 100.325 106.335 100.325 97.4983C100.325 88.6618 93.162 81.4983 84.3254 81.4983C75.4889 81.4983 68.3254 88.6618 68.3254 97.4983C68.3254 106.335 75.4889 113.498 84.3254 113.498Z';
const TO_DIAL = 'translate(107.6746 94.5017)';
function point(r, turns) {
  const angle = turns * 2 * Math.PI;
  return { x: 192 + r * Math.sin(angle), y: 192 - r * Math.cos(angle) };
}
const numerals = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, ...point(138, (i + 1) / 12) }));
// Screens pass now = 0 while they're not on screen, so the clock stops redrawing. It holds its
// last time instead of drawing 0, so the hands stay put while the screen fades out.
let shown = 0;
const angles = computed(() => {
  if (props.now) shown = props.now;
  const p = CT.parts(shown);
  const minutes = p.minutes + p.seconds / 60;
  return { hour: ((p.hours % 12) + minutes / 60) * 30, minute: minutes * 6 };
});
</script>
<template>
  <svg class="c-face" viewBox="0 0 384 384" aria-label="Analog clock">
    <image :href="track" :xlink:href="track" x="13.44" y="13.44" width="357.12" height="357.12" />
    <g v-if="!numbers">
      <g v-for="mark in marks" :key="mark.i" :transform="'rotate(' + mark.i * 30 + ' 192 192)'">
        <image :href="mark.href" :xlink:href="mark.href" :x="mark.x" :y="mark.y" :width="mark.w" :height="mark.h" />
      </g>
    </g>
    <g v-else class="c-numerals"><text v-for="n in numerals" :key="n.n" :x="n.x" :y="n.y + 10" text-anchor="middle">{{ n.n }}</text></g>
    <g :transform="'rotate(' + angles.hour + ' 192 192)'">
      <g transform="rotate(-54.722 192 192)">
        <path :d="HOUR_D" :transform="TO_DIAL" fill="#ffffff" :stroke="handStroke" stroke-width="2.88" />
      </g>
    </g>
    <g :transform="'rotate(' + angles.minute + ' 192 192)'">
      <g transform="rotate(-54.487 192 192)">
        <path :d="MINUTE_D" :transform="TO_DIAL" fill="#ffffff" :stroke="handStroke" stroke-width="2.88" />
      </g>
    </g>
    <path :d="HUB_D" :transform="TO_DIAL" :fill="hubFill" :stroke="handStroke" stroke-width="2.88" />
  </svg>
</template>
