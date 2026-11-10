# RapidOCR — pure Node.js port (no Python)

A faithful port of the **RapidOCR (PP-OCRv3)** CPU OCR pipeline to Node.js.
It runs the full `detect → angle-classify → recognize` stack on PNG/JPEG files
with **zero Python** and **no native compilation step**.

The port was written directly against the Python reference implementation in
`bench/.venv/Lib/site-packages/rapidocr_onnxruntime/` and reproduces its output
**byte for byte** (text *and* confidence scores) on the benchmark images.

## Quick start

```bash
cd bench/node
npm install                 # 4 runtime dependencies, no build tools required
node cli/ocr.js ../samples/zh_en_800x600.png
node cli/ocr.js ../samples/zh_en_800x600.png --json
npm run bench               # writes report_node.json / report_node.md
```

## Runtime dependencies (the whole deployment cost)

| package | why | native build? |
|---|---|---|
| `onnxruntime-node` ^1.31.1 | runs the three PP-OCRv3 ONNX models | no — prebuilt binaries |
| `@techstark/opencv-js` ^5.0.0-release.1 | OpenCV 5.0.0 compiled to WASM: `resize`, `warpPerspective`, `findContours`, `minAreaRect`, `fillPoly`, `dilate`, `getPerspectiveTransform` | no — WASM |
| `pngjs` ^7.0.0 | pure-JS PNG decoder | no — pure JS |
| `clipper-lib` ^6.4.2 | JS port of Clipper 6.4.2 (the library `pyclipper` wraps) for the DB `unclip` polygon expansion | no — pure JS |

The Python reference uses `opencv-python 5.0.0`; `opencv-js 5.0.0` is the same
OpenCV release, so `resize` / `warpPerspective` / `findContours` / `minAreaRect`
produce identical pixels.

## Layout

```
src/
  ocr.js            RapidOCR orchestration (port of rapid_ocr_api.py)
  det.js            DBNet detection + DB post-processing (port of ch_ppocr_v3_det/*)
  cls.js            180°/0° angle classifier (port of ch_ppocr_v2_cls/*)
  rec.js            CRNN recognition + CTC greedy decode (port of ch_ppocr_v3_rec/*)
  geometry.js       polygon offsetting ("unclip") via clipper-lib
  image.js          PNG decode -> RGB Mat (mirrors utils.LoadImage)
  onnxMetadata.js   minimal ONNX protobuf reader for the embedded char dictionary
  matops.js         np.rot90 / cv2.rotate equivalents
  sessionOptions.js ORT session options identical to the Python reference
  util.js           NumPy/CPython semantics helpers (round-half-even, splitlines, ...)
cli/ocr.js          CLI: OCR one image
tools/bench_node.js benchmark harness -> report_node.json / report_node.md
```

## Notable fidelity details

* **Detection preprocessing** — `limit_side_len: 736`, `limit_type: min`,
  Python-style `round()` (half-to-even) for the multiple-of-32 sizing, RGB
  order with ImageNet mean/std, `/255` as `float32`, CHW layout.
* **DB post-processing** — `thresh 0.3`, `box_thresh 0.5`, `unclip_ratio 1.6`,
  `max_candidates 1000`, `score_mode: fast`, 2×2 dilation, `findContours`
  with `RETR_LIST`/`CHAIN_APPROX_SIMPLE`, `minAreaRect` mini-boxes, `fillPoly`
  score mask.
* **`unclip`** — shoelace area / perimeter → offset distance, then Clipper
  6.4.2 offset with round joins. `pyclipper` truncates path coordinates and
  rounds the distance half-away-from-zero; the port does the same.
* **Crops** — perspective warp with `INTER_CUBIC` + `BORDER_REPLICATE`, then
  `np.rot90` when `h/w >= 1.5`.
* **Classifier** — `[3,48,192]`, `cls_thresh 0.9`, labels `0`/`180`,
  `cv2.ROTATE_90_CLOCKWISE` when flipped.
* **Recognizer** — `[3,48,W]` with `W = int(48 * max_wh_ratio)`, aspect-preserving
  resize, `/255` then `(x-0.5)/0.5`, padding to the batch width.
* **CTC decode** — character list from the ONNX metadata, `' '` appended,
  `'blank'` prepended (blank = index 0), duplicate removal over the *previous
  timestep* (not the previous emitted character), mean confidence with the
  `1e-50` epsilon.
* **Character dictionary** — `onnxruntime-node` has no metadata API, so
  `src/onnxMetadata.js` parses the ONNX `ModelProto.metadata_props` directly
  (pure JS protobuf scan). The extracted 6623 characters are identical to
  Python's `session.get_character_list()`.

## Models

The three ONNX files are reused from the plugin bundle, so the repository
stores only one copy of the 13 MB of weights:

```
packages/dsh-rapidocr/models/
```

The loader checks, in order: `bench/node/src/models`, `bench/node/models`
(optional local override), `packages/dsh-rapidocr/models`, and finally the
RapidOCR Python package inside the venv:

```
bench/.venv/Lib/site-packages/rapidocr_onnxruntime/models/
```

Override with `--model-dir <path>` (the CLI) or `new RapidOCR({ modelDir })`.

## Known gaps / caveats

* `js-angusj-clipper` (WASM) was tried first but its WASM build returns empty
  offset solutions under Node 24, so `clipper-lib` is used instead.
* `cv.boxPoints` returns a plain `{x,y}[]` array in OpenCV.js 5 (not a Mat);
  the port handles both shapes.
* Peak RSS is ~550 MB for the 800×600 … 1920×1080 samples and ~1.8 GB for a
  2480×3508 300-dpi scan; ORT's CPU arena is disabled (as in the Python
  reference) which roughly halves it.
* Only PNG/JPEG are decoded (pngjs). WebP/AVIF would need another decoder.
