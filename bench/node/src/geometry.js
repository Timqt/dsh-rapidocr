'use strict';
/**
 * Polygon offsetting (the `unclip` step of the DB post-processing).
 *
 * The Python reference uses:
 *   shapely.geometry.Polygon(box).area / .length   -> offset distance
 *   pyclipper.PyclipperOffset().AddPath(box, JT_ROUND, ET_CLOSEDPOLYGON)
 *                                          .Execute(distance)
 *
 * pyclipper 1.4.0 wraps Clipper 6.4.2 (integer coordinates):
 *   * path coordinates are truncated towards zero
 *   * the offset distance is rounded half-away-from-zero
 *   * join type = round, end type = closed polygon, miter limit 2, arc tolerance 0.25
 *
 * `clipper-lib` is a JavaScript port of Clipper 6.4.2 and reproduces those
 * semantics; `js-angusj-clipper` (WASM) was rejected because its WASM build
 * returns empty solutions in this Node runtime.
 */
const C = require('clipper-lib');
const { clip, cRound } = require('./util');

/** shoelace area + perimeter of a closed polygon (shapely Polygon semantics). */
function polygonAreaLength(points) {
  let area2 = 0;
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area2 += x1 * y2 - x2 * y1;
    length += Math.hypot(x2 - x1, y2 - y1);
  }
  return { area: Math.abs(area2) / 2, length };
}

/**
 * Offset a closed polygon outwards by `distance` using round joins.
 * @param {Array<[number,number]>} points
 * @param {number} distance
 * @returns {Array<[number,number]>} expanded polygon (integer coordinates)
 */
function offsetPolygon(points, distance) {
  const path = points.map(
    (p) => new C.IntPoint(Math.trunc(p[0]), Math.trunc(p[1]))
  );
  const co = new C.ClipperOffset(2, 0.25);
  co.AddPath(path, C.JoinType.jtRound, C.EndType.etClosedPolygon);
  const solution = new C.Paths();
  co.Execute(solution, cRound(distance));
  if (!solution || solution.length === 0) return [];
  // pyclipper returns the first path (np.array(offset.Execute(distance)))
  return solution[0].map((p) => [p.X, p.Y]);
}

/** RapidOCR DBPostProcess.unclip */
function unclip(points, unclipRatio) {
  const { area, length } = polygonAreaLength(points);
  const distance = (area * unclipRatio) / length;
  const expanded = offsetPolygon(points, distance);
  return { distance, expanded };
}

module.exports = { unclip, offsetPolygon, polygonAreaLength, clip };
