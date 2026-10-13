#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
读取砺儒云课堂每个视频的真实时长（只读）。

原理：视频是 HLS。抓页面拿到带 token 的 m3u8 地址，再读播放列表里的
      #EXTINF 分片时长求和 = 视频总时长。全程只读，不提交任何进度。

时长决定了防挂机策略：
  - <= 10 分钟：不弹人机验证，可连续播放
  - >  10 分钟：需要人机验证，脚本无法自动通过（必须本人点）

用法：
  python moodle_duration.py            # 探测所有视频时长
  python moodle_duration.py --save     # 并把结果存成 out/video_durations.json
"""
import os
import re
import sys
import json
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
COOKIE_FILE = os.path.join(HERE, "cookie.txt")
SITE = "https://moodle.scnu.edu.cn"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

sys.path.insert(0, HERE)
from moodle_video import session, newest, parse_course_videos  # noqa: E402


def get_m3u8_url(s, view_id):
    """从 fsresource 页面取出带 token 的 m3u8 地址。"""
    r = s.get(f"{SITE}/mod/fsresource/view.php?id={view_id}", timeout=30, verify=False)
    m = re.search(r'"(?:OD|FHD|HD|SD|LD|FD)":"([^"]+\.m3u8[^"]*)"', r.text)
    if not m:
        return None, None
    url = m.group(1).replace("\\/", "/").replace("\\u0026", "&")
    fid = re.search(r"'fsresourceid':(\d+)", r.text)
    prog = re.search(r"'progress':(\d+)", r.text)
    return url, {"fsresourceid": fid.group(1) if fid else None,
                 "progress": prog.group(1) if prog else None}


def playlist_duration(s, url, depth=0):
    """递归解析 m3u8，返回 (总秒数, 类型)。"""
    if depth > 3:
        return None, "too-deep"
    try:
        r = s.get(url, timeout=30, verify=False)
    except Exception as e:
        return None, f"请求失败 {type(e).__name__}"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    txt = r.text.strip()
    if not txt.startswith("#EXTM3U"):
        return None, "非 m3u8 内容"

    # 主播放列表：含 EXT-X-STREAM-INF，取第一个变体递归
    if "#EXT-X-STREAM-INF" in txt:
        lines = [l.strip() for l in txt.splitlines()]
        for i, l in enumerate(lines):
            if l.startswith("#EXT-X-STREAM-INF"):
                for nxt in lines[i + 1:]:
                    if nxt and not nxt.startswith("#"):
                        sub = nxt if nxt.startswith("http") else \
                            url.rsplit("/", 1)[0] + "/" + nxt
                        return playlist_duration(s, sub, depth + 1)
        return None, "主列表无变体"

    # 媒体播放列表：累加 EXTINF
    total = 0.0
    for m in re.finditer(r"#EXTINF:\s*([\d.]+)", txt):
        total += float(m.group(1))
    if total <= 0:
        return None, "无 EXTINF"
    return total, "ok"


def fmt(sec):
    if sec is None:
        return "?"
    sec = int(round(sec))
    return f"{sec // 60}分{sec % 60:02d}秒"


def main():
    path = newest("moodle_course_*.html")
    if not path:
        print("[X] 先抓课程页")
        return 1
    vids = parse_course_videos(path)
    print(f"共 {len(vids)} 个视频，开始探测时长（只读）...\n")

    s = session()
    results = []
    over10 = []
    for i, v in enumerate(vids, 1):
        url, meta = get_m3u8_url(s, v["fsview"])
        if not url:
            print(f"  {i:>2}. {v['name'][:46]:<46} 取不到 m3u8")
            results.append({**v, "duration": None, "note": "无 m3u8"})
            continue
        dur, note = playlist_duration(s, url)
        flag = ""
        if dur and dur > 600:
            flag = "  <- 超过10分钟，会弹人机验证"
            over10.append(v["name"])
        print(f"  {i:>2}. {v['name'][:46]:<46} {fmt(dur):>10}  {note if note != 'ok' else ''}{flag}")
        results.append({**v, "duration": dur, "note": note,
                        "fsresourceid": (meta or {}).get("fsresourceid"),
                        "progress": (meta or {}).get("progress")})
        time.sleep(0.4)

    total = sum(r["duration"] for r in results if r["duration"])
    print(f"\n合计时长: {fmt(total)}（约 {total/3600:.2f} 小时）")
    print(f"超过 10 分钟（会触发人机验证）的视频: {len(over10)} 个")
    for n in over10:
        print(f"    - {n}")

    if "--save" in sys.argv:
        p = os.path.join(OUT, "video_durations.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\n[OK] 已保存 {p}")
    return 0


if __name__ == "__main__":
    import urllib3
    urllib3.disable_warnings()
    sys.exit(main())
