# Security policy

## What this plugin does with your machine

`dsh-rapidocr` is designed to be auditable and to stay inside the DSH sandbox.
In short:

| Capability | Behaviour |
|---|---|
| Network | **None.** The plugin makes no network calls at all. The OCR engine is local ONNX inference. |
| Files read | Only the image you pass to `ocr_image`, resolved through `ctx.fs` (`ctx.workingDirectory.ensure` → `ctx.fs.resolve` → `ctx.fs.readBytes`). Path authorisation stays with the host filesystem backend. |
| Files written | **None.** |
| Processes | One long-lived sidecar child process, spawned with `ctx.subprocess.spawn`, running the fixed in-package script `worker/ocr-worker.js`. The path is not configurable (an earlier configurable `workerPath` was removed on purpose). |
| Web routes | **None.** No `webServer` route is registered. |
| Credentials | None are read, stored or transmitted. |

Image bytes are handed to the sidecar over stdin/stdout using a JSON Lines
protocol, so no temporary file is created either.

Two limits are enforced on input, both configurable and both also re-checked
inside the sidecar: `maxImageBytes` (default 50 MiB) and `maxPixels` (default 40
million, checked from the PNG/JPEG header **before** decoding, because a small
compressed file can decode into a very large image).

## Supported versions

Security fixes land on `master` and are released as a new version. The plugin
market pins a specific commit or npm release, so please report the version you
are running.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private reporting flow:
<https://github.com/Timqt/dsh-rapidocr/security/advisories/new>

If that is unavailable, contact the maintainer through the GitHub profile
<https://github.com/Timqt> and mention "security" in the subject.

Please include the version, the platform, and a minimal reproduction. We aim to
acknowledge within 7 days.

## Scope notes

* Issues that require an attacker to already control the machine, the DSH
  profile, or the plugin's own files are generally out of scope.
* The bundle vendors third-party code (`onnxruntime-node`, `@techstark/opencv-js`,
  `pngjs`, `jpeg-js`, `clipper-lib`). Vulnerabilities in those upstream projects
  should be reported upstream; we will pick up patched versions. Attribution and
  licenses are listed in `packages/dsh-rapidocr/NOTICE`.
* The OCR models are Apache-2.0 PP-OCRv3 weights shipped with the package; they
  are data, not executable code, and are loaded by ONNX Runtime as model files.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
