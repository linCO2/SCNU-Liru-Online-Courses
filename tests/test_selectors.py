#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
离线回归测试：用真实存档的砺儒云课堂 HTML 验证两个 userscript 的选择器与解析逻辑。

为什么需要它：
  本沙箱起不了浏览器（Chromium 需要命名管道做 IPC，被沙箱拒绝），
  所以 userscript 无法在这里真跑。但**选择器与解析逻辑**可以在离线 HTML 上
  用同一套等价规则验证一遍，避免发到用户手上才发现选择器全空。

只用 lxml 原生 XPath，不依赖 cssselect。

它验的是"选择器还能不能选中"这件事，等价实现自 userscript：
  - 自动连播助手：.num-gksc span（观看时长）、.num-bfjd span（进度）、
                  video#fsplayer-container-id、playerdata、anti-bot 结构
  - 答题助手   ：div.que / .qtext / .ablock / div.answer>div.rN /
                  input[name=q..:.._answer] / .qno / .answernumber

用法：
  python test_selectors.py
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


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'[OK]' if cond else '[XX]'} {name}" + (f"   {detail}" if detail else ""))


def newest(pat):
    fs = glob.glob(os.path.join(OUT, pat))
    return max(fs, key=os.path.getmtime) if fs else None


def load(path):
    p = etree.HTMLParser(recover=True, huge_tree=True)
    with open(path, "rb") as f:
        return etree.parse(f, p)


def cls_of(el):
    return el.get("class") or ""


def q_el(root, *path):
    """XPath 查询，等价于 CSS 选择器。"""
    return root.xpath(" | ".join(path))


# ---------------------------------------------------------------- 视频页
def test_video_page():
    print("\n" + "=" * 74)
    print("【视频页】fsresource 选择器")
    print("=" * 74)
    path = newest("fsresource_video_*.html")
    if not path:
        check("找到视频页存档", False)
        return
    print(f"存档: {os.path.basename(path)}")
    tree = load(path)
    root = tree.getroot()
    raw = open(path, encoding="utf-8", errors="replace").read()

    # 面板要读的两个数字：.num-gksc span / .num-bfjd span
    gksc = root.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," num-gksc ")]//span')
    bfjd = root.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," num-bfjd ")]//span')
    check(".num-gksc span 观看时长", len(gksc) >= 1,
          f"值={gksc[0].xpath("string(.)").strip() if gksc else 'N/A'} 秒")
    check(".num-bfjd span 播放进度", len(bfjd) >= 1,
          f"值={bfjd[0].xpath("string(.)").strip() if bfjd else 'N/A'} %")

    tips = root.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," tips ")]')
    tiptxt = " ".join(tips[0].xpath("string(.)").split()) if tips else ""
    check("完成要求含 95%", "95%" in tiptxt, tiptxt[:90])

    # playerdata
    m = re.search(r"var\s+playerdata\s*=\s*(\{.*?\})\s*\n", raw, re.S)
    check("能取到 playerdata", bool(m))
    if m:
        for k in ("fsresourceid", "sesskey", "siteUrl", "userid"):
            check(f"playerdata.{k}", f"'{k}'" in m.group(1))

    js = read_js("js_tcplayer_video_*")
    main_js = read_js("js_tcplayer_main_*")

    check("video 挂载点 #player-con", 'id="player-con"' in raw)
    check("video 元素 id 由 main.js 创建（静态 HTML 里本来没有 <video>）",
          "fsplayer-container-id" in main_js)
    check("防挂机遮罩 anti-bot-* 由 JS 运行时插入（静态 HTML 里本来没有）",
          "anti-bot-" in js)

    check("上报 methodname=mod_fsresource_set_time", "mod_fsresource_set_time" in js)
    check("250ms 累加器 + playerState==1", "this.viewTotalTime += 250" in js and "playerState == 1" in js)
    check("95% 阈值由服务端判定（本脚本不自己定阈值）", "totaltime" in js)
    check("验证间隔 10 分钟分档", "tenMinutesMs" in js)
    check("验证按钮 id 前缀 ab-btn-", 'ab-btn-' in js)
    check("验证遮罩 id 前缀 anti-bot-", 'anti-bot-' in js)


def read_js(pat):
    p = newest(pat)
    if not p:
        return ""
    return open(p, encoding="utf-8", errors="replace").read()


# ---------------------------------------------------------------- 答题页
def scrape_questions(root):
    """
    scrapeQuestions() 的等价实现，用于离线验证。
    返回 [{n, qno, slot, prefix, type, text, options:[{key,label}]}]
    """
    out = []
    ques = root.xpath('//div[contains(concat(" ",normalize-space(@class)," ")," que ")]')
    for i, q in enumerate(ques):
        m = re.search(r"\bque\s+([a-z0-9_]+)", cls_of(q))
        qt = m.group(1) if m else "unknown"
        qtels = q.xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," qtext ")]')
        qtext = " ".join(qtels[0].xpath("string(.)").split()) if qtels else ""
        qnoels = q.xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," qno ")]')
        qno = qnoels[0].xpath("string(.)").strip() if qnoels else str(i + 1)

        inp = q.xpath('.//input[@name] | .//textarea[@name] | .//select[@name]')
        prefix = None
        if inp:
            mm = re.match(r"^(q\d+:\d+)_", inp[0].get("name") or "")
            if mm:
                prefix = mm.group(1)
        slot = prefix.split(":")[1] if prefix else str(i + 1)

        item = {"n": i + 1, "qno": qno, "slot": slot, "prefix": prefix,
                "type": qt, "text": qtext, "options": []}

        rows = [r for r in q.xpath(
            './/*[contains(concat(" ",normalize-space(@class)," ")," answer ")]/div')
            if re.match(r"^r\d", cls_of(r))]
        for k, r in enumerate(rows):
            lab = r.xpath('.//*[@data-region="answer-label"]')
            if lab:
                t = " ".join(lab[0].xpath("string(.)").split())
                num = lab[0].xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," answernumber ")]')
                if num:
                    nn = num[0].xpath("string(.)").strip()
                    if nn and t.startswith(nn):
                        t = t[len(nn):]
            else:
                t = " ".join(r.xpath("string(.)").split())
            m2 = re.match(r"^\.?([A-Za-z])[.、)．:：]\s*(.+)$", t.strip(), re.S)
            if m2 and m2.group(2):
                t = m2.group(2).strip()
            item["options"].append({"key": chr(65 + k), "label": t.strip()})
        out.append(item)
    return out


def make_attempt_fixture():
    """
    用真实回顾页合成一份「作答中」页面夹具，供离线验证：
      - 去掉 disabled（作答页的 radio 是可点的）
      - 去掉 checked（作答页默认未选）
      - 补上真实 Moodle 作答页的翻页表单
    这样就能在不用浏览器、不用真去点学校服务器的前提下，
    验证「抓题 → 决定要点哪个 input」这条链路。
    """
    src = newest("quizreview_*.html")
    if not src:
        return None
    raw = open(src, encoding="utf-8", errors="replace").read()
    raw = raw.replace(' disabled="disabled"', '').replace(" disabled", "")
    raw = raw.replace(' checked="checked"', '').replace(" checked", "")
    raw += """
<form action="/mod/quiz/processattempt.php" method="post" id="responseform-nav">
  <div id="mod_quiz-next-nav">
    <input type="hidden" name="sesskey" value="FIXTURE" />
    <input type="submit" name="next" value="下一页" class="submitbtn" />
  </div>
</form>"""
    path = os.path.join(OUT, "quiz_attempt_FIXTURE.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(raw)
    return path


def test_quiz_page():
    print("\n" + "=" * 74)
    print("【答题/回顾页】Moodle quiz 选择器")
    print("=" * 74)
    path = newest("quizreview_*.html")
    if not path:
        check("找到回顾页存档", False)
        return
    print(f"存档: {os.path.basename(path)}")
    root = load(path).getroot()

    parsed = scrape_questions(root)
    check("div.que 抓到题目", len(parsed) > 0, f"{len(parsed)} 道")
    n = len(parsed)
    check(".qtext 题干", all(p["text"] for p in parsed), f"{sum(1 for p in parsed if p['text'])}/{n}")
    check(".qno 题号", all(p["qno"] for p in parsed), f"{sum(1 for p in parsed if p['qno'])}/{n}")
    check("name 前缀 q<qubaid>:<slot>_", all(p["prefix"] for p in parsed),
          f"{sum(1 for p in parsed if p['prefix'])}/{n}")
    withopts = [p for p in parsed if p["options"]]
    check("选项行 + 字母标号", len(withopts) > 0, f"{len(withopts)} 道有选项")
    types = {}
    for p in parsed:
        types[p["type"]] = types.get(p["type"], 0) + 1
    print(f"    题型分布: {types}")

    # 选项文本不能带重复字母前缀
    bad = [(p["n"], o) for p in parsed for o in p["options"]
           if re.match(r"^[A-Za-z][.、)．]\s", o["label"])]
    check("选项文本已剥掉重复字母前缀", not bad, str(bad[:3]))

    correct = root.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," correct ")]')
    check("div.correct 正确选项标记", len(correct) > 0, f"{len(correct)} 个")

    print("\n  —— 解析样例（等价于答题助手的输出）——")
    for p in parsed[:2]:
        print(f"  【第 {p['qno']} 题】({p['type']}) {p['text'][:56]}")
        for o in p["options"]:
            print(f"      {o['key']}. {o['label'][:60]}")

    # ---- 合成"作答中"夹具再验一遍 ----
    fx = make_attempt_fixture()
    if fx:
        froot = load(fx).getroot()
        fparsed = scrape_questions(froot)
        print(f"\n  合成作答页夹具: {os.path.basename(fx)}")
        check("夹具：抓到同样多的题", len(fparsed) == n, f"{len(fparsed)}/{n}")
        # 每个选项都能定位到可点的 input
        clickable = 0
        total = 0
        for p in froot.xpath('//div[contains(concat(" ",normalize-space(@class)," ")," que ")]'):
            rows = [r for r in p.xpath(
                './/*[contains(concat(" ",normalize-space(@class)," ")," answer ")]/div')
                if re.match(r"^r\d", cls_of(r))]
            for r in rows:
                total += 1
                if r.xpath('.//input[@type="radio" or @type="checkbox"]'):
                    clickable += 1
        check("夹具：每个选项都有可点 input", clickable == total and total > 0,
              f"{clickable}/{total}")
        nosel = [p["n"] for p in fparsed if p["options"] and not any(
            o["key"] for o in p["options"])]
        check("夹具：选项字母齐全", not nosel)


# ---------------------------------------------------------------- 翻页按钮
def test_nav():
    print("\n" + "=" * 74)
    print("【翻页】下一页 / 提交按钮选择器")
    print("=" * 74)
    src = newest("quizreview_*.html")
    if not src:
        check("找到存档", False)
        return
    print("  回顾页（本来就没有翻页按钮，用它验「不误判」）:")
    root = load(src).getroot()
    xps = {
        'input[@name="next"]': '//input[@name="next"]',
        'button[@name="next"]': '//button[@name="next"]',
        'input[@name="finishattempt"]': '//input[@name="finishattempt"]',
        'button[@name="finishattempt"]': '//button[@name="finishattempt"]',
        '#mod_quiz-next-nav input': '//*[@id="mod_quiz-next-nav"]//input',
        '#mod_quiz-next-nav button': '//*[@id="mod_quiz-next-nav"]//button',
    }
    review_hits = []
    for label, xp in xps.items():
        els = root.xpath(xp)
        if els:
            val = (els[0].get("value") or els[0].xpath("string(.)") or "").strip()[:28]
            review_hits.append((label, len(els), val))
    for label, cnt, val in review_hits:
        print(f"    {label:<30} x{cnt}  「{val}」")
    check("回顾页上这些选择器不误命中",
          not any("next" in h[0] or "finishattempt" in h[0] for h in review_hits))

    print("\n  合成作答页夹具:")
    fx = make_attempt_fixture()
    if not fx:
        check("夹具可用", False)
        return
    froot = load(fx).getroot()
    hit = None
    for label, xp in xps.items():
        els = froot.xpath(xp)
        if els:
            val = (els[0].get("value") or els[0].xpath("string(.)") or "").strip()[:28]
            print(f"    {label:<30} x{len(els)}  「{val}」")
            if "next" in label and hit is None:
                hit = val
    check("夹具：能定位「下一页」按钮", hit is not None, str(hit))


def main():
    test_video_page()
    test_quiz_page()
    test_nav()

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
