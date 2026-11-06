"""Generate representative OCR test images (Chinese + English, screen-shot style)."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
os.makedirs(OUT, exist_ok=True)

FONTS = [
    r"C:\Windows\Fonts\msyh.ttc",          # Microsoft YaHei
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]


def font(size, bold=False):
    for p in (FONTS[1] if bold else FONTS[0], FONTS[2], FONTS[3]):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def make(path, size, lines, scale=1.0):
    img = Image.new("RGB", size, (250, 250, 252))
    d = ImageDraw.Draw(img)
    x, y = 40, 40
    for text, sz, bold in lines:
        f = font(int(sz * scale), bold)
        d.text((x, y), text, fill=(20, 20, 25), font=f)
        y += int(sz * scale * 1.7)
    img.save(path)
    print("wrote", path, img.size)


make(
    os.path.join(OUT, "zh_en_800x600.png"),
    (800, 600),
    [
        ("本地部署 RapidOCR 视觉识别", 34, True),
        ("DeepSeek Harness 插件评估报告", 28, False),
        ("CPU inference: 12.5 ms / line", 24, False),
        ("Order No. A-2024-0917  Total: 1,280.00", 22, False),
        ("联系电话 138-0013-8000", 22, False),
    ],
)

make(
    os.path.join(OUT, "screenshot_1280x720.png"),
    (1280, 720),
    [
        ("系统设置 / 网络配置", 30, True),
        ("IP 地址: 192.168.1.108", 22, False),
        ("子网掩码: 255.255.255.0", 22, False),
        ("DNS: 223.5.5.5, 119.29.29.29", 22, False),
        ("状态: 已连接  速度: 100 Mbps", 22, False),
        ("Saved successfully at 09:42:11", 20, False),
    ],
)

make(
    os.path.join(OUT, "dense_1920x1080.png"),
    (1920, 1080),
    [
        ("第 1 行: 本地推理无需 GPU，模型体积约 15 MB", 26, False),
        ("第 2 行: 文本检测 DBNet + 方向分类 + CRNN 识别", 26, False),
        ("第 3 行: 支持中英文混排，倾斜矫正", 26, False),
        ("第 4 行: The quick brown fox jumps over the lazy dog", 26, False),
        ("第 5 行: 识别结果 JSON 结构化返回", 26, False),
        ("第 6 行: 插件形态为 Host bundle, inject tools", 26, False),
    ],
)

print("done")
