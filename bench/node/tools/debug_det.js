// Debug the detection stage against the Python reference dump.
const path = require('path');
const ort = require('onnxruntime-node');

async function run() {
const cv = await require('@techstark/opencv-js');
const { TextDetector, filterTagDetRes, sortedBoxes } = require('../src/det');
const { decodeImage, rgbToMat } = require('../src/image');
const { unclip } = require('../src/geometry');

const imgPath = process.argv[2] || path.join(__dirname, '..', '..', 'samples', 'zh_en_800x600.png');
const det = new TextDetector(cv, ort, path.join(
  __dirname,
  '..',
  '..',
  '.venv',
  'Lib',
  'site-packages',
  'rapidocr_onnxruntime',
  'models',
  'ch_PP-OCRv3_det_infer.onnx'
));
await det.ready();

const img = decodeImage(imgPath);
const mat = rgbToMat(cv, img);
console.log('src', mat.rows, mat.cols);

const resized = det.resizeForTest(mat);
console.log('resized', resized.mat.rows, resized.mat.cols, resized.shape);

const chw = det.normalizeToCHW(resized.mat);
const tensor = new ort.Tensor('float32', chw, [1, 3, resized.mat.rows, resized.mat.cols]);
const out = await det.session.run({ [det.inputName]: tensor });
const preds = out[det.session.outputNames[0]];
console.log('pred dims', preds.dims);

const PH = resized.mat.rows;
const PW = resized.mat.cols;
const predData = preds.data;

const seg = new Uint8Array(PH * PW);
for (let i = 0; i < PH * PW; i++) seg[i] = predData[i] > 0.3 ? 1 : 0;
let segCount = 0;
for (let i = 0; i < seg.length; i++) segCount += seg[i];
console.log('seg pixels', segCount);

const kernel = cv.matFromArray(2, 2, cv.CV_8UC1, new Uint8Array([1, 1, 1, 1]));
const src = cv.matFromArray(PH, PW, cv.CV_8UC1, seg);
const dst = new cv.Mat();
cv.dilate(src, dst, kernel);
let dCount = 0;
for (let i = 0; i < dst.data.length; i++) dCount += dst.data[i];
console.log('dilated pixels', dCount);

const maskMat = cv.matFromArray(PH, PW, cv.CV_8UC1, dst.data);
const contours = new cv.MatVector();
const hierarchy = new cv.Mat();
cv.findContours(maskMat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
console.log('contours', contours.size());

for (let i = 0; i < contours.size(); i++) {
  const c = contours.get(i);
  const mini = det.getMiniBoxes(c);
  const score = det.boxScoreFast(predData, PW, PH, mini.box);
  const { distance, expanded } = unclip(mini.box, 1.6);
  const mini2 = expanded.length ? det.getMiniBoxesFromPoints(expanded) : null;
  console.log(
    `  contour ${i}: sside=${mini.sside} score=${score} dist=${distance} expanded=${expanded.length} mini2=${mini2 ? JSON.stringify(mini2.box.map((p) => [Math.round(p[0]), Math.round(p[1])])) : null}`
  );
}

const res = await det.detect(mat);
console.log('detect boxes', res.boxes.length);
const filtered = filterTagDetRes(cv, res.boxes, mat.rows, mat.cols);
console.log('filtered', filtered.length, JSON.stringify(filtered));
console.log('sorted', JSON.stringify(sortedBoxes(filtered)));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
