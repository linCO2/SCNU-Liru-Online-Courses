#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
砺儒云课堂测验内容导出器 —— 把测验题目转成纯文本。

用途：把你**已经做过**的测验导出成 txt，方便复习、留档、搜索。
      也会标出"你选了什么 / 正确答案是什么 / 哪题错了"，用于查漏补缺。

⚠️ 定位说明
   本工具是**导出与存档**，不是"代考"：
   - 只读取页面上**已经存在**的回顾信息（答题回顾页 mod/quiz/review.php）
   - 你没做过的测验，页面上没有答案，脚本**不会去猜、不会去提交**
   - 不调用任何答题/提交接口

用法：
  python quiz_export.py list                # 列出课程所有测验
  python quiz_export.py export <cmid>       # 导出指定测验
  python quiz_export.py exportall           # 导出所有已作答的测验
  python quiz_export.py parse <html文件>    # 解析已保存的 review 页面
"""
import os
import re
import sys
import glob
import datetime
import html as htmllib

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import requests
from bs4 import BeautifulSoup

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
EXPORT = os.path.join(HERE, "测验导出")
COOKIE_FILE = os.path.join(HERE, "cookie.txt")
SITE = "https://moodle.scnu.edu.cn"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

os.makedirs(EXPORT, exist_ok=True)

# 题型中文名
QTYPE_CN = {
    "multichoice": "单选题",
    "multichoiceset": "多选题",
    "truefalse": "判断题",
    "shortanswer": "填空题",
    "match": "匹配题",
    "essay": "论述题",
    "numerical": "数值题",
    "calculated": "计算题",
    "ddwtos": "拖拽填空题",
    "gapselect": "选词填空题",
    "multianswer": "完形填空题",
    "description": "说明",
}


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


def txt(el):
    if el is None:
        return ""
    s = el.get_text("\n", strip=True)
    return re.sub(r"\n{2,}", "\n", s).strip()


def parse_question(que):
    """解析一道题（DOM 方式，不再用正则硬啃）。"""
    q = {
        "type": "?", "no": "", "state": "", "grade": "",
        "stem": "", "options": [], "feedback": [], "correct_txt": "",
        # 附加属性
        "dom_id": que.get("id", ""), "raw_class": " ".join(que.get("class") or []),
        "qid": "", "slot": "", "qubaid": "", "qaid": "",
        "maxmark": "", "seqcheck": "", "blank": False, "html": str(que)[:20000],
    }
    cls = " ".join(que.get("class") or [])
    for t, cn in QTYPE_CN.items():
        if t in cls:
            q["type"] = cn
            break

    el = que.select_one(".qno")
    if el:
        q["no"] = el.get_text(strip=True)
    el = que.select_one(".state")
    if el:
        q["state"] = el.get_text(strip=True)
    el = que.select_one(".grade")
    if el:
        q["grade"] = el.get_text(strip=True)
        m = re.search(r"([\d.]+)\s*/\s*([\d.]+)", q["grade"])
        if m:
            q["maxmark"] = m.group(2)
    el = que.select_one(".qtext")
    if el:
        q["stem"] = txt(el)
    el = que.select_one(".rightanswer")
    if el:
        q["correct_txt"] = txt(el)

    # 从 flagpostdata 里抽出服务端属性
    fp = que.select_one("input.questionflagpostdata")
    if fp:
        val = htmllib.unescape(fp.get("value", ""))
        for key in ("qaid", "qubaid", "qid", "slot"):
            m = re.search(rf"{key}=([^&]*)", val)
            if m:
                q[key] = m.group(1)

    sc = que.select_one('input[name$="_:sequencecheck"]')
    if sc:
        q["seqcheck"] = sc.get("value", "")

    # 选项
    for row in que.select(".answer > div"):
        rcls = " ".join(row.get("class") or [])
        if not rcls.startswith("r"):
            continue
        inp = row.find("input")
        selected = bool(inp and inp.has_attr("checked"))
        num = row.select_one(".answernumber")
        body = row.select_one(".flex-fill")
        label = num.get_text(strip=True).rstrip(".").strip() if num else "?"
        content = txt(body) if body else txt(row)
        is_correct = "correct" in rcls and "incorrect" not in rcls
        is_wrong = "incorrect" in rcls
        q["options"].append({
            "label": label, "text": content,
            "correct": is_correct, "wrong": is_wrong, "selected": selected,
        })

    # 是否未作答：有选项但一个都没选中
    if q["options"] and not any(o["selected"] for o in q["options"]):
        q["blank"] = True

    # 反馈
    for sel in (".feedback", ".specificfeedback", ".generalfeedback"):
        for el in que.select(sel):
            t = txt(el)
            if t and t not in q["feedback"]:
                q["feedback"].append(t)
    return q


def fmt_quiz(title, url, questions, meta=""):
    L = []
    L.append("=" * 78)
    L.append(title)
    L.append("=" * 78)
    L.append(f"来源: {url}")
    L.append(f"导出时间: {datetime.datetime.now():%Y-%m-%d %H:%M:%S}")
    if meta:
        L.append(meta)
    n_opt = sum(1 for q in questions if q["options"])
    n_ok = sum(1 for q in questions if q["state"] == "正确")
    n_bad = sum(1 for q in questions if q["state"] == "错误")
    n_half = sum(1 for q in questions if q["state"] == "部分正确")
    n_blank = sum(1 for q in questions if q["blank"])
    L.append(f"题目数: {len(questions)}（选择题 {n_opt}）  "
             f"正确 {n_ok}  部分正确 {n_half}  错误 {n_bad}  未作答 {n_blank}")
    from collections import Counter
    tc = Counter(q["type"] for q in questions)
    L.append("题型分布: " + "、".join(f"{k}×{v}" for k, v in tc.most_common()))
    L.append("")

    for q in questions:
        bits = []
        if q["state"]:
            bits.append(q["state"])
        if q["grade"]:
            bits.append(q["grade"])
        if q["type"] != "?":
            bits.append(q["type"])
        if q["blank"]:
            bits.append("未作答")
        L.append(f"【第 {q['no'] or '?'} 题】" + ("  (" + " · ".join(bits) + ")" if bits else ""))
        L.append("")
        for ln in (q["stem"] or "(题干为空)").split("\n"):
            L.append("  " + ln)
        L.append("")
        for o in q["options"]:
            if o["correct"]:
                mark = "[正确]"
            elif o["wrong"]:
                mark = "[错误]"
            else:
                mark = "      "
            sel = "★你选了" if o["selected"] else "        "
            L.append(f"   {mark} {sel}  {o['label']}. {o['text']}")
        L.append("")
        # 结论行：正确项 / 你选错的地方
        right = [o["label"] for o in q["options"] if o["correct"]]
        chosen_wrong = [o["label"] for o in q["options"] if o["wrong"] and o["selected"]]
        if right:
            L.append(f"  → 正确答案: {'、'.join(right)}")
        elif q["correct_txt"]:
            L.append(f"  → 正确答案: {q['correct_txt']}")
        if q["blank"]:
            L.append("  → 状态: 未作答（空白）")
        if chosen_wrong:
            L.append(f"  → 你选错了: {'、'.join(chosen_wrong)}")
        if q["feedback"]:
            for f in q["feedback"]:
                L.append(f"  → 反馈: {f[:300]}")
        # 属性行
        attrs = []
        if q["slot"]:
            attrs.append(f"slot={q['slot']}")
        if q["qid"]:
            attrs.append(f"qid={q['qid']}")
        if q["qubaid"]:
            attrs.append(f"qubaid={q['qubaid']}")
        if q["maxmark"]:
            attrs.append(f"满分={q['maxmark']}")
        if attrs:
            L.append("  · 属性: " + "  ".join(attrs))
        L.append("")
        L.append("-" * 74)
        L.append("")

    # 答案速查 + 错题清单 + 未作答清单
    ans = []
    for q in questions:
        right = [o["label"] for o in q["options"] if o["correct"]]
        if right or q["state"]:
            ans.append((q["no"], "、".join(right) or "—", q["state"], q["blank"]))
    if ans:
        L.append("")
        L.append("=" * 78)
        L.append("答案速查（★=未作答）")
        L.append("=" * 78)
        for no, a, st, blank in ans:
            L.append(f"  {no:>2}. {a:<12} {st}" + ("  ★未作答" if blank else ""))
        wrongs = [(no, a) for no, a, st, _ in ans if st == "错误"]
        blanks = [no for no, _, _, b in ans if b]
        if wrongs:
            L.append("")
            L.append("错题清单（建议重点复习）")
            L.append("-" * 74)
            for no, a in wrongs:
                L.append(f"  第 {no} 题 —— 正确答案 {a}")
        if blanks:
            L.append("")
            L.append("未作答题目")
            L.append("-" * 74)
            L.append("  第 " + "、".join(blanks) + " 题")
    return "\n".join(L)


def safe_name(s):
    return re.sub(r'[\\/:*?"<>|]', "_", s).strip()[:80]


def quiz_list_from_course():
    p = newest("course_fresh_*.html") or newest("moodle_course_*.html")
    if not p:
        return []
    soup = BeautifulSoup(open(p, encoding="utf-8", errors="replace").read(), "lxml")
    out, seen = [], set()
    for li in soup.select('li.activity[id^="module-"]'):
        if "modtype_quiz" not in " ".join(li.get("class") or []) and \
           not li.select_one('a[href*="mod/quiz/view.php"]'):
            continue
        mid = li.get("id", "").replace("module-", "")
        if not mid or mid in seen:
            continue
        seen.add(mid)
        card = li.select_one("[data-activityname]")
        name = card.get("data-activityname", "") if card else ""
        if not name:
            nm = li.select_one(".instancename")
            name = nm.get_text(" ", strip=True) if nm else f"测验{mid}"
        html_li = str(li)
        done = "btn-subtle-success" in html_li and "fa-check" in html_li
        out.append({"cmid": mid, "name": name, "done": done})
    return out


def export_quiz(s, cmid, name, all_attempts=False):
    """
    抓 view 页找出回顾链接，再抓 review 页解析。

    all_attempts=False：只导第一次（通常是最新一次）
    all_attempts=True ：把每一次尝试都导出来（成绩取最高分，看多次更有用）

    返回 (文本 或 文本列表, 错误信息)
    """
    view = f"{SITE}/mod/quiz/view.php?id={cmid}"
    r = s.get(view, timeout=30, verify=False)
    soup_v = BeautifulSoup(r.text, "lxml")

    # 收集所有 review 链接（可能多个 attempt）
    links, seen = [], set()
    for a in soup_v.select('a[href*="mod/quiz/review.php"]'):
        href = htmllib.unescape(a.get("href", ""))
        if not href:
            continue
        if href.startswith("/"):
            href = SITE + href
        m = re.search(r"attempt=(\d+)", href)
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        links.append((m.group(1), href))

    if not links:
        return None, "没有答题记录（未作答或不允许回顾）"
    if not all_attempts:
        links = links[:1]

    outs = []
    for attempt_id, url in links:
        rr = s.get(url, timeout=30, verify=False)
        soup = BeautifulSoup(rr.text, "lxml")
        qs = [parse_question(q) for q in soup.select("div.que")]
        if not qs:
            continue
        t = soup.select_one("title")
        title = t.get_text(strip=True) if t else name
        # attempt 摘要
        meta = f"测验ID: {cmid}   尝试号: {attempt_id}   回顾: {url}"
        tbl = soup.select_one("table.generaltable")
        if tbl:
            meta += "\n摘要: " + " ".join(tbl.get_text(" ", strip=True).split())[:240]
        outs.append((attempt_id, fmt_quiz(title, url, qs, meta), len(qs)))

    if not outs:
        return None, "回顾页没解析到题目"
    return (outs if all_attempts else outs[0][1]), None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]

    if cmd == "list":
        for q in quiz_list_from_course():
            print(f"  [{'已做' if q['done'] else '未做'}] cmid={q['cmid']:<8} {q['name']}")
        return 0

    if cmd == "parse":
        if len(sys.argv) < 3:
            print("用法: python quiz_export.py parse <html文件>")
            return 1
        path = sys.argv[2]
        soup = BeautifulSoup(open(path, encoding="utf-8", errors="replace").read(), "lxml")
        t = soup.select_one("title")
        title = t.get_text(strip=True) if t else os.path.basename(path)
        qs = [parse_question(q) for q in soup.select("div.que")]
        print(fmt_quiz(title, path, qs))
        return 0

    s = session()
    quizzes = quiz_list_from_course()

    if cmd == "export":
        if len(sys.argv) < 3:
            print("用法: python quiz_export.py export <cmid> [--all-attempts]")
            return 1
        cmid = sys.argv[2]
        all_att = "--all-attempts" in sys.argv
        q = next((x for x in quizzes if x["cmid"] == cmid), None)
        name = q["name"] if q else f"测验{cmid}"
        res, err = export_quiz(s, cmid, name, all_attempts=all_att)
        if err:
            print(f"[X] {name}: {err}")
            return 1
        if all_att:
            for attempt_id, body, nq in res:
                p = os.path.join(EXPORT, safe_name(f"{name}_{cmid}_尝试{attempt_id}") + ".txt")
                open(p, "w", encoding="utf-8").write(body)
                print(f"[OK] {name} 尝试{attempt_id}（{nq}题） -> {p}")
        else:
            p = os.path.join(EXPORT, safe_name(f"{name}_{cmid}") + ".txt")
            open(p, "w", encoding="utf-8").write(res)
            print(f"[OK] {name} -> {p}\n")
            print(res[:2000])
        return 0

    if cmd == "exportall":
        all_att = "--all-attempts" in sys.argv
        ok = 0
        for q in quizzes:
            if not q["done"]:
                print(f"  [跳过] {q['name']}（未作答，无回顾可导）")
                continue
            res, err = export_quiz(s, q["cmid"], q["name"], all_attempts=all_att)
            if err:
                print(f"  [X] {q['name']}: {err}")
                continue
            if all_att:
                for attempt_id, body, nq in res:
                    p = os.path.join(EXPORT, safe_name(f"{q['name']}_{q['cmid']}_尝试{attempt_id}") + ".txt")
                    open(p, "w", encoding="utf-8").write(body)
                    print(f"  [OK] {q['name']} 尝试{attempt_id}（{nq}题） -> {os.path.basename(p)}")
                    ok += 1
            else:
                p = os.path.join(EXPORT, safe_name(f"{q['name']}_{q['cmid']}") + ".txt")
                open(p, "w", encoding="utf-8").write(res)
                print(f"  [OK] {q['name']} -> {os.path.basename(p)}")
                ok += 1
        print(f"\n共导出 {ok} 个文件，目录: {EXPORT}")
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    import urllib3
    urllib3.disable_warnings()
    sys.exit(main())
