# Changelog

All notable changes to `dsh-rapidocr` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-11-10

Repository and metadata fixes; no change to OCR behaviour or the tool contract.

### Fixed

- `package.json` `homepage` pointed at a `main` branch that does not exist; it now
  uses `master`, so the npm and market links resolve.
- Stale statements in the docs: `docs/implementation.md` claimed the repository
  had no commits, and the README described the plugin market in the future
  tense after it had already been listed.
- Absolute local paths in `docs/` and the Python benchmark transcript were
  replaced with placeholders (`%USERPROFILE%`, relative paths).
- `bench/node/package.json` declared `ISC` while the repository is Apache-2.0;
  it now matches, and the package is marked `private`.

### Changed

- The three ONNX models are no longer stored twice. `bench/` reuses
  `packages/dsh-rapidocr/models/`, which removes ~13 MB of duplicated, identical
  weights from the repository. The loader gained the plugin bundle as a
  fallback model directory.
- Removed the stale duplicate benchmark reports at `bench/report_node.{json,md}`
  (the canonical copies live in `bench/node/`).
- Declared `engines.node >=20` alongside the existing `engines.dsh` range.

### Added

- GitHub Actions CI: the sidecar selftest runs on Windows for Node 20/22/24, a
  vendored-layout integrity check guards the shipped binaries, and a job asserts
  that `dsh.bundle.patch`, `main` and the ONNX models are present in the
  `npm pack` tarball.
- `SECURITY.md` describing exactly what the plugin can and cannot do, and how to
  report a vulnerability privately.
- Open Plugin Market and license badges in the README.

## [0.1.0] — 2026-11-06

First public release, listed in the Open Plugin Market.

### Added

- A pure Node.js port of the RapidOCR / PP-OCRv3 pipeline (DBNet detection,
  direction classification, CRNN recognition with CTC decoding) on top of
  `onnxruntime-node` and OpenCV.js WASM, with no Python and no build step.
  Output matches the Python reference implementation line for line on the
  reference image set, and runs 15–25 % faster on the same machine.
- Host-only DSH bundle registering the model-facing `ocr_image` tool, with the
  engine in a warm sidecar process so inference never blocks the UI.
- All runtime dependencies and the 13 MB of ONNX weights vendored into the
  bundle: no npm dependencies, no build scripts, no install approvals.
- Schemastery configuration (`enabled`, `timeoutMs`, `maxImageBytes`,
  `maxPixels`, `maxTextChars`, `startTimeoutMs`) surfaced in *Settings → Plugins*.
- Input hardening: byte cap, and a pixel cap evaluated from the PNG/JPEG header
  before decoding, re-checked inside the sidecar.
- PNG (grayscale, truecolour, palette, RGBA, 16-bit) and JPEG (baseline,
  progressive, CMYK) decoding.
- Bilingual locale files, an original stroke icon, and a sidecar selftest that
  exercises the real JSON Lines protocol.

[0.1.1]: https://github.com/Timqt/dsh-rapidocr/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Timqt/dsh-rapidocr/releases/tag/v0.1.0
