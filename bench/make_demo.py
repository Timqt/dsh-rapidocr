"""Render a demo image for the plugin marketplace listing.

Left  : the input screenshot with the detected text boxes drawn on top.
Right : the text ``ocr_image`` returned, with the confidence of every line.

Run:  .\\.venv\\Scripts\\python.exe make_demo.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SAMPLE = HERE / "samples" / "screenshot_1280x720.png"
OUT = ROOT / "docs" / "images" / "ocr_image_demo.png"

FONT_CANDIDATES = [
    Path(r"C:\Windows\Fonts\msyh.ttc"),
    Path(r"C:\Windows\Fonts\msyh.ttf"),
    Path(r"C:\Windows\Fonts\simhei.ttf"),
    Path(r"C:\Windows\Fonts\arial.ttf"),
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def run_ocr() -> dict:
    """Ask the Node port for the recognised lines of the sample image."""
    proc = subprocess.run(
        ["node", "cli/ocr.js", str(SAMPLE), "--json"],
        cwd=HERE / "node",
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(proc.stdout)


def content_bbox(image: Image.Image, threshold: int = 245) -> tuple[int, int, int, int]:
    """Bounding box of everything that is not near-white, with a little padding."""
    grey = image.convert("L")
    mask = grey.point(lambda value: 255 if value < threshold else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return (0, 0, image.width, image.height)
    left, top, right, bottom = bbox
    pad = 16
    return (
        max(0, left - pad),
        max(0, top - pad),
        min(image.width, right + pad),
        min(image.height, bottom + pad),
    )


def main() -> int:
    data = run_ocr()
    lines = data["lines"]
    det, cls, rec = data["elapse"]
    source = Image.open(SAMPLE).convert("RGB")
    image = source.crop(content_bbox(source))
    draw = ImageDraw.Draw(image)

    font = load_font(20)
    small = load_font(16)

    # Detection boxes on top of the input image.
    for index, line in enumerate(lines):
        box = line["box"]
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        draw.rectangle([min(xs), min(ys), max(xs), max(ys)], outline=(220, 40, 40), width=2)
        draw.text((min(xs) + 3, min(ys) - 20), str(index + 1), fill=(220, 40, 40), font=small)

    # Result panel on the right.
    panel_width = 620
    margin = 24
    panel_height = 44 + 32 * len(lines) + 18 + 26 + 26
    canvas = Image.new(
        "RGB",
        (image.width + panel_width + margin * 3, max(image.height, panel_height) + margin * 2),
        (247, 247, 249),
    )
    canvas.paste(image, (margin, margin))
    draw = ImageDraw.Draw(canvas)

    x0 = image.width + margin * 2
    y = margin + 4
    draw.text((x0, y), "ocr_image 返回的文本", fill=(20, 20, 20), font=font)
    y += 44
    for index, line in enumerate(lines):
        draw.text((x0, y), f"[{line['score']:.4f}] {line['text']}", fill=(20, 20, 20), font=small)
        y += 32

    y += 18
    draw.text((x0, y), "本机 CPU 推理，无网络调用", fill=(90, 90, 90), font=small)
    y += 26
    draw.text(
        (x0, y),
        f"总耗时 {data['total_ms']:.0f} ms "
        f"(det {det:.0f} / cls {cls:.0f} / rec {rec:.0f})",
        fill=(90, 90, 90),
        font=small,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
