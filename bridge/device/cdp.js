import { EventEmitter } from 'node:events';

/** Minimal Chrome DevTools Protocol client (Node 22's built-in WebSocket; no dependencies). */
export class CDP extends EventEmitter {
  static connect(wsUrl, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP connect timeout: ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CDP(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${wsUrl}`));
      });
    });
  }

  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.emit(msg.method, msg.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  send(method, params = {}, timeoutMs = 10000) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

export async function listTargets(port, host = '127.0.0.1') {
  const res = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}
