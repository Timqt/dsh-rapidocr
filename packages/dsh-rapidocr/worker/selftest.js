#!/usr/bin/env node
'use strict';
/**
 * Local smoke test for the OCR sidecar.
 *
 *   node worker/selftest.js <image.png|jpg>
 *
 * Spawns worker/ocr-worker.js as a child process and exchanges real JSON
 * Lines over stdin/stdout, exactly the way the host will use it:
 *
 *   1. wait for {"event":"ready",...}
 *   2. {"id":"ping-1","op":"ping"}            -> {"id":"ping-1","ok":true,...}
 *   3. {"id":"ocr-1","op":"ocr","image":"<base64>","mediaType":"..."} -> {"id":"ocr-1","ok":true,...}
 *   4. {"id":"bad-1","op":"nope"}              -> {"id":"bad-1","ok":false,"error":"unsupported operation"}
 *
 * Exits non-zero when the protocol or the recognised text is wrong.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'ocr-worker.js');

/** Verified reference output (Python rapidocr_onnxruntime) for the bundled samples. */
const EXPECTED = {
  'screenshot_1280x720.png': [
    '系统设置／网络配置',
    'IP地址：192.168.1.108',
    '子网掩码：255.255.255.0',
    'DNS: 223.5.5.5, 119.29.29.29',
    '状态：已连接速度：100Mbps',
    'Saved successfully at 09:42:11',
  ],
  'zh_en_800x600.png': [
    '本地部署 RapidOCR 视觉识别',
    'DeepSeekHarness插件评估报告',
    'CPU inference: 12.5 ms / line',
    'Order No.A-2024-0917 Total:1,280.00',
    '联系电话138-0013-8000',
  ],
  'dense_1920x1080.png': [
    '第1行:本地推理无需 GPU，模型体积约 15 MB',
    '第 2 行:文本检测 DBNet +方向分类 + CRNN 识别',
    '第3行：支持中英文混排，倾斜矫正',
    '第 4 行: The quick brown fox jumps over the lazy dog',
    '第5行：识别结果JSON结构化返回',
    '第 6 行:插件形态为 Host bundle,inject tools',
  ],
  // Same picture saved as an 8-bit palette PNG (colour type 3). Palette
  // images used to fail outright with "unsupported PNG colour type 3"; the
  // recognised text must match the truecolour original.
  'palette_1280x720.png': [
    '系统设置／网络配置',
    'IP地址：192.168.1.108',
    '子网掩码：255.255.255.0',
    'DNS: 223.5.5.5, 119.29.29.29',
    '状态：已连接速度：100Mbps',
    'Saved successfully at 09:42:11',
  ],
};

/**
 * Shorten a request for the console echo: the base64 image payload is huge,
 * so it is replaced by a short marker. The line that is actually written to
 * the worker is always the full one.
 * @param {object} obj
 * @returns {string}
 */
function abbreviate(obj) {
  const copy = Object.assign({}, obj);
  if (typeof copy.image === 'string') {
    copy.image = `<base64 ${copy.image.length} chars>`;
  }
  return JSON.stringify(copy);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/**
 * Drive the worker child process over JSON Lines.
 * @param {string} imagePath
 */
function runWorker(imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pending = new Map();
    let readyEvent = null;
    let stdoutBuf = '';
    let stderrBuf = '';
    let finished = false;
    let closing = false;

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill('SIGKILL');
        reject(new Error('worker timed out after 180s'));
      }
    }, 180000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      process.stderr.write(chunk);
    });

    /** Register a request id we are waiting for. */
    function expect(id) {
      return new Promise((res) => pending.set(id, res));
    }

    /** Send a request and wait for the matching response. */
    async function request(obj) {
      const p = expect(obj.id);
      const line = JSON.stringify(obj);
      console.log('>> ' + abbreviate(obj));
      child.stdin.write(line + '\n');
      return p;
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.trim() === '') continue;
        console.log('<< ' + line);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          child.kill('SIGKILL');
          reject(new Error(`worker emitted a non-JSON line: ${line}`));
          return;
        }
        if (msg.event === 'ready') {
          readyEvent = msg;
          resolveReady();
          continue;
        }
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
    });

    let resolveReady;
    const readyPromise = new Promise((res) => {
      resolveReady = res;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!finished && !closing) {
        finished = true;
        reject(
          new Error(
            `worker exited early (code=${code}, signal=${signal})\n${stderrBuf}`
          )
        );
      }
    });

    (async () => {
      try {
        await readyPromise;
        if (!readyEvent) throw new Error('worker never became ready');

        const ping = await request({ id: 'ping-1', op: 'ping' });
        if (ping.ok !== true) throw new Error(`ping failed: ${JSON.stringify(ping)}`);

        const b64 = fs.readFileSync(imagePath).toString('base64');
        const mediaType = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';
        const ocr = await request({
          id: 'ocr-1',
          op: 'ocr',
          image: b64,
          mediaType,
        });
        if (ocr.ok !== true) throw new Error(`ocr failed: ${JSON.stringify(ocr)}`);

        const bad = await request({ id: 'bad-1', op: 'nope' });
        if (bad.ok !== false) throw new Error(`unknown op was not rejected: ${JSON.stringify(bad)}`);

        // A payload that is not decodable must fail with ok:false, not crash.
        const badImg = await request({
          id: 'bad-img-1',
          op: 'ocr',
          image: 'not-valid-base64!!',
          mediaType: 'image/png',
        });
        if (badImg.ok !== false) {
          throw new Error(`broken image was not rejected: ${JSON.stringify(badImg)}`);
        }

        // Graceful shutdown: closing stdin must let the worker exit with 0.
        closing = true;
        child.stdin.end();
        const exitCode = await new Promise((res) => child.on('exit', (code) => res(code)));
        if (exitCode !== 0) throw new Error(`worker exited with code ${exitCode}`);

        finished = true;
        clearTimeout(timer);
        resolve({ ready: readyEvent, ping, ocr, bad, badImg });
      } catch (err) {
        clearTimeout(timer);
        finished = true;
        child.kill('SIGKILL');
        reject(err);
      }
    })();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const imagePath = args.find((a) => !a.startsWith('--'));
  if (!imagePath) {
    console.error('usage: node worker/selftest.js <image.png|jpg>');
    process.exit(2);
  }
  const resolved = path.resolve(imagePath);
  if (!fs.existsSync(resolved)) fail(`image not found: ${resolved}`);

  const result = await runWorker(resolved);

  const { ready, ocr } = result;
  console.log('');
  console.log(`image        : ${path.basename(resolved)}`);
  console.log(`worker load  : ${ready.loadMs} ms`);
  console.log(
    `total        : ${ocr.totalMs.toFixed(1)} ms (det ${ocr.elapse[0].toFixed(
      1
    )} | cls ${ocr.elapse[1].toFixed(1)} | rec ${ocr.elapse[2].toFixed(1)})`
  );
  console.log(`lines        : ${ocr.lines.length}`);
  for (const line of ocr.lines) {
    console.log(`  [${line.score.toFixed(4)}] ${line.text}`);
    console.log(`      box: ${line.box.map((p) => `${p[0]},${p[1]}`).join(' ')}`);
  }
  console.log('');
  console.log('--- text ---');
  console.log(ocr.text);

  const expected = EXPECTED[path.basename(resolved)];
  if (expected) {
    const actual = ocr.lines.map((l) => l.text);
    const same =
      actual.length === expected.length && actual.every((t, i) => t === expected[i]);
    if (!same) {
      console.error('');
      console.error('FAIL: recognised text does not match the reference');
      console.error('expected: ' + JSON.stringify(expected, null, 2));
      console.error('actual  : ' + JSON.stringify(actual, null, 2));
      process.exit(1);
    }
    console.log('');
    console.log('OK: recognised text matches the verified reference');
  }
  console.log('OK: JSON Lines round trip via a spawned worker succeeded');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
