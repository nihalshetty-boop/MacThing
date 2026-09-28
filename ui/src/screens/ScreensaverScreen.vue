<script setup>
import { computed } from 'vue';
import { state, CT } from '../state.js';
import { describe } from '../weather.js';
import ScreenStage from '../components/ScreenStage.vue';
import AnalogClock from '../components/AnalogClock.vue';
import WeatherIcon from '../components/WeatherIcon.vue';
const parts = computed(() => CT.parts(state.now));
const data = computed(() => state.weather);
const ok = computed(() => data.value.status === 'ok' && data.value.current);
const condition = computed(() => ok.value ? describe(data.value.current.code, data.value.current.isDay).label : '');
CT.screen('screensaver');
</script>
<template>
  <section id="screen-screensaver" class="screen fill flex" :class="{ active: state.current === 'screensaver', leaving: state.leaving === 'screensaver' }">
    <div class="left-rail saver-rail flex-col justify-between">
      <div class="flex-col gap-12">
        <p class="font-small bold truncate">{{ CT.MONTHS[parts.month] }}</p>
        <p class="font-huge">{{ parts.date }}</p>
        <p class="font-medium semibold truncate">{{ CT.DAYS[parts.day] }}</p>
      </div>
      <template v-if="ok">
        <div class="saver-line" />
        <div class="flex-col gap-8">
          <p class="font-small medium muted truncate">{{ data.place }}</p>
          <div class="flex items-center gap-16">
            <p class="saver-temp flex-none">{{ data.current.temp }}°</p>
            <div class="flex items-center gap-8 flex-1">
              <WeatherIcon class="saver-icon flex-none" :code="data.current.code" :is-day="!!data.current.isDay" />
              <p class="saver-cond truncate">{{ condition }}</p>
            </div>
          </div>
        </div>
      </template>
    </div>
    <ScreenStage class="bg-panel">
      <AnalogClock :now="state.current === 'screensaver' ? state.now : 0" />
    </ScreenStage>
  </section>
</template>
