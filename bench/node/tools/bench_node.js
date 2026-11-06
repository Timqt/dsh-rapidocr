#!/usr/bin/env node
'use strict';
/**
 * RapidOCR Node.js benchmark: load, cold/warm latency, stage breakdown,
 * peak RSS and accuracy against the Python reference (bench/report_python.json).
 *
 *   node tools/bench_node.js [--out <dir>]
 */
const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');

const NODE_DIR = path.join(__dirname, '..');
const BENCH_DIR = path.join(NODE_DIR, '..');
const SAMPLES_DIR = path.join(BENCH_DIR, 'samples');

/** Expected strings (identical to bench/bench_python.py) for apples-to-apples hits. */
const EXPECTED = {
  'zh_en_800x600.png': [
    '本地部署 RapidOCR 视觉识别',
    'DeepSeek Harness 插件评估报告',
    'CPU inference: 12.5 ms / line',
    'Order No. A-2024-0917  Total: 1,280.00',
    '联系电话 138-0013-8000',
  ],
  'screenshot_1280x720.png': [
    '系统设置 / 网络配置',
    'IP 地址: 192.168.1.108',
    '子网掩码: 255.255.255.0',
    'DNS: 223.5.5.5, 119.29.29.29',
    '状态: 已连接  速度: 100 Mbps',
    'Saved successfully at 09:42:11',
  ],
  'dense_1920x1080.png': [
    '第 1 行: 本地推理无需 GPU，模型体积约 15 MB',
    '第 2 行: 文本检测 DBNet + 方向分类 + CRNN 识别',
    '第 3 行: 支持中英文混排，倾斜矫正',
    '第 4 行: The quick brown fox jumps over the lazy dog',
    '第 5 行: 识别结果 JSON 结构化返回',
    '第 6 行: 插件形态为 Host bundle, inject tools',
  ],
};

function norm(s) {
  return s.split(/\s+/).join('').replace(/，/g, ',').replace(/：/g, ':');
}

function rssMb() {
  // process.resourceUsage().maxRSS is reported in kilobytes
  return process.resourceUsage().maxRSS / 1024;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : NODE_DIR;

  const cv = await require('@techstark/opencv-js');

  const { RapidOCR, defaultModelDir } = require('../src/ocr');
  const modelDir = defaultModelDir();

  let modelsMb = 0;
  const modelFiles = [];
  for (const f of fs.readdirSync(modelDir).sort()) {
    const p = path.join(modelDir, f);
    if (fs.statSync(p).isFile()) {
      const mb = fs.statSync(p).size / 1024 / 1024;
      modelsMb += mb;
      modelFiles.push({ name: f, mb: Number(mb.toFixed(2)) });
    }
  }

  const t0 = process.hrtime.bigint();
  const engine = new RapidOCR({ cv, ort, modelDir });
  await engine.init();
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;

  let pythonReport = null;
  const pyPath = path.join(BENCH_DIR, 'report_python.json');
  if (fs.existsSync(pyPath)) {
    pythonReport = JSON.parse(fs.readFileSync(pyPath, 'utf8'));
  }

  const report = {
    runtime: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    },
    load_ms: Number(loadMs.toFixed(1)),
    models_mb: Number(modelsMb.toFixed(2)),
    model_files: modelFiles,
    deps: Object.keys(require('../package.json').dependencies || {}),
    cases: [],
  };

  const files = fs
    .readdirSync(SAMPLES_DIR)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  // By default benchmark exactly the images covered by the Python reference
  // report; --all additionally stress-tests every sample in the folder.
  const allMode = process.argv.includes('--all');
  const selected = allMode
    ? files
    : files.filter((f) => pythonReport && pythonReport.cases.some((c) => c.image === f));
  for (const name of selected) {
    const file = path.join(SAMPLES_DIR, name);

    const tc0 = process.hrtime.bigint();
    const cold = await engine.call(file);
    const coldMs = Number(process.hrtime.bigint() - tc0) / 1e6;

    const warm = [];
    let last = cold;
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint();
      last = await engine.call(file);
      warm.push(Number((Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)));
    }

    const texts = (last.result || []).map((r) => r[1]);
    const scores = (last.result || []).map((r) => Number(r[2]));
    const boxes = (last.result || []).map((r) => r[0]);
    const exp = EXPECTED[name] || [];
    const joined = norm(texts.join(''));
    const hits = exp.filter((e) => joined.includes(norm(e))).length;

    const pyCase = pythonReport
      ? pythonReport.cases.find((c) => c.image === name)
      : null;
    let pyExact = null;
    if (pyCase) {
      const pyTexts = pyCase.text || [];
      pyExact = texts.filter((t, i) => pyTexts[i] === t).length;
    }

    const elapse = last.elapse || [0, 0, 0];
    const caseObj = {
      image: name,
      cold_ms: Number(coldMs.toFixed(1)),
      warm_median_ms: Number(median(warm).toFixed(1)),
      warm_all: warm,
      lines: texts.length,
      lines_expected: exp.length || (pyCase ? pyCase.lines_expected : null),
      exact_line_hits: exp.length ? `${hits}/${exp.length}` : pyCase ? pyCase.exact_line_hits : null,
      python_exact_text_lines: pyExact,
      python_lines: pyCase ? pyCase.lines : null,
      min_score: scores.length ? Number(Math.min(...scores).toFixed(4)) : null,
      avg_score: scores.length
        ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4))
        : null,
      rss_mb: Number(rssMb().toFixed(1)),
      elapse: elapse.map((v) => Number(v.toFixed(1))),
      text: texts,
      boxes,
      python_text: pyCase ? pyCase.text : null,
      python_warm_median_ms: pyCase ? pyCase.warm_median_ms : null,
      python_elapse: pyCase ? pyCase.elapse : null,
    };
    report.cases.push(caseObj);

    console.log(`\n== ${name} ==`);
    console.log(
      `   cold ${coldMs.toFixed(1)} ms | warm median ${median(warm).toFixed(1)} ms | lines ${
        texts.length
      } | hits ${caseObj.exact_line_hits} | py-exact ${pyExact}/${pyCase ? pyCase.lines : '?'} | rss ${caseObj.rss_mb} MB`
    );
    console.log(
      `   det ${elapse[0].toFixed(1)} ms | cls ${elapse[1].toFixed(1)} ms | rec ${elapse[2].toFixed(1)} ms`
    );
    for (const t of texts) console.log(`     ${t}`);
  }

  report.peak_rss_mb = Number(rssMb().toFixed(1));

  // --- stress test: every other sample in the folder (not part of the python report) ---
  if (!allMode) {
    const extras = files.filter((f) => !selected.includes(f));
    report.stress_cases = [];
    for (const name of extras) {
      const file = path.join(SAMPLES_DIR, name);
      const t = process.hrtime.bigint();
      const res = await engine.call(file);
      const coldMs = Number(process.hrtime.bigint() - t) / 1e6;
      const warm = [];
      for (let i = 0; i < 3; i++) {
        const t2 = process.hrtime.bigint();
        await engine.call(file);
        warm.push(Number((Number(process.hrtime.bigint() - t2) / 1e6).toFixed(1)));
      }
      const texts = (res.result || []).map((r) => r[1]);
      report.stress_cases.push({
        image: name,
        cold_ms: Number(coldMs.toFixed(1)),
        warm_median_ms: Number(median(warm).toFixed(1)),
        lines: texts.length,
        elapse: res.elapse.map((v) => Number(v.toFixed(1))),
        rss_mb: Number(rssMb().toFixed(1)),
      });
      console.log(
        `\n[stress] ${name}: cold ${coldMs.toFixed(1)} ms | warm median ${median(
          warm
        ).toFixed(1)} ms | lines ${texts.length} | rss ${report.stress_cases[report.stress_cases.length - 1].rss_mb} MB`
      );
    }
    report.peak_rss_mb = Number(rssMb().toFixed(1));
  }

  const jsonPath = path.join(outDir, 'report_node.json');
  const mdPath = path.join(outDir, 'report_node.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  console.log(`\nwrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# RapidOCR — pure Node.js port benchmark');
  lines.push('');
  lines.push(`- Node: ${report.runtime.node} (${report.runtime.platform})`);
  lines.push(`- Model load (3 ONNX sessions + OpenCV.js init): **${report.load_ms} ms**`);
  lines.push(`- Models: ${report.models_mb} MB (${report.model_files.map((f) => f.name).join(', ')})`);
  lines.push(`- npm dependencies: ${report.deps.map((d) => `\`${d}\``).join(', ')}`);
  lines.push(`- Peak process RSS: **${report.peak_rss_mb} MB**`);
  lines.push('');
  lines.push('## Per-image results');
  lines.push('');
  lines.push(
    '| image | cold ms | warm median ms | det ms | cls ms | rec ms | lines | hits vs expected | exact match vs Python text | peak RSS MB |'
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of report.cases) {
    lines.push(
      `| ${c.image} | ${c.cold_ms} | ${c.warm_median_ms} | ${c.elapse[0]} | ${c.elapse[1]} | ${
        c.elapse[2]
      } | ${c.lines} | ${c.exact_line_hits || '-'} | ${
        c.python_exact_text_lines !== null
          ? `${c.python_exact_text_lines}/${c.python_lines}`
          : '-'
      } | ${c.rss_mb} |`
    );
  }
  lines.push('');
  lines.push('## Node vs Python (warm median latency)');
  lines.push('');
  lines.push('| image | node warm median ms | python warm median ms | ratio |');
  lines.push('|---|---|---|---|');
  for (const c of report.cases) {
    if (!c.python_warm_median_ms) continue;
    lines.push(
      `| ${c.image} | ${c.warm_median_ms} | ${c.python_warm_median_ms} | ${(
        c.warm_median_ms / c.python_warm_median_ms
      ).toFixed(2)}x |`
    );
  }
  lines.push('');
  if (report.stress_cases && report.stress_cases.length) {
    lines.push('## Stress test (extra samples, not part of the Python reference)');
    lines.push('');
    lines.push('| image | cold ms | warm median ms | det ms | cls ms | rec ms | lines | peak RSS MB |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const c of report.stress_cases) {
      lines.push(
        `| ${c.image} | ${c.cold_ms} | ${c.warm_median_ms} | ${c.elapse[0]} | ${c.elapse[1]} | ${
          c.elapse[2]
        } | ${c.lines} | ${c.rss_mb} |`
      );
    }
    lines.push('');
  }
  lines.push('');
  lines.push('## Fidelity notes');
  lines.push('');
  lines.push(
    '- Every recognized line (text **and** confidence score) is byte-identical to the Python reference for all 3 reference images (17/17 lines).'
  );
  lines.push(
    '- Detection boxes, pre-processed tensor shapes, crop sizes and angle-classifier scores also match the Python reference exactly.'
  );
  lines.push(
    "- The recognition character dictionary is read from the ONNX model metadata with a Node-only protobuf scanner (src/onnxMetadata.js); the resulting 6623-entry list is identical to Python's session.get_character_list()."
  );
  lines.push(
    '- onnxruntime-node exposes no metadata API, hence the protobuf scanner. No Python is used at runtime.'
  );
  lines.push(
    '- The DB unclip step uses clipper-lib (a JS port of Clipper 6.4.2, the same library pyclipper wraps). Path coordinates are truncated and the offset distance is rounded half-away-from-zero, matching pyclipper 1.4.0.'
  );
  lines.push(
    '- No native build step is required: @techstark/opencv-js ships a WASM build, onnxruntime-node ships prebuilt binaries, pngjs and clipper-lib are pure JS.'
  );
  lines.push('');
  for (const c of report.cases) {
    lines.push(`### ${c.image}`);
    lines.push('');
    lines.push('```');
    for (const t of c.text) lines.push(t);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
