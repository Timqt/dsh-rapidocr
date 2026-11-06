"""Probe pyclipper 1.4.0 coordinate/delta rounding semantics."""
import json
import os
import sys

BENCH = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(BENCH, ".venv", "Lib", "site-packages"))

import pyclipper  # noqa: E402


def expand(points, distance):
    offset = pyclipper.PyclipperOffset()
    offset.AddPath(points, pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    return [[[float(x), float(y)] for x, y in p] for p in offset.Execute(distance)]


cases = [
    # integer box, fractional deltas around .5
    ([(0, 0), (100, 0), (100, 10), (0, 10)], 7.4),
    ([(0, 0), (100, 0), (100, 10), (0, 10)], 7.5),
    ([(0, 0), (100, 0), (100, 10), (0, 10)], 7.6),
    # fractional box coordinates
    ([(0.4, 0.4), (100.4, 0.4), (100.4, 10.4), (0.4, 10.4)], 8.0),
    ([(0.6, 0.6), (100.6, 0.6), (100.6, 10.6), (0.6, 10.6)], 8.0),
    # rotated box
    ([(10.0, 0.0), (60.0, 50.0), (50.0, 60.0), (0.0, 10.0)], 8.0),
]

out = []
for pts, d in cases:
    res = expand(pts, d)
    xs = [p[0] for p in res[0]] if res else []
    ys = [p[1] for p in res[0]] if res else []
    out.append({"points": pts, "distance": d, "expanded": res})
    print("d=", d, "pts=", pts, "->", len(res[0]) if res else 0, "pts,",
          "xrange", (min(xs), max(xs)) if xs else None,
          "yrange", (min(ys), max(ys)) if ys else None)
    print("   ", res[0][:6] if res else None)

with open(os.path.join(BENCH, "node", "tools", "pyclipper_probe.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, indent=1)
