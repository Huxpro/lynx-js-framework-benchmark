// Minimal flat-protocol CDP client over the browser's remote-debugging port,
// using Node's built-in WebSocket. Used for what playwright-core's public API
// cannot reach: per-target (page AND dedicated-worker) sampling profiles and
// heap usage, which give the btsCpu/mtsCpu split.

export class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #eventHandlers = [];

  static async connect(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = await res.json();
    const client = new CdpClient();
    await client.#open(webSocketDebuggerUrl);
    return client;
  }

  #open(url) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.addEventListener('open', () => resolve());
      this.#ws.addEventListener('error', (e) => reject(new Error(`CDP connect failed: ${e.message ?? e}`)));
      this.#ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)));
    });
  }

  #onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id != null && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const h of this.#eventHandlers) h(msg.method, msg.params ?? {}, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  onEvent(handler) {
    this.#eventHandlers.push(handler);
  }

  close() {
    try { this.#ws.close(); } catch { /* already closed */ }
  }
}

/**
 * Attach to the page target whose URL matches `urlPrefix` and auto-attach to
 * its dedicated workers. Returns session handles for profiling.
 */
export async function setCPUThrottlingRate(client, sessionId, cpuThrottle = 1) {
  if (typeof cpuThrottle !== 'number' || !Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
    throw new Error(`invalid CPU throttling rate: ${cpuThrottle}`);
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle }, sessionId);
}

export async function attachToPageAndWorkers(client, urlPrefix, { cpuThrottle = 1 } = {}) {
  const { targetInfos } = await client.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix));
  if (!page) throw new Error(`no page target matching ${urlPrefix}`);
  const { sessionId: pageSession } = await client.send('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  });
  await setCPUThrottlingRate(client, pageSession, cpuThrottle);

  const workers = new Map(); // targetId -> { sessionId, url, name }
  client.onEvent((method, params, sessionId) => {
    if (method === 'Target.attachedToTarget' && sessionId === pageSession) {
      const info = params.targetInfo;
      if (info.type === 'worker') {
        workers.set(info.targetId, {
          sessionId: params.sessionId,
          url: info.url,
          title: info.title,
        });
      }
    }
    if (method === 'Target.detachedFromTarget') {
      for (const [tid, w] of workers) {
        if (w.sessionId === params.sessionId) workers.delete(tid);
      }
    }
  });
  await client.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  }, pageSession);

  return {
    pageSession,
    workers,
    /** The lynx background worker session (worker named/URL'd by web-core). */
    bgWorker() {
      for (const w of workers.values()) {
        if (/worker-chunk|lynx-bg|blob:/.test(w.url)) return w;
      }
      return null;
    },
  };
}

/** Sum sampled JS CPU ms from a V8 profiler profile, excluding idle/program. */
export function profileCpuMs(profile) {
  if (!profile?.samples?.length) return 0;
  const meta = new Map();
  for (const node of profile.nodes) {
    const fn = node.callFrame?.functionName ?? '';
    meta.set(node.id, fn === '(idle)' || fn === '(program)' || fn === '(root)');
  }
  let busyMicros = 0;
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) {
    const idle = meta.get(samples[i]) ?? false;
    const dt = timeDeltas[i] ?? 0;
    if (!idle && dt > 0) busyMicros += dt;
  }
  return busyMicros / 1000;
}

export class RealmProfiler {
  #client;
  #sessions;

  /** sessions: array of { key, sessionId } */
  constructor(client, sessions) {
    this.#client = client;
    this.#sessions = sessions;
  }

  async start() {
    for (const s of this.#sessions) {
      await this.#client.send('Profiler.enable', {}, s.sessionId);
      await this.#client.send('Profiler.setSamplingInterval', { interval: 200 }, s.sessionId);
      await this.#client.send('Profiler.start', {}, s.sessionId);
    }
  }

  /** Returns { [key]: cpuMs } */
  async stop() {
    const out = {};
    for (const s of this.#sessions) {
      try {
        const { profile } = await this.#client.send('Profiler.stop', {}, s.sessionId);
        out[s.key] = profileCpuMs(profile);
      } catch {
        out[s.key] = null; // session may be gone (worker terminated)
      }
    }
    return out;
  }
}
