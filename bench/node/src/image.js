'use strict';
/**
 * PNG decoding (pure JS, pngjs) -> OpenCV Mat (CV_8UC3, RGB).
 *
 * Mirrors rapidocr_onnxruntime.utils.LoadImage:
 *   * PIL loads the file as RGB (numpy array)
 *   * 4-channel images are composited over white
 *     (cvt_four_to_three: new_img = (bgr & a) + (~a))
 */
const fs = require('fs');
const { PNG } = require('pngjs');

/**
 * Decode an image file into an RGB Uint8Array.
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function decodeImage(filePath) {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);
  const { width, height } = png;
  const src = png.data;
  const out = new Uint8Array(width * height * 3);

  const hasAlpha = png.alpha === true || png.colorType === 6;
  if (!hasAlpha) {
    // PNG colour type 2 (truecolour) or 0 (greyscale) -> copy channels
    if (png.colorType === 2) {
      for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
        out[j] = src[i];
        out[j + 1] = src[i + 1];
        out[j + 2] = src[i + 2];
      }
    } else if (png.colorType === 0) {
      for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
        out[j] = src[i];
        out[j + 1] = src[i];
        out[j + 2] = src[i];
      }
    } else if (png.colorType === 4) {
      for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
        out[j] = src[i];
        out[j + 1] = src[i];
        out[j + 2] = src[i];
      }
    } else {
      throw new Error(`unsupported PNG colour type ${png.colorType}`);
    }
    return { width, height, data: out };
  }

  // RGBA -> RGB over white, using integer ops identical to cv2.bitwise_and/add
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    const a = src[i + 3];
    const na = 255 - a;
    out[j] = (src[i] & a) + na;
    out[j + 1] = (src[i + 1] & a) + na;
    out[j + 2] = (src[i + 2] & a) + na;
  }
  return { width, height, data: out };
}

/** Wrap raw RGB bytes into an OpenCV Mat. */
function rgbToMat(cv, img) {
  return cv.matFromArray(img.height, img.width, cv.CV_8UC3, img.data);
}

module.exports = { decodeImage, rgbToMat };
