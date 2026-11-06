'use strict';
/**
 * Angle classification (PP-OCRv2 cls).
 * Port of rapidocr_onnxruntime/ch_ppocr_v2_cls/{text_cls.py,utils.py}
 */
const { f32, argsortStable } = require('./util');
const { rotate90Clockwise } = require('./matops');
const { SESSION_OPTIONS } = require('./sessionOptions');

class TextClassifier {
  constructor(cv, ort, modelPath, cfg = {}) {
    this.cv = cv;
    this.ort = ort;
    this.cfg = Object.assign(
      { cls_image_shape: [3, 48, 192], cls_batch_num: 6, cls_thresh: 0.9, label_list: ['0', '180'] },
      cfg
    );
    this.sessionPromise = ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
  }

  async ready() {
    if (!this.sessionPromise) return;
    this.session = await this.sessionPromise;
    this.inputName = this.session.inputNames[0];
  }

  /** TextClassifier.resize_norm_img */
  resizeNormImg(mat) {
    const cv = this.cv;
    const [, imgH, imgW] = this.cfg.cls_image_shape;
    const h = mat.rows;
    const w = mat.cols;
    const ratio = w / h;
    let resizedW = Math.ceil(imgH * ratio) > imgW ? imgW : Math.ceil(imgH * ratio);
    const resized = new cv.Mat();
    cv.resize(mat, resized, new cv.Size(resizedW, imgH), 0, 0, cv.INTER_LINEAR);
    const data = resized.data;
    const plane = imgH * resizedW;
    const out = new Float32Array(3 * imgH * imgW);
    for (let c = 0; c < 3; c++) {
      const base = c * imgH * imgW;
      for (let y = 0; y < imgH; y++) {
        for (let x = 0; x < resizedW; x++) {
          const px = data[(y * resizedW + x) * 3 + c];
          let v = f32(px / 255);
          v = f32(v - 0.5);
          v = f32(v / 0.5);
          out[base + y * imgW + x] = v;
        }
      }
    }
    resized.delete();
    return out;
  }

  /**
   * @param {Array<cv.Mat>} imgList
   * @returns {{images: Array<cv.Mat>, results: Array<[string,number]>, elapse:number}}
   */
  async classify(imgList) {
    const cv = this.cv;
    if (!this.session) await this.ready();
    const images = imgList.slice();
    const num = images.length;
    const clsRes = new Array(num).fill(['0', 0.0]);
    if (num === 0) return { images, results: clsRes, elapse: 0 };

    const widthList = images.map((m) => m.cols / m.rows);
    const indices = argsortStable(widthList, (i) => widthList[i]);

    const batchNum = this.cfg.cls_batch_num;
    let elapse = 0;
    for (let beg = 0; beg < num; beg += batchNum) {
      const end = Math.min(num, beg + batchNum);
      const tensors = [];
      for (let ino = beg; ino < end; ino++) {
        const norm = this.resizeNormImg(images[indices[ino]]);
        tensors.push(norm);
      }
      const batch = new Float32Array(tensors.reduce((a, t) => a + t.length, 0));
      let off = 0;
      for (const t of tensors) {
        batch.set(t, off);
        off += t.length;
      }
      const [, imgH, imgW] = this.cfg.cls_image_shape;
      const tensor = new this.ort.Tensor('float32', batch, [end - beg, 3, imgH, imgW]);
      const start = process.hrtime.bigint();
      const outputs = await this.session.run({ [this.inputName]: tensor });
      const prob = outputs[this.session.outputNames[0]]; // [N,2]
      elapse += Number(process.hrtime.bigint() - start) / 1e6;

      for (let rno = 0; rno < end - beg; rno++) {
        const idx = indices[beg + rno];
        const p0 = prob.data[rno * 2];
        const p1 = prob.data[rno * 2 + 1];
        const argmax = p1 > p0 ? 1 : 0;
        const label = this.cfg.label_list[argmax];
        const score = argmax === 1 ? p1 : p0;
        clsRes[idx] = [label, score];
        if (label.includes('180') && score > this.cfg.cls_thresh) {
          images[idx] = rotate90Clockwise(cv, images[idx]);
        }
      }
    }
    return { images, results: clsRes, elapse };
  }
}

module.exports = { TextClassifier };
