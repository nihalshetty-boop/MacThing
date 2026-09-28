<script setup>
import { computed, ref } from "vue";
import { state, CT } from "../state.js";
import { describe } from "../weather.js";
import LeftRail from "../components/LeftRail.vue";
import ScreenStage from "../components/ScreenStage.vue";
import StageMessage from "../components/StageMessage.vue";
import WeatherIcon from "../components/WeatherIcon.vue";
import WeatherHour from "../components/WeatherHour.vue";
import WeatherDay from "../components/WeatherDay.vue";
import WeatherToday from "../components/WeatherToday.vue";
import WeatherWeek from "../components/WeatherWeek.vue";
const data = computed(() => state.weather);
const ok = computed(() => data.value.status === "ok");
const tz = computed(() => data.value.utcOffset / 60);
const condition = computed(() =>
  ok.value
    ? describe(data.value.current.code, data.value.current.isDay).label
    : "",
);
const message = computed(() => {
  if (ok.value) return {};
  if (data.value.status === "noLocation")
    return {
      title: ["denied", "restricted"].includes(data.value.reason)
        ? "Location access is off"
        : "Can’t find your location",
      detail:
        "Press the settings button and choose Weather location to pick a place.",
    };
  return data.value.status === "error"
    ? { title: "Weather unavailable", detail: "Press the weather button to try again." }
    : { title: "Getting the weather…" };
});
const hours = computed(() =>
  !ok.value
    ? []
    : data.value.hourly.slice(0, 5).map((h, i) =>
        i === 0 ? { ...h, ...data.value.current } : h,
      ),
);
const days = computed(() => {
  if (!ok.value) return [];
  const rows = data.value.daily.slice(0, 4);
  const min = Math.min(...rows.map((d) => d.lo)),
    max = Math.max(...rows.map((d) => d.hi));
  return rows.map((d) => ({
    ...d,
    range: {
      left: ((d.lo - min) / Math.max(1, max - min)) * 100 + "%",
      right: ((max - d.hi) / Math.max(1, max - min)) * 100 + "%",
    },
  }));
});
// The weather button, pressed on the weather, steps from the forecast to today's hours, then the
// week's days, then back to the forecast. While the weather is unavailable it asks the Mac to try
// again instead (the Mac makes each failed try wait longer before the next: 4 s, 8 s, …); coming
// to the screen asks too, without the "try again in" toast.
const VIEWS = ["forecast", "today", "week"];
const view = ref("forecast");
const screen = CT.screen("weather");
screen.show = () => {
  if (data.value.status === "error") CT.send({ type: "retryWeather", quiet: true });
};
screen.reselect = () => {
  if (data.value.status === "error") return CT.send({ type: "retryWeather" });
  view.value = VIEWS[(VIEWS.indexOf(view.value) + 1) % VIEWS.length];
};
</script>
<template>
  <section
    id="screen-weather"
    class="screen fill flex"
    :class="{ active: state.current === 'weather', leaving: state.leaving === 'weather' }"
  >
    <LeftRail
      :eyebrow="ok ? data.place : 'Weather'"
      :title="ok ? data.current.temp + '°' : '--°'"
      :lower-content="ok ? 'Updated ' + CT.timeText(data.updatedAt) : ''"
    >
      <template v-if="ok" #subtitle
        ><div class="flex items-center gap-10">
          <WeatherIcon
            class="w-cond-icon flex-none"
            :code="data.current.code"
            :is-day="!!data.current.isDay"
          /><span>{{ condition }}</span>
        </div></template
      >
    </LeftRail>
    <ScreenStage class="bg-panel">
      <Transition name="view">
      <WeatherToday
        v-if="ok && view === 'today'"
        class="stage-safe"
        :hours="data.hourly.slice(0, 6)"
        :day="data.daily[0]"
        :tz="tz"
      />
      <WeatherWeek
        v-else-if="ok && view === 'week'"
        class="stage-safe"
        :days="data.daily.slice(0, 6)"
        :tz="tz"
      />
      <div v-else-if="ok" class="stage-safe-x stage-safe-top flex-col gap-28">
        <div class="w-hourly grid">
          <WeatherHour
            v-for="(h, i) in hours"
            :key="i"
            :forecast="h"
            :current="i === 0"
            :label="Math.abs(h.t - state.now) < 75 * 60 * 1000 ? 'Now' : CT.hourText(h.t, tz)"
          />
        </div>
        <div class="w-daily grid items-center">
          <WeatherDay
            v-for="(d, i) in days"
            :key="d.t"
            :forecast="d"
            :current="i === 0"
            :label="
              CT.dayNumber(d.t, tz) === CT.dayNumber(state.now)
                ? 'Today'
                : CT.DAYS[CT.parts(d.t, tz).day].slice(0, 3)
            "
          />
        </div>
      </div>
      </Transition>
      <StageMessage :title="message.title" :detail="message.detail" />
    </ScreenStage>
  </section>
</template>
