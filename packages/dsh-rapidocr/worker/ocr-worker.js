#!/usr/bin/env node
'use strict';
/**
 * OCR sidecar worker.
 *
 * Speaks JSON Lines on stdin/stdout:
 *
 *   -> {"id":"1","op":"ocr","image":"<base64>","mediaType":"image/png"}
 *   -> {"id":"1","op":"ping"}
 *   <- {"id":"1","ok":true,"text":"...","lines":[...],"elapse":[d,c,r],"totalMs":12.3}
 *   <- {"id":"1","ok":false,"error":"..."}
 *   <- {"event":"ready","loadMs":410.7}      (once, right after the engine is up)
 *
 * stdout carries protocol lines ONLY - every library log is routed to stderr.
 * The ONNX engine is loaded once and kept hot for the lifetime of the process;
 * requests are answered sequentially because the sessions are not re-entrant.
 */
const path = require('path');
const readline = require('readline');

/**
 * Load onnxruntime-node from the vendored copy.
 *
 * The vendored package is pruned to the win32/x64 native binaries, so its
 * public entry point (dist/index.js) may be missing. When that happens the
 * public API is rebuilt from onnxruntime-common plus the vendored backend -
 * exactly what onnxruntime-node/dist/index.js does.
 */
function loadOrt() {
  try {
    return require('../vendor/node_modules/onnxruntime-node');
  } catch (err) {
    const common = require('../vendor/node_modules/onnxruntime-common');
    const backend = require('../vendor/node_modules/onnxruntime-node/lib/backend');
    for (const supported of backend.listSupportedBackends()) {
      common.registerBackend(supported.name, backend.onnxruntimeBackend, 100);
    }
    return common;
  }
}

const ort = loadOrt();
const { RapidOCR } = require('../src/ocr');
const { probeImageSize } = require('../src/image');

const PACKAGE_ROOT = path.join(__dirname, '..');
const MODEL_DIR = path.join(PACKAGE_ROOT, 'models');

/**
 * Hard cap on the decoded pixel count, handed over by the host through the
 * environment. An explicit `0` disables the cap; when the variable is absent
 * the schema default is applied, so a Host that has not been reloaded since
 * the option was introduced is still protected.
 *
 * The host already caps the *bytes* it reads, but that does not bound memory:
 * a small, highly compressed PNG can decode into a huge RGBA buffer. The
 * header is therefore checked before the decode allocates anything, and the
 * pipeline checks the real dimensions again once they are known.
 */
const DEFAULT_MAX_PIXELS = 40000000;
const MAX_PIXELS = (() => {
  const raw = process.env.RAPIDOCR_MAX_PIXELS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_PIXELS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PIXELS;
  return parsed > 0 ? Math.floor(parsed) : 0;
})();

/* ------------------------------------------------------------------ *
 * stdout is reserved for the protocol: send every console message
 * that a library might emit to stderr instead.
 * ------------------------------------------------------------------ */
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);
/** Write a single protocol line to stdout. */
function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Flush stdout and exit with the given code. */
function safeExit(code) {
  try {
    process.stdout.write('', () => process.exit(code));
  } catch (_err) {
    process.exit(code);
  }
  // Fallback in case the write callback never fires.
  setTimeout(() => process.exit(code), 1000).unref();
}

/**
 * Decode a base64 image payload.
 * @param {string} value
 * @returns {Buffer}
 */
function decodeBase64(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('missing image payload');
  }
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error('invalid base64 image payload');
  }
  const buf = Buffer.from(compact, 'base64');
  if (buf.length === 0) {
    throw new Error('invalid base64 image payload');
  }
  return buf;
}

/**
 * Turn a pipeline result into the wire format.
 * @param {Array|null} result
 * @param {number[]} elapse
 * @param {number} totalMs
 */
function toResponsePayload(result, elapse, totalMs) {
  const lines = (result || []).map((row) => ({
    text: row[1],
    score: Number(row[2]),
    box: row[0].map((p) => [p[0], p[1]]),
  }));
  return {
    ok: true,
    text: lines.map((l) => l.text).join('\n'),
    lines,
    elapse: [elapse[0], elapse[1], elapse[2]],
    totalMs,
  };
}

/**
 * Create a worker instance around an already-initialised engine.
 * @param {object} engine a ready RapidOCR instance
 */
function createWorker(engine) {
  const queue = [];
  let running = false;
  let shuttingDown = false;
  let ready = false;

  async function pump() {
    if (running || !ready) return;
    running = true;
    try {
      while (queue.length > 0) {
        const req = queue.shift();
        await handle(req);
      }
    } finally {
      running = false;
      if (shuttingDown && queue.length === 0) safeExit(0);
    }
  }

  /**
   * Handle one request object and write the response line.
   * @param {object} req
   */
  async function handle(req) {
    const id = req && Object.prototype.hasOwnProperty.call(req, 'id') ? req.id : undefined;
    const op = req && req.op;

    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      writeLine({ id, ok: false, error: 'invalid request' });
      return;
    }
    if (op === 'ping') {
      writeLine({ id, ok: true, pong: true });
      return;
    }
    if (op !== 'ocr') {
      writeLine({ id, ok: false, error: 'unsupported operation' });
      return;
    }

    try {
      const buffer = decodeBase64(req.image);
      if (MAX_PIXELS > 0) {
        const size = probeImageSize(buffer);
        if (size !== undefined && size.width * size.height > MAX_PIXELS) {
          throw new Error(
            `the image is too large: ${size.width}x${size.height} ` +
              `(${size.width * size.height} pixels) exceeds the ${MAX_PIXELS} pixel limit`
          );
        }
      }
      const t0 = process.hrtime.bigint();
      const { result, elapse } = await engine.callBuffer(buffer);
      const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const payload = toResponsePayload(result, elapse, totalMs);
      writeLine(Object.assign({ id }, payload));
    } catch (err) {
      writeLine({
        id,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Feed one raw input line into the worker.
   * @param {string} line
   */
  function pushLine(line) {
    if (shuttingDown) return;
    const trimmed = line.trim();
    if (trimmed === '') return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (err) {
      writeLine({ ok: false, error: `invalid JSON: ${err.message}` });
      return;
    }
    queue.push(req);
    pump();
  }

  return {
    pushLine,
    /** Mark the engine as ready and start draining the queue. */
    setReady() {
      ready = true;
      pump();
    },
    /** Stop accepting work; exits once the queue is drained. */
    shutdown() {
      shuttingDown = true;
      if (!running && queue.length === 0) safeExit(0);
    },
    get pending() {
      return queue.length;
    },
  };
}

/**
 * Boot the worker: load the engine, announce readiness, then serve stdin.
 */
async function main() {
  // Read stdin from the very start so a request that arrives while the models
  // are still loading is captured instead of blocking the host's write.
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  /** @type {string[]} lines received before the engine was ready */
  const earlyLines = [];
  let worker = null;
  rl.on('line', (line) => {
    if (worker === null) earlyLines.push(line);
    else worker.pushLine(line);
  });
  rl.on('close', () => {
    if (worker !== null) worker.shutdown();
  });

  const cv = await require('../vendor/node_modules/@techstark/opencv-js');

  const t0 = process.hrtime.bigint();
  const engine = new RapidOCR({ cv, ort, modelDir: MODEL_DIR, maxPixels: MAX_PIXELS });
  await engine.init();
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;

  worker = createWorker(engine);

  const onSignal = () => {
    worker.shutdown();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // The ready event goes out before any queued request is answered.
  writeLine({ event: 'ready', loadMs: Number(loadMs.toFixed(1)) });
  worker.setReady();

  // Replay whatever arrived during the model load.
  for (const line of earlyLines) worker.pushLine(line);
  earlyLines.length = 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    safeExit(1);
  });
}

module.exports = { createWorker, decodeBase64, toResponsePayload, main, MODEL_DIR };
