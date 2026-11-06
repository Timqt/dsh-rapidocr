# RapidOCR — pure Node.js port benchmark

- Node: v24.15.0 (win32 x64)
- Model load (3 ONNX sessions + OpenCV.js init): **410.7 ms**
- Models: 13.07 MB (ch_PP-OCRv3_det_infer.onnx, ch_PP-OCRv3_rec_infer.onnx, ch_ppocr_mobile_v2.0_cls_infer.onnx)
- npm dependencies: `@techstark/opencv-js`, `clipper-lib`, `onnxruntime-node`, `pngjs`
- Peak process RSS: **1768.9 MB**

## Per-image results

| image | cold ms | warm median ms | det ms | cls ms | rec ms | lines | hits vs expected | exact match vs Python text | peak RSS MB |
|---|---|---|---|---|---|---|---|---|---|
| dense_1920x1080.png | 1741.3 | 1067.9 | 375.2 | 7.4 | 562.7 | 6 | 6/6 | 6/6 | 553.1 |
| screenshot_1280x720.png | 844.2 | 494.6 | 134.2 | 3.7 | 275.2 | 6 | 5/6 | 6/6 | 553.1 |
| zh_en_800x600.png | 918.8 | 568.3 | 118 | 15.5 | 413.1 | 5 | 5/5 | 5/5 | 553.1 |

## Node vs Python (warm median latency)

| image | node warm median ms | python warm median ms | ratio |
|---|---|---|---|
| dense_1920x1080.png | 1067.9 | 1197.4 | 0.89x |
| screenshot_1280x720.png | 494.6 | 633.1 | 0.78x |
| zh_en_800x600.png | 568.3 | 668.6 | 0.85x |

## Stress test (extra samples, not part of the Python reference)

| image | cold ms | warm median ms | det ms | cls ms | rec ms | lines | peak RSS MB |
|---|---|---|---|---|---|---|---|
| a4_300dpi.png | 14553.9 | 9253.9 | 3058 | 52.4 | 10507.1 | 68 | 1768.9 |


## Fidelity notes

- Every recognized line (text **and** confidence score) is byte-identical to the Python reference for all 3 reference images (17/17 lines).
- Detection boxes, pre-processed tensor shapes, crop sizes and angle-classifier scores also match the Python reference exactly.
- The recognition character dictionary is read from the ONNX model metadata with a Node-only protobuf scanner (src/onnxMetadata.js); the resulting 6623-entry list is identical to Python's session.get_character_list().
- onnxruntime-node exposes no metadata API, hence the protobuf scanner. No Python is used at runtime.
- The DB unclip step uses clipper-lib (a JS port of Clipper 6.4.2, the same library pyclipper wraps). Path coordinates are truncated and the offset distance is rounded half-away-from-zero, matching pyclipper 1.4.0.
- No native build step is required: @techstark/opencv-js ships a WASM build, onnxruntime-node ships prebuilt binaries, pngjs and clipper-lib are pure JS.

### dense_1920x1080.png

```
第1行:本地推理无需 GPU，模型体积约 15 MB
第 2 行:文本检测 DBNet +方向分类 + CRNN 识别
第3行：支持中英文混排，倾斜矫正
第 4 行: The quick brown fox jumps over the lazy dog
第5行：识别结果JSON结构化返回
第 6 行:插件形态为 Host bundle,inject tools
```

### screenshot_1280x720.png

```
系统设置／网络配置
IP地址：192.168.1.108
子网掩码：255.255.255.0
DNS: 223.5.5.5, 119.29.29.29
状态：已连接速度：100Mbps
Saved successfully at 09:42:11
```

### zh_en_800x600.png

```
本地部署 RapidOCR 视觉识别
DeepSeekHarness插件评估报告
CPU inference: 12.5 ms / line
Order No.A-2024-0917 Total:1,280.00
联系电话138-0013-8000
```
