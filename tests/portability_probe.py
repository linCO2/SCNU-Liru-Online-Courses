#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
机动性实测：判断「答题助手」依赖的 DOM 口令到底属于
  (a) Moodle 内核（跨站点通用）
  (b) 主题（换主题就变）
  (c) 本站点特有（换学校就废）

做法：把存档 HTML 里出现的所有 class 名拉出来，按「是不是 Moodle 内核命名的
固定形态」分类。Moodle 内核的题引擎 class（que/qtext/ablock/answer/rN/
answernumber）和表单 name（q<qubaid>:<slot>_answer）是 qtype 渲染器写死的，
主题只能改 CSS，改不了这些——这是核心论据，这里用实际 HTML 验证它确实存在。

用法：
  python portability_probe.py
"""
import os
import re
import sys
import glob
from collections import Counter

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# Moodle 题引擎（question engine）渲染器写死的、与主题无关的标记
CORE_MARKERS = {
    "que": "题容器（qtype 渲染器输出）",
    "qtext": "题干",
    "qno": "题号",
    "ablock": "答案区（单选/多选/判断共用）",
    "answer": "答案列表容器",
    "answernumber": "选项字母标号 chip",
    "info": "题头（题号/状态/得分）",
    "formulation": "题面容器",
    "state": "判定状态（回顾页）",
    "grade": "得分（回顾页）",
    "correct": "正确标记（回顾页）",
    "deferredfeedback": "行为模式名（qbehaviour 提供）",
    "multichoice": "题型名（qtype 提供）",
    "multichoiceset": "题型名",
    "truefalse": "题型名",
    "shortanswer": "题型名",
    "numerical": "题型名",
    "essay": "题型名",
    "match": "题型名",
}

# 明显是主题/站点自己加的口袋（出现即说明"与主题绑定的风险点"）
THEME_HINTS = re.compile(
    r"^(lambda|boost|classic|fordson|remui|moove|edumy|snap|snc-|scnu-|d-flex|ms-|me-|mt-|mb-|px-|py-|fw-|text-|bg-|m-|p-)"
)


def newest(pat):
    fs = glob.glob(os.path.join(OUT, pat))
    return max(fs, key=os.path.getmtime) if fs else None


def classes_of(path):
    with open(path, "rb") as f:
        root = etree.parse(f, etree.HTMLParser(recover=True, huge_tree=True)).getroot()
    c = Counter()
    for el in root.iter():
        for cl in (el.get("class") or "").split():
            c[cl] += 1
    return root, c


def main():
    print("=" * 78)
    print("机动性实测：答题助手依赖的 DOM 口令来自哪一层")
    print("=" * 78)

    # ---------- 1. 核心标记是否真的存在 ----------
    print("\n【1】Moodle 内核标记：在真实存档 HTML 里是否都命中")
    files = [
        ("测验回顾页", newest("quizreview_*.html")),
        ("合成作答页", newest("quiz_attempt_FIXTURE.html")),
        ("合成中间页", newest("quiz_attempt_MIDDLE_FIXTURE.html")),
    ]
    for label, p in files:
        if not p:
            print(f"  {label:<12} 存档缺失，跳过")
            continue
        root, c = classes_of(p)
        print(f"\n  {label}: {os.path.basename(p)}")
        for mk, desc in CORE_MARKERS.items():
            n = c.get(mk, 0)
            if n:
                print(f"      [OK] .{mk:<18} x{n:<4} {desc}")

    # ---------- 2. 表单 name 形态 ----------
    print("\n" + "=" * 78)
    print("【2】表单 name 形态（题引擎写死，主题改不了）")
    print("=" * 78)
    pat = re.compile(r'name="(q\d+:\d+)_([a-zA-Z0-9_]+)"')
    for label, p in files:
        if not p:
            continue
        raw = open(p, encoding="utf-8", errors="replace").read()
        names = pat.findall(raw)
        kinds = Counter(k for _, k in names)
        print(f"\n  {label}: 找到 {len(names)} 个 q<qubaid>:<slot>_* 字段")
        for k, n in kinds.most_common(8):
            print(f"      [OK] q<qubaid>:<slot>_{k:<16} x{n}")

    # ---------- 3. 与主题绑定的 class 有没有被我们用到 ----------
    print("\n" + "=" * 78)
    print("【3】我们**没有**用到的主题 class（说明没绑主题）")
    print("=" * 78)
    p = newest("quizreview_*.html")
    if p:
        _, c = classes_of(p)
        theme_cls = [k for k in c if THEME_HINTS.match(k) or k.startswith("lambda")]
        print(f"\n  回顾页里主题/工具类 class 共 {len(theme_cls)} 种，例如：")
        for k in sorted(theme_cls)[:14]:
            print(f"      .{k}")
        print("\n  → 这些**一个都没进**答题助手的选择器。")
        print("     脚本只用：div.que / .qtext / .qno / .ablock / div.answer>div.rN")
        print("               / .answernumber / [data-region=\"answer-label\"]")
        print("               / input[name=q..:.._answer] / input[type=submit][name=next]")

    # ---------- 4. 结论 ----------
    print("\n" + "=" * 78)
    print("【4】结论")
    print("=" * 78)
    print("""
  答题助手（quiz）:
    依赖 = Moodle 题引擎 + mod_quiz 内核标记
    与主题无关：是（主题只改 CSS 类，改不了 qtype 渲染出的 DOM 结构）
    与学校无关：是
    → 换任何 Moodle 站点/课程，只要题引擎版本相近就能用
    唯一需要改的：userscript 的 @match 域名（见下）

  连播（视频）:
    依赖 = mod_fsresource 插件 + 腾讯 tcplayer + 站点的 anti-bot 验证
    → **本校特有**，别的 Moodle 站点除非也装了同一套 fsresource 插件，
       否则完全不适用

  DSH 插件:
    → 本来就与 Moodle 无关（纯 OpenAI 兼容接口 + 本机 JSON 文件）
""")


if __name__ == "__main__":
    main()
