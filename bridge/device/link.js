import { EventEmitter } from 'node:events';
import { config, paths } from '../config.js';
import { log } from '../log.js';
import { adb, shell } from './adb.js';
import { CDP, listTargets } from './cdp.js';
import { macClockExpression } from './mac-clock.js';
import { isBootInstalled, syncSleepd, syncUi } from './deploy.js';

const BINDING = '__carthingSend'; // page → Mac (Runtime.addBinding)
const CONSOLE_MARK = '⁣carthing '; // fallback channel if bindings are unavailable

/** What device/sleepd.sh reads out of /var/lib/carthing/sleep.conf. */
const sleepConf = () => ({
  HB: config.deviceHeartbeat,
  IDLE: config.deviceSleepSeconds,
  WAKE: config.deviceWakeSeconds,
  POWERSAVE: config.devicePowersave ? 1 : 0,
  HEAL: config.deviceUsbHealSeconds,
});

/**
 * One live connection to a Car Thing: forwards its Chromium devtools port over adb,
 * makes sure the page shows our UI, and relays messages both ways.
 *   Mac → page: Runtime.evaluate(window.__carthingReceive(msg))
 *   page → Mac: window.__carthingSend(json) binding
 *
 * Events: 'ready' (page loaded and wants full state), 'message' (from page), 'close'.
 */
export class DeviceLink extends EventEmitter {
  constructor(serial, { host = null } = {}) {
    super();
    this.serial = serial;
    this.host = host;
    this.cdp = null;
    this.closed = false;
    this.sleepd = false; // is the device-side sleep watchdog installed?
    this.beat = 0;
  }

  async connect() {
    let reload = false;
    if (this.host) {
      log.info(`[device] USB ${this.host}:${config.usbCdpPort} — page is already on the device`);
      this.pageUrl = 'http://localhost:80/';
      this.uiVersion = 'firmware';
    } else {
      await adb(['forward', `tcp:${config.cdpPort}`, 'tcp:2222'], { serial: this.serial });
      const sync = await syncUi(this.serial, paths.ui, config.deviceUiDir);
      if (sync.changed) log.info(`[device] UI deployed (${sync.version})`);
      this.uiVersion = sync.version;
      reload = sync.changed;

      const sleepd = await syncSleepd(this.serial, paths.sleepd, config.deviceDir, sleepConf()).catch((err) => {
        log.warn('[device] sleep watchdog:', err.message);
        return { installed: false, changed: false };
      });
      this.sleepd = sleepd.installed;
      if (sleepd.changed) log.info('[device] sleep watchdog updated');
      else if (!sleepd.installed) log.warn('[device] no sleep watchdog — run `npm run setup-device` so the screen sleeps when the Mac is off');

      const installed = await isBootInstalled(this.serial, config.deviceUiDir);
      this.pageUrl = installed ? config.deviceBootUrl : `file://${config.deviceUiDir}/index.html`;
      if (!installed) log.warn('[device] boot web app not pointed at our UI yet — run `npm run setup-device` so it survives reboots');
    }

    const target = await this.#waitForPage();
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    this.cdp = cdp;

    cdp.on('Runtime.bindingCalled', (p) => p.name === BINDING && this.#onPayload(p.payload));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = p.args.map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
      if (text.startsWith(CONSOLE_MARK)) this.#onPayload(text.slice(CONSOLE_MARK.length));
      else log.debug('[device console]', text);
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      log.warn('[device] page error:', d.exception?.description || d.text);
    });
    cdp.on('close', () => this.close());

    await cdp.send('Runtime.enable');
    // Chrome 69 on this device never replies to Page.enable over the USB forward.
    // The page is already open; state is sent with Runtime.evaluate.
    if (this.host) cdp.send('Page.enable').catch(() => {});
    else await cdp.send('Page.enable');
    await cdp.send('Runtime.addBinding', { name: BINDING }).catch((e) => log.warn('[device] addBinding failed, using console channel', e.message));

    const here = (target.url || '').replace(/\/$/, '');
    const want = (this.pageUrl || '').replace(/\/$/, '');
    if (here !== want) {
      log.info(`[device] opening UI (was ${target.url})`);
      await cdp.send('Page.navigate', { url: this.pageUrl });
    } else if (reload) {
      await this.reload();
    } else {
      this.emit('ready'); // our UI is already up; it just needs state
    }
  }

  async #waitForPage(timeoutMs = 90000) {
    // Chromium can take a while after a cold boot; keep polling its devtools endpoint.
    const host = this.host || '127.0.0.1';
    const port = this.host ? config.usbCdpPort : config.cdpPort;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const page = (await listTargets(port, host)).find((t) => t.type === 'page');
        if (page) {
          if (this.host && page.webSocketDebuggerUrl) {
            page.webSocketDebuggerUrl = page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${this.host}:${port}`);
          }
          return page;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error('Chromium devtools not reachable on the device');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  #onPayload(payload) {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return log.warn('[device] bad payload', payload.slice(0, 200));
    }
    if (msg.type === 'hello') this.emit('ready');
    this.emit('message', msg);
  }

  /** Point an already-flashed page at Mac time. A page that does this itself is left alone. */
  applyMacClock() {
    if (!this.cdp || this.closed) return Promise.resolve();
    this._clock ||= this.cdp
      .send('Runtime.evaluate', { expression: macClockExpression, returnByValue: true })
      .then((result) => {
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'clock patch failed');
        if (result.result?.value === 'installed') log.info('[device] clock follows the Mac');
      })
      .catch((err) => log.warn('[device] clock patch failed:', err.message))
      .finally(() => {
        this._clock = null;
      });
    return this._clock;
  }

  send(msg) {
    if (!this.cdp || this.closed) return;
    const expression = `window.__carthingReceive && window.__carthingReceive(${JSON.stringify(msg)})`;
    this.cdp.send('Runtime.evaluate', { expression }).catch((e) => log.debug('[device] send failed', e.message));
  }

  async reload() {
    await this.cdp?.send('Page.reload', { ignoreCache: true });
  }

  async redeploy() {
    const sync = await syncUi(this.serial, paths.ui, config.deviceUiDir);
    if (sync.changed) {
      log.info(`[device] UI redeployed (${sync.version})`);
      await this.reload();
    }
  }

  /**
   * Tells the device-side watchdog the Mac is still here, and what the screen should be doing.
   * It's the heartbeat going stale — not the screen state — that makes the device sleep on its own.
   */
  async heartbeat(on) {
    if (!this.sleepd || this.closed) return;
    await shell(this.serial, `echo ${++this.beat} ${on ? 'on' : 'off'} > ${config.deviceHeartbeat}`, { timeout: 5000 });
  }

  /**
   * Backlight on/off. The ambient-light daemon is paused while off so it can't relight the screen.
   *
   * Use the Amlogic driver's own switch: the standard /sys/class/backlight/aml-bl/bl_power and
   * its `brightness` are both accepted on this panel and do nothing — the LEDs stay lit while the
   * page goes black, which looks like a dark screen in a dark room and lit everywhere else.
   * device/sleepd.sh switches the same file when the Mac isn't there to do it.
   */
  async setScreen(on) {
    this.send({ type: 'screen', on });
    if (this.host || this.closed) return;
    const power = '/sys/class/aml_bl/power'; // echo 0|1 (see `cat /sys/class/aml_bl/help`)
    await shell(
      this.serial,
      on
        ? `echo 1 > ${power}; supervisorctl start backlight >/dev/null 2>&1; true`
        : `supervisorctl stop backlight >/dev/null 2>&1; echo 0 > ${power}; true`,
      { timeout: 3000 },
    );
  }

  async screenshot() {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.cdp?.close();
    } catch {}
    this.emit('close');
  }
}
