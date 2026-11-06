"""RapidOCR CPU benchmark: model load, cold/warm latency, accuracy, memory."""
import os
import sys
import time
import json
try:
    import resource
except ImportError:  # Windows
    resource = None


def rss_mb():
    if resource is not None:
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    import ctypes
    import ctypes.wintypes as w

    class PMC(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("PageFaultCount", w.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

    c = PMC()
    c.cb = ctypes.sizeof(PMC)
    ctypes.windll.psapi.GetProcessMemoryInfo(
        ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    return c.WorkingSetSize / 1024 / 1024

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "samples")

EXPECTED = {
    "zh_en_800x600.png": [
        "本地部署 RapidOCR 视觉识别",
        "DeepSeek Harness 插件评估报告",
        "CPU inference: 12.5 ms / line",
        "Order No. A-2024-0917  Total: 1,280.00",
        "联系电话 138-0013-8000",
    ],
    "screenshot_1280x720.png": [
        "系统设置 / 网络配置",
        "IP 地址: 192.168.1.108",
        "子网掩码: 255.255.255.0",
        "DNS: 223.5.5.5, 119.29.29.29",
        "状态: 已连接  速度: 100 Mbps",
        "Saved successfully at 09:42:11",
    ],
    "dense_1920x1080.png": [
        "第 1 行: 本地推理无需 GPU，模型体积约 15 MB",
        "第 2 行: 文本检测 DBNet + 方向分类 + CRNN 识别",
        "第 3 行: 支持中英文混排，倾斜矫正",
        "第 4 行: The quick brown fox jumps over the lazy dog",
        "第 5 行: 识别结果 JSON 结构化返回",
        "第 6 行: 插件形态为 Host bundle, inject tools",
    ],
}


def norm(s):
    return "".join(s.split()).replace("，", ",").replace("：", ":").replace("，", ",")


def main():
    from rapidocr_onnxruntime import RapidOCR
    import rapidocr_onnxruntime as pkg

    models_dir = os.path.join(os.path.dirname(pkg.__file__), "models")
    print("== package ==", pkg.__file__)
    print("== bundled models ==")
    total = 0
    for f in sorted(os.listdir(models_dir)) if os.path.isdir(models_dir) else []:
        p = os.path.join(models_dir, f)
        if os.path.isfile(p):
            total += os.path.getsize(p)
            print(f"   {f:40s} {os.path.getsize(p)/1024/1024:8.2f} MB")
    print(f"   TOTAL models: {total/1024/1024:.2f} MB")

    t0 = time.perf_counter()
    engine = RapidOCR()
    load_ms = (time.perf_counter() - t0) * 1000
    print(f"\n== model init: {load_ms:.0f} ms ==")

    report = {"load_ms": round(load_ms, 1), "models_mb": round(total / 1024 / 1024, 2), "cases": []}

    for name in sorted(os.listdir(SAMPLES)):
        if not name.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        path = os.path.join(SAMPLES, name)
        # cold (first call after init)
        t0 = time.perf_counter()
        res, elapse = engine(path)
        cold_ms = (time.perf_counter() - t0) * 1000
        # warm: 5 more runs
        times = []
        for _ in range(5):
            t0 = time.perf_counter()
            engine(path)
            times.append((time.perf_counter() - t0) * 1000)
        warm_ms = sorted(times)[len(times) // 2]
        texts = [r[1] for r in (res or [])]
        scores = [float(r[2]) for r in (res or [])]
        exp = EXPECTED.get(name, [])
        joined = norm("".join(texts))
        hits = sum(1 for e in exp if norm(e) in joined)
        rss = rss_mb()
        case = {
            "image": name,
            "cold_ms": round(cold_ms, 1),
            "warm_median_ms": round(warm_ms, 1),
            "warm_all": [round(t, 1) for t in times],
            "lines": len(texts),
            "lines_expected": len(exp),
            "exact_line_hits": f"{hits}/{len(exp)}",
            "min_score": round(min(scores), 4) if scores else None,
            "avg_score": round(sum(scores) / len(scores), 4) if scores else None,
            "rss_mb": round(rss, 1),
            "elapse": elapse,
            "text": texts,
        }
        report["cases"].append(case)
        print(f"\n== {name} ==")
        print(f"   cold {cold_ms:8.1f} ms | warm median {warm_ms:8.1f} ms | lines {len(texts)}/{len(exp)} | hits {hits}/{len(exp)} | rss {rss:.0f} MB")
        for t, s in zip(texts, scores):
            print(f"     [{s:.3f}] {t}")

    with open(os.path.join(HERE, "report_python.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\nwrote report_python.json")


if __name__ == "__main__":
    main()
