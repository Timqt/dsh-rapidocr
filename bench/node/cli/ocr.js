#!/usr/bin/env node
'use strict';
/**
 * CLI: run the RapidOCR pipeline on an image and print the recognized lines.
 *
 *   node cli/ocr.js <image.png> [--json] [--model-dir <dir>]
 */
const path = require('path');
const ort = require('onnxruntime-node');
const { RapidOCR } = require('../src/ocr');

async function main() {
  const args = process.argv.slice(2);
  const imagePath = args.find((a) => !a.startsWith('--'));
  if (!imagePath) {
    console.error('usage: node cli/ocr.js <image.png> [--json] [--model-dir <dir>]');
    process.exit(2);
  }
  const asJson = args.includes('--json');
  const modelDirIdx = args.indexOf('--model-dir');
  const modelDir = modelDirIdx >= 0 ? args[modelDirIdx + 1] : undefined;

  const cv = await require('@techstark/opencv-js');

  const t0 = process.hrtime.bigint();
  const engine = new RapidOCR({ cv, ort, modelDir });
  await engine.init();
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const t1 = process.hrtime.bigint();
  const { result, elapse } = await engine.call(path.resolve(imagePath));
  const totalMs = Number(process.hrtime.bigint() - t1) / 1e6;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          image: path.basename(imagePath),
          load_ms: Number(loadMs.toFixed(1)),
          total_ms: Number(totalMs.toFixed(1)),
          elapse: elapse,
          lines: (result || []).map((r) => ({
            box: r[0],
            text: r[1],
            score: Number(r[2]),
          })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`image      : ${path.basename(imagePath)}`);
  console.log(`load       : ${loadMs.toFixed(1)} ms`);
  console.log(
    `total      : ${totalMs.toFixed(1)} ms (det ${elapse[0].toFixed(1)} | cls ${elapse[1].toFixed(
      1
    )} | rec ${elapse[2].toFixed(1)})`
  );
  console.log(`lines      : ${result ? result.length : 0}`);
  if (result) {
    for (const row of result) {
      const box = row[0];
      const text = row[1];
      const score = row[2];
      const boxStr = box.map((p) => `${p[0]},${p[1]}`).join(' ');
      console.log(`  [${Number(score).toFixed(4)}] ${text}`);
      console.log(`      box: ${boxStr}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
