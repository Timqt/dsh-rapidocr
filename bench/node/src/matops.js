'use strict';
/**
 * Small Mat helpers implemented on raw pixel data (uint8 RGB, CV_8UC3).
 */

/** np.rot90(m): rotate counter-clockwise.  out[i][j] = m[j][w-1-i] */
function rot90CCW(cv, mat) {
  const h = mat.rows;
  const w = mat.cols;
  const src = mat.data;
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      const s = (j * w + (w - 1 - i)) * 3;
      const d = (i * h + j) * 3;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
    }
  }
  return cv.matFromArray(w, h, cv.CV_8UC3, out);
}

/** cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE): out[i][j] = m[h-1-j][i] */
function rotate90Clockwise(cv, mat) {
  const h = mat.rows;
  const w = mat.cols;
  const src = mat.data;
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      const s = ((h - 1 - j) * w + i) * 3;
      const d = (i * h + j) * 3;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
    }
  }
  return cv.matFromArray(w, h, cv.CV_8UC3, out);
}

module.exports = { rot90CCW, rotate90Clockwise };
