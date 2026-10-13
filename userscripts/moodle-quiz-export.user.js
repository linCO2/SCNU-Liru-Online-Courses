// ==UserScript==
// @name         砺儒云课堂 · 测验内容导出
// @namespace    https://moodle.scnu.edu.cn/
// @version      1.0.0
// @description  把砺儒云课堂的测验题目导出成纯文本并下载。用于复习、存档、搜索。
// @author       DSH
// @match        https://moodle.scnu.edu.cn/mod/quiz/view.php*
// @match        https://moodle.scnu.edu.cn/mod/quiz/review.php*
// @match        https://moodle.scnu.edu.cn/mod/quiz/attempt.php*
// @match        https://moodle.scnu.edu.cn/course/view.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * ===========================================================================
 * 定位：这是**导出工具**，不是代考工具
 * ===========================================================================
 *   ✅ 它做的：把测验页面上**已经存在**的题目、你的作答、正确答案读出来，
 *              整理成纯文本让你下载，方便复习和存档。
 *   ❌ 它不做的：不答题、不提交、不绕过任何限制。
 *              没做过的测验页面上没有答案，工具也不会去猜。
 *
 *   导出内容来自：
 *     - review.php（答题回顾页）：题目 + 你的作答 + 正确答案 + 反馈
 *     - attempt.php / view.php：题目文本（若页面上有）
 * ===========================================================================
 */

(function () {
  'use strict';

  const QTYPE_CN = {
    multichoice: '单选题', multichoiceset: '多选题', truefalse: '判断题',
    shortanswer: '填空题', match: '匹配题', essay: '论述题',
    numerical: '数值题', calculated: '计算题', ddwtos: '拖拽填空题',
    gapselect: '选词填空题', multianswer: '完形填空题', description: '说明',
  };

  const log = (...a) => console.log('%c[测验导出]', 'color:#0f766e;font-weight:bold', ...a);

  /* ------------------------------------------------------------ 文本提取 */
  function elText(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style').forEach(n => n.remove());
    return (c.textContent || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }

  /* ------------------------------------------------------------ 单题解析 */
  function parseQuestion(que) {
    const cls = que.className || '';
    let type = '?';
    for (const k in QTYPE_CN) {
      if (cls.includes(k)) { type = QTYPE_CN[k]; break; }
    }

    const q = { type, no: '', state: '', grade: '', stem: '', options: [], feedback: [] };
    const qno = que.querySelector('.qno');
    if (qno) q.no = elText(qno);
    const st = que.querySelector('.state');
    if (st) q.state = elText(st);
    const gr = que.querySelector('.grade');
    if (gr) q.grade = elText(gr);
    const qt = que.querySelector('.qtext');
    if (qt) q.stem = elText(qt);
    const ra = que.querySelector('.rightanswer');
    if (ra) q.correctTxt = elText(ra);

    // 选项：.answer 下 class 以 r 开头的行
    que.querySelectorAll('.answer > div').forEach(row => {
      const rcls = row.className || '';
      if (!/^r\d/.test(rcls.trim())) return;
      const inp = row.querySelector('input');
      const selected = !!(inp && inp.hasAttribute('checked'));
      const num = row.querySelector('.answernumber');
      const body = row.querySelector('.flex-fill');
      q.options.push({
        label: num ? elText(num).replace(/\.$/, '').trim() : '?',
        text: body ? elText(body) : elText(row),
        correct: rcls.includes('correct') && !rcls.includes('incorrect'),
        wrong: rcls.includes('incorrect'),
        selected,
      });
    });

    ['.feedback', '.specificfeedback', '.generalfeedback'].forEach(sel => {
      que.querySelectorAll(sel).forEach(el => {
        const t = elText(el);
        if (t && !q.feedback.includes(t)) q.feedback.push(t);
      });
    });
    return q;
  }

  /* ------------------------------------------------------------ 生成文本 */
  function fmtQuiz(title, questions) {
    const pad = n => String(n).padStart(2, ' ');
    const L = [];
    const line = '='.repeat(76);
    L.push(line, title, line);
    L.push('来源: ' + location.href);
    L.push('导出时间: ' + new Date().toLocaleString('zh-CN'));
    const nOpt = questions.filter(q => q.options.length).length;
    const nOk = questions.filter(q => q.state === '正确').length;
    const nBad = questions.filter(q => q.state === '错误').length;
    L.push(`题目数: ${questions.length}（选择题 ${nOpt}）  正确 ${nOk}  错误 ${nBad}`);
    L.push('');

    questions.forEach(q => {
      const bits = [q.state, q.grade, q.type].filter(Boolean);
      L.push(`【第 ${q.no || '?'} 题】` + (bits.length ? '  (' + bits.join(' · ') + ')' : ''));
      L.push('');
      (q.stem || '(题干为空)').split('\n').forEach(l => L.push('  ' + l));
      L.push('');
      q.options.forEach(o => {
        const mark = o.correct ? '[正确]' : (o.wrong ? '[错误]' : '      ');
        const sel = o.selected ? '★你选了' : '        ';
        L.push(`   ${mark} ${sel}  ${o.label}. ${o.text}`);
      });
      L.push('');
      const right = q.options.filter(o => o.correct).map(o => o.label);
      const wrongSel = q.options.filter(o => o.wrong && o.selected).map(o => o.label);
      if (right.length) L.push('  → 正确答案: ' + right.join('、'));
      else if (q.correctTxt) L.push('  → 正确答案: ' + q.correctTxt);
      if (wrongSel.length) L.push('  → 你选错了: ' + wrongSel.join('、'));
      q.feedback.forEach(f => L.push('  → 反馈: ' + f.slice(0, 300)));
      L.push('', '-'.repeat(72), '');
    });

    // 答案速查 + 错题
    const ans = questions
      .map(q => ({ no: q.no, a: q.options.filter(o => o.correct).map(o => o.label).join('、'), st: q.state }))
      .filter(x => x.a);
    if (ans.length) {
      L.push('', line, '答案速查', line);
      ans.forEach(x => L.push(`  ${pad(x.no)}. ${x.a.padEnd(10)} ${x.st}`));
      const wrongs = ans.filter(x => x.st === '错误');
      if (wrongs.length) {
        L.push('', '错题清单（建议重点复习）', '-'.repeat(72));
        wrongs.forEach(x => L.push(`  第 ${x.no} 题 —— 正确答案 ${x.a}`));
      }
    }
    return L.join('\n');
  }

  /* ------------------------------------------------------------ 下载文件 */
  function download(filename, text) {
    // 加 BOM，保证 Windows 记事本正确识别 UTF-8
    const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function safeName(s) {
    return (s || 'quiz').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
  }

  function pageQuizzes() {
    return Array.from(document.querySelectorAll('div.que'));
  }

  function pageTitle() {
    let t = document.title || '测验';
    t = t.replace(/\s*[|｜]\s*砺儒云课堂.*$/, '').trim();
    return t || '测验';
  }

  function exportCurrent() {
    const ques = pageQuizzes();
    if (!ques.length) {
      toast('这个页面上没找到题目。请到「答题回顾」页面再导出。', 'warn');
      return 0;
    }
    const parsed = ques.map(parseQuestion);
    const text = fmtQuiz(pageTitle(), parsed);
    download(safeName(pageTitle()) + '.txt', text);
    toast(`已导出 ${parsed.length} 道题，检查浏览器下载文件夹`, 'ok');
    log('导出完成', parsed.length, '题');
    return parsed.length;
  }

  /* ------------------------------------------------------------ 界面 */
  function toast(msg, kind) {
    let t = document.getElementById('qe-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'qe-toast';
      t.style.cssText = `position:fixed;right:18px;bottom:18px;z-index:99999;max-width:330px;
        padding:11px 15px;border-radius:9px;background:#0f766e;color:#fff;
        font:13px/1.55 "Microsoft YaHei",system-ui,sans-serif;
        box-shadow:0 8px 24px rgba(0,0,0,.28);`;
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = kind === 'warn' ? '#b42318' : (kind === 'ok' ? '#067647' : '#0f766e');
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.remove(); }, 6000);
  }

  function buildPanel() {
    if (document.getElementById('qe-panel')) return;
    const n = pageQuizzes().length;
    const el = document.createElement('div');
    el.id = 'qe-panel';
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:8px 12px;background:linear-gradient(90deg,#0f766e,#14b8a6);
                  color:#fff;font-weight:600;font-size:13px;">
        <span>测验内容导出</span><span id="qe-min" style="cursor:pointer;padding:0 4px">−</span>
      </div>
      <div id="qe-bd" style="padding:10px 12px;">
        <div id="qe-info" style="font-size:12px;color:#334155;margin-bottom:8px;"></div>
        <button id="qe-go" style="width:100%;padding:8px;border:0;border-radius:8px;
          background:linear-gradient(90deg,#0f766e,#14b8a6);color:#fff;cursor:pointer;
          font-size:13px;font-weight:600;">📄 导出本页题目为 TXT</button>
        <div style="font-size:11px;color:#64748b;margin-top:8px;line-height:1.5;">
          只导出本页已有的内容（题目／你的作答／正确答案）。<br>
          没做过的测验没有答案可导，本工具也不猜答案。
        </div>
      </div>`;
    el.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:99998;width:296px;
      background:#fff;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;
      box-shadow:0 8px 28px rgba(16,24,40,.18);
      font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;`;
    document.body.appendChild(el);

    const info = el.querySelector('#qe-info');
    info.innerHTML = n
      ? `本页检测到 <b>${n}</b> 道题`
      : '本页没检测到题目';

    el.querySelector('#qe-go').onclick = exportCurrent;
    el.querySelector('#qe-min').onclick = () => {
      const bd = el.querySelector('#qe-bd');
      bd.style.display = bd.style.display === 'none' ? 'block' : 'none';
    };
  }

  /* ------------------------------------------------------------ 课程页批量导出 */
  async function exportAllFromCourse() {
    // 课程页：找出所有已作答的测验，逐个抓 view 页找 review 链接并导出
    const links = Array.from(document.querySelectorAll('li.activity a[href*="mod/quiz/view.php"]'));
    const seen = new Set();
    const items = [];
    links.forEach(a => {
      const m = a.href.match(/view\.php\?id=(\d+)/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const li = a.closest('li.activity');
      const card = li && li.querySelector('[data-activityname]');
      const name = (card && card.getAttribute('data-activityname')) ||
                   (li && li.querySelector('.instancename') && elText(li.querySelector('.instancename'))) ||
                   ('测验' + m[1]);
      const done = li && /btn-subtle-success/.test(li.innerHTML) && /fa-check/.test(li.innerHTML);
      items.push({ cmid: m[1], name, done });
    });

    if (!items.length) { toast('课程页没找到测验链接', 'warn'); return; }
    const targets = items.filter(x => x.done);
    if (!targets.length) { toast('没有已作答的测验可供导出', 'warn'); return; }

    toast(`开始导出 ${targets.length} 个已作答测验，请稍候…`, 'ok');
    let ok = 0;
    for (const it of targets) {
      try {
        const viewUrl = `${location.origin}/mod/quiz/view.php?id=${it.cmid}`;
        const r = await fetch(viewUrl, { credentials: 'same-origin' });
        const html = await r.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rev = doc.querySelector('a[href*="mod/quiz/review.php"]');
        if (!rev) { log('跳过（无回顾）', it.name); continue; }
        const revUrl = new URL(rev.getAttribute('href'), location.origin).href;
        const r2 = await fetch(revUrl, { credentials: 'same-origin' });
        const html2 = await r2.text();
        const doc2 = new DOMParser().parseFromString(html2, 'text/html');
        const ques = Array.from(doc2.querySelectorAll('div.que'));
        if (!ques.length) { log('跳过（无题目）', it.name); continue; }
        const parsed = ques.map(parseQuestion);
        let title = doc2.title || it.name;
        title = title.replace(/\s*[|｜]\s*砺儒云课堂.*$/, '').trim();
        const text = fmtQuiz(title, parsed).replace('来源: ' + location.href, '来源: ' + revUrl);
        download(safeName(it.name) + '.txt', text);
        ok++;
        log('已导出', it.name, parsed.length, '题');
        // 给浏览器一点时间处理下载
        await new Promise(z => setTimeout(z, 700));
      } catch (e) {
        log('导出失败', it.name, e);
      }
    }
    toast(`批量导出完成：成功 ${ok} / ${targets.length}`, ok ? 'ok' : 'warn');
  }

  function buildCourseButton() {
    if (document.getElementById('qe-allbtn')) return;
    const b = document.createElement('button');
    b.id = 'qe-allbtn';
    b.textContent = '📄 导出全部已作答测验';
    b.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:99998;
      padding:11px 18px;border:0;border-radius:10px;cursor:pointer;
      background:linear-gradient(90deg,#0f766e,#14b8a6);color:#fff;font-weight:600;
      font-size:13px;box-shadow:0 8px 24px rgba(15,118,110,.42);
      font-family:"Microsoft YaHei",system-ui,sans-serif;`;
    b.onclick = () => { b.disabled = true; b.textContent = '导出中…'; exportAllFromCourse().finally(() => {
      b.disabled = false; b.textContent = '📄 导出全部已作答测验';
    }); };
    document.body.appendChild(b);
  }

  /* ------------------------------------------------------------ 初始化 */
  function init() {
    const path = location.pathname;
    if (/\/mod\/quiz\/(review|attempt|view)\.php/.test(path)) {
      buildPanel();
    } else if (/\/course\/view\.php/.test(path)) {
      buildCourseButton();
    }
    log('已加载：', path);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
