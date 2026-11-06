'use strict';
/**
 * Small helpers that mirror NumPy / CPython semantics used by the RapidOCR
 * Python reference implementation.
 */

/** float32 rounding (matches numpy float32 arithmetic). */
const f32 = Math.fround;

/**
 * Python's round() / numpy round(): round-half-to-even.
 * numpy's rint() rounds halfway cases to the nearest even integer.
 */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** C/C++ std::round(): halfway cases away from zero (used by pyclipper). */
function cRound(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Python's str.splitlines(): splits on \n \r \r\n \v \f \x1c \x1d \x1e
 * \x85 \u2028 \u2029 (and does not produce a trailing empty element).
 */
function pySplitLines(str) {
  const out = [];
  let cur = '';
  const isBreak = (ch) =>
    ch === '\n' ||
    ch === '\r' ||
    ch === '\v' ||
    ch === '\f' ||
    ch === '\x1c' ||
    ch === '\x1d' ||
    ch === '\x1e' ||
    ch === '\x85' ||
    ch === '\u2028' ||
    ch === '\u2029';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\r') {
      out.push(cur);
      cur = '';
      if (str[i + 1] === '\n') i++;
    } else if (isBreak(ch)) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** numpy clip(value, lo, hi). */
function clip(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Euclidean norm of a 2D difference (numpy.linalg.norm on a 2-vector). */
function norm2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Stable sort by key (numpy argsort on small arrays is insertion sort => stable). */
function argsortStable(arr, keyFn) {
  const idx = arr.map((_, i) => i);
  idx.sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a - b;
  });
  return idx;
}

module.exports = { f32, pyRound, cRound, pySplitLines, clip, norm2, argsortStable };
