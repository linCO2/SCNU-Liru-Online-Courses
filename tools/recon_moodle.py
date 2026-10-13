#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
砺儒云课堂（moodle.scnu.edu.cn）课程现状复勘（**只读**）。

做三件事，全程只用 GET，不提交任何数据、不改任何状态：
  1. 校验 cookie.txt 里的 MoodleSession 是否还活着
  2. 拉一份最新课程页，存到 out/，逐项解析完成状态
  3. 汇总：视频 / 测验 / 其他活动的 已完成、未完成、锁定 数量与清单

用法：
  python recon_moodle.py             # 默认复勘课程 19887
  python recon_moodle.py --id 19887
  python recon_moodle.py --quiz      # 额外扫一遍测验列表
"""
import os
import re
import sys
import glob
import html as htmllib
import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import requests
try:
    import urllib3
    urllib3.disable_warnings()
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
COOKIE_FILE = os.path.join(HERE, "cookie.txt")
SITE = "https://moodle.scnu.edu.cn"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

os.makedirs(OUT, exist_ok=True)


def load_cookies():
    if not os.path.exists(COOKIE_FILE):
        return {}
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


def stamp():
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")


def strip_tags(s):
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = htmllib.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def title_of(t):
    m = re.search(r"<title[^>]*>(.*?)</title>", t, re.S | re.I)
    return strip_tags(m.group(1)) if m else ""


def login_state(s, url):
    """只读探活：拉一次课程页，看有没有被踢到登录页。"""
    r = s.get(url, timeout=30, verify=False, allow_redirects=True)
    t = r.text
    logged_out = ("/login/index.php" in r.url) or ("loginform" in t and "MoodleSession" not in t)
    who = ""
    m = re.search(r'"userid"\s*:\s*(\d+)', t) or re.search(r'data-userid="(\d+)"', t)
    if m:
        who = m.group(1)
    return r, logged_out, who


def parse_activities(s_html):
    """按 module-<id> 切块解析活动。"""
    marks = [(m.start(), m.group(1)) for m in re.finditer(r'id="module-(\d+)"', s_html)]
    acts = []
    for idx, (pos, mid) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else min(len(s_html), pos + 30000)
        blk = s_html[pos:end]

        mt = re.search(r"modtype_([a-z0-9_]+)", blk)
        mtype = mt.group(1) if mt else "?"

        name = ""
        nm = re.search(r'data-activityname="([^"]*)"', blk)
        if nm:
            name = htmllib.unescape(nm.group(1)).strip()
        if not name:
            nm = re.search(r'class="[^"]*instancename[^"]*"[^>]*>(.*?)</span>', blk, re.S | re.I)
            if nm:
                name = strip_tags(nm.group(1))

        # 直链
        link = ""
        lm = re.search(r'href="(https?://moodle\.scnu\.edu\.cn/mod/[^"]+)"', blk) or \
             re.search(r'href="(/mod/[^"]+)"', blk)
        if lm:
            link = lm.group(1)

        done = bool(re.search(r"btn-subtle-success", blk)) and bool(re.search(r"fa-check", blk))
        lock = bool(re.search(r"fa-lock|locked|尚未解锁|不可用", blk))

        # 完成要求正文（若有）
        req = ""
        m2 = re.search(r'data-for="dropdowndialog_content">([\s\S]{0,1500}?)</div>\s*</div>', blk)
        if m2:
            req = strip_tags(m2.group(1))
        if not req:
            m2 = re.search(r'class="completion-dialog[^"]*"[^>]*>([\s\S]{0,1200}?)</div>\s*</div>', blk)
            if m2:
                req = strip_tags(m2.group(1))

        acts.append({"mid": mid, "type": mtype, "name": name, "done": done,
                     "lock": lock, "req": req, "link": link})
    return acts


def main():
    argv = sys.argv[1:]
    cid = "19887"
    if "--id" in argv:
        cid = argv[argv.index("--id") + 1]

    url = f"{SITE}/course/view.php?id={cid}"
    print("=" * 78)
    print("砺儒云课堂 · 课程现状复勘（只读）")
    print("=" * 78)
    print(f"目标    : {url}")
    print(f"cookie  : {sorted(load_cookies()) or '（空）'}")

    s = session()
    r, logged_out, uid = login_state(s, url)
    print(f"HTTP    : {r.status_code}  长度 {len(r.content)}")
    print(f"最终URL : {r.url}")
    print(f"标题    : {title_of(r.text)}")
    if uid:
        print(f"userid  : {uid}")
    print(f"登录态  : {'[未登录] 需要重新提供 cookie' if logged_out else '[已登录]'}")
    if logged_out:
        print("\n[!] cookie 已失效，无法继续复勘。请按 cookie使用说明.md 重新导出 MoodleSession。")
        return 2

    path = os.path.join(OUT, f"recon_course_{cid}_{stamp()}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(r.text)
    print(f"已存档  : {os.path.relpath(path, HERE)}")

    acts = parse_activities(r.text)
    vids = [a for a in acts if a["type"] == "fsresource"]
    quizzes = [a for a in acts if a["type"] in ("quiz", "quizgame", "hvp")]
    others = [a for a in acts if a not in vids and a not in quizzes and a["type"] != "label"]

    def summarize(title, items):
        print("\n" + "-" * 78)
        print(f"{title}（共 {len(items)}）")
        print("-" * 78)
        d = [a for a in items if a["done"]]
        u = [a for a in items if not a["done"] and not a["lock"]]
        l = [a for a in items if a["lock"] and not a["done"]]
        print(f"  ✅ 已完成 {len(d)}   ⬜ 未完成 {len(u)}   🔒 锁定 {len(l)}")
        for a in items:
            mark = "✅" if a["done"] else ("🔒" if a["lock"] else "⬜")
            print(f"   {mark} [{a['type']:<12}] cmid={a['mid']:<8} {a['name'][:58]}")
            if a["req"] and not a["done"]:
                print(f"        要求: {a['req'][:150]}")
        return d, u, l

    dv, uv, lv = summarize("视频活动（fsresource）", vids)
    dq, uq, lq = summarize("测验", quizzes)
    if others:
        summarize("其他活动", others)

    print("\n" + "=" * 78)
    print("小结")
    print("=" * 78)
    print(f"  视频: {len(dv)}/{len(vids)} 完成，剩余 {len(uv)} 个可做，{len(lv)} 个锁定")
    print(f"  测验: {len(dq)}/{len(quizzes)} 完成，剩余 {len(uq)} 个可做，{len(lq)} 个锁定")
    if uv:
        print("\n  ⬜ 待完成视频：")
        for a in uv:
            print(f"     cmid={a['mid']}  {a['name']}")
    if uq:
        print("\n  ⬜ 待完成测验：")
        for a in uq:
            print(f"     cmid={a['mid']}  {a['name']}  {a['link']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
