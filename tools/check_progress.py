#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
深入检查砺儒云课堂视频的真实观看记录（只读）。

之前的 moodle_video.py 只读了 playerdata 里的 'progress' 字段，
那更可能只是"本次会话是否播完"的标记，不代表累计观看时长。

这个脚本：
  1. 把每个视频页的原始 playerdata 整个打出来
  2. 抓页面里所有可能的进度字段（观看时间、完成度、完成状态）
  3. 检查课程页的完成度图标（Moodle completion）
  4. 查询 Moodle 的完成状态接口

全程只读，不提交任何东西。

用法：
  python check_progress.py raw <view_id>     # 打印某个视频页的全部线索
  python check_progress.py all               # 检查所有视频
"""
import os
import re
import sys
import json

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


def load_cookies():
    raw = open(COOKIE_FILE, encoding="utf-8").read()
    jar = {}
    for line in raw.splitlines():
        s = line.strip()
        if not s or s.startswith(("#", ">", "|", "```")):
            continue
        for part in s.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                k, v = k.strip(), v.strip()
                if k and k != "PASTE_COOKIE_HERE":
                    jar[k] = v
    return jar


def session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    s.cookies.update(load_cookies())
    return s


def dump_raw(s, view_id):
    url = f"{SITE}/mod/fsresource/view.php?id={view_id}"
    r = s.get(url, timeout=30, verify=False)
    print(f"=== {url} ===")
    print(f"HTTP {r.status_code}  长度 {len(r.content)}")
    if "login" in r.url or "登录" in r.text[:3000]:
        print("[!] 可能未登录")

    print("\n--- playerdata 原文 ---")
    m = re.search(r"var\s+playerdata\s*=\s*(\{.*?\})\s*\n", r.text, re.S)
    if m:
        raw = m.group(1)
        print(raw[:1200])
        print("\n--- 逐字段解析 ---")
        for k in ("userid", "width", "height", "progress", "fsresourceid",
                  "sesskey", "siteUrl", "source"):
            mm = re.search(rf"['\"]?{k}['\"]?\s*:\s*(['\"]?)([^,}}]*)\1", raw)
            if mm:
                print(f"    {k:<14} = {mm.group(2)[:160]}")
    else:
        print("  (没找到 playerdata)")

    print("\n--- 页面上所有含 progress/time/finish/percent 的 JS 变量 ---")
    pats = re.findall(r"(?:var|let|const)\s+(\w*(?:progress|time|finish|percent|complete)\w*)\s*=\s*([^;\n]{0,160})",
                      r.text, re.I)
    for name, val in pats:
        print(f"    {name} = {val.strip()[:150]}")
    if not pats:
        print("    (无)")

    print("\n--- 页面原始 JSON 片段里含 progress 的 ---")
    for m in re.finditer(r"\{[^{}]{0,400}['\"]progress['\"][^{}]{0,300}\}", r.text):
        print("   ", re.sub(r"\s+", " ", m.group(0))[:350])

    return r.text


def check_completion_api(s):
    """查 Moodle 课程完成状态（core_completion_get_activities_completion_status）。"""
    print("\n" + "=" * 74)
    print("查询 Moodle 完成状态接口")
    print("=" * 74)
    # 先取 sesskey
    r = s.get(f"{SITE}/course/view.php?id=19887", timeout=30, verify=False)
    sk = re.search(r'"sesskey":"([^"]+)"', r.text) or re.search(r"sesskey=([A-Za-z0-9]+)", r.text)
    sesskey = sk.group(1) if sk else None
    print(f"sesskey = {sesskey}")

    if not sesskey:
        print("[!] 取不到 sesskey，跳过")
        return

    body = [{
        "index": 0,
        "methodname": "core_completion_get_activities_completion_status",
        "args": {"courseid": 19887, "userid": 0},
    }]
    url = f"{SITE}/lib/ajax/service.php?sesskey={sesskey}&info=core_completion_get_activities_completion_status"
    try:
        rr = s.post(url, data=json.dumps(body), timeout=30, verify=False,
                    headers={"Content-Type": "application/json"})
        print(f"HTTP {rr.status_code}")
        try:
            data = rr.json()
            pretty = json.dumps(data, ensure_ascii=False, indent=2)
            print(pretty[:4000])
            p = os.path.join(OUT, "completion_status.json")
            with open(p, "w", encoding="utf-8") as f:
                f.write(pretty)
            print(f"\n[OK] 已保存 {p}")
        except Exception:
            print(rr.text[:2000])
    except Exception as e:
        print(f"[!] 请求失败: {type(e).__name__} {e}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    s = session()

    if cmd == "raw":
        vid = sys.argv[2] if len(sys.argv) > 2 else "872652"
        dump_raw(s, vid)
        return 0

    if cmd == "completion":
        check_completion_api(s)
        return 0

    if cmd == "all":
        # 从课程页拿视频列表
        sys.path.insert(0, HERE)
        from moodle_video import newest, parse_course_videos
        p = newest("moodle_course_*.html")
        vids = parse_course_videos(p)
        print(f"检查 {len(vids)} 个视频的原始 playerdata\n")
        rows = []
        for i, v in enumerate(vids, 1):
            r = s.get(f"{SITE}/mod/fsresource/view.php?id={v['fsview']}",
                      timeout=30, verify=False)
            m = re.search(r"var\s+playerdata\s*=\s*(\{.*?\})\s*\n", r.text, re.S)
            prog = fid = None
            if m:
                pm = re.search(r"'progress':(\d+)", m.group(1))
                fm = re.search(r"'fsresourceid':(\d+)", m.group(1))
                prog = pm.group(1) if pm else None
                fid = fm.group(1) if fm else None
            rows.append((i, v["name"], prog, fid))
            print(f"  {i:>2}. {v['name'][:44]:<44} progress={prog}  fsresourceid={fid}")
        done = [r for r in rows if r[2] == "1"]
        print(f"\nprogress=1 的视频: {len(done)} / {len(rows)}")
        for r in done:
            print(f"    - {r[1]}")
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    import urllib3
    urllib3.disable_warnings()
    sys.exit(main())
