// Memory profile: where does the RSS go?
const path = require('path');
const ort = require('onnxruntime-node');

async function run() {
  const rss = () => Number((process.resourceUsage().maxRSS / 1024).toFixed(1));
  const cur = () => Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
  console.log(`start          peak=${rss()} cur=${cur()}`);

  const cv = await require('@techstark/opencv-js');
  console.log(`opencv.js init peak=${rss()} cur=${cur()}`);

  const { RapidOCR } = require('../src/ocr');
  const engine = new RapidOCR({ cv, ort });
  await engine.init();
  console.log(`sessions init  peak=${rss()} cur=${cur()}`);

  const img = process.argv[2] || path.join(__dirname, '..', '..', 'samples', 'zh_en_800x600.png');
  for (let i = 0; i < 3; i++) {
    await engine.call(img);
    console.log(`run ${i}          peak=${rss()} cur=${cur()}`);
  }
  if (global.gc) global.gc();
  console.log(`after gc       peak=${rss()} cur=${cur()}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
