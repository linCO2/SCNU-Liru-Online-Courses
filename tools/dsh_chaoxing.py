#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
超星/学习通 task.chaoxing.com 抓取工具。

用途：
  1. 用 URL 自带的 jsessionid 尝试直接访问（可能无需 cookie）
  2. 用本地 cookie.txt 携带登录态访问
  3. 把返回的 HTML / JSON 存到 out/ 目录
  4. 打印重定向链、状态码、页面标题，便于判断是否登录成功

用法：
  python dsh_chaoxing.py probe
  python dsh_chaoxing.py get "<url>" [名称]
  python dsh_chaoxing.py cookie          # 检查 cookie.txt 是否可用
"""
import os
import re
import sys
import json
import datetime
import urllib.parse

# Windows 控制台默认 GBK，强制 UTF-8 输出，避免中文/符号报 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import requests
except ImportError:
    print("需要 requests: python -m pip install requests")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
COOKIE_FILE = os.path.join(HERE, "cookie.txt")
URL_FILE = os.path.join(HERE, "网址.txt")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

os.makedirs(OUT, exist_ok=True)


def target_urls():
    """读取网址.txt 里所有的 http 链接（文件可能有多行多个网址）。"""
    with open(URL_FILE, encoding="utf-8") as f:
        txt = f.read()
    urls = [u.strip() for u in re.findall(r"https?://\S+", txt)]
    if not urls:
        raise SystemExit("网址.txt 里没找到 URL")
    return urls


def target_url():
    """兼容旧调用：返回第一个 URL。"""
    return target_urls()[0]


def load_cookie():
    """
    读取 cookie.txt。支持三种格式：
      a) 浏览器里复制的一整行: "a=1; b=2; c=3"
      b) Netscape cookie 文件（每行 7 列，含 domain/path）
      c) JSON 数组（如 EditThisCookie 导出）
    会忽略 markdown 说明文字和占位符，所以说明文档直接粘在最上面也不影响。
    返回 dict。
    """
    if not os.path.exists(COOKIE_FILE):
        return None
    raw = open(COOKIE_FILE, encoding="utf-8").read()
    if not raw.strip():
        return None

    # 去掉 markdown 代码块围栏、引用、表格行等说明性内容
    lines = []
    for line in raw.splitlines():
        s = line.strip()
        if not s or s.startswith("```") or s.startswith(">") or s.startswith("#"):
            continue
        if s.startswith("|") or s.startswith("---"):
            continue
        if s.upper() in ("PASTE_COOKIE_HERE", "PASTE_COOKIE_HERE;"):
            continue
        lines.append(s)
    body = "\n".join(lines)
    if not body.strip():
        return None

    # c) JSON 格式
    if body.lstrip().startswith("["):
        try:
            arr = json.loads(body)
            return {c["name"]: c["value"] for c in arr if "name" in c} or None
        except Exception as e:
            print(f"[!] cookie.txt 看着像 JSON 但解析失败: {e}")

    # b) Netscape 格式：7 列 tab 分隔
    ns_lines = [l for l in body.splitlines() if len(l.split("\t")) >= 7]
    if ns_lines:
        jar = {l.split("\t")[5]: l.split("\t")[6] for l in ns_lines}
        if jar:
            return jar

    # a) "a=1; b=2"（也可能整行带 "Cookie: " 前缀）
    body = re.sub(r"^\s*Cookie\s*:\s*", "", body, flags=re.I | re.M)
    jar = {}
    for pair in re.split(r"[;\n]+", body):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        k, v = k.strip(), v.strip().strip('"')
        # 排除说明文档里的普通句子（既不像 cookie 名也不像值）
        if not k or " " in k or k.startswith("*"):
            continue
        jar[k] = v
    return jar or None


def stamp():
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")


def fetch(url, name, cookie=None, save=True):
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    if cookie:
        s.cookies.update(cookie)
    r = s.get(url, allow_redirects=True, timeout=30, verify=False)
    # 超星页面声明 UTF-8，但 requests 的 apparent_encoding 常误判成 GBK/GB18030，
    # 导致部分中文变乱码。优先信页面里的 charset 声明。
    enc = None
    m = re.search(rb'charset=["\']?\s*([\w-]+)', r.content[:4096], re.I)
    if m:
        enc = m.group(1).decode("ascii", "ignore")
    if not enc or enc.lower() in ("gb2312", "gbk"):
        enc = "utf-8"
    r.encoding = enc

    print(f"--- {name} ---")
    print(f"最终 URL : {r.url}")
    if r.history:
        print("重定向链 :")
        for h in r.history:
            print(f"    {h.status_code} -> {h.headers.get('Location', '')}")
    print(f"状态码   : {r.status_code}   长度: {len(r.content)}")

    logged_out = "passport2.chaoxing.com" in r.url
    title = ""
    m = re.search(r"<title[^>]*>(.*?)</title>", r.text, re.S | re.I)
    if m:
        title = m.group(1).strip()
        print(f"标题     : {title}")
    print(f"登录态   : {'[未登录] 被重定向到 passport2' if logged_out else '[已登录] 成功进入站内'}")

    if save:
        ext = "json" if r.text.lstrip()[:1] in "[{" else "html"
        path = os.path.join(OUT, f"{name}_{stamp()}.{ext}")
        with open(path, "w", encoding="utf-8") as f:
            f.write(r.text)
        print(f"已保存   : {path}")
    return r


def all_jsessionid(url):
    """同一 jsessionid 有时也要放进 cookie，这里生成两种候选 URL。"""
    m = re.search(r";jsessionid=([0-9A-Fa-f]+)", url)
    return m.group(1) if m else None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    url = target_url()

    if cmd == "probe":
        print(f"目标 URL : {url}\n")
        jsid = all_jsessionid(url)
        print(f"URL 内 jsessionid : {jsid or '无'}\n")

        # 试验 1：原样访问（URL 自带 jsessionid）
        fetch(url, "probe_urlonly", cookie=None)

        # 试验 2：把 jsessionid 同时当 cookie 提交
        if jsid:
            fetch(url, "probe_jsid_cookie",
                  cookie={"JSESSIONID": jsid, "jsessionid": jsid})

        # 试验 3：用 cookie.txt
        ck = load_cookie()
        if ck:
            print(f"\n[+] cookie.txt 解析到 {len(ck)} 个 cookie: {sorted(ck)}")
            fetch(url, "probe_cookie", cookie=ck)
        else:
            print("\n[!] 没有可用的 cookie.txt（或为空），跳过 cookie 试验")
        return 0

    if cmd == "cookie":
        ck = load_cookie()
        if not ck:
            print("[X] cookie.txt 不存在或为空/解析不出内容")
            return 1
        print(f"[OK] 解析到 {len(ck)} 个 cookie：")
        for k, v in ck.items():
            show = v if len(v) <= 24 else v[:12] + "..." + v[-6:]
            print(f"    {k} = {show}")
        important = [k for k in ck if k.lower() in
                     ("jsessionid", "_uid", "uf", "fid", "vc3", "p_auth_token", "cx_p_token")]
        print(f"\n关键登录 cookie: {important or '（未发现常见的登录 cookie 名，可能仍需抓完整 cookie）'}")
        return 0

    if cmd == "get":
        if len(sys.argv) < 3:
            print("用法: python dsh_chaoxing.py get <url> [名称]")
            return 1
        u = sys.argv[2]
        n = sys.argv[3] if len(sys.argv) > 3 else "page"
        fetch(u, n, cookie=load_cookie())
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    import urllib3
    urllib3.disable_warnings()
    sys.exit(main())
