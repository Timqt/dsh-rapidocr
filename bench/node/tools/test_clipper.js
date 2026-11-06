// Parity check: clipper-lib (Clipper 6.4.2 port) vs pyclipper 1.4.0 expansion.
const fs = require('fs');
const path = require('path');
const C = require('clipper-lib');

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'clipper_ref.json'), 'utf8'));

function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function expand(points, distance, coordMode, deltaMode) {
  const coordConv = coordMode === 'round' ? pyRound : Math.trunc;
  const deltaConv = deltaMode === 'round' ? pyRound : Math.trunc;
  const p = points.map((q) => new C.IntPoint(coordConv(q[0]), coordConv(q[1])));
  const co = new C.ClipperOffset(2, 0.25);
  co.AddPath(p, C.JoinType.jtRound, C.EndType.etClosedPolygon);
  const solution = new C.Paths();
  co.Execute(solution, deltaConv(distance));
  return solution.map((pp) => pp.map((q) => [q.X, q.Y]));
}

function compare(got, want) {
  if (!got || got.length !== want.length) return { same: false, maxDiff: NaN };
  let maxDiff = 0;
  for (let k = 0; k < got.length; k++) {
    const a = got[k];
    const w = want[k];
    if (!w || a.length !== w.length) return { same: false, maxDiff: NaN };
    for (let j = 0; j < a.length; j++) {
      maxDiff = Math.max(maxDiff, Math.abs(a[j][0] - w[j][0]), Math.abs(a[j][1] - w[j][1]));
    }
  }
  return { same: maxDiff === 0, maxDiff };
}

for (const coordMode of ['trunc', 'round']) {
  for (const deltaMode of ['trunc', 'round']) {
    const results = ref.map((row) => {
      const got = expand(row.mini, row.distance, coordMode, deltaMode);
      return compare(got, row.expanded);
    });
    const allSame = results.every((r) => r.same);
    console.log(
      `coord=${coordMode} delta=${deltaMode} allSame=${allSame} diffs=${results.map((r) => r.maxDiff).join(',')}`
    );
  }
}
