'use strict';
/**
 * Text detection: DBNet (PP-OCRv3 det) + RapidOCR DB post-processing.
 *
 * Faithful port of
 *   rapidocr_onnxruntime/ch_ppocr_v3_det/text_detect.py
 *   rapidocr_onnxruntime/ch_ppocr_v3_det/utils.py
 */
const { f32, pyRound, clip, norm2 } = require('./util');
const { unclip } = require('./geometry');
const { SESSION_OPTIONS } = require('./sessionOptions');

const DEFAULT_CFG = {
  limit_side_len: 736,
  limit_type: 'min',
  thresh: 0.3,
  box_thresh: 0.5,
  max_candidates: 1000,
  unclip_ratio: 1.6,
  use_dilation: true,
  score_mode: 'fast',
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  scale: 1 / 255,
};

class TextDetector {
  constructor(cv, ort, modelPath, cfg = {}) {
    this.cv = cv;
    this.ort = ort;
    this.cfg = Object.assign({}, DEFAULT_CFG, cfg);
    this.sessionPromise = ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
    this.inputName = null;
  }

  async ready() {
    if (!this.sessionPromise) return;
    const sess = await this.sessionPromise;
    this.session = sess;
    this.inputName = sess.inputNames[0];
  }

  /** DetResizeForTest.resize_image_type0 */
  resizeForTest(src) {
    const cv = this.cv;
    const limitSideLen = this.cfg.limit_side_len;
    const h = src.rows;
    const w = src.cols;
    let ratio;
    if (this.cfg.limit_type === 'max') {
      if (Math.max(h, w) > limitSideLen) {
        ratio = h > w ? limitSideLen / h : limitSideLen / w;
      } else {
        ratio = 1;
      }
    } else {
      if (Math.min(h, w) < limitSideLen) {
        ratio = h < w ? limitSideLen / h : limitSideLen / w;
      } else {
        ratio = 1;
      }
    }
    let resizeH = Math.trunc(h * ratio);
    let resizeW = Math.trunc(w * ratio);
    resizeH = Math.trunc(pyRound(resizeH / 32) * 32);
    resizeW = Math.trunc(pyRound(resizeW / 32) * 32);
    if (resizeW <= 0 || resizeH <= 0) return null;
    const dst = new cv.Mat();
    cv.resize(src, dst, new cv.Size(resizeW, resizeH), 0, 0, cv.INTER_LINEAR);
    return {
      mat: dst,
      ratioH: resizeH / h,
      ratioW: resizeW / w,
      shape: [h, w, resizeH / h, resizeW / w],
    };
  }

  /** NormalizeImage(order='hwc') + ToCHWImage */
  normalizeToCHW(mat) {
    const { mean, std, scale } = this.cfg;
    const H = mat.rows;
    const W = mat.cols;
    const data = mat.data; // CV_8UC3 interleaved
    const scale32 = f32(scale);
    const mean32 = mean.map((m) => f32(m));
    const std32 = std.map((s) => f32(s));
    const out = new Float32Array(3 * H * W);
    const plane = H * W;
    for (let c = 0; c < 3; c++) {
      const base = c * plane;
      const m = mean32[c];
      const s = std32[c];
      for (let i = 0, j = 0; i < plane; i++, j += 3) {
        let v = f32(data[j + c] * scale32);
        v = f32(v - m);
        v = f32(v / s);
        out[base + i] = v;
      }
    }
    return out;
  }

  /**
   * Run detection on an OpenCV Mat.
   * @returns {{boxes: Array<Array<[number,number]>>, elapse:number}}
   */
  async detect(imgMat) {
    const cv = this.cv;
    if (!this.session) await this.ready();

    const oriH = imgMat.rows;
    const oriW = imgMat.cols;

    const resized = this.resizeForTest(imgMat);
    if (!resized) return { boxes: [], elapse: 0 };

    const chw = this.normalizeToCHW(resized.mat);
    const tensor = new this.ort.Tensor('float32', chw, [
      1,
      3,
      resized.mat.rows,
      resized.mat.cols,
    ]);
    const start = process.hrtime.bigint();
    const outputs = await this.session.run({ [this.inputName]: tensor });
    const preds = outputs[this.session.outputNames[0]]; // [1,1,H,W]
    const predData = preds.data;
    const PH = resized.mat.rows;
    const PW = resized.mat.cols;

    // segmentation = pred > thresh  (pred[:, 0, :, :])
    const pp = this.cfg;
    const seg = new Uint8Array(PH * PW);
    for (let i = 0; i < PH * PW; i++) seg[i] = predData[i] > pp.thresh ? 1 : 0;

    // dilation with a 2x2 kernel of ones (cv2.dilate default anchor => offsets -1..0)
    let maskData = seg;
    if (pp.use_dilation) {
      const kernel = cv.matFromArray(2, 2, cv.CV_8UC1, new Uint8Array([1, 1, 1, 1]));
      const src = cv.matFromArray(PH, PW, cv.CV_8UC1, seg);
      const dst = new cv.Mat();
      cv.dilate(src, dst, kernel);
      maskData = dst.data.slice();
      src.delete();
      dst.delete();
      kernel.delete();
    }

    // findContours(RETR_LIST, CHAIN_APPROX_SIMPLE)
    const maskMat = cv.matFromArray(PH, PW, cv.CV_8UC1, maskData);
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(maskMat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const numContours = Math.min(contours.size(), pp.max_candidates);

    const boxes = [];
    for (let i = 0; i < numContours; i++) {
      const contour = contours.get(i);
      const { box, sside } = this.getMiniBoxes(contour);
      if (sside < 3) continue;
      const score = this.boxScoreFast(predData, PW, PH, box);
      if (pp.box_thresh > score) continue;
      const { expanded } = unclip(box, pp.unclip_ratio);
      if (!expanded.length) continue;
      const mini2 = this.getMiniBoxesFromPoints(expanded);
      if (!mini2) continue;
      if (mini2.sside < 3 + 2) continue;
      // scale back to source resolution
      const scaled = mini2.box.map((p) => [
        clip(pyRound(f32(f32(p[0] / PW) * oriW)), 0, oriW),
        clip(pyRound(f32(f32(p[1] / PH) * oriH)), 0, oriH),
      ]);
      boxes.push(scaled);
    }
    maskMat.delete();
    contours.delete();
    hierarchy.delete();
    resized.mat.delete();

    const elapse = Number(process.hrtime.bigint() - start) / 1e6;
    return { boxes, elapse };
  }

  /** DBPostProcess.get_mini_boxes */
  getMiniBoxes(contour) {
    return this.getMiniBoxesFromPoints(this.readPoints(contour));
  }

  readPoints(mat) {
    const pts = [];
    const isInt = mat.type() === this.cv.CV_32SC2;
    const data = isInt ? mat.data32S : mat.data32F;
    for (let i = 0; i < mat.rows; i++) {
      pts.push([data[i * 2], data[i * 2 + 1]]);
    }
    return pts;
  }

  getMiniBoxesFromPoints(points) {
    const cv = this.cv;
    if (!points.length) return null;
    const ptsMat = this.pointsToMat(points);
    const rect = cv.minAreaRect(ptsMat);
    ptsMat.delete();
    const boxPts = cv.boxPoints(rect);
    const pts = [];
    if (Array.isArray(boxPts)) {
      // OpenCV.js >= 5 returns a plain array of {x, y}
      for (const p of boxPts) pts.push([p.x, p.y]);
    } else {
      for (let i = 0; i < 4; i++) pts.push([boxPts.data32F[i * 2], boxPts.data32F[i * 2 + 1]]);
    }
    pts.sort((a, b) => a[0] - b[0]); // python: sorted(..., key=lambda x: x[0])
    let index1, index2, index3, index4;
    if (pts[1][1] > pts[0][1]) {
      index1 = 0;
      index4 = 1;
    } else {
      index1 = 1;
      index4 = 0;
    }
    if (pts[3][1] > pts[2][1]) {
      index2 = 2;
      index3 = 3;
    } else {
      index2 = 3;
      index3 = 2;
    }
    const box = [pts[index1], pts[index2], pts[index3], pts[index4]];
    const sside = Math.min(rect.size.width, rect.size.height);
    return { box, sside };
  }

  pointsToMat(points) {
    const cv = this.cv;
    const n = points.length;
    const arr = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      arr[i * 2] = points[i][0];
      arr[i * 2 + 1] = points[i][1];
    }
    return cv.matFromArray(n, 1, cv.CV_32FC2, arr);
  }

  /** DBPostProcess.box_score_fast */
  boxScoreFast(predData, PW, PH, box) {
    const cv = this.cv;
    let xmin = Infinity;
    let xmax = -Infinity;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const p of box) {
      if (p[0] < xmin) xmin = p[0];
      if (p[0] > xmax) xmax = p[0];
      if (p[1] < ymin) ymin = p[1];
      if (p[1] > ymax) ymax = p[1];
    }
    xmin = clip(Math.trunc(Math.floor(xmin)), 0, PW - 1);
    xmax = clip(Math.trunc(Math.ceil(xmax)), 0, PW - 1);
    ymin = clip(Math.trunc(Math.floor(ymin)), 0, PH - 1);
    ymax = clip(Math.trunc(Math.ceil(ymax)), 0, PH - 1);

    const mw = xmax - xmin + 1;
    const mh = ymax - ymin + 1;
    const mask = new cv.Mat(mh, mw, cv.CV_8UC1);
    mask.delete();

    // numpy: box[:,0] = box[:,0] - xmin ; astype(np.int32) truncates towards zero
    const pts = new Int32Array(8);
    for (let i = 0; i < 4; i++) {
      pts[i * 2] = Math.trunc(box[i][0] - xmin);
      pts[i * 2 + 1] = Math.trunc(box[i][1] - ymin);
    }
    const ptsMat = cv.matFromArray(4, 1, cv.CV_32SC2, pts);
    const ptsVec = new cv.MatVector();
    ptsVec.push_back(ptsMat);
    const maskMat = cv.matFromArray(mh, mw, cv.CV_8UC1, new Uint8Array(mh * mw));
    cv.fillPoly(maskMat, ptsVec, new cv.Scalar(1, 0, 0, 0), cv.LINE_8, 0);
    ptsMat.delete();
    ptsVec.delete();

    // cv2.mean(region, mask)
    let sum = 0;
    let count = 0;
    const mdata = maskMat.data;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (mdata[y * mw + x] !== 0) {
          sum += predData[(ymin + y) * PW + (xmin + x)];
          count++;
        }
      }
    }
    maskMat.delete();
    return count === 0 ? 0 : sum / count;
  }
}

/** TextDetector.filter_tag_det_res */
function filterTagDetRes(cv, boxes, imgH, imgW) {
  const out = [];
  for (const raw of boxes) {
    const box = orderPointsClockwise(raw);
    const clipped = box.map((p) => [
      Math.trunc(clip(p[0], 0, imgW - 1)),
      Math.trunc(clip(p[1], 0, imgH - 1)),
    ]);
    const rectWidth = Math.trunc(norm2(clipped[0][0], clipped[0][1], clipped[1][0], clipped[1][1]));
    const rectHeight = Math.trunc(norm2(clipped[0][0], clipped[0][1], clipped[3][0], clipped[3][1]));
    if (rectWidth <= 3 || rectHeight <= 3) continue;
    out.push(clipped);
  }
  return out;
}

/** TextDetector.order_points_clockwise */
function orderPointsClockwise(pts) {
  const xSorted = [...pts].sort((a, b) => a[0] - b[0]);
  const leftMost = xSorted.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const rightMost = xSorted.slice(2).sort((a, b) => a[1] - b[1]);
  return [leftMost[0], rightMost[0], rightMost[1], leftMost[1]];
}

/** RapidOCR.sorted_boxes */
function sortedBoxes(boxes) {
  const sorted = [...boxes].sort((a, b) => {
    const ay = a[0][1];
    const by = b[0][1];
    if (ay !== by) return ay - by;
    return a[0][0] - b[0][0];
  });
  for (let i = 0; i < sorted.length - 1; i++) {
    if (
      Math.abs(sorted[i + 1][0][1] - sorted[i][0][1]) < 10 &&
      sorted[i + 1][0][0] < sorted[i][0][0]
    ) {
      const tmp = sorted[i];
      sorted[i] = sorted[i + 1];
      sorted[i + 1] = tmp;
    }
  }
  return sorted;
}

module.exports = { TextDetector, filterTagDetRes, sortedBoxes, orderPointsClockwise };
