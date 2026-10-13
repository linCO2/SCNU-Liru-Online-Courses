#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
分析砺儒云课堂（moodle.scnu.edu.cn）课程页：列出活动、区分视频/图文、找完成判定。

用法：
  python moodle.py course <html文件>     # 分析已保存的课程页
  python moodle.py find <html文件>       # 只找视频相关活动
"""
import os
import re
import sys
import glob
import html as htmllib

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")


def newest(pat):
    fs = glob.glob(os.path.join(OUT, pat))
    return max(fs, key=os.path.getmtime) if fs else None


def strip_tags(s):
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = htmllib.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    mode, path = sys.argv[1], sys.argv[2]
    if not os.path.exists(path):
        p = newest(path)
        if not p:
            print(f"[X] 找不到 {path}")
            return 1
        path = p
    s = open(path, encoding="utf-8", errors="replace").read()
    print(f"文件: {os.path.basename(path)}  ({len(s)} 字符)\n")

    # 每个活动：id / 类型 / 名称 / 完成状态
    # Moodle 活动块形如 <li class="activity fsresource modtype_fsresource" id="module-123">
    acts = []
    for m in re.finditer(r'<li[^>]*class="[^"]*activity[^"]*"[^>]*id="module-(\d+)"[^>]*>(.*?)</li>',
                         s, re.S | re.I):
        mid, block = m.group(1), m.group(2)
        mt = re.search(r"modtype_([a-z0-9_]+)", m.group(0), re.I)
        name = ""
        nm = re.search(r'class="[^"]*instancename[^"]*"[^>]*>(.*?)</span>', block, re.S | re.I)
        if nm:
            name = strip_tags(nm.group(1))
        if not name:
            nm = re.search(r"data-activityname=\"([^\"]*)\"", block, re.I)
            if nm:
                name = htmllib.unescape(nm.group(1))
        link = re.search(r'href="([^"]+)"', block)
        # 完成状态：Moodle 用 completion 图标
        comp = ""
        cm = re.search(r'class="[^"]*(completion|aalink)[^"]*"', block)
        if re.search(r"autocompletion|completion-manual|completion-auto", block, re.I):
            comp = "有完成追踪"
        # 是否含"视频"字样
        acts.append({"id": mid, "type": mt.group(1) if mt else "?",
                     "name": name, "url": link.group(1) if link else "",
                     "comp": comp, "block": block})

    print(f"=== 活动共 {len(acts)} 个 ===")
    vid_like = [a for a in acts if re.search(r"视频|录像|微课|讲座|实录|观看|video", a["name"], re.I)]
    print(f"其中名称像视频的: {len(vid_like)} 个\n")

    for a in acts:
        flag = "🎬" if re.search(r"视频|录像|微课|讲座|实录|观看|video", a["name"], re.I) else "  "
        print(f"{flag} [{a['type']:<12}] {a['name'][:60]}")
        print(f"     id={a['id']}  {a['url'][:90]}")

    print("\n=== 课程页里出现的所有 fsresource id ===")
    ids = sorted(set(re.findall(r"fsresource/view\.php\?id=(\d+)", s)), key=int)
    print(f"  {len(ids)} 个: {', '.join(ids)}")

    print("\n=== 课程页里的视频线索（关键词所在片段）===")
    for kw in ["videojs", "<video", "m3u8", "player", "fsresource/view"]:
        for m in re.finditer(re.escape(kw), s, re.I):
            a, b = max(0, m.start() - 120), m.start() + 200
            frag = re.sub(r"\s+", " ", s[a:b])
            print(f"\n  [{kw}] ...{frag}...")
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
