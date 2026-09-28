<script setup>
import { computed } from 'vue';
import { state, CT } from '../state.js';
const props = defineProps({ now: Number, numbers: Boolean });
const light = computed(() => state.light);
// Figma 2003:1580 (dark) and 2003:1699 (light). Assets are the exported vectors;
// markers sit where those frames put them, then each hour is that 12 o'clock mark turned.
const MARK = { tri: [33.08, 39.08], dot: [17.4, 17.4], bar: [16.6, 39.16] };
const CENTER = { tri: [192, 59.808], dot: [192, 52.93], bar: [192, 60.81] };
const marks = computed(() => {
  return Array.from({ length: 12 }, (_, i) => {
    const kind = i === 0 ? 'tri' : i % 3 === 0 ? 'bar' : 'dot';
    const [w, h] = MARK[kind];
    const [cx, cy] = CENTER[kind];
    // Marks and hands use the light vectors in both themes: white fill, black stroke.
    return { i, w, h, x: cx - w / 2, y: cy - h / 2, href: 'images/clock/mark-' + kind + '-light.svg' };
  });
});
const track = computed(() => light.value ? 'images/clock/track-light.svg' : 'images/clock/track-dark.svg');
const handStroke = '#222222';
const hubFill = '#111111';
// The frame draws both hands at one sample time. These are those same vectors, moved so
// the hub is the dial center and each hand points at 12. The only rotation left is the time.
const HOUR_D = 'M203.499 96.517L192.000 95.827C190.412 95.732 189.048 96.942 188.953 98.530L182.858 200.107C182.763 201.695 183.973 203.059 185.561 203.154L197.060 203.844C198.647 203.940 200.012 202.730 200.107 201.142L206.202 99.565C206.297 97.977 205.087 96.613 203.499 96.517Z';
const MINUTE_D = 'M192.000 34.534L186.241 34.639C184.650 34.668 183.385 35.981 183.414 37.571L186.434 202.663C186.463 204.254 187.776 205.519 189.366 205.490L195.125 205.385C196.716 205.356 197.981 204.043 197.952 202.453L194.932 37.360C194.903 35.770 193.590 34.504 192.000 34.534Z';
const HUB_D = 'M192.000 208.000C200.837 208.000 208.000 200.837 208.000 192.000C208.000 183.163 200.837 176.000 192.000 176.000C183.163 176.000 176.000 183.163 176.000 192.000C176.000 200.837 183.163 208.000 192.000 208.000Z';
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
      <path :d="HOUR_D" fill="#ffffff" :stroke="handStroke" stroke-width="2.88" />
    </g>
    <g :transform="'rotate(' + angles.minute + ' 192 192)'">
      <path :d="MINUTE_D" fill="#ffffff" :stroke="handStroke" stroke-width="2.88" />
    </g>
    <path :d="HUB_D" :fill="hubFill" :stroke="handStroke" stroke-width="2.88" />
  </svg>
</template>
