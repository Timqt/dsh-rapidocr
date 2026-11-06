// Reproduce the order-dependent recognition difference (dense first, then screenshot).
const path = require('path');
const ort = require('onnxruntime-node');

async function run() {
  const cv = await require('@techstark/opencv-js');
  const { RapidOCR } = require('../src/ocr');
  const { decodeImage, rgbToMat } = require('../src/image');
  const { filterTagDetRes, sortedBoxes } = require('../src/det');

  const engine = new RapidOCR({ cv, ort });
  await engine.init();

  const samples = path.join(__dirname, '..', '..', 'samples');
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : [
    'dense_1920x1080.png',
    'screenshot_1280x720.png',
  ]) {
    const file = path.join(samples, name);
    const img = decodeImage(file);
    const mat = rgbToMat(cv, img);
    const det = await engine.detector.detect(mat);
    const sorted = sortedBoxes(filterTagDetRes(cv, det.boxes, mat.rows, mat.cols));
    const crops = engine.getCropImgList(mat, sorted);
    const cls = await engine.classifier.classify(crops);
    const rec = await engine.recognizer.recognize(cls.images);
    console.log(`\n== ${name} ==`);
    console.log('crop shapes', crops.map((c) => `${c.rows}x${c.cols}`).join(' '));
    console.log('cls', JSON.stringify(cls.results));
    for (const r of rec.results) console.log('  ', JSON.stringify(r));
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
