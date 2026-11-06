// Debug the recognition stage (tensor layout / decode).
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
  const sorted = sortedBoxes(filterTagDetRes(cv, det.boxes, mat.rows, mat.cols));
  const crops = engine.getCropImgList(mat, sorted);
  const cls = await engine.classifier.classify(crops);

  const rec = engine.recognizer;
  console.log('rec session inputs', rec.session.inputNames, 'outputs', rec.session.outputNames);

  // replicate the first batch manually
  const m = cls.images[0];
  const maxWhRatio = m.cols / m.rows;
  const imgWidth = Math.trunc(48 * maxWhRatio);
  console.log('crop', m.rows, m.cols, 'maxWhRatio', maxWhRatio, 'imgWidth', imgWidth);
  const norm = rec.resizeNormImg(m, maxWhRatio);
  console.log('norm len', norm.length, 'expected', 3 * 48 * imgWidth);
  console.log('norm sample', Array.from(norm.slice(0, 6)), 'max', Math.max(...norm.slice(0, 1000)));
  const tensor = new ort.Tensor('float32', norm, [1, 3, 48, imgWidth]);
  const out = await rec.session.run({ [rec.inputName]: tensor });
  const preds = out[rec.session.outputNames[0]];
  console.log('preds dims', preds.dims, 'len', preds.data.length);
  const [, T, C] = preds.dims;
  const idx = [];
  for (let t = 0; t < Math.min(T, 20); t++) {
    let best = 0;
    let bestVal = -Infinity;
    for (let c = 0; c < C; c++) {
      const v = preds.data[t * C + c];
      if (v > bestVal) {
        bestVal = v;
        best = c;
      }
    }
    idx.push(`${best}:${bestVal.toFixed(3)}`);
  }
  console.log('argmax per step', idx.join(' '));
  console.log('character count', rec.postprocess.character.length);
  console.log('decode', rec.postprocess.decodeBatch(preds.data, [0], T, C));

  // now the batched path
  const all = cls.images;
  const widthList = all.map((mm) => mm.cols / mm.rows);
  const indices = widthList.map((_, i) => i);
  indices.sort((a, b) => (widthList[a] - widthList[b]) || (a - b));
  let maxWh = 0;
  for (const i of indices) maxWh = Math.max(maxWh, widthList[i]);
  const batchWidth = Math.trunc(48 * maxWh);
  console.log('batch maxWh', maxWh, 'batchWidth', batchWidth);
  const tensors = indices.map((i) => rec.resizeNormImg(all[i], maxWh));
  const batch = new Float32Array(tensors.reduce((a, t) => a + t.length, 0));
  let off = 0;
  for (const t of tensors) {
    batch.set(t, off);
    off += t.length;
  }
  const bt = new ort.Tensor('float32', batch, [tensors.length, 3, 48, batchWidth]);
  const bout = await rec.session.run({ [rec.inputName]: bt });
  const bpreds = bout[rec.session.outputNames[0]];
  console.log('batch preds dims', bpreds.dims);
  const [, bT, bC] = bpreds.dims;
  for (let b = 0; b < tensors.length; b++) {
    const dec = rec.postprocess.decodeBatch(bpreds.data, [b * bT * bC], bT, bC);
    console.log('  batch item', b, JSON.stringify(dec));
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
