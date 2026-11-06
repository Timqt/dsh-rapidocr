// Debug crop + cls + rec stages.
const path = require('path');
const ort = require('onnxruntime-node');

async function run() {
  const cv = await require('@techstark/opencv-js');
  const { RapidOCR } = require('../src/ocr');
  const { decodeImage, rgbToMat } = require('../src/image');
  const { filterTagDetRes, sortedBoxes } = require('../src/det');

  const imgPath =
    process.argv[2] || path.join(__dirname, '..', '..', 'samples', 'zh_en_800x600.png');
  const engine = new RapidOCR({ cv, ort });
  await engine.init();

  const img = decodeImage(imgPath);
  const mat = rgbToMat(cv, img);
  const det = await engine.detector.detect(mat);
  const filtered = filterTagDetRes(cv, det.boxes, mat.rows, mat.cols);
  const sorted = sortedBoxes(filtered);
  console.log('boxes', JSON.stringify(sorted));

  const crops = engine.getCropImgList(mat, sorted);
  console.log('crop shapes', crops.map((c) => [c.rows, c.cols]).join(' '));
  console.log(
    'python crop shapes (zh_en):',
    [35, 464], [27, 419], [24, 328], [21, 415], [22, 258]
  );

  const cls = await engine.classifier.classify(crops);
  console.log('cls', JSON.stringify(cls.results));

  const rec = await engine.recognizer.recognize(cls.images);
  console.log('rec', JSON.stringify(rec.results));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
