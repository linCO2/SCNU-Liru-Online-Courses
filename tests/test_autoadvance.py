#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
答题助手 v2「自动翻页」离线回归测试。

背景：userscript 无法在本沙箱真跑（Chromium 起不来），但**决定自动翻页的那两个
选择器**可以在真实/合成 HTML 上验证。这两个函数点错一步就是：
  - 误点隐藏的 sesskey 域 → 什么都不发生，卡死
  - 该点「下一页」时找不到 → 停机
  - 在提交页误点「下一页」→ 不存在，但若误点「提交所有答案并结束」= 自动交卷（不可接受）

本测试覆盖 findNextButton() / findFinishButton() 的等价实现，三种页面：
  A. 真实回顾页（review.php）  —— 两个都应找不到（回顾页没有翻页/提交）
  B. 合成「中间页」           —— 有隐藏 sesskey + 可见「下一页」
  C. 合成「最后一页」         —— 有隐藏 sesskey + 可见「提交所有答案并结束」

选择器顺序取自 userscript 里 findNextButton/findFinishButton 的 sels 数组，
并同样排除 type=hidden 与 disabled。

用法：
  python test_autoadvance.py
"""
import os
import re
import sys
import glob

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

PASS, FAIL = [], []

NEXT_NAMES = ["next"]
FINISH_NAMES = ["finishattempt", "finish"]
NEXT_TEXTS = ["下一页", "下一步", "下一题", "Next page", "Next", "Next question", "Continue"]
FINISH_TEXTS = ["提交所有答案并结束", "结束答题", "Submit all and finish", "Finish attempt", "Submit all"]


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'[OK]' if cond else '[XX]'} {name}" + (f"   {detail}" if detail else ""))


def newest(pat):
    fs = glob.glob(os.path.join(OUT, pat))
    return max(fs, key=os.path.getmtime) if fs else None


def load_root(path):
    with open(path, "rb") as f:
        return etree.parse(f, etree.HTMLParser(recover=True, huge_tree=True)).getroot()


def visible_submit(root, texts, names):
    """
    findSubmitButton() 的等价实现（三层）：
      ① name 属性（与语言无关，最可靠）
      ② 按钮文案（多语言列表）
    跳过 type=hidden 与 disabled。
    返回 (元素, 显示值, 命中层次) 或 None。
    """
    # ① name
    for n in names:
        for el in root.xpath('//input[@type="submit"] | //button'):
            if (el.get("name") or "") != n:
                continue
            if (el.get("type") or "").lower() == "hidden" or el.get("disabled") is not None:
                continue
            val = el.get("value") or el.xpath("string(.)") or ""
            return (el, val.strip()[:32], "name")
    # ② 文案
    for el in root.xpath('//input[@type="submit"] | //button'):
        if (el.get("type") or "").lower() == "hidden" or el.get("disabled") is not None:
            continue
        v = re.sub(r"\s+", " ", (el.get("value") or el.xpath("string(.)") or "")).strip()
        if not v:
            continue
        if any(v == t or v.startswith(t) for t in texts):
            return (el, v[:32], "text")
    return None


# ---------------------------------------------------------------- 夹具构造
# 注意：必须带 <meta charset="utf-8">。
# 真实 Moodle 页面是有 charset 声明的（Content-Type: text/html; charset=utf-8），
# 浏览器因此能正确解出「下一页」；夹具缺了声明就会被 lxml 按 latin-1 解析成乱码。
# 这不是脚本的 bug，但会让测试输出难读，所以补上。
MIDDLE_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body>
<div class="que multichoice deferredfeedback">
  <div class="info"><h3 class="no">试题 <span class="qno">1</span></h3></div>
  <div class="content"><div class="formulation clearfix">
    <div class="qtext">中间页第 1 题</div>
    <fieldset class="ablock"><legend>回答</legend><div class="answer">
      <div class="r0"><input type="radio" name="q111:1_answer" value="0" />
        <div data-region="answer-label"><span class="answernumber">A. </span><div>甲</div></div></div>
      <div class="r1"><input type="radio" name="q111:1_answer" value="1" />
        <div data-region="answer-label"><span class="answernumber">B. </span><div>乙</div></div></div>
    </div></fieldset>
  </div></div>
</div>
<form action="/mod/quiz/processattempt.php" method="post">
  <input type="hidden" name="sesskey" value="AbCdEf123" />
  <input type="hidden" name="attempt" value="7000001" />
  <div id="mod_quiz-next-nav">
    <input type="submit" name="next" value="下一页" class="submitbtn btn-primary" />
  </div>
</form>
</body></html>"""

LAST_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body>
<div class="que truefalse deferredfeedback">
  <div class="info"><h3 class="no">试题 <span class="qno">2</span></h3></div>
  <div class="content"><div class="formulation clearfix">
    <div class="qtext">最后一页第 2 题</div>
    <fieldset class="ablock"><legend>回答</legend><div class="answer">
      <div class="r0"><input type="radio" name="q222:2_answer" value="0" />
        <div data-region="answer-label"><span class="answernumber">A. </span><div>对</div></div></div>
      <div class="r1"><input type="radio" name="q222:2_answer" value="1" />
        <div data-region="answer-label"><span class="answernumber">B. </span><div>错</div></div></div>
    </div></fieldset>
  </div></div>
</div>
<form action="/mod/quiz/summary.php" method="post">
  <input type="hidden" name="sesskey" value="ZzYyXx999" />
  <div id="mod_quiz-next-nav">
    <input type="submit" name="finishattempt" value="提交所有答案并结束"
           class="submitbtn btn-primary" />
  </div>
</form>
</body></html>"""


def write_fixtures():
    mid = os.path.join(OUT, "quiz_attempt_MIDDLE_FIXTURE.html")
    last = os.path.join(OUT, "quiz_attempt_LAST_FIXTURE.html")
    with open(mid, "w", encoding="utf-8") as f:
        f.write(MIDDLE_PAGE)
    with open(last, "w", encoding="utf-8") as f:
        f.write(LAST_PAGE)
    return mid, last


def test_review_page():
    print("\n" + "=" * 74)
    print("【A】真实回顾页 —— 两个按钮都**不该**找到")
    print("=" * 74)
    src = newest("quizreview_*.html")
    if not src:
        check("找到回顾页存档", False)
        return
    print(f"存档: {os.path.basename(src)}")
    root = load_root(src)
    nxt = visible_submit(root, NEXT_TEXTS, NEXT_NAMES)
    fin = visible_submit(root, FINISH_TEXTS, FINISH_NAMES)
    check("回顾页找不到「下一页」", nxt is None,
          f"误命中: {nxt[1]!r}" if nxt else "")
    check("回顾页找不到「提交所有答案并结束」", fin is None,
          f"误命中: {fin[1]!r}" if fin else "")


def test_middle_page():
    print("\n" + "=" * 74)
    print("【B】合成中间页 —— 应找到「下一页」且**跳过隐藏 sesskey**")
    print("=" * 74)
    mid, _ = write_fixtures()
    print(f"夹具: {os.path.basename(mid)}")
    root = load_root(mid)

    # 页面上确实有隐藏域（用来证明我们跳过了它）
    hidden = root.xpath('//input[@type="hidden"]')
    check("夹具里确实有隐藏域（sesskey 等）", len(hidden) >= 2, f"{len(hidden)} 个")

    nxt = visible_submit(root, NEXT_TEXTS, NEXT_NAMES)
    check("找到「下一页」", nxt is not None, nxt[1] if nxt else "没找到")
    if nxt:
        check("找到的是 name=next（不是 sesskey）",
              nxt[0].get("name") == "next", f"name={nxt[0].get('name')}")
    check("中间页不该找到「提交所有答案并结束」",
          visible_submit(root, FINISH_TEXTS, FINISH_NAMES) is None)


def test_last_page():
    print("\n" + "=" * 74)
    print("【C】合成最后一页 —— 应找到「提交所有答案并结束」、找不到「下一页」")
    print("=" * 74)
    _, last = write_fixtures()
    print(f"夹具: {os.path.basename(last)}")
    root = load_root(last)

    fin = visible_submit(root, FINISH_TEXTS, FINISH_NAMES)
    check("找到「提交所有答案并结束」", fin is not None, fin[1] if fin else "没找到")
    if fin:
        check("找到的是 name=finishattempt（不是 sesskey）",
              fin[0].get("name") == "finishattempt", f"name={fin[0].get('name')}")
    check("最后一页没有「下一页」", visible_submit(root, NEXT_TEXTS, NEXT_NAMES) is None)

    # 这条最关键：userscript 的判定是
    #   if (findFinishButton() && !findNextButton()) stopAtSubmitPage();
    # 也就是"有结束按钮且没有下一页" → 停机等人。这里验证这个组合成立。
    has_fin = visible_submit(root, FINISH_TEXTS, FINISH_NAMES) is not None
    has_next = visible_submit(root, NEXT_TEXTS, NEXT_NAMES) is not None
    check("停机条件 (有结束 && 无下一页) 成立", has_fin and not has_next,
          f"finish={has_fin} next={has_next}")


def test_i18n():
    """
    跨站点最重要的新能力：**不同语言的按钮文案**。
    Moodle 各语言的 string 来自语言包，所以英文站点的按钮是 "Next page" /
    "Submit all and finish"。这里验证兜底逻辑认得出。
    """
    print("\n" + "=" * 74)
    print("【E】多语言与 name 兜底（跨站点关键）")
    print("=" * 74)

    def mk(btn_html):
        html = ('<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>'
                '<form action="/mod/quiz/processattempt.php" method="post">'
                '<input type="hidden" name="sesskey" value="XyZ123" />'
                + btn_html + '</form></body></html>')
        return etree.fromstring(html, etree.HTMLParser(recover=True))

    cases = [
        # (按钮 HTML, 期望名, 说明)
        ('<input type="submit" name="next" value="Next page" />', 'next', '英文 Next page'),
        ('<input type="submit" name="next" value="Next" />', 'next', '英文 Next'),
        ('<input type="submit" name="next" value="次のページ" />', 'next', '日文'),
        ('<input type="submit" name="next" value="下一页" />', 'next', '中文'),
        # 只有文案、没有 name（某些自定义主题会这样）→ 靠文案兜底
        ('<input type="submit" value="Next page" />', None, '无 name，靠文案'),
        ('<input type="submit" value="下一页" />', None, '无 name，靠文案'),
    ]
    for html, want_name, desc in cases:
        root = mk(html)
        got = visible_submit(root, NEXT_TEXTS, NEXT_NAMES)
        ok = got is not None and (want_name is None or got[0].get("name") == want_name)
        check(f"识别「下一页」: {desc}", ok,
              (f"命中层次={got[2]}，{got[1]!r}" if got else "没找到"))

    fin_cases = [
        ('<input type="submit" name="finishattempt" value="Submit all and finish" />', 'finishattempt'),
        ('<input type="submit" name="finishattempt" value="提交所有答案并结束" />', 'finishattempt'),
        ('<input type="submit" value="Submit all and finish" />', None),
    ]
    for html, want_name in fin_cases:
        root = mk(html)
        got = visible_submit(root, FINISH_TEXTS, FINISH_NAMES)
        ok = got is not None and (want_name is None or got[0].get("name") == want_name)
        check(f"识别「提交并结束」: {html[20:52]}...", ok,
              (f"命中层次={got[2]}" if got else "没找到"))

    # 反向验证：绝不把隐藏域当成按钮
    root = mk('<input type="submit" name="next" value="Next page" />')
    hidden_hit = None
    for el in root.xpath('//input[@type="hidden"]'):
        if (el.get("name") or "") in NEXT_NAMES or (el.get("name") or "") in FINISH_NAMES:
            hidden_hit = el.get("name")
    check("隐藏域没被误认为按钮", hidden_hit is None, f"误命中 {hidden_hit}")


def test_state_machine_rules():
    print("\n" + "=" * 74)
    print("【D】状态机规则（纯逻辑，等价于 userscript 的判定）")
    print("=" * 74)

    def decide(armed, sig, processed, has_next, has_finish):
        """processPage 的翻页决策等价实现"""
        if not armed:
            return 'idle'
        if sig in processed:
            return 'STOP:dup-guard'
        if has_finish and not has_next:
            return 'STOP:submit-page'
        if not has_next:
            return 'STOP:no-next-button'
        return 'click-next'

    cases = [
        # (armed, sig, processed, has_next, has_finish, 期望)
        (False, 'a', [], True, False, 'idle'),
        (True, 'a', [], True, False, 'click-next'),
        (True, 'a', ['a'], True, False, 'STOP:dup-guard'),
        (True, 'b', ['a'], True, False, 'click-next'),
        (True, 'c', ['a', 'b'], False, True, 'STOP:submit-page'),
        (True, 'c', ['a', 'b'], False, False, 'STOP:no-next-button'),
    ]
    for armed, sig, processed, has_next, has_finish, want in cases:
        got = decide(armed, sig, processed, has_next, has_finish)
        check(f"armed={armed} sig={sig} processed={processed} next={has_next} fin={has_finish} -> {want}",
              got == want, f"实得 {got}")

    print("\n  说明：")
    print("    dup-guard   = 翻页没生效/用户退回时绝不重复作答")
    print("    submit-page = 到达提交页停机，把提交留给人")


def main():
    test_review_page()
    test_middle_page()
    test_last_page()
    test_i18n()
    test_state_machine_rules()

    print("\n" + "=" * 74)
    print(f"结果: 通过 {len(PASS)}   失败 {len(FAIL)}")
    print("=" * 74)
    if FAIL:
        for f in FAIL:
            print("  [XX] " + f)
        return 1
    print("  全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
