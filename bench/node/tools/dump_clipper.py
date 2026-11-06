"""Dump the pre-unclip mini boxes and the pyclipper expansion for clipper parity testing."""
import json
import os
import sys

NODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCH = os.path.dirname(NODE_DIR)
sys.path.insert(0, os.path.join(BENCH, ".venv", "Lib", "site-packages"))

import numpy as np  # noqa: E402
import cv2  # noqa: E402
import pyclipper  # noqa: E402
from shapely.geometry import Polygon  # noqa: E402

import rapidocr_onnxruntime as pkg  # noqa: E402
from rapidocr_onnxruntime.rapid_ocr_api import RapidOCR  # noqa: E402
from rapidocr_onnxruntime.ch_ppocr_v3_det.utils import transform  # noqa: E402

engine = RapidOCR()
det = engine.text_detector
img = engine.load_img(os.path.join(BENCH, "samples", "zh_en_800x600.png"))

data = transform({"image": img}, det.preprocess_op)
pre, shape_list = data
shape_list = np.expand_dims(shape_list, axis=0)
pre_batch = np.expand_dims(pre, axis=0).astype(np.float32)
preds = det.infer(pre_batch)[0]
pred = preds[:, 0, :, :]
seg = pred > det.postprocess_op.thresh
mask = cv2.dilate(np.array(seg[0]).astype(np.uint8), det.postprocess_op.dilation_kernel)
contours = cv2.findContours((mask * 255).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0]

rows = []
pp = det.postprocess_op
for contour in contours[:6]:
    points, sside = pp.get_mini_boxes(contour)
    points = np.array(points)
    score = pp.box_score_fast(pred[0], points.reshape(-1, 2))
    poly = Polygon(points)
    distance = poly.area * pp.unclip_ratio / poly.length
    offset = pyclipper.PyclipperOffset()
    offset.AddPath(points, pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    expanded = np.array(offset.Execute(distance))
    rows.append({
        "mini": [[float(x) for x in pt] for pt in points],
        "sside": float(sside),
        "score": float(score),
        "distance": float(distance),
        "area": float(poly.area),
        "length": float(poly.length),
        "expanded": [[[float(x) for x in pt] for pt in p] for p in expanded],
    })

with open(os.path.join(NODE_DIR, "tools", "clipper_ref.json"), "w", encoding="utf-8") as f:
    json.dump(rows, f, indent=1)
print(json.dumps(rows[0], indent=1)[:2000])
print("wrote clipper_ref.json rows=", len(rows))
