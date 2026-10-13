#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
查砺儒云课堂每项活动的**完成要求**和判定方式（只读）。

目的：搞清楚到底哪些视频真的需要"观看时长≥95%"，
     哪些只是"点开即可"，避免盲目刷。

Moodle 的完成要求藏在活动块的 completion-dialog 里，形如：
   "你必须 ... 查看" / "你必须 ... 完成" / "接收成绩不低于 x"

用法：
  python requirements.py           # 列出所有活动的完成要求
  python requirements.py --video   # 只看视频
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
    path = newest("course_fresh_*.html") or newest("moodle_course_*.html")
    if not path:
        print("[X] 找不到课程页 HTML")
        return 1
    s = open(path, encoding="utf-8", errors="replace").read()
    print(f"课程页: {os.path.basename(path)}\n")

    marks = [(m.start(), m.group(1)) for m in re.finditer(r'id="module-(\d+)"', s)]
    rows = []
    for idx, (pos, mid) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else min(len(s), pos + 30000)
        blk = s[pos:end]

        mt = re.search(r"modtype_([a-z0-9_]+)", blk)
        mtype = mt.group(1) if mt else "?"

        nm = re.search(r'data-activityname="([^"]*)"', blk)
        name = nm.group(1).strip() if nm else ""
        if not name:
            nm = re.search(r'class="instancename">(.*?)</span>', blk, re.S)
            if nm:
                name = strip_tags(nm.group(1))

        done = bool(re.search(r"btn-subtle-success", blk)) and bool(re.search(r"fa-check", blk))

        # 完成要求正文
        req = ""
        m2 = re.search(r'data-for="dropdowndialog_content">([\s\S]{0,1500}?)</div>\s*</div>', blk)
        if m2:
            req = strip_tags(m2.group(1))
        rows.append({"mid": mid, "type": mtype, "name": name,
                     "done": done, "req": req})

    video_only = "--video" in sys.argv
    print("=" * 78)
    print("每一项活动的完成要求")
    print("=" * 78)
    for r in rows:
        if video_only and not (r["type"] == "fsresource" and r["name"].lower().endswith(".mp4")):
            continue
        if r["type"] == "label":
            continue
        mark = "✅" if r["done"] else "⬜"
        print(f"\n{mark} [{r['type']}] {r['name'][:60]}")
        if r["req"]:
            print(f"     要求: {r['req'][:220]}")
        else:
            print("     要求: (无完成追踪 / 未标注)")

    # 汇总各类型的要求分布
    print("\n" + "=" * 78)
    print("完成要求去重统计（找出哪些是真需要时长的）")
    print("=" * 78)
    from collections import Counter
    c = Counter(r["req"][:80] for r in rows if r["req"] and r["type"] != "label")
    for k, v in c.most_common():
        print(f"  x{v:<3} {k}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
