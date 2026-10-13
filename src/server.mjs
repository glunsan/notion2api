import { createServer as createHttpServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

class HttpError extends Error {
  constructor(status, code, message, param = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

class ClientDisconnected extends Error {}

function errorResponse(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status : 502;
  return {
    status,
    body: {
      error: {
        message: typeof error?.message === 'string' && error.message
          ? error.message : 'The upstream provider failed.',
        type: status < 500 ? 'invalid_request_error' : 'api_error',
        param: error instanceof HttpError ? error.param : null,
        code: typeof error?.code === 'string' || typeof error?.code === 'number'
          ? error.code : 'upstream_error',
      },
    },
  };
}

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function sendError(res, error) {
  if (res.destroyed || res.writableEnded || error instanceof ClientDisconnected) return;
  const { status, body } = errorResponse(error);
  if (res.headersSent) {
    // Once streaming started, a terminal error replaces the success terminator.
    res.end(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
  } else {
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    if (status === 413) res.setHeader('Connection', 'close');
    sendJson(res, status, body);
  }
}

function invalid(message, param, code = 'invalid_parameter') {
  throw new HttpError(400, code, message, param);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateChat(body) {
  if (!isObject(body)) invalid('Request body must be a JSON object.', null);
  for (const key of Object.keys(body)) {
    if (!['messages', 'model', 'stream'].includes(key)) {
      invalid(`Parameter "${key}" is not supported.`, key, 'unsupported_parameter');
    }
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    invalid('model must be a non-empty string.', 'model');
  }
  if (Object.hasOwn(body, 'stream') && typeof body.stream !== 'boolean') {
    invalid('stream must be a boolean.', 'stream');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    invalid('messages must be a non-empty array.', 'messages');
  }
  const messages = body.messages.map((message, index) => {
    const param = `messages[${index}]`;
    if (!isObject(message)) invalid('Each message must be an object.', param);
    for (const key of Object.keys(message)) {
      if (!['role', 'content'].includes(key)) {
        invalid(`Message parameter "${key}" is not supported.`, `${param}.${key}`, 'unsupported_parameter');
      }
    }
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      invalid('Message role must be system, user, or assistant.', `${param}.role`);
    }
    if (typeof message.content !== 'string') {
      invalid('Only text messages with string content are supported.', `${param}.content`);
    }
    return { role: message.role, content: message.content };
  });
  return { messages, model: body.model, stream: body.stream ?? false };
}

// All pending operations race the same signal, including an uncooperative next().
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

function readBody(req, maxBodyBytes, signal) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const fail = error => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal.reason);
    const tooLarge = () => {
      fail(new HttpError(413, 'body_too_large', 'Request body exceeds maxBodyBytes.'));
      req.resume();
    };
    const data = chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) return tooLarge();
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'Request body is not valid JSON.'));
      }
    };
    if (signal.aborted) return reject(signal.reason);
    if (Number(req.headers['content-length']) > maxBodyBytes) return tooLarge();
    req.on('data', data);
    req.once('end', end);
    req.once('error', fail);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', drained);
      res.removeListener('close', closed);
      res.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const closed = () => failed(new ClientDisconnected());
    const aborted = () => failed(signal.reason);
    if (signal.aborted) return reject(signal.reason);
    if (res.destroyed) return closed();
    res.once('drain', drained);
    res.once('close', closed);
    res.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function writeEvent(res, data, signal) {
  signal.throwIfAborted();
  if (res.destroyed) throw new ClientDisconnected();
  const encoded = typeof data === 'string' ? data : JSON.stringify(data);
  if (!res.write(`data: ${encoded}\n\n`)) await waitForDrain(res, signal);
}

function getModels(provider) {
  const models = provider.models();
  if (!Array.isArray(models) || models.some(id => typeof id !== 'string' || !id.trim())) {
    throw new HttpError(502, 'invalid_upstream_response', 'Provider models must be an array of model IDs.');
  }
  return models;
}

function requireReady(provider) {
  if (provider.ready !== true) {
    throw new HttpError(503, 'provider_not_ready', 'The upstream provider is not ready.');
  }
}

/** A dependency-free, text-only OpenAI-compatible HTTP server. It does not listen. */
export function createServer({
  provider,
  apiKey,
  maxBodyBytes = 1048576,
  maxConcurrency = 1,
  timeoutMs = 120000,
} = {}) {
  if (!provider || typeof provider.ready !== 'boolean'
    || typeof provider.models !== 'function' || typeof provider.stream !== 'function') {
    throw new TypeError('provider must expose ready, models(), and stream().');
  }
  if (typeof apiKey !== 'string' || !apiKey || /\s/.test(apiKey)) {
    throw new TypeError('apiKey must be a non-empty string without whitespace.');
  }
  for (const [key, value] of Object.entries({ maxBodyBytes, maxConcurrency, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1 || (key === 'timeoutMs' && value > 2147483647)) {
      throw new TypeError(`${key} must be a positive integer within its supported range.`);
    }
  }
  const expectedKey = createHash('sha256').update(apiKey).digest();
  let active = 0;

  function authenticate(req) {
    const authorization = req.headers.authorization ?? '';
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    const actualKey = createHash('sha256').update(match?.[1] ?? '').digest();
    const validKey = timingSafeEqual(actualKey, expectedKey);
    const authorizationCount = req.rawHeaders.filter((header, index) =>
      index % 2 === 0 && header.toLowerCase() === 'authorization').length;
    if (!match || authorizationCount !== 1 || !validKey) {
      throw new HttpError(401, 'invalid_api_key', 'A valid Bearer API key is required.');
    }
  }

  async function chat(req, res) {
    const controller = new AbortController();
    const { signal } = controller;
    const disconnected = () => {
      if (!signal.aborted) controller.abort(new ClientDisconnected());
    };
    const closed = () => { if (!res.writableFinished) disconnected(); };
    req.once('aborted', disconnected);
    res.once('close', closed);
    res.once('error', disconnected);
    let timer;
    let acquired = false;
    let iterator;
    let iteratorDone = false;
    const release = () => {
      clearTimeout(timer);
      if (acquired) { active -= 1; acquired = false; }
    };
    try {
      const input = validateChat(await readBody(req, maxBodyBytes, signal));
      signal.throwIfAborted();
      requireReady(provider);
      if (!getModels(provider).includes(input.model)) {
        throw new HttpError(400, 'model_not_found', 'The requested model is not available.', 'model');
      }
      if (active >= maxConcurrency) {
        throw new HttpError(429, 'server_busy', 'The server is busy; retry after the active request completes.');
      }
      active += 1;
      acquired = true;
      signal.addEventListener('abort', release, { once: true });
      timer = setTimeout(() => {
        controller.abort(new HttpError(504, 'upstream_timeout', 'The upstream request timed out.'));
      }, timeoutMs);
      timer.unref();
      const source = provider.stream({ messages: input.messages, model: input.model, signal });
      if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
        throw new HttpError(502, 'invalid_upstream_response', 'Provider stream must be an async iterable.');
      }
      iterator = source[Symbol.asyncIterator]();
      const next = async () => {
        const item = await abortable(() => iterator.next(), signal);
        if (!isObject(item) || (item.done !== undefined && typeof item.done !== 'boolean')
          || (!item.done && typeof item.value !== 'string')) {
          throw new HttpError(502, 'invalid_upstream_response', 'Provider stream must yield string deltas.');
        }
        iteratorDone = item.done === true;
        return item;
      };
      // Do not commit HTTP 200 until the first upstream next() succeeds.
      let item = await next();
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      if (input.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const chunk = (delta, finishReason = null) => ({
          id, object: 'chat.completion.chunk', created, model: input.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        await writeEvent(res, chunk({ role: 'assistant', ...(item.done ? {} : { content: item.value }) }), signal);
        while (!item.done) {
          item = await next();
          if (!item.done) await writeEvent(res, chunk({ content: item.value }), signal);
        }
        await writeEvent(res, chunk({}, 'stop'), signal);
        await writeEvent(res, '[DONE]', signal);
        res.end();
      } else {
        const deltas = [];
        while (!item.done) {
          deltas.push(item.value);
          item = await next();
        }
        signal.throwIfAborted();
        sendJson(res, 200, {
          id, object: 'chat.completion', created, model: input.model,
          choices: [{ index: 0, message: { role: 'assistant', content: deltas.join('') }, finish_reason: 'stop' }],
        });
      }
    } catch (error) {
      if (!signal.aborted) controller.abort(error);
      sendError(res, signal.aborted ? signal.reason : error);
    } finally {
      release();
      signal.removeEventListener('abort', release);
      req.removeListener('aborted', disconnected);
      res.removeListener('close', closed);
      res.removeListener('error', disconnected);
      if (iterator && !iteratorDone && typeof iterator.return === 'function') {
        // A pending next() may ignore Abort; iterator cleanup must not hold a slot.
        try { Promise.resolve(iterator.return()).catch(() => {}); } catch {}
      }
    }
  }

  const server = createHttpServer((req, res) => {
    const dispatch = async () => {
      const path = req.url?.split('?', 1)[0];
      if (req.method === 'GET' && path === '/health') {
        const ready = provider.ready === true;
        return sendJson(res, 200, { status: ready ? 'ok' : 'not_ready', ready });
      }
      const modelsRoute = req.method === 'GET' && path === '/v1/models';
      const chatRoute = req.method === 'POST' && path === '/v1/chat/completions';
      if (!modelsRoute && !chatRoute) throw new HttpError(404, 'not_found', 'Route not found.');
      authenticate(req);
      requireReady(provider);
      if (modelsRoute) {
        return sendJson(res, 200, {
          object: 'list', data: getModels(provider).map(id => ({ id, object: 'model', owned_by: 'local' })),
        });
      }
      await chat(req, res);
    };
    dispatch().catch(error => {
      req.resume();
      sendError(res, error);
    });
  });
  return server;
}
