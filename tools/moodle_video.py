#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
砺儒云课堂（moodle.scnu.edu.cn）视频信息读取工具。

只做**只读**查询：读取每个视频的时长、已看进度，不做任何提交。

用法：
  python moodle_video.py list          # 列出课程所有视频 fsresource
  python moodle_video.py info          # 查询每个视频的时长/进度（只读）
"""
import os
import re
import sys
import json
import glob
import urllib.parse

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


def newest(pat):
    fs = glob.glob(os.path.join(OUT, pat))
    return max(fs, key=os.path.getmtime) if fs else None


def parse_course_videos(path):
    """
    从课程页 HTML 里解析出视频活动列表。

    注意：Moodle 的 <li> 属性是**多行**的，且 li 内部还嵌了 div，
    所以不能用非贪婪的 </li> 匹配。这里改成按 module-<id> 切块。
    """
    s = open(path, encoding="utf-8", errors="replace").read()
    vids = []

    # 找所有 "module-<数字>" 的出现位置作为切分点
    marks = [(m.start(), m.group(1))
             for m in re.finditer(r'id="module-(\d+)"', s)]
    for idx, (pos, mid) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else min(len(s), pos + 6000)
        block = s[pos:end]

        # 只取 fsresource 类型
        if "modtype_fsresource" not in block and "fsresource" not in block:
            continue

        # 活动名优先取 data-activityname
        name = ""
        nm = re.search(r'data-activityname="([^"]*)"', block)
        if nm:
            name = nm.group(1).strip()
        if not name:
            nm = re.search(r'class="[^"]*instancename[^"]*"[^>]*>(.*?)</span>', block, re.S | re.I)
            if nm:
                name = re.sub(r"<[^>]+>", "", nm.group(1)).strip()

        vm = re.search(r"fsresource/view\.php\?id=(\d+)", block)
        if vm and name.lower().endswith(".mp4"):
            vids.append({"cmid": mid, "fsview": vm.group(1), "name": name})

    # 去重（同一活动可能在页面上出现多次）
    seen, out = set(), []
    for v in vids:
        if v["fsview"] not in seen:
            seen.add(v["fsview"])
            out.append(v)
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    path = newest("moodle_course_*.html")
    if not path:
        print("[X] 找不到课程页，先抓一次:")
        print('    python dsh_chaoxing.py get "https://moodle.scnu.edu.cn/course/view.php?id=19887" course')
        return 1
    vids = parse_course_videos(path)
    print(f"课程页解析到 {len(vids)} 个 mp4 视频\n")

    if cmd == "list":
        for i, v in enumerate(vids, 1):
            print(f"  {i:>2}. {v['name']}")
            print(f"      cmid={v['cmid']}  view.php?id={v['fsview']}")
        return 0

    if cmd == "info":
        s = session()
        for i, v in enumerate(vids, 1):
            url = f"{SITE}/mod/fsresource/view.php?id={v['fsview']}"
            try:
                r = s.get(url, timeout=30, verify=False)
            except Exception as e:
                print(f"  {i:>2}. {v['name']}  [请求失败 {type(e).__name__}]")
                continue
            # playerdata 里有 progress（0/1）与 fsresourceid、m3u8 地址
            m = re.search(r"var\s+playerdata\s*=\s*(\{[\s\S]*?\})\s*\n", r.text)
            info = {}
            if m:
                try:
                    info = json.loads(m.group(1).replace("'", '"'))
                except Exception:
                    # 宽松解析
                    for k in ("fsresourceid", "progress", "userid"):
                        mm = re.search(rf"'{k}'\s*:\s*'?([^,}}']+)", m.group(1))
                        if mm:
                            info[k] = mm.group(1)
            src = re.search(r'"OD":"([^"]+)"', r.text) or re.search(r'"SD":"([^"]+)"', r.text)
            print(f"  {i:>2}. {v['name']}")
            print(f"      已完成标记 progress={info.get('progress')}  "
                  f"fsresourceid={info.get('fsresourceid')}")
            if src:
                u = src.group(1).replace("\\/", "/")
                base = u.split("?")[0]
                print(f"      流地址: {base}")
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    import urllib3
    urllib3.disable_warnings()
    sys.exit(main())
