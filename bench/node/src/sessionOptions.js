'use strict';
/**
 * ONNX Runtime session options, mirroring
 * rapidocr_onnxruntime/utils.py::OrtInferSession:
 *
 *   sess_opt.log_severity_level = 4
 *   sess_opt.enable_cpu_mem_arena = False
 *   sess_opt.graph_optimization_level = ORT_ENABLE_ALL
 */
const SESSION_OPTIONS = {
  logSeverityLevel: 4,
  enableCpuMemArena: false,
  graphOptimizationLevel: 'all',
  executionProviders: [{ name: 'cpu' }],
};

module.exports = { SESSION_OPTIONS };
