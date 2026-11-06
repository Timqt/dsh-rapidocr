'use strict';
/**
 * Image decoding (pure JS: pngjs + jpeg-js) -> OpenCV Mat (CV_8UC3, RGB).
 *
 * Mirrors rapidocr_onnxruntime.utils.LoadImage:
 *   * PIL loads the file as RGB (numpy array)
 *   * 4-channel images are composited over white
 *     (cvt_four_to_three: new_img = (bgr & a) + (~a))
 *
 * Two entry points share the very same pixel conversion helpers:
 *   * decodeImage(filePath)     - read a file from disk
 *   * decodeImageBuffer(buffer) - decode raw bytes already in memory
 */
const fs = require('fs');
const { PNG } = require('../vendor/node_modules/pngjs');
const jpeg = require('../vendor/node_modules/jpeg-js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Read the pixel dimensions straight out of the PNG header.
 *
 * A PNG always starts with the 8-byte signature followed by the IHDR chunk,
 * whose first two fields are the width and height as big-endian uint32. This
 * costs a handful of bytes and lets a decompression bomb be rejected *before*
 * the full RGBA buffer is allocated.
 * @param {Buffer} buf the raw file bytes.
 * @returns {{width:number,height:number}|undefined} the dimensions, or
 *   undefined when the header is not a readable IHDR.
 */
function probePngSize(buf) {
  // 8 signature + 4 length + 4 type + 8 width/height = 24 bytes.
  if (buf.length < 24) return undefined;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/**
 * Read the pixel dimensions straight out of a JPEG's first start-of-frame.
 *
 * Scans the marker segments from the start of the file. Any SOFn marker other
 * than the DHT/C8/CC markers carries the frame size: 2-byte height then
 * 2-byte width. Stops at the first start-of-scan, so this never walks the
 * actual entropy-coded data.
 * @param {Buffer} buf the raw file bytes.
 * @returns {{width:number,height:number}|undefined} the dimensions, or
 *   undefined when no frame header was found.
 */
function probeJpegSize(buf) {
  let offset = 2; // skip SOI
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    // Fill bytes (0xff) and markers without a length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return undefined; // reached the scan
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    // SOF0..SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/**
 * Read an image's pixel dimensions from its header without decoding it.
 * @param {Buffer|Uint8Array} buffer the raw file bytes.
 * @returns {{width:number,height:number}|undefined} the dimensions, or
 *   undefined when the container is unsupported or the header is unreadable.
 */
function probeImageSize(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length === 0) return undefined;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return probePngSize(buf);
  }
  if (buf.length >= JPEG_MAGIC.length && buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return probeJpegSize(buf);
  }
  return undefined;
}

/**
 * Composite RGBA bytes over white and drop the alpha channel.
 * Uses integer ops identical to cv2.bitwise_and / cv2.add.
 * @param {Uint8Array|Buffer} src RGBA bytes (4 per pixel)
 * @param {number} pixelCount number of pixels
 * @returns {Uint8Array} RGB bytes (3 per pixel)
 */
function rgbaToRgbOverWhite(src, pixelCount) {
  const out = new Uint8Array(pixelCount * 3);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    const a = src[i + 3];
    const na = 255 - a;
    out[j] = (src[i] & a) + na;
    out[j + 1] = (src[i + 1] & a) + na;
    out[j + 2] = (src[i + 2] & a) + na;
  }
  return out;
}

/**
 * Drop the alpha channel of an RGBA buffer without compositing.
 * @param {Uint8Array|Buffer} src RGBA bytes (4 per pixel)
 * @param {number} pixelCount number of pixels
 * @returns {Uint8Array} RGB bytes (3 per pixel)
 */
function rgbFromRgba(src, pixelCount) {
  const out = new Uint8Array(pixelCount * 3);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    out[j] = src[i];
    out[j + 1] = src[i + 1];
    out[j + 2] = src[i + 2];
  }
  return out;
}

/**
 * Replicate the grey channel of an RGBA buffer into R, G and B.
 * @param {Uint8Array|Buffer} src RGBA bytes (4 per pixel)
 * @param {number} pixelCount number of pixels
 * @returns {Uint8Array} RGB bytes (3 per pixel)
 */
function greyToRgb(src, pixelCount) {
  const out = new Uint8Array(pixelCount * 3);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    out[j] = src[i];
    out[j + 1] = src[i];
    out[j + 2] = src[i];
  }
  return out;
}

/**
 * Decode a PNG buffer into RGB bytes.
 *
 * pngjs always expands the file to 8-bit RGBA, so `png.data` carries four
 * bytes per pixel for every colour type. That makes the palette type (3) and
 * the alpha-carrying types (4, 6) all reachable with the same conversion.
 * @param {Buffer|Uint8Array} buf
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function decodePngBuffer(buf) {
  const png = PNG.sync.read(buf);
  const { width, height } = png;
  const src = png.data;
  const pixelCount = width * height;

  if (src.length !== pixelCount * 4) {
    throw new Error(
      `unexpected PNG pixel layout: expected ${pixelCount * 4} bytes, got ${src.length}`
    );
  }

  switch (png.colorType) {
    // 2 = truecolour: the RGB channels are already what we need.
    case 2:
      return { width, height, data: rgbFromRgba(src, pixelCount) };
    // 0 = greyscale (including 1/2/4/8/16-bit, which pngjs widens to 8-bit).
    case 0:
      return { width, height, data: greyToRgb(src, pixelCount) };
    // 3 = palette, already resolved into `src`; a tRNS chunk may supply alpha.
    // 4 = greyscale + alpha.
    // 6 = truecolour + alpha.
    // All three composite over white, the same rule cvt_four_to_three applies.
    case 3:
    case 4:
    case 6:
      return { width, height, data: rgbaToRgbOverWhite(src, pixelCount) };
    default:
      throw new Error(`unsupported PNG colour type ${png.colorType}`);
  }
}

/**
 * Decode a JPEG buffer into RGB bytes.
 * @param {Buffer|Uint8Array} buf
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function decodeJpegBuffer(buf) {
  const decoded = jpeg.decode(buf, {
    useTArray: true,
    formatAsRGBA: false,
  });
  const { width, height } = decoded;
  const src = decoded.data;
  const pixelCount = width * height;

  if (src.length === pixelCount * 4) {
    // 4 channels -> composite over white (same rule as the PNG path)
    return { width, height, data: rgbaToRgbOverWhite(src, pixelCount) };
  }
  if (src.length !== pixelCount * 3) {
    throw new Error(
      `unsupported JPEG pixel layout: expected ${pixelCount * 3} bytes, got ${src.length}`
    );
  }
  return { width, height, data: new Uint8Array(src) };
}

/**
 * Decode an image file into an RGB Uint8Array.
 * Kept behaviourally identical to the original PNG-only implementation:
 * the bytes are handed to the PNG decoder, so non-PNG files fail the same way.
 * Use decodeImageBuffer() when the format may be PNG *or* JPEG.
 * @param {string} filePath
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function decodeImage(filePath) {
  return decodePngBuffer(fs.readFileSync(filePath));
}

/**
 * Decode raw image bytes into an RGB Uint8Array.
 * The container is sniffed from the magic bytes; only PNG and JPEG are supported.
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function decodeImageBuffer(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length === 0) {
    throw new Error('empty image buffer');
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return decodePngBuffer(buf);
  }
  if (buf.length >= JPEG_MAGIC.length && buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return decodeJpegBuffer(buf);
  }
  throw new Error('unsupported image format: expected PNG or JPEG');
}

/** Wrap raw RGB bytes into an OpenCV Mat. */
function rgbToMat(cv, img) {
  return cv.matFromArray(img.height, img.width, cv.CV_8UC3, img.data);
}

module.exports = {
  decodeImage,
  decodeImageBuffer,
  decodePngBuffer,
  decodeJpegBuffer,
  probeImageSize,
  rgbToMat,
};
