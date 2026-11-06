'use strict';
/**
 * Text recognition (PP-OCRv3 rec) + CTC greedy decode.
 * Port of rapidocr_onnxruntime/ch_ppocr_v3_rec/{text_recognize.py,utils.py}
 */
const { f32, argsortStable, pySplitLines } = require('./util');
const { SESSION_OPTIONS } = require('./sessionOptions');

class CTCLabelDecode {
  /** @param {string[]} characterList */
  constructor(characterList) {
    const characterStr = characterList.slice();
    characterStr.push(' '); // python: self.character_str.append(' ')
    this.character = ['blank'].concat(characterStr); // python: add_special_char
  }

  /**
   * @param {Float32Array} preds [N,T,C]
   * @param {number[]} offsets per-batch offset into preds
   * @param {number} T
   * @param {number} C
   */
  decodeBatch(preds, offsets, T, C) {
    const results = [];
    for (let b = 0; b < offsets.length; b++) {
      const base = offsets[b];
      const chars = [];
      const confs = [];
      let prev = -1;
      for (let t = 0; t < T; t++) {
        let best = 0;
        let bestVal = -Infinity;
        const row = base + t * C;
        for (let c = 0; c < C; c++) {
          const v = preds[row + c];
          if (v > bestVal) {
            bestVal = v;
            best = c;
          }
        }
        if (best === 0) {
          // blank -> skipped, but duplicates still compare against the previous index
          prev = best;
          continue;
        }
        if (t > 0 && best === prev) {
          prev = best;
          continue;
        }
        chars.push(this.character[best]);
        confs.push(bestVal);
        prev = best;
      }
      const text = chars.join('');
      const all = confs.concat([1e-50]);
      let sum = 0;
      for (const c of all) sum += c;
      results.push([text, sum / all.length]);
    }
    return results;
  }
}

class TextRecognizer {
  constructor(cv, ort, modelPath, characterList, cfg = {}) {
    this.cv = cv;
    this.ort = ort;
    this.cfg = Object.assign({ rec_img_shape: [3, 48, 320], rec_batch_num: 6 }, cfg);
    this.postprocess = new CTCLabelDecode(characterList);
    this.sessionPromise = ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
  }

  async ready() {
    if (!this.sessionPromise) return;
    this.session = await this.sessionPromise;
    this.inputName = this.session.inputNames[0];
  }

  /** TextRecognizer.resize_norm_img */
  resizeNormImg(mat, maxWhRatio) {
    const cv = this.cv;
    const [imgChannel, imgHeight] = this.cfg.rec_img_shape;
    const imgWidth = Math.trunc(imgHeight * maxWhRatio);
    const h = mat.rows;
    const w = mat.cols;
    const ratio = w / h;
    const resizedW =
      Math.ceil(imgHeight * ratio) > imgWidth ? imgWidth : Math.ceil(imgHeight * ratio);

    const resized = new cv.Mat();
    cv.resize(mat, resized, new cv.Size(resizedW, imgHeight), 0, 0, cv.INTER_LINEAR);
    const src = resized.data;
    const out = new Float32Array(imgChannel * imgHeight * imgWidth);
    for (let c = 0; c < imgChannel; c++) {
      const base = c * imgHeight * imgWidth;
      for (let y = 0; y < imgHeight; y++) {
        for (let x = 0; x < resizedW; x++) {
          const px = src[(y * resizedW + x) * 3 + c];
          let v = f32(px / 255);
          v = f32(v - 0.5);
          v = f32(v / 0.5);
          out[base + y * imgWidth + x] = v;
        }
      }
    }
    resized.delete();
    return out;
  }

  /**
   * @param {Array<cv.Mat>} imgList
   * @returns {{results: Array<[string,number]>, elapse:number}}
   */
  async recognize(imgList) {
    if (!this.session) await this.ready();
    const num = imgList.length;
    const recRes = new Array(num).fill(['', 0.0]);
    if (num === 0) return { results: recRes, elapse: 0 };

    const widthList = imgList.map((m) => m.cols / m.rows);
    const indices = argsortStable(widthList, (i) => widthList[i]);

    const batchNum = this.cfg.rec_batch_num;
    const [, imgHeight] = this.cfg.rec_img_shape;
    let elapse = 0;
    for (let beg = 0; beg < num; beg += batchNum) {
      const end = Math.min(num, beg + batchNum);
      let maxWhRatio = 0;
      for (let ino = beg; ino < end; ino++) {
        const m = imgList[indices[ino]];
        const wh = (m.cols * 1.0) / m.rows;
        if (wh > maxWhRatio) maxWhRatio = wh;
      }
      const tensors = [];
      for (let ino = beg; ino < end; ino++) {
        tensors.push(this.resizeNormImg(imgList[indices[ino]], maxWhRatio));
      }
      const imgWidth = Math.trunc(imgHeight * maxWhRatio);
      const batch = new Float32Array(tensors.length * 3 * imgHeight * imgWidth);
      let off = 0;
      for (const t of tensors) {
        batch.set(t, off);
        off += t.length;
      }
      const tensor = new this.ort.Tensor('float32', batch, [
        tensors.length,
        3,
        imgHeight,
        imgWidth,
      ]);
      const start = process.hrtime.bigint();
      const outputs = await this.session.run({ [this.inputName]: tensor });
      const preds = outputs[this.session.outputNames[0]]; // [N,T,C]
      elapse += Number(process.hrtime.bigint() - start) / 1e6;

      const [, T, C] = preds.dims; // [N, T, C]
      const offsets = [];
      for (let rno = 0; rno < end - beg; rno++) {
        offsets.push(rno * T * C);
      }
      const decoded = this.postprocess.decodeBatch(preds.data, offsets, T, C);
      for (let rno = 0; rno < decoded.length; rno++) {
        recRes[indices[beg + rno]] = decoded[rno];
      }
    }
    return { results: recRes, elapse };
  }
}

module.exports = { TextRecognizer, CTCLabelDecode };
