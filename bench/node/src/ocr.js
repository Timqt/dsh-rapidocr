'use strict';
/**
 * RapidOCR orchestration (pure Node port).
 *
 * Port of rapidocr_onnxruntime/rapid_ocr_api.py
 */
const path = require('path');
const fs = require('fs');

const { TextDetector, filterTagDetRes, sortedBoxes } = require('./det');
const { TextClassifier } = require('./cls');
const { TextRecognizer } = require('./rec');
const { decodeImage, rgbToMat } = require('./image');
const { rot90CCW } = require('./matops');
const { readModelMetadata } = require('./onnxMetadata');
const { pySplitLines, norm2 } = require('./util');

const GLOBAL_CFG = {
  text_score: 0.5,
  use_angle_cls: true,
  use_text_det: true,
  min_height: 30,
  width_height_ratio: 8,
};

/** Locate the bundled RapidOCR ONNX models. */
function defaultModelDir() {
  const candidates = [
    path.join(__dirname, 'models'),
    path.join(__dirname, '..', 'models'),
    // The plugin bundle ships the same three models; reuse them instead of
    // keeping a second 13 MB copy in the repository.
    path.join(__dirname, '..', '..', '..', 'packages', 'dsh-rapidocr', 'models'),
    path.join(
      __dirname,
      '..',
      '..',
      '.venv',
      'Lib',
      'site-packages',
      'rapidocr_onnxruntime',
      'models'
    ),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'ch_PP-OCRv3_det_infer.onnx'))) return dir;
  }
  throw new Error(
    'ONNX models not found. Looked in:\n' + candidates.map((c) => '  ' + c).join('\n')
  );
}

class RapidOCR {
  /**
   * @param {object} opts
   * @param {string} [opts.modelDir]
   * @param {object} [opts.global]
   * @param {object} [opts.det]
   * @param {object} [opts.cls]
   * @param {object} [opts.rec]
   */
  constructor(opts = {}) {
    this.cv = opts.cv;
    this.ort = opts.ort;
    this.global = Object.assign({}, GLOBAL_CFG, opts.global || {});
    const modelDir = opts.modelDir || defaultModelDir();

    this.detector = new TextDetector(
      this.cv,
      this.ort,
      path.join(modelDir, 'ch_PP-OCRv3_det_infer.onnx'),
      opts.det || {}
    );
    this.classifier = new TextClassifier(
      this.cv,
      this.ort,
      path.join(modelDir, 'ch_ppocr_mobile_v2.0_cls_infer.onnx'),
      opts.cls || {}
    );
    const metadata = readModelMetadata(
      path.join(modelDir, 'ch_PP-OCRv3_rec_infer.onnx')
    );
    if (!('character' in metadata)) {
      throw new Error('ONNX model metadata does not contain the "character" list');
    }
    this.characterList = pySplitLines(metadata.character);
    this.recognizer = new TextRecognizer(
      this.cv,
      this.ort,
      path.join(modelDir, 'ch_PP-OCRv3_rec_infer.onnx'),
      this.characterList,
      opts.rec || {}
    );
  }

  async init() {
    await Promise.all([
      this.detector.ready(),
      this.classifier.ready(),
      this.recognizer.ready(),
    ]);
    return this;
  }

  /** RapidOCR.get_crop_img_list */
  getCropImgList(imgMat, boxes) {
    const cv = this.cv;
    const crops = [];
    for (const box of boxes) {
      const p = box;
      const cropWidth = Math.trunc(
        Math.max(norm2(p[0][0], p[0][1], p[1][0], p[1][1]), norm2(p[2][0], p[2][1], p[3][0], p[3][1]))
      );
      const cropHeight = Math.trunc(
        Math.max(norm2(p[0][0], p[0][1], p[3][0], p[3][1]), norm2(p[1][0], p[1][1], p[2][0], p[2][1]))
      );
      const srcPts = new Float32Array(8);
      for (let i = 0; i < 4; i++) {
        srcPts[i * 2] = p[i][0];
        srcPts[i * 2 + 1] = p[i][1];
      }
      const dstPts = new Float32Array([
        0, 0,
        cropWidth, 0,
        cropWidth, cropHeight,
        0, cropHeight,
      ]);
      const srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, srcPts);
      const dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, dstPts);
      const M = cv.getPerspectiveTransform(srcMat, dstMat);
      srcMat.delete();
      dstMat.delete();
      const out = new cv.Mat();
      cv.warpPerspective(
        imgMat,
        out,
        M,
        new cv.Size(cropWidth, cropHeight),
        cv.INTER_CUBIC,
        cv.BORDER_REPLICATE
      );
      M.delete();
      let crop = out;
      if (out.rows * 1.0 / out.cols >= 1.5) {
        crop = rot90CCW(cv, out);
        out.delete();
      }
      crops.push(crop);
    }
    return crops;
  }

  /**
   * Run the full pipeline on an image file.
   * @param {string} imgPath
   * @returns {{result: Array<[Array<Array<number>>,string,string]>|null, elapse: number[]}}
   */
  async call(imgPath) {
    const cv = this.cv;
    const img = decodeImage(imgPath);
    const imgMat = rgbToMat(cv, img);
    const h = img.height;
    const w = img.width;

    let dtBoxes;
    let crops;
    let detElapse = 0.0;
    const useLimitRatio =
      this.global.width_height_ratio !== -1 &&
      w / h > this.global.width_height_ratio;

    if (!this.global.use_text_det || h <= this.global.min_height || useLimitRatio) {
      dtBoxes = [[[0, 0], [w, 0], [w, h], [0, h]]];
      crops = [imgMat];
    } else {
      const det = await this.detector.detect(imgMat);
      detElapse = det.elapse;
      const filtered = filterTagDetRes(cv, det.boxes, h, w);
      if (filtered.length === 0) return { result: null, elapse: [detElapse, 0, 0] };
      dtBoxes = sortedBoxes(filtered);
      crops = this.getCropImgList(imgMat, dtBoxes);
    }

    let clsElapse = 0.0;
    if (this.global.use_angle_cls) {
      const cls = await this.classifier.classify(crops);
      crops = cls.images;
      clsElapse = cls.elapse;
    }

    const rec = await this.recognizer.recognize(crops);

    const result = [];
    for (let i = 0; i < dtBoxes.length; i++) {
      const [text, score] = rec.results[i];
      if (score >= this.global.text_score) {
        result.push([dtBoxes[i], text, String(score)]);
      }
    }
    if (result.length === 0) return { result: null, elapse: [detElapse, clsElapse, rec.elapse] };
    return { result, elapse: [detElapse, clsElapse, rec.elapse] };
  }
}

module.exports = { RapidOCR, defaultModelDir, GLOBAL_CFG };
