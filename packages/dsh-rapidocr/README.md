# Local OCR for DeepSeek Harness

Recognises the text inside images **on this machine**, with no GPU, no network
call and no vision model. The plugin registers one model-facing tool,
`ocr_image`, so a text-only agent can read a screenshot, a scanned page or a
photo of a document.

## Why

A text-only model cannot look at an image. When a user attaches a screenshot
to a conversation, the model is told the file path but never sees the pixels.
`ocr_image` closes that gap locally: the image bytes are read by the host,
handed to a local ONNX OCR engine and returned as plain text.

* **Private** — images never leave the computer.
* **Cheap** — no vision-model tokens, no API call.
* **Offline** — the 13 MB of model weights ship with the plugin.
* **Fast** — a 1280×720 screen capture is recognised in roughly half a second
  on an ordinary 8-core desktop CPU.

## Platform support

Windows x64 only in this release: the vendored ONNX Runtime ships as a prebuilt
`onnxruntime.dll` for `win32/x64` (the OpenCV.js part is WASM and portable, the
inference backend is not). To run on another platform, drop the matching
`onnxruntime-node` binary into `vendor/node_modules/onnxruntime-node/bin/`.

## What it recognises

| Input | Result |
|---|---|
| PNG (all colour types, incl. palette / RGBA), JPEG (baseline + progressive) | up to 52 MB and 40 megapixels per image |
| Chinese, English, digits, common punctuation | 6623-character dictionary |
| 180°-rotated text | corrected automatically |
| Printed text | yes |
| Handwriting, photographs of text at a strong angle | no |
| Image *content* (what is in the picture, tables, charts) | no — this is OCR, not a vision model |

## How it works

```
agent  ->  ocr_image(file_path)  ->  Host plugin (index.js)
                                      |  resolves the path through ctx.fs
                                      |  (so path authorisation stays with the
                                      |   filesystem backend) and reads the bytes
                                      v
                                   sidecar worker (worker/ocr-worker.js)
                                      |  one warm ONNX engine, JSON Lines protocol
                                      v
                                   RapidOCR pipeline (src/)  ->  ONNX Runtime (CPU)
```

The engine runs in a **separate Node process** so that a one-second inference
never blocks the Electron UI. The process is started lazily on the first call
and stays warm, so the ~410 ms model load is paid once, not per image.

The pipeline is a faithful port of
[RapidOCR](https://github.com/RapidAI/RapidOCR) (PP-OCRv3: DBNet detection,
direction classification, CRNN recognition with CTC decoding). It reproduces
the Python reference implementation's output byte-for-byte on the reference
image set.

Everything is vendored under `vendor/`, so the bundle installs with **no npm
dependencies, no build script and no approval step**.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for the plugin. |
| `timeoutMs` | `120000` | Tool timeout. Raise it for very large scans. |
| `maxImageBytes` | `52428800` | Hard cap on the image file size. |
| `maxPixels` | `40000000` | Hard cap on decoded pixels (`width × height`). Byte size alone does not bound memory, because a small compressed file can decode into a very large image. |
| `maxTextChars` | `20000` | Recognised text is truncated beyond this. |
| `startTimeoutMs` | `30000` | How long to wait for the engine to report ready. |

## Performance

Measured on an Intel i7-10700F (8 cores / 16 threads, no GPU):

| Image | Warm latency | det / cls / rec |
|---|---|---|
| 1280×720 screenshot | 495 ms | 134 / 4 / 275 ms |
| 800×600 mixed text | 568 ms | 118 / 16 / 413 ms |
| 1920×1080 dense text | 1068 ms | 375 / 7 / 563 ms |
| A4 300 dpi scan (68 lines) | 9.3 s | 3058 / 52 / 10507 ms |

Cost scales with the number of text lines — roughly 120–210 ms per line. A
full-page scan is therefore seconds, not milliseconds; raise `timeoutMs` if you
feed it large documents.

## Layout

```
index.js              Host plugin: tool registration, sidecar lifecycle
worker/ocr-worker.js  Sidecar: JSON Lines protocol over stdin/stdout
worker/selftest.js    Sidecar smoke test (real child process, real protocol)
src/                  The RapidOCR pipeline port (det / cls / rec / geometry)
models/               PP-OCRv3 ONNX weights (13.07 MB)
vendor/               Vendored runtime dependencies (no npm install needed)
locale/, icon.svg     Display metadata
```

## Testing

```powershell
# sidecar round trip + reference text comparison
node worker/selftest.js ../../bench/samples/screenshot_1280x720.png

# the Host half: apply(), tool registration, warm reuse, disposer
node ../../bench/host-harness.mjs index.js ../../bench/samples/zh_en_800x600.png

# the pixel cap is actually plumbed to the sidecar
node ../../bench/check-cap.mjs index.js ../../bench/samples/screenshot_1280x720.png 100000
```

The reference images and their expected text live in `bench/samples/` and in
the `EXPECTED` table of `worker/selftest.js`.

## License

Apache-2.0. See `NOTICE` for the bundled third-party components.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
