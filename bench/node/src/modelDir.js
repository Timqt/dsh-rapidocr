'use strict';
/**
 * Locate the RapidOCR ONNX models used by the benchmark harness.
 *
 * Kept in its own module, with no heavyweight requires, so that the model
 * resolution can be tested without installing the benchmark's npm
 * dependencies (onnxruntime-node and OpenCV.js are ~300 MB unpacked).
 */
const path = require('path');
const fs = require('fs');

const DET_MODEL = 'ch_PP-OCRv3_det_infer.onnx';

/**
 * Candidate directories, in priority order.
 *
 * The plugin bundle ships the three models, so the repository stores only that
 * one copy; `bench/node/models` and `bench/node/src/models` stay available as
 * optional local overrides, and the Python RapidOCR package inside the venv is
 * the last resort.
 */
function modelDirCandidates() {
  return [
    path.join(__dirname, 'models'),
    path.join(__dirname, '..', 'models'),
    path.join(__dirname, '..', '..', '..', 'packages', 'dsh-rapidocr', 'models'),
    path.join(
      __dirname,
      '..',
      '..',
      '.venv',
      'Lib',
      'site-packages',
      'rapidocr_onnxruntime',
      'models'
    ),
  ];
}

/** Return the first candidate that actually contains the detection model. */
function defaultModelDir() {
  const candidates = modelDirCandidates();
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, DET_MODEL))) return dir;
  }
  throw new Error(
    'ONNX models not found. Looked in:\n' + candidates.map((c) => '  ' + c).join('\n')
  );
}

module.exports = { defaultModelDir, modelDirCandidates, DET_MODEL };
