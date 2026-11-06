"""Dump RapidOCR python intermediates for fidelity comparison against the Node port.

Read-only usage of the existing venv; writes only into bench/node/.
"""
import json
import os
import sys

NODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCH = os.path.dirname(NODE_DIR)
SITE = os.path.join(BENCH, ".venv", "Lib", "site-packages")
sys.path.insert(0, SITE)

import numpy as np  # noqa: E402
import cv2  # noqa: E402

import rapidocr_onnxruntime as pkg  # noqa: E402
from rapidocr_onnxruntime.rapid_ocr_api import RapidOCR  # noqa: E402
from rapidocr_onnxruntime.utils import read_yaml, concat_model_path  # noqa: E402

root_dir = os.path.dirname(pkg.__file__)
config = concat_model_path(read_yaml(os.path.join(root_dir, "config.yaml")))

engine = RapidOCR()
det = engine.text_detector
cls = engine.text_cls
rec = engine.text_recognizer

SAMPLES = os.path.join(BENCH, "samples")

out = {}

for name in sorted(os.listdir(SAMPLES)):
    if not name.lower().endswith(".png"):
        continue
    path = os.path.join(SAMPLES, name)
    img = engine.load_img(path)
    h, w = img.shape[:2]

    # --- replicate detector.__call__ with instrumentation ---
    ori_im_shape = img.shape[:2]
    data = {"image": img}
    from rapidocr_onnxruntime.ch_ppocr_v3_det.utils import transform
    data = transform(data, det.preprocess_op)
    pre, shape_list = data
    shape_list = np.expand_dims(shape_list, axis=0)
    pre_batch = np.expand_dims(pre, axis=0).astype(np.float32)
    preds = det.infer(pre_batch)[0]
    pred = preds[:, 0, :, :]
    segmentation = pred > det.postprocess_op.thresh
    mask = cv2.dilate(np.array(segmentation[0]).astype(np.uint8), det.postprocess_op.dilation_kernel)
    contours = cv2.findContours((mask * 255).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0]
    post = det.postprocess_op(preds, shape_list)
    dt_boxes_raw = post[0]["points"]
    dt_boxes = det.filter_tag_det_res(dt_boxes_raw, ori_im_shape)

    sorted_boxes = engine.sorted_boxes(dt_boxes)
    crops = engine.get_crop_img_list(img, sorted_boxes)
    crop_shapes = [list(c.shape[:2]) for c in crops]

    crops2, cls_res, cls_elapse = cls(crops)
    rec_res, rec_elapse = rec(crops2)

    out[name] = {
        "src_shape": [int(h), int(w)],
        "pre_shape": [int(pre.shape[0]), int(pre.shape[1]), int(pre.shape[2])],
        "shape_list": [float(x) for x in shape_list[0]],
        "pred_shape": [int(x) for x in preds.shape],
        "n_contours": int(len(contours)),
        "dt_boxes": [[[float(x) for x in pt] for pt in p] for p in dt_boxes],
        "sorted_boxes": [[[float(x) for x in pt] for pt in p] for p in sorted_boxes],
        "crop_shapes": crop_shapes,
        "cls_res": [[str(a), float(b)] for a, b in cls_res],
        "rec_res": [[str(a), float(b)] for a, b in rec_res],
    }
    print(name, "boxes", len(dt_boxes), "cls", cls_res)

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "python_ref.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

# character list from model metadata
meta = rec.session.have_key()
chars = rec.session.get_character_list() if meta else None
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "python_chars.txt"), "w", encoding="utf-8") as f:
    if chars:
        f.write("\n".join(chars))
print("have_key", meta, "n_chars", len(chars) if chars else 0)
print("wrote python_ref.json / python_chars.txt")
