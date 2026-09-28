import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  root,
  ui: path.join(root, 'dist', 'ui'),
  uiSource: path.join(root, 'ui'),
  bin: path.join(root, 'native', 'bin'),
  sleepd: path.join(root, 'device', 'sleepd.sh'),
};

export const config = {
  // Host port that `adb forward` maps to the Car Thing's Chromium devtools port (2222).
  // NOTE: never use `adb reverse` with this firmware — it crashes adbd and drops USB until a reboot.
  cdpPort: Number(process.env.CARTHING_CDP_PORT || 22222),
  // The firmware image has no adbd. Chromium listens on this address over the USB gadget
  // (device 172.16.42.2, Mac 172.16.42.1).
  usbHost: process.env.CARTHING_USB_HOST || '172.16.42.2',
  usbCdpPort: Number(process.env.CARTHING_USB_CDP_PORT || 2222),

  // Where our files live on the device. /var/lib is the persistent "settings" partition,
  // so updates never need the read-only rootfs remounted.
  deviceDir: '/var/lib/carthing',
  deviceUiDir: '/var/lib/carthing/ui',
  // What Chromium opens at boot (supervisord --app). scripts/setup-device.sh points it at deviceUiDir.
  deviceBootUrl: 'file:///usr/share/qt-superbird-app/webapp/index.html',

  // Buttons → action. Keys are what the device reports to the page: top buttons 1–4, the
  // fifth (settings) button at the end of the top row (m) and the back button under the knob
  // (Escape — also closes Settings whatever it's mapped to).
  // Actions: screen:<nowplaying|calendar|weather|clock> | settings | favorite | unfavorite
  // (the playing Apple Music song) | previous | next | playpause | null
  buttons: {
    1: 'screen:nowplaying',
    2: 'screen:calendar',
    3: 'screen:weather',
    4: 'screen:clock',
    m: 'settings',
    Escape: 'favorite',
  },
  // Knob press, by number of quick presses. A single press waits multiClickMs to see if more follow.
  knobClicks: { 1: 'playpause', 2: 'next', 3: 'previous' },
  // Buttons that count presses the same way. The back button favorites the playing song on one
  // press and unfavorites it on two, so neither is a toggle you have to guess the state of.
  // A key listed here ignores its `buttons` entry.
  buttonClicks: { Escape: { 1: 'favorite', 2: 'unfavorite' } },
  multiClickMs: 350,

  // Hold a button for holdMs to get a second action out of it; the short press then happens on
  // release instead. `sleep` puts the screen to sleep until the next button or knob input.
  buttonHolds: { m: 'sleep' },
  holdMs: 1200,

  // Mac-side settings page (weather location etc.), loopback only.
  settingsPort: Number(process.env.CARTHING_SETTINGS_PORT || 4747),

  volumeStep: 1 / 64, // per knob detent — macOS's fine (Option+Shift) volume-key step
  // true: turn the knob by pressing the Mac's volume keys so macOS shows its volume indicator.
  // Needs native/bin/volumectl allowed under Privacy & Security → Accessibility (software
  // can't press keys without it). false: set the volume directly — silent, no permission.
  macVolumeIndicator: false,
  knobDirection: 1, // 1 = turning right raises the volume (same as Spotify's firmware); -1 flips it

  // The lock screen still turns the panel off. Display sleep does not: the page shows the
  // screensaver and asks for a low backlight. A button or knob press restores full brightness
  // for screenWakeMs, and the same wait with no input does that even while the display is awake.
  sleepWithMac: true,
  screenWakeMs: 60 * 1000,

  // Deep sleep, run by the device itself (device/sleepd.sh, installed by `npm run setup-device`).
  // The bridge writes deviceHeartbeat every heartbeatMs with the screen state it wants; when the
  // Mac stops writing it — shut down, cable pulled, bridge stopped — the device turns its own
  // backlight off after deviceSleepSeconds and idles the CPU, since nothing on the Mac can do it
  // any more. Any button or knob input wakes it for deviceWakeSeconds.
  deviceSleepSeconds: 90,
  deviceWakeSeconds: 20,
  devicePowersave: true, // also idle the device's CPU while asleep (see device/sleepd.sh)
  // Shortest gap between adb server restarts. The bridge only restarts it when ioreg shows the
  // Car Thing on the USB bus while `adb devices` is empty, which is always wrong and always the
  // server's fault, so there's no reason to wait long or to give up.
  adbRestartMs: 20 * 1000,

  // This firmware's USB gadget doesn't always survive the Mac suspending the port, and it's only
  // built at boot, so the Mac can wake to no device on the bus until it's fully power-cycled.
  // After this many seconds without a heartbeat — and only while no host has the gadget
  // configured — the device rebinds it itself.
  deviceUsbHealSeconds: 180, // 0 turns it off
  heartbeatMs: 10 * 1000,
  deviceHeartbeat: '/tmp/carthing-heartbeat', // tmpfs: the rootfs is read-only and flash wears out

  // Sources that don't get an app badge on the artwork (your "home" player).
  unbadgedApps: ['com.apple.Music'],
};
