import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { newThreadId, messagesToPrompt, NotionError } from './notion.mjs';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{64}$/;
const JSON_LIMIT = 64 * 1024;
const DELTA_LIMIT = 32 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const PROMPT_LIMIT = 1024 * 1024;
const JOB_LIMIT = 16;
const HISTORY_LIMIT = 256;
const ERROR_MESSAGES = Object.freeze({
  notion_access_denied: 'Notion 拒绝访问，请检查浏览器登录和工作区权限。',
  notion_request_rejected: 'Notion 拒绝本次请求，请在浏览器中检查状态。',
  notion_quota_exhausted: 'Notion 当前额度或速率限制已达到上限。',
  notion_user_action_required: 'Notion 需要人工操作或授权，请在浏览器中处理。',
  notion_incomplete_stream: 'Notion 的响应流未能完整结束。',
  notion_unknown_patch: 'Notion 响应格式已变化，需要更新适配器。',
  notion_network_error: '浏览器连接不可用，请重新连接扩展。',
  notion_empty_answer: 'Notion 未返回非空文本答案。',
});

function failure(status, code) {
  return new NotionError(status, code, ERROR_MESSAGES[code] ?? '浏览器桥接请求无效。');
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workerId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure(400, 'bridge_invalid_worker');
  return value.toLowerCase();
}

function equalNonce(actual, expected) {
  // Both buffers have fixed length. Never compare attacker-controlled strings directly.
  const valid = typeof actual === 'string' && NONCE.test(actual);
  const bytes = valid ? Buffer.from(actual, 'hex') : Buffer.alloc(32);
  return timingSafeEqual(bytes, expected) && valid;
}

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return false;
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (body === undefined) res.end();
  else {
    const text = JSON.stringify(body);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(text));
    res.end(text);
  }
  return true;
}

function sendError(res, error) {
  const status = error instanceof NotionError ? error.status : 502;
  const code = error instanceof NotionError ? error.code : 'notion_network_error';
  // All messages originate here, including upload and transport failures.
  if (status === 413 && !res.headersSent && !res.destroyed) res.setHeader('Connection', 'close');
  send(res, status, { error: { code, message: ERROR_MESSAGES[code] ?? '浏览器桥接请求无效。' } });
}

function readJson(req, res, signal) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', failed);
      req.removeListener('aborted', disconnected);
      req.removeListener('close', closed);
      res.removeListener('close', disconnected);
      res.removeListener('error', disconnected);
      signal.removeEventListener('abort', shutdown);
    };
    const failed = error => { cleanup(); chunks = []; reject(error); };
    const disconnected = () => failed(failure(400, 'bridge_disconnected'));
    const shutdown = () => failed(failure(503, 'notion_network_error'));
    const closed = () => { if (!req.complete) disconnected(); };
    const tooLarge = () => {
      failed(failure(413, 'bridge_payload_too_large'));
      req.resume();
    };
    const data = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > JSON_LIMIT) return tooLarge();
      chunks.push(bytes);
    };
    const end = () => {
      cleanup();
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        chunks = [];
        const body = JSON.parse(text);
        if (!object(body)) throw new Error();
        resolve(body);
      } catch { failed(failure(400, 'bridge_invalid_json')); }
    };
    if (signal.aborted) return shutdown();
    if (req.aborted || res.destroyed) return disconnected();
    if (Number(req.headers['content-length']) > JSON_LIMIT) return tooLarge();
    req.on('data', data);
    req.once('end', end);
    req.once('error', failed);
    req.once('aborted', disconnected);
    req.once('close', closed);
    res.once('close', disconnected);
    res.once('error', disconnected);
    signal.addEventListener('abort', shutdown, { once: true });
    timer = setTimeout(() => { failed(failure(408, 'bridge_upload_timeout')); req.resume(); }, 15000);
    timer.unref();
  });
}

/** In-memory transport only: the extension performs requests in its logged-in browser.
 * The HTTP host must authenticate Bearer before handle(), except for OPTIONS.
 * ready reports configuration + a live worker lease, not verified Notion AI access.
 */
export class BrowserRelayProvider {
  #worker;
  #leaseTimer;
  #jobs = new Map();
  #streams = new Set();
  #queue = [];
  #history = new Map();
  #uploads = 0;
  #disconnectUpload = false;
  #epoch = 0;
  #closed = false;
  #shutdown = new AbortController();
  #leaseMs;
  #waitMs;
  #now;

  constructor(config, { leaseMs = 45000, waitMs = 15000, now = Date.now } = {}) {
    for (const [name, value] of Object.entries({ leaseMs, waitMs })) {
      if (!Number.isSafeInteger(value) || value < (name === 'waitMs' ? 0 : 1) || value > 2147483647) {
        throw new TypeError(`${name} must be an integer within its supported timer range.`);
      }
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    // Deliberately copy only public routing metadata; no token/cookie is needed.
    this.config = Object.fromEntries(['userId', 'spaceId', 'clientVersion', 'cellHint'].map(key => [key, config?.[key]]));
    this.#leaseMs = leaseMs;
    this.#waitMs = waitMs;
    this.#now = now;
  }

  get ready() {
    if (this.#closed) return false;
    this.#expire();
    return ['userId', 'spaceId'].every(key => typeof this.config[key] === 'string' && this.config[key].trim())
      && Boolean(this.#worker);
  }

  models() { return ['notion-auto']; }

  /** Permanently shut down this instance; safe to call repeatedly from SIGINT/SIGTERM. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#epoch++;
    this.#disconnect();
    clearTimeout(this.#leaseTimer);
    this.#leaseTimer = undefined;
    // Also discard completed-but-unread output held by a suspended consumer.
    for (const job of this.#streams) {
      job.error = failure(503, 'notion_network_error');
      job.deltas.length = 0;
      job.payload = undefined;
      this.#wake(job);
    }
    this.#streams.clear();
    this.#queue.length = 0;
    this.#history.clear();
    this.#shutdown.abort();
  }

  #expire() {
    const now = this.#now();
    for (const [id, old] of this.#history) if (old.until <= now) this.#history.delete(id);
    if (!this.#worker || this.#worker.until > now) return;
    this.#disconnect();
  }

  #disconnect() {
    const worker = this.#worker;
    if (!worker) return;
    this.#epoch++;
    this.#worker = undefined;
    clearTimeout(this.#leaseTimer);
    this.#leaseTimer = undefined;
    for (const job of this.#jobs.values()) this.#finish(job, failure(503, 'notion_network_error'));
    worker.poll?.finish(503, { error: { code: 'notion_network_error', message: ERROR_MESSAGES.notion_network_error } });
  }

  #renew(worker) {
    worker.until = this.#now() + this.#leaseMs;
    clearTimeout(this.#leaseTimer);
    // Expiry also wakes stalled streams when there is no subsequent HTTP request.
    this.#leaseTimer = setTimeout(() => { this.#expire(); }, this.#leaseMs);
    this.#leaseTimer.unref();
  }

  #remember(job) {
    this.#history.set(job.id, {
      workerId: job.workerId, origin: job.origin, nonce: job.nonce,
      until: this.#now() + Math.max(60000, this.#leaseMs),
    });
    while (this.#history.size > HISTORY_LIMIT) this.#history.delete(this.#history.keys().next().value);
  }

  #wake(job) { const wake = job.wake; job.wake = undefined; wake?.(); }

  #finish(job, error) {
    if (job.done) return;
    job.done = true;
    job.error = error;
    this.#jobs.delete(job.id);
    this.#queue = this.#queue.filter(id => id !== job.id);
    this.#remember(job);
    job.payload = undefined;
    if (error) {
      job.deltas.length = 0;
      this.#streams.delete(job);
    }
    this.#wake(job);
  }

  #authenticate(id, origin) {
    if (!this.#worker || this.#worker.id !== id || this.#worker.origin !== origin) {
      throw failure(403, 'bridge_worker_forbidden');
    }
    return this.#worker;
  }

  #take(worker) {
    while (this.#queue.length) {
      const job = this.#jobs.get(this.#queue.shift());
      if (!job || job.done) continue;
      if (job.workerId !== worker.id || job.origin !== worker.origin) {
        this.#finish(job, failure(503, 'notion_network_error'));
        continue;
      }
      job.dispatched = true;
      return job;
    }
  }

  #deliver(worker, res) {
    const job = this.#take(worker);
    if (!job) return false;
    if (!send(res, 200, job.payload)) this.#finish(job, failure(503, 'notion_network_error'));
    return true;
  }

  #poll(req, res, worker) {
    if (worker.poll) throw failure(409, 'bridge_poll_conflict');
    this.#renew(worker);
    if (req.aborted || res.destroyed) return Promise.resolve();
    if (this.#deliver(worker, res)) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        req.removeListener('aborted', disconnected);
        req.removeListener('close', closed);
        res.removeListener('close', disconnected);
        res.removeListener('error', disconnected);
        if (worker.poll === poll) worker.poll = undefined;
      };
      const poll = {
        finish: (status, body) => { cleanup(); if (status !== undefined) send(res, status, body); resolve(); },
        deliver: () => {
          cleanup();
          this.#expire();
          if (this.#worker === worker) this.#deliver(worker, res);
          else sendError(res, failure(503, 'notion_network_error'));
          resolve();
        },
      };
      const disconnected = () => poll.finish();
      // IncomingMessage.close also fires on a normally completed GET body.
      const closed = () => { if (!req.complete) disconnected(); };
      worker.poll = poll;
      req.once('aborted', disconnected);
      req.once('close', closed);
      res.once('close', disconnected);
      res.once('error', disconnected);
      timer = setTimeout(() => {
        this.#expire();
        if (worker.poll === poll) poll.finish(204);
      }, this.#waitMs);
      timer.unref();
    });
  }

  async *stream({ messages, model, signal }) {
    signal?.throwIfAborted();
    if (!this.ready) throw failure(503, 'notion_network_error');
    if (model !== 'notion-auto') throw failure(400, 'model_not_found');
    if (!Array.isArray(messages) || !messages.length || messages.length > 1024
      || messages.some(message => !object(message) || !['system', 'user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string')) throw failure(400, 'bridge_invalid_messages');
    if (messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content), 0) > PROMPT_LIMIT) {
      throw failure(413, 'bridge_prompt_too_large');
    }
    const prompt = messagesToPrompt(messages);
    if (Buffer.byteLength(prompt) > PROMPT_LIMIT) throw failure(413, 'bridge_prompt_too_large');
    if (this.#streams.size >= JOB_LIMIT) throw failure(429, 'bridge_queue_full');
    for (const key of ['userId', 'spaceId', 'clientVersion', 'cellHint']) {
      const value = this.config[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > 256)) throw failure(400, 'bridge_invalid_config');
    }
    const worker = this.#worker;
    const id = randomUUID();
    const nonce = randomBytes(32);
    const job = {
      id, nonce, workerId: worker.id, origin: worker.origin, dispatched: false,
      bytes: 0, hasAnswer: false, deltas: [], done: false,
      payload: {
        id, nonce: nonce.toString('hex'), threadId: newThreadId(this.config.spaceId, this.#now()),
        spaceId: this.config.spaceId, userId: this.config.userId,
        clientVersion: this.config.clientVersion ?? '', cellHint: this.config.cellHint ?? '', prompt,
      },
    };
    const abort = () => {
      this.#finish(job, signal.reason);
      job.deltas.length = 0;
      job.payload = undefined;
      this.#streams.delete(job);
    };
    this.#jobs.set(id, job);
    this.#streams.add(job);
    this.#queue.push(id);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      worker.poll?.deliver();
      while (true) {
        signal?.throwIfAborted();
        this.#expire();
        if (job.error) throw job.error;
        if (job.deltas.length) yield job.deltas.shift();
        else if (job.done) return;
        else await new Promise(resolve => { job.wake = resolve; });
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!job.done) this.#finish(job, failure(502, 'notion_incomplete_stream'));
      job.deltas.length = 0;
      job.payload = undefined;
      this.#streams.delete(job);
    }
  }

  #result(body, origin) {
    const id = workerId(body.workerId);
    const allowedKeys = ['workerId', 'jobId', 'nonce', 'kind', 'text', 'status', 'code'];
    if (Object.keys(body).some(key => !allowedKeys.includes(key))
      || typeof body.jobId !== 'string' || !UUID.test(body.jobId)
      || !['delta', 'done', 'error'].includes(body.kind)) throw failure(400, 'bridge_invalid_result');
    const job = this.#jobs.get(body.jobId);
    const target = job ?? this.#history.get(body.jobId);
    if (!target) {
      this.#authenticate(id, origin);
      throw failure(410, 'bridge_job_gone');
    }
    if (target.workerId !== id || target.origin !== origin || !equalNonce(body.nonce, target.nonce)) {
      throw failure(403, 'bridge_result_forbidden');
    }
    if (!job) throw failure(410, 'bridge_job_gone');
    this.#authenticate(id, origin);
    if (!job.dispatched) throw failure(409, 'bridge_job_not_dispatched');
    if (body.kind === 'delta') {
      if (typeof body.text !== 'string') throw failure(400, 'bridge_invalid_delta');
      const bytes = Buffer.byteLength(body.text);
      if (bytes > DELTA_LIMIT || job.bytes + bytes > OUTPUT_LIMIT) {
        this.#finish(job, failure(502, 'notion_incomplete_stream'));
        throw failure(413, 'bridge_output_too_large');
      }
      job.bytes += bytes;
      job.hasAnswer ||= Boolean(body.text.trim());
      if (body.text) {
        // Coalesce only unread deltas, keeping tiny-chunk floods bounded in memory.
        const tail = job.deltas.at(-1);
        if (tail !== undefined && Buffer.byteLength(tail) + bytes <= DELTA_LIMIT) job.deltas[job.deltas.length - 1] += body.text;
        else job.deltas.push(body.text);
        this.#wake(job);
      }
    } else if (body.kind === 'done') {
      this.#finish(job, job.hasAnswer ? undefined : failure(502, 'notion_empty_answer'));
    } else {
      const status = Number.isInteger(body.status) && body.status >= 400 && body.status <= 599 ? body.status : 502;
      const code = typeof body.code === 'string' && Object.hasOwn(ERROR_MESSAGES, body.code) ? body.code : 'notion_request_rejected';
      this.#finish(job, failure(status, code));
    }
  }

  async handle(req, res) {
    this.#expire();
    const rawPath = req.url?.split('?', 1)[0] ?? '';
    if (rawPath !== '/bridge' && !rawPath.startsWith('/bridge/')) return false;
    try {
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)) throw failure(403, 'bridge_origin_forbidden');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.url.includes('#')) throw failure(400, 'bridge_invalid_query');
      const methods = { '/bridge/connect': ['POST'], '/bridge/next': ['GET', 'POST'], '/bridge/result': ['POST'], '/bridge/disconnect': ['POST'] }[rawPath];
      if (!methods) throw failure(404, 'bridge_not_found');
      const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
      if (((rawPath !== '/bridge/next' || req.method === 'POST') && query.size)
        || (rawPath === '/bridge/next' && [...query.keys()].some(key => key !== 'workerId'))
        || query.getAll('workerId').length > 1) throw failure(400, 'bridge_invalid_query');
      if (req.method === 'OPTIONS') {
        const requestedMethod = req.headers['access-control-request-method'];
        const requestedHeaders = req.headers['access-control-request-headers'];
        if ((requestedMethod !== undefined && !methods.includes(requestedMethod))
          || (requestedHeaders !== undefined && (typeof requestedHeaders !== 'string'
            || requestedHeaders.split(',').some(header => !['authorization', 'content-type'].includes(header.trim().toLowerCase()))))) {
          throw failure(400, 'bridge_invalid_preflight');
        }
        res.setHeader('Access-Control-Allow-Methods', `${methods.join(', ')}, OPTIONS`);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        send(res, 204);
      } else if (!methods.includes(req.method)) throw failure(400, 'bridge_invalid_method');
      else if (this.#closed) throw failure(503, 'notion_network_error');
      else if (req.method === 'GET') {
        const id = workerId(query.get('workerId'));
        await this.#poll(req, res, this.#authenticate(id, origin));
      } else {
        // Reserve a bounded control slot so ordinary uploads cannot block Stop.
        const stopping = rawPath === '/bridge/disconnect';
        if (stopping ? this.#disconnectUpload : this.#uploads >= JOB_LIMIT) throw failure(429, 'bridge_busy');
        if (stopping) this.#disconnectUpload = true;
        else this.#uploads++;
        const epoch = this.#epoch;
        let body;
        try { body = await readJson(req, res, this.#shutdown.signal); } finally {
          if (stopping) this.#disconnectUpload = false;
          else this.#uploads--;
        }
        // Another connect/next/result can run while an upload awaits its body.
        this.#expire();
        if (res.destroyed || req.aborted) return true;
        if (this.#closed) throw failure(503, 'notion_network_error');
        if (rawPath === '/bridge/connect' || rawPath === '/bridge/disconnect' || rawPath === '/bridge/next') {
          // An upload begun before a stop/expiry cannot revive or stop a new session.
          if (epoch !== this.#epoch) throw failure(410, 'bridge_connection_changed');
          if (Object.keys(body).some(key => key !== 'workerId')) throw failure(400, 'bridge_invalid_connect');
          const id = workerId(body.workerId);
          if (rawPath === '/bridge/next') {
            await this.#poll(req, res, this.#authenticate(id, origin));
            return true;
          }
          if (rawPath === '/bridge/disconnect') {
            this.#authenticate(id, origin);
            this.#disconnect();
            send(res, 200, { ok: true });
            return true;
          }
          if (this.#worker) {
            if (this.#worker.id !== id) throw failure(409, 'bridge_worker_conflict');
            this.#authenticate(id, origin);
          } else this.#worker = { id, origin };
          this.#renew(this.#worker);
          send(res, 200, { workerId: id, leaseMs: this.#leaseMs });
        } else {
          this.#result(body, origin);
          send(res, 200, { ok: true });
        }
      }
    } catch (error) {
      req.resume();
      sendError(res, error);
    }
    return true;
  }
}
