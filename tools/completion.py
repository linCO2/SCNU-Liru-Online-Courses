#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
正确解析砺儒云课堂课程页的**完成状态**（只读）。

之前的错误：读了 playerdata 的 'progress' 字段。
那其实是 progressControl（是否允许拖动进度条），跟观看记录无关。

Moodle 真正的完成状态在活动块的 HTML 里：
  已完成  -> <button class="... btn-subtle-success ..."> <i class="fa fa-check"></i> 完成
  未完成  -> 用 fa-circle / 不同 class，文案为「完成」但非 success 样式
  锁定    -> 有锁图标

用法：
  python completion.py            # 输出 23 个视频的完成状态
  python completion.py --detail   # 附带完成要求细节
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
SITE = "https://moodle.scnu.edu.cn"


def newest(pat):
    fs = glob.glob(os.path.join(OUT, pat))
    return max(fs, key=os.path.getmtime) if fs else None


def strip_tags(s):
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", htmllib.unescape(s)).strip()


def parse_activities(path, detail=False):
    """
    按 module-<id> 切块，逐块判定完成状态。
    返回 [{cmid, type, name, done, lock, reqs}]
    """
    s = open(path, encoding="utf-8", errors="replace").read()
    marks = [(m.start(), m.group(1)) for m in re.finditer(r'id="module-(\d+)"', s)]
    acts = []
    for idx, (pos, mid) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else min(len(s), pos + 20000)
        blk = s[pos:end]

        mt = re.search(r"modtype_([a-z0-9_]+)", blk)
        mtype = mt.group(1) if mt else "?"

        name = ""
        nm = re.search(r'data-activityname="([^"]*)"', blk)
        if nm:
            name = nm.group(1).strip()
        if not name:
            nm = re.search(r'class="instancename">(.*?)</span>', blk, re.S)
            if nm:
                name = strip_tags(nm.group(1))

        # ---- 完成状态判定 ----
        # 已完成：按钮带 btn-subtle-success + fa-check
        done = bool(re.search(r'btn-subtle-success', blk)) and \
               bool(re.search(r'fa-check', blk))
        # 未完成：按钮里有 "完成" 或 "尚未完成"，但没有 success 样式
        notdone = bool(re.search(r'btn-outline-secondary|btn-subtle-secondary|尚未完成|未完成', blk))
        # 锁定
        lock = bool(re.search(r'fa-lock|locked|不可用|尚未解锁', blk))

        # 完成要求明细
        reqs = []
        if detail:
            for m in re.finditer(r'class="completion-dialog[^"]*"([\s\S]{0,1200}?)</div>\s*</div>', blk):
                reqs.append(strip_tags(m.group(1))[:300])

        acts.append({"cmid": mid, "type": mtype, "name": name,
                     "done": done, "notdone": notdone, "lock": lock, "reqs": reqs})
    return acts


def main():
    path = newest("course_fresh_*.html") or newest("moodle_course_*.html")
    if not path:
        print("[X] 找不到课程页 HTML")
        return 1
    detail = "--detail" in sys.argv
    acts = parse_activities(path, detail)
    print(f"课程页: {os.path.basename(path)}")
    print(f"活动总数: {len(acts)}\n")

    vids = [a for a in acts if a["type"] == "fsresource" and a["name"].lower().endswith(".mp4")]
    others = [a for a in acts if a not in vids]

    print("=" * 78)
    print(f"视频（fsresource / .mp4）共 {len(vids)} 个")
    print("=" * 78)
    n_done = 0
    for i, a in enumerate(vids, 1):
        if a["done"]:
            mark = "✅ 已完成"
            n_done += 1
        elif a["lock"]:
            mark = "🔒 锁定"
        else:
            mark = "⬜ 未完成"
        print(f"  {i:>2}. {mark}  {a['name']}")
        if detail and a["reqs"]:
            for r in a["reqs"][:2]:
                print(f"         要求: {r[:160]}")

    print(f"\n视频完成情况: {n_done} / {len(vids)}")
    if n_done:
        print("\n已完成的视频：")
        for a in vids:
            if a["done"]:
                print(f"   ✅ {a['name']}")

    print("\n" + "=" * 78)
    print(f"其他活动（测验/讨论等）共 {len(others)} 个")
    print("=" * 78)
    for a in others:
        if a["type"] == "label":
            continue
        mark = "✅ 已完成" if a["done"] else ("🔒 锁定" if a["lock"] else "⬜ 未完成")
        print(f"  {mark}  [{a['type']:<12}] {a['name'][:60]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
