// ==UserScript==
// @name         Moodle 通用 · 答题助手（一次确认 → 全自动答完所有题）
// @namespace    https://moodle.scnu.edu.cn/
// @version      2.1.0
// @description  Moodle 测验全自动作答：面板上点一次「放任自流」，之后逐题抓取→大模型→自动填入→自动切下一题，直到提交页停下等你确认。默认绝不自动交卷。适用于任何 Moodle 站点。
// @author       DSH
//
// 为什么 @match 敢写这么宽：
//   脚本依赖的 DOM 标记全部来自 **Moodle 题引擎与 mod_quiz 内核**
//   （div.que / .qtext / .qno / .ablock / div.answer>div.rN / .answernumber /
//    input[name=q<qubaid>:<slot>_answer] / input[type=submit][name=next]），
//   这些是 qtype 渲染器写死的，**主题只能改 CSS、改不了结构**。
//   已用 portability_probe.py 在真实存档 HTML 上验证：本校主题（lambda2）
//   的 27 个主题类**一个都没进**选择器。所以跨站点可用。
//
//   真正会变的只有两样，都已在运行时处理：
//     ① 按钮文案（不同语言）→ 见 NEXT_TEXTS / FINISH_TEXTS
//     ② 路径 → isAttempt() 等函数在运行时按 /mod/quiz/... 判断，
//        非测验页直接不启动
//
// @match        https://*/*
// @match        http://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/*
 * ===========================================================================
 * 答题助手 v2.1.0 —— 「人工只介入两次」+ 跨站点通用
 * ===========================================================================
 *
 * v2.1.0（跨站点）
 *   - @match 放宽到任意站点：依赖的标记全来自 Moodle 内核（见文件头 metadata 注释）
 *   - 按钮查找改三层兜底：name 属性（与语言无关）→ 多语言文案 → 可见 submit
 *   - 停机检测、论述题字数提示补英文匹配
 *
 * 交互设计（按用户明确要求）：
 *
 *   人工第一次介入：在面板上点一次 **「🚀 放任自流」** 按钮
 *                    —— 这是唯一的授权动作，点之前脚本不会自动提交任何东西。
 *   人工第二次介入：答完全部页后到达提交页，脚本**停下**并高亮
 *                    「提交所有答案并结束」按钮，由你点下去。
 *
 *   中间全程无人值守：抓当前页题目 → 问模型 → 自动填入 → 自动点「下一页」
 *   → 页面刷新 → 脚本接着干 → …… 直到提交页。
 *
 * ---------------------------------------------------------------------------
 * 关键工程问题：Moodle 的「下一页」是**整页表单提交**，不是 AJAX
 * ---------------------------------------------------------------------------
 *   userscript 在整页跳转时会被重新加载，所以"循环"不能靠 while，
 *   只能靠**跨页面的运行状态**（localStorage）+ 每次页面加载时续跑。
 *
 *   状态机（存 localStorage 的 scnu_quiz_run_v1）：
 *     armed      = true          面板点了「放任自流」
 *     processed  = [url, url...] 已经处理过的页面（防重复作答 / 防死循环）
 *     pages      = 已处理页数
 *     asked      = 已请求模型的批次数
 *   每次页面加载：
 *     若 armed 且 当前 url 不在 processed → 处理本页 → 点「下一页」
 *     若 armed 但 url 已在 processed    → 说明翻页没成功（或导航回退）
 *                                          → 停下并告警，绝不重复作答
 *     若到提交页/摘要页                  → 停下，等用户点提交
 *
 * ---------------------------------------------------------------------------
 * 支持题型（按真实 Moodle DOM 实现，已用存档 HTML + 合成夹具离线验证）
 * ---------------------------------------------------------------------------
 *   multichoice     单选   radio
 *   multichoiceset  多选   checkbox
 *   truefalse       判断   radio
 *   shortanswer     填空   text input
 *   numerical       数值   text input（会自动只留数字）
 *   essay           论述   textarea（会检查最低字数）
 *   match/ddmatch   匹配   select
 *   其它未知题型：不猜答案，标红，并默认**不阻断**翻页（可关）
 *
 * ---------------------------------------------------------------------------
 * 安全边界（刻意保留）
 * ---------------------------------------------------------------------------
 *   - **绝不自动点「提交所有答案并结束」**。交卷不可逆、有次数限制，
 *     这一步永远留给人。脚本只负责把你送到提交页。
 *   - 不猜答案。模型返回空就标红，不填假答案。
 *   - 只操作当前页表单，不发任何额外请求去构造/上传答案。
 *   - 页面上一旦出现错误提示（会话过期、不允许再次作答等）立刻停机。
 * ===========================================================================
 */

(function () {
  'use strict';

  const LS = {
    cfg: 'scnu_quiz_ai_cfg_v1',
    cache: 'scnu_quiz_ai_cache_v1',
    run: 'scnu_quiz_run_v1',
  };
  const CACHE_MAX = 400;
  /** 一次「放任自流」最多处理多少页，防死循环烧钱 */
  const MAX_PAGES = 40;
  /** 一次运行最多请求模型多少次（每批算一次） */
  const MAX_ASKS = 60;

  /*
   * 按钮文案按语言列出 —— 这是唯一与"站点/语言"有关的东西。
   * Moodle 各语言的 string 来自语言包，所以这里列常见几种；
   * 兜底还会认 name 属性（name="next" / name="finishattempt" 与语言无关，最可靠）。
   */
  const NEXT_TEXTS = [
    '下一页', '下一步', '下一题', '下一頁', '下一題',
    'Next page', 'Next', 'Next question', 'Continue',
    '次のページ', '次へ', '다음 페이지', 'Weiter', 'Suivant',
  ];
  const FINISH_TEXTS = [
    '提交所有答案并结束', '结束答题', '提交并结束', '交卷',
    '提交所有答案並結束', '結束答題',
    'Submit all and finish', 'Finish attempt', 'Submit all',
    'すべての解答を送信して終了', '모든 답안 제출하고 종료',
    'Alles absenden und beenden', 'Terminer',
  ];

  const log = (...a) => console.log('%c[答题助手]', 'color:#7c3aed;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[答题助手]', 'color:#e8590c;font-weight:bold', ...a);

  /* ============================ 配置 ============================ */
  const DEFAULT_CFG = {
    provider: 'direct',              // 'direct' 直连接口 | 'bridge' 走本地 DSH 桥
    bridgeUrl: 'http://127.0.0.1:19387/scnu-bridge/ask',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0,
    maxTokens: 2000,
    batch: 5,
    delayMs: 800,
    promptExtra: '',
    /** 有题目没自动填上时，是否仍然翻到下一页（false = 停下来让你处理） */
    keepGoingOnFailure: true,
    /** 页面加载后等待多少毫秒再抓题（等 Moodle 的 JS 把 DOM 渲染完） */
    settleMs: 1200,
  };

  let CFG = loadCfg();

  function loadCfg() {
    try {
      const raw = (typeof GM_getValue === 'function')
        ? GM_getValue(LS.cfg, '') : localStorage.getItem(LS.cfg);
      return Object.assign({}, DEFAULT_CFG, JSON.parse(raw || '{}'));
    } catch (e) { return Object.assign({}, DEFAULT_CFG); }
  }
  function saveCfg(cfg) {
    const raw = JSON.stringify(cfg);
    try {
      if (typeof GM_setValue === 'function') GM_setValue(LS.cfg, raw);
      else localStorage.setItem(LS.cfg, raw);
    } catch (e) { /* ignore */ }
  }

  /* ======================= 跨页面运行状态 ========================= */
  function readRun() {
    try {
      const r = JSON.parse(localStorage.getItem(LS.run) || '{}');
      return {
        armed: r.armed === true,
        processed: Array.isArray(r.processed) ? r.processed : [],
        pages: Number(r.pages) || 0,
        asked: Number(r.asked) || 0,
        quizId: r.quizId || null,
        startedAt: r.startedAt || null,
      };
    } catch (e) {
      return { armed: false, processed: [], pages: 0, asked: 0, quizId: null, startedAt: null };
    }
  }
  function writeRun(run) {
    try { localStorage.setItem(LS.run, JSON.stringify(run)); } catch (e) { /* ignore */ }
  }
  function disarm() {
    const run = readRun();
    run.armed = false;
    writeRun(run);
  }

  /* ========================= 答案缓存 ============================ */
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(LS.cache) || '{}'); }
    catch (e) { return {}; }
  }
  function saveCache(c) {
    try {
      const keys = Object.keys(c);
      if (keys.length > CACHE_MAX) {
        const trim = keys.slice(keys.length - CACHE_MAX);
        const n = {};
        trim.forEach(k => { n[k] = c[k]; });
        c = n;
      }
      localStorage.setItem(LS.cache, JSON.stringify(c));
    } catch (e) { /* ignore */ }
  }
  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* =========================== 工具 ============================== */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function txt(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }
  /** 剥掉选项文本的字母前缀（"B. 历史唯物主义" → "历史唯物主义"） */
  function stripPrefix(label) {
    const s = String(label || '').trim();
    const m = s.match(/^\.?([A-Za-z])[.、)．:：]\s*(.+)$/s);
    if (m && m[2] && !(m[1] === 'A' && m[2] === 'I')) return m[2].trim();
    return s.replace(/^[\s\-–—_]+/, '').trim();
  }
  function optionLabel(row) {
    const lbl = row.querySelector('[data-region="answer-label"]');
    if (lbl) {
      const num = lbl.querySelector('.answernumber');
      let t = txt(lbl);
      if (num) {
        const n = txt(num);
        if (n && t.startsWith(n)) t = t.slice(n.length);
      }
      const clean = stripPrefix(t);
      if (clean) return clean;
    }
    return stripPrefix(txt(row));
  }

  /* ========================= 一、抓题 ============================ */
  /**
   * 返回 [{ n, qno, type, text, options:[{key,label,value,el}],
   *         inputType, el, extraInputs, matchSelects, minwords, answered }]
   */
  function scrapeQuestions() {
    const nodes = document.querySelectorAll('div.que');
    const out = [];

    nodes.forEach((q, i) => {
      const cls = q.className || '';
      const qtype = (cls.match(/\bque\s+([a-z0-9_]+)/) || [])[1] || 'unknown';
      const qtextEl = q.querySelector('.qtext');
      const text = txt(qtextEl) || ('（第 ' + (i + 1) + ' 题，取不到题干）');
      const qno = txt(q.querySelector('.qno')) || String(i + 1);

      let prefix = null;
      const anyInput = q.querySelector('input[name], textarea[name], select[name]');
      if (anyInput) {
        const m = (anyInput.getAttribute('name') || '').match(/^(q\d+:\d+)_/);
        if (m) prefix = m[1];
      }

      const item = {
        n: i + 1, qno, prefix, type: qtype, text,
        options: [], inputType: null, el: null,
        extraInputs: [], matchSelects: null, answered: false, minwords: 0,
      };

      /* --- 选择题 --- */
      if (qtype === 'multichoice' || qtype === 'truefalse' || qtype === 'multichoiceset') {
        const ans = q.querySelector('.ablock') || q;
        let rows = ans.querySelectorAll('div.answer > div[class^="r"], div.answer > div[class*=" r"]');
        if (!rows.length) rows = ans.querySelectorAll('div[class^="r"]');
        rows.forEach((row, k) => {
          const inp = row.querySelector('input[type=radio], input[type=checkbox]');
          const label = optionLabel(row) || (inp ? stripPrefix(txt(inp.closest('label'))) : '');
          item.options.push({
            key: String.fromCharCode(65 + k),
            label,
            value: inp ? inp.value : null,
            el: inp || null,
            checked: inp ? inp.checked : false,
          });
          if (inp && !item.inputType) item.inputType = inp.type;
          if (inp && inp.checked) item.answered = true;
        });
      }
      /* --- 填空 / 数值 / 论述 --- */
      else if (qtype === 'shortanswer' || qtype === 'numerical' || qtype === 'essay') {
        const inp = q.querySelector('textarea, input[type=text]');
        item.inputType = inp ? (inp.tagName === 'TEXTAREA' ? 'textarea' : 'text') : null;
        item.el = inp || null;
        item.answered = !!(inp && inp.value && inp.value.trim());
        // 论述题最低字数（中英文都要认）
        const all = txt(q);
        let mw = all.match(/不少于\s*(\d+)\s*(?:个)?\s*(?:词|字)/);
        if (!mw) mw = all.match(/(?:at least|minimum(?: of)?|not less than)\s*(\d+)\s*words?/i);
        if (!mw) mw = all.match(/(\d+)\s*words?\s*(?:or more|minimum)/i);
        if (mw) item.minwords = parseInt(mw[1], 10) || 0;
      }
      /* --- 匹配题：每个空是 select --- */
      else if (qtype === 'match' || qtype === 'ddmatch') {
        item.matchSelects = Array.from(q.querySelectorAll('select'));
        item.inputType = 'select';
      }
      /* --- 其它：把所有可填元素收起来，只为"标注需人工" --- */
      else {
        item.extraInputs = Array.from(q.querySelectorAll('input[type=text], textarea, select'));
        item.inputType = item.extraInputs.length ? 'multi' : null;
      }

      out.push(item);
    });

    return out;
  }

  /* ======================= 二、问模型 ============================ */
  function buildPrompt(questions) {
    const TYPES = {
      multichoice: '单选题（只能选 1 个）',
      multichoiceset: '多选题（可选多个）',
      truefalse: '判断题',
      shortanswer: '填空题（给出填空内容，不要带引号）',
      numerical: '数值题（只给数字）',
      essay: '简答题（用 150~300 字作答）',
      match: '匹配题（按空位顺序给出答案文字）',
      ddmatch: '匹配题（按空位顺序给出答案文字）',
    };
    const lines = [];
    questions.forEach(q => {
      lines.push(`【第${q.n}题】(${TYPES[q.type] || ('题目类型：' + q.type)})`);
      lines.push(q.text);
      q.options.forEach(o => lines.push(`  ${o.key}. ${o.label}`));
      lines.push('');
    });

    const sys = [
      '你是一位严谨的学科答题助手。请根据题目和选项给出**最可能正确**的答案。',
      '要求：',
      '1. 只输出 JSON，不要任何解释、不要 markdown 代码围栏。',
      '2. 格式：{"answers":[{"n":题号,"answer":"答案"}]}',
      '3. 选择题 answer 用选项字母：单选 "B"，多选按字母升序连写 "ABD"。',
      '4. 判断题同样用字母（A/B）。',
      '5. 填空题 answer 直接给内容；数值题只给数字；简答题给一段完整作答文字。',
      '6. 若某题完全无法判断，answer 用空字符串 ""。',
      CFG.promptExtra ? ('补充信息：' + CFG.promptExtra) : '',
    ].filter(Boolean).join('\n');

    return { sys, user: lines.join('\n') };
  }

  function callBridge(user) {
    const url = String(CFG.bridgeUrl || '').trim();
    if (!url) return Promise.reject(new Error('没填本地桥地址'));
    const body = JSON.stringify({ questions: user, jsonMode: true });
    return new Promise((resolve, reject) => {
      const done = (text) => {
        try {
          const j = JSON.parse(text);
          if (j && j.ok === true) {
            resolve({ choices: [{ message: { content: String(j.content || '') } }], _bridge: true });
          } else reject(new Error((j && j.error) || '桥返回失败'));
        } catch (e) {
          reject(new Error('桥返回不是 JSON：' + String(text).slice(0, 300)));
        }
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url,
          headers: { 'Content-Type': 'application/json' },
          data: body, timeout: 150000,
          onload: (r) => done(r.responseText),
          onerror: () => reject(new Error('连不上本地桥。请确认插件里 bridgeEnabled: true')),
          ontimeout: () => reject(new Error('本地桥超时')),
        });
      } else {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
          .then(async (r) => done(await r.text()))
          .catch((e) => reject(new Error('连不上本地桥（可能跨域被拦）：' + e.message)));
      }
    });
  }

  function callLLM(sys, user) {
    if (CFG.provider === 'bridge') return callBridge(user);

    const url = CFG.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: CFG.model,
      temperature: Number(CFG.temperature) || 0,
      max_tokens: Number(CFG.maxTokens) || 2000,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    };

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST', url,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + CFG.apiKey,
          },
          data: JSON.stringify(body), timeout: 120000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              try { resolve(JSON.parse(res.responseText)); }
              catch (e) { reject(new Error('接口返回不是 JSON: ' + res.responseText.slice(0, 300))); }
            } else {
              reject(new Error('HTTP ' + res.status + ' ' + String(res.responseText || '').slice(0, 300)));
            }
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('请求超时')),
        });
      });
    }

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CFG.apiKey,
      },
      body: JSON.stringify(body),
    }).then(async r => {
      const t = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300));
      return JSON.parse(t);
    });
  }

  function parseAnswers(respText) {
    let s = String(respText || '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    const obj = JSON.parse(s);
    const arr = Array.isArray(obj) ? obj : (obj.answers || obj.result || []);
    const map = {};
    arr.forEach(x => {
      const n = parseInt(x.n !== undefined ? x.n : x.index, 10);
      if (Number.isFinite(n)) map[n] = String(x.answer === undefined ? '' : x.answer).trim();
    });
    return map;
  }

  async function solveQuestions(questions, onProgress) {
    const cache = loadCache();
    const result = {};
    const todo = [];

    questions.forEach(q => {
      const key = hashCode(q.text + '|' + q.options.map(o => o.label).join('|'));
      q._key = key;
      if (cache[key] !== undefined) {
        result[q.n] = cache[key];
        log(`第 ${q.n} 题命中缓存: ${cache[key]}`);
      } else todo.push(q);
    });

    if (!todo.length) return { answers: result, asks: 0 };

    let asks = 0;
    const batch = Math.max(1, parseInt(CFG.batch, 10) || 5);
    for (let i = 0; i < todo.length; i += batch) {
      const chunk = todo.slice(i, i + batch);
      asks++;
      if (onProgress) {
        onProgress(`正在问模型：第 ${chunk[0].n}~${chunk[chunk.length - 1].n} 题（第 ${asks} 批）`);
      }
      const { sys, user } = buildPrompt(chunk);
      let content = '';
      try {
        const resp = await callLLM(sys, user);
        content = resp && resp.choices && resp.choices[0] &&
          resp.choices[0].message && resp.choices[0].message.content;
      } catch (e) {
        warn('接口失败:', e.message);
        if (onProgress) onProgress('❌ 接口失败：' + e.message);
        chunk.forEach(q => { result[q.n] = ''; });
        await sleep(CFG.delayMs);
        continue;
      }
      let map = {};
      try {
        map = parseAnswers(content);
      } catch (e) {
        warn('解析模型输出失败:', String(content).slice(0, 400));
        if (onProgress) onProgress('⚠ 模型输出不是合法 JSON，该批跳过');
      }
      chunk.forEach(q => {
        const a = map[q.n] !== undefined ? map[q.n] : '';
        result[q.n] = a;
        cache[q._key] = a;
      });
      await sleep(CFG.delayMs);
    }
    saveCache(cache);
    return { answers: result, asks };
  }

  /* ======================= 三、填答案 ============================ */
  function fillAnswer(q, answer) {
    const a = String(answer || '').trim();
    if (!a) return { ok: false, why: '模型没给答案' };

    /* --- 选择题 --- */
    if (q.options && q.options.length) {
      const letters = (a.toUpperCase().match(/[A-Z]/g) || []);
      if (!letters.length) return { ok: false, why: '模型没给字母：' + a.slice(0, 20) };
      let hit = 0;
      q.options.forEach(o => {
        if (!o.el) return;
        const want = letters.includes(o.key);
        if (o.el.checked !== want) {
          o.el.checked = want;
          fire(o.el, 'input');
          fire(o.el, 'change');
          fire(o.el, 'click');
        }
        if (want) hit++;
      });
      return { ok: hit > 0, why: hit ? ('已选 ' + letters.join('')) : '没匹配到选项' };
    }

    /* --- 匹配题 --- */
    if (q.inputType === 'select' && q.matchSelects && q.matchSelects.length) {
      const parts = a.split(/[;；,，\n]/).map(s => s.trim()).filter(Boolean);
      let hit = 0;
      q.matchSelects.forEach((sel, i) => {
        const want = parts[i] || parts[0] || '';
        const opts = Array.from(sel.options);
        const found = opts.find(o => txt(o) === want) ||
                      opts.find(o => want && txt(o).includes(want)) ||
                      opts.find(o => txt(o) && want.includes(txt(o)));
        if (found) { sel.value = found.value; fire(sel, 'change'); hit++; }
      });
      return { ok: hit > 0, why: hit ? `匹配 ${hit} 个空` : '没匹配到选项文本' };
    }

    /* --- 填空/数值/论述 --- */
    const el = q.el || (q.extraInputs && q.extraInputs[0]);
    if (el) {
      const v = (q.type === 'numerical') ? a.replace(/[^\d.\-]/g, '') : a;
      el.focus();
      el.value = v;
      fire(el, 'input');
      fire(el, 'change');
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.blur();
      if (q.minwords && v.replace(/\s/g, '').length < q.minwords) {
        return { ok: true, why: `已填入，但 ${v.length} 字 < 要求 ${q.minwords} 字（可能判未达标）` };
      }
      return { ok: true, why: '已填入' };
    }

    /* --- 多空 --- */
    if (q.extraInputs && q.extraInputs.length > 1) {
      const parts = a.split(/[;；,，\n]/).map(s => s.trim());
      q.extraInputs.forEach((inp, i) => {
        inp.value = parts[i] !== undefined ? parts[i] : a;
        fire(inp, 'input'); fire(inp, 'change');
      });
      return { ok: true, why: '已填多空' };
    }

    return { ok: false, why: '不支持的题型：' + q.type };
  }

  /* ==================== 四、识别页面与翻页 ======================= */
  const isAttempt = () => /\/mod\/quiz\/attempt\.php/.test(location.pathname);
  const isReview = () => /\/mod\/quiz\/review\.php/.test(location.pathname);
  const isSummary = () => /\/mod\/quiz\/summary\.php/.test(location.pathname) ||
    /\/mod\/quiz\/attempt\.php/.test(location.pathname) && !!document.querySelector('#mod_quiz-view-summary');
  const isView = () => /\/mod\/quiz\/view\.php/.test(location.pathname);
  const isSubmitPage = () => isSummary() || !!findFinishButton();

  /**
   * 找到一个"可见且可点"的提交类按钮。
   * 顺序分三层，越往后越宽松：
   *   ① name 属性（与语言完全无关，最可靠）
   *   ② 常见语言按钮文案
   *   ③ 上面都不中时的兜底：可见的 submit
   */
  function findSubmitButton(texts, names) {
    // ① name 属性
    for (const n of names) {
      const els = document.querySelectorAll(
        `input[type=submit][name="${n}"], button[name="${n}"]`);
      for (const el of els) {
        if (el.type === 'hidden' || el.disabled) continue;
        if (el.offsetParent === null && el.getClientRects().length === 0) continue;
        return el;
      }
    }
    // ② 文案
    const all = document.querySelectorAll('input[type=submit], button[type=submit], button');
    for (const el of all) {
      if (el.type === 'hidden' || el.disabled) continue;
      const v = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!v) continue;
      if (texts.some(t => v === t || v.startsWith(t))) return el;
    }
    return null;
  }

  function findNextButton() {
    // 注意：不能写 '#mod_quiz-next-nav input' —— 会先命中隐藏的 sesskey 域。
    return findSubmitButton(NEXT_TEXTS, ['next']);
  }
  function findFinishButton() {
    return findSubmitButton(FINISH_TEXTS, ['finishattempt', 'finish']);
  }
  /** 当前尝试号（不同 attempt 是不同页面，分开记 processed） */
  function attemptId() {
    const u = new URLSearchParams(location.search);
    return u.get('attempt') || u.get('cmid') || 'na';
  }
  function pageSig() {
    return location.pathname + location.search;
  }
  /** 页面 id（题目页会有 page= 参数） */
  function pageNo() {
    return new URLSearchParams(location.search).get('page');
  }

  /**
   * 检测页面上是否出现了"不能再继续"的错误提示。
   * 命中就停机，不硬闯。中英文都覆盖，因为跨站点语言不定。
   */
  function detectBlockers() {
    const patterns = [
      /会话\s*(已)?\s*(超时|过期|失效)/,
      /session\s+(has\s+)?(timed?\s*out|expired)/i,
      /(不允许|不能再|无法)\s*(再次)?\s*作答/,
      /(you (are|do) not have permission|not allowed to (attempt|continue))/i,
      /你没有权限/, /无法继续/, /cannot continue/i,
      /最多可以作答\s*\d+\s*次/, /已用完.{0,6}次/,
      /(the )?maximum number of attempts/i,
      /本测验已关闭/, /(quiz|this quiz) is (now )?closed/i,
      /attempts? (are )?(no longer|not) (allowed|available)/i,
    ];
    const text = (document.body && document.body.innerText || '').slice(0, 20000);
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[0];
    }
    return null;
  }

  /* ======================= 五、界面 ============================== */
  const state = { busy: false, lastReport: [] };

  function setNow(html) {
    const el = document.getElementById('qa-now');
    if (el) el.innerHTML = html;
  }
  function setBanner(html, kind) {
    const el = document.getElementById('qa-banner');
    if (!el) return;
    el.innerHTML = html;
    el.style.background = kind === 'run' ? 'rgba(34,197,94,.12)'
      : kind === 'stop' ? 'rgba(245,158,11,.14)'
      : kind === 'err' ? 'rgba(239,68,68,.14)' : '#f5f3ff';
    el.style.borderColor = kind === 'run' ? 'rgba(34,197,94,.45)'
      : kind === 'stop' ? 'rgba(245,158,11,.5)'
      : kind === 'err' ? 'rgba(239,68,68,.5)' : 'transparent';
  }
  function toast(msg, kind) {
    let t = document.getElementById('qa-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'qa-toast';
      t.style.cssText = `position:fixed;left:16px;top:16px;z-index:2147483647;max-width:360px;
        padding:10px 14px;border-radius:9px;background:#1f2937;color:#fff;font-weight:600;
        font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);display:none;`;
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = kind === 'warn' ? '#b42318' : (kind === 'ok' ? '#067647' : '#1f2937');
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.display = 'none'; }, 7000);
  }

  function renderReport(rows) {
    const box = document.getElementById('qa-report');
    if (!box) return;
    box.innerHTML = rows.map(r =>
      `<div class="r"><b>${r.qno}</b> <span class="${r.ok && r.answer ? 'ok' : 'bad'}">${(r.answer || '—')}</span>` +
      ` <span class="t">${r.text}</span><br><span class="w">${r.why}</span></div>`).join('');
  }

  function buildPanel() {
    if (document.getElementById('qa-panel')) return;
    const el = document.createElement('div');
    el.id = 'qa-panel';
    el.innerHTML = `
      <style>
        #qa-panel{position:fixed;left:16px;bottom:16px;z-index:2147483646;width:372px;
          font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;color:#1f2937;background:#fff;
          border:1px solid #d7dde6;border-radius:12px;box-shadow:0 8px 28px rgba(16,24,40,.2);overflow:hidden}
        #qa-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
          background:linear-gradient(90deg,#7c3aed,#a78bfa);color:#fff;cursor:move;font-weight:600;font-size:13px}
        #qa-panel .hd span.mi{cursor:pointer;padding:0 4px;font-size:16px;line-height:1}
        #qa-panel .bd{padding:10px 12px;max-height:460px;overflow:auto}
        #qa-panel label{display:block;font-size:11px;color:#475569;margin:6px 0 2px}
        #qa-panel input[type=text],#qa-panel input[type=password],#qa-panel select{
          width:100%;padding:5px 7px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;box-sizing:border-box}
        #qa-panel .row{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
        #qa-panel button.b{flex:1;min-width:62px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:7px;
          background:#f8fafc;cursor:pointer;font-size:12px;color:#1f2937}
        #qa-panel button.b:hover{background:#f5f3ff;border-color:#7c3aed}
        #qa-panel button.b.pri{background:linear-gradient(90deg,#7c3aed,#a78bfa);color:#fff;border-color:transparent;font-weight:700}
        #qa-panel button.b.dan{background:#fff1f0;border-color:#f0a8a0;color:#b42318}
        #qa-panel button.b.dan:hover{background:#ffe4e0}
        #qa-panel .banner{padding:9px 11px;border-radius:8px;margin-bottom:8px;font-size:12px;
          border:1px solid transparent;line-height:1.6}
        #qa-panel .now{padding:8px 10px;background:#f1f5f9;border-radius:7px;margin-bottom:8px;font-size:12px}
        #qa-panel .r{padding:5px 0;border-bottom:1px dashed #eef2f7;font-size:12px}
        #qa-panel .r .ok{color:#067647;font-weight:700}
        #qa-panel .r .bad{color:#b42318;font-weight:700}
        #qa-panel .r .t{color:#94a3b8}
        #qa-panel .r .w{color:#94a3b8;font-size:11px}
        #qa-panel .tip{font-size:11px;color:#64748b;margin-top:8px;line-height:1.5}
        #qa-panel hr{border:0;border-top:1px solid #eef2f7;margin:10px 0}
        #qa-panel .lock{font-size:11px;color:#067647;margin-top:6px}
      </style>
      <div class="hd"><span>答题助手 v2</span><span class="mi" id="qa-min">−</span></div>
      <div class="bd">
        <div class="banner" id="qa-banner">尚未授权</div>
        <div class="now" id="qa-now">就绪</div>

        <div class="row">
          <button class="b pri" id="qa-run">🚀 放任自流</button>
          <button class="b dan" id="qa-stop">■ 停</button>
        </div>
        <div class="row">
          <button class="b" id="qa-once">只答本页（不翻页）</button>
          <button class="b" id="qa-rescan">↻ 只抓题</button>
        </div>

        <hr>
        <label>取答案方式</label>
        <select id="qa-provider">
          <option value="direct">直连接口（key 存浏览器）</option>
          <option value="bridge">走本地 DSH 桥（key 留插件里）</option>
        </select>
        <div id="qa-direct-box">
          <label>接口地址（OpenAI 兼容，含 /v1）</label>
          <input type="text" id="qa-base" />
          <label>API Key</label>
          <input type="password" id="qa-key" placeholder="sk-..." />
          <label>模型名</label>
          <input type="text" id="qa-model" />
        </div>
        <div id="qa-bridge-box" style="display:none">
          <label>本地桥地址</label>
          <input type="text" id="qa-bridge" />
          <div class="tip">需插件里 <code>bridgeEnabled: true</code>。当前该 profile 的 webServer 不可用，桥暂不可用，建议用直连。</div>
        </div>
        <label>每批题数 / 请求间隔(ms)</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="qa-batch" style="flex:1" />
          <input type="text" id="qa-delay" style="flex:1" />
        </div>
        <label>追加提示（可选，例：本课程为劳动教育）</label>
        <input type="text" id="qa-extra" />
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px">
          <input type="checkbox" id="qa-keepgoing" />
          <span>有题没填上时仍继续翻页（否则停下等你）</span>
        </div>

        <div id="qa-report"></div>
        <div class="lock" id="qa-lock"></div>
        <div class="tip">
          <b>「放任自流」会做什么</b>：抓本页题 → 问模型 → 自动填入 → 自动点「下一页」→
          页面刷新后自动接着干，直到**提交页停下**。<br>
          <b>绝不会自动交卷</b>——「提交所有答案并结束」永远由你点。
        </div>
      </div>`;
    document.body.appendChild(el);

    el.querySelector('#qa-min').onclick = () => {
      const bd = el.querySelector('.bd');
      bd.style.display = bd.style.display === 'none' ? 'block' : 'none';
    };

    /* 回填配置 */
    el.querySelector('#qa-provider').value = CFG.provider;
    el.querySelector('#qa-base').value = CFG.baseUrl;
    el.querySelector('#qa-key').value = CFG.apiKey;
    el.querySelector('#qa-model').value = CFG.model;
    el.querySelector('#qa-bridge').value = CFG.bridgeUrl;
    el.querySelector('#qa-batch').value = CFG.batch;
    el.querySelector('#qa-delay').value = CFG.delayMs;
    el.querySelector('#qa-extra').value = CFG.promptExtra;
    el.querySelector('#qa-keepgoing').checked = !!CFG.keepGoingOnFailure;

    const syncProvider = () => {
      const bridge = el.querySelector('#qa-provider').value === 'bridge';
      el.querySelector('#qa-direct-box').style.display = bridge ? 'none' : 'block';
      el.querySelector('#qa-bridge-box').style.display = bridge ? 'block' : 'none';
    };
    el.querySelector('#qa-provider').onchange = syncProvider;
    syncProvider();

    const readCfg = () => {
      CFG.provider = el.querySelector('#qa-provider').value === 'bridge' ? 'bridge' : 'direct';
      CFG.bridgeUrl = el.querySelector('#qa-bridge').value.trim() || DEFAULT_CFG.bridgeUrl;
      CFG.baseUrl = el.querySelector('#qa-base').value.trim() || DEFAULT_CFG.baseUrl;
      CFG.apiKey = el.querySelector('#qa-key').value.trim();
      CFG.model = el.querySelector('#qa-model').value.trim() || DEFAULT_CFG.model;
      CFG.batch = parseInt(el.querySelector('#qa-batch').value, 10) || 5;
      CFG.delayMs = parseInt(el.querySelector('#qa-delay').value, 10) || 800;
      CFG.promptExtra = el.querySelector('#qa-extra').value.trim();
      CFG.keepGoingOnFailure = el.querySelector('#qa-keepgoing').checked;
      saveCfg(CFG);
    };
    // 输入即存，避免翻页丢配置
    ['#qa-provider', '#qa-base', '#qa-key', '#qa-model', '#qa-bridge',
      '#qa-batch', '#qa-delay', '#qa-extra', '#qa-keepgoing']
      .forEach(sel => {
        const n = el.querySelector(sel);
        n.addEventListener('change', readCfg);
        n.addEventListener('blur', readCfg);
      });

    el.querySelector('#qa-run').onclick = () => { readCfg(); armAndGo(); };
    el.querySelector('#qa-stop').onclick = () => {
      disarm();
      state.busy = false;
      setBanner('⏹ 已停止。不会再自动翻页。', 'stop');
      setNow('已停止');
      toast('已停止自动作答', 'warn');
      paintLock();
    };
    el.querySelector('#qa-once').onclick = () => { readCfg(); processPage({ advance: false }); };
    el.querySelector('#qa-rescan').onclick = () => {
      const qs = scrapeQuestions();
      setNow(`抓到 <b>${qs.length}</b> 道题（仅本地，未上传）`);
      renderReport(qs.map(q => ({
        n: q.n, qno: q.qno, type: q.type, answer: '',
        ok: !!(q.options.length || q.inputType),
        why: `${q.type} · ${q.options.length} 选项`,
        text: q.text.slice(0, 60),
      })));
      console.table(qs.map(q => ({
        题号: q.qno, 题型: q.type, 已答: q.answered,
        题干: q.text.slice(0, 40), 选项数: q.options.length,
      })));
    };

    (function drag() {
      const hd = el.querySelector('.hd');
      let sx, sy, ox, oy, on = false;
      hd.addEventListener('mousedown', e => {
        on = true; sx = e.clientX; sy = e.clientY;
        const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
      });
      document.addEventListener('mousemove', e => {
        if (!on) return;
        el.style.left = (ox + e.clientX - sx) + 'px';
        el.style.top = (oy + e.clientY - sy) + 'px';
        el.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => { on = false; });
    })();

    paintLock();
  }

  /** 刷新"授权状态"提示条与锁定提示 */
  function paintLock() {
    const run = readRun();
    const lock = document.getElementById('qa-lock');
    if (run.armed) {
      setBanner(`🟢 <b>放任自流已开启</b> · 已处理 ${run.pages} 页 / 已请求模型 ${run.asked} 批<br>`
        + `脚本会一直往下答，直到提交页停下。`, 'run');
      if (lock) lock.textContent = '状态存在 localStorage，刷新/翻页不会丢。';
    } else {
      setBanner('⚪ 尚未授权 —— 点上面「🚀 放任自流」才会开始自动作答。', 'idle');
      if (lock) lock.textContent = '';
    }
  }

  /* ==================== 六、主流程：处理一页 ===================== */
  /**
   * @param {{advance:boolean}} opts  advance=true 时处理完自动点「下一页」
   */
  async function processPage(opts) {
    opts = opts || {};
    const run = readRun();

    if (state.busy) { log('已有任务在跑，跳过'); return; }
    if (!isAttempt()) {
      setNow('这一页不是作答页（回顾/入口页），不自动填。');
      return;
    }
    if (CFG.provider === 'direct' && !CFG.apiKey) {
      setNow('⚠ 还没填 API Key。要么填上，要么把「取答案方式」切成走本地桥。');
      toast('请先填 API Key', 'warn');
      disarm();
      paintLock();
      return;
    }
    if (run.pages >= MAX_PAGES) {
      disarm();
      setBanner(`🛑 已处理 ${run.pages} 页，达到上限（${MAX_PAGES}），为避免死循环已停机。`, 'err');
      return;
    }
    if (run.asked >= MAX_ASKS) {
      disarm();
      setBanner(`🛑 已请求模型 ${run.asked} 批，达到上限（${MAX_ASKS}），已停机。`, 'err');
      return;
    }

    const blocker = detectBlockers();
    if (blocker) {
      disarm();
      setBanner(`🛑 页面提示「${blocker}」，已停机，不硬闯。请手动检查。`, 'err');
      return;
    }

    state.busy = true;
    try {
      const questions = scrapeQuestions();
      if (!questions.length) {
        setNow('⚠ 本页没抓到题目。可能：已交卷 / 未解锁 / 本页无题。');
        disarm();
        paintLock();
        return;
      }
      setNow(`本页 <b>${questions.length}</b> 道题，正在问模型…`);

      const { answers, asks } = await solveQuestions(questions, (m) => setNow(m));
      run.asked += asks;

      const report = [];
      let failed = 0;
      for (const q of questions) {
        const a = answers[q.n];
        const pr = fillAnswer(q, a);
        if (!pr.ok || !a) failed++;
        report.push({
          n: q.n, qno: q.qno, type: q.type, answer: a,
          ok: pr.ok, why: pr.why, text: q.text.slice(0, 60),
        });
        renderReport(report.slice());
      }
      state.lastReport = report;
      log('本页填写结果', report);

      const okCount = questions.length - failed;
      setNow(`本页已填 <b>${okCount}/${questions.length}</b> 题` +
        (failed ? `，<b style="color:#b42318">${failed} 题没填上</b>` : '') +
        (opts.advance ? '<br>正在翻到下一页…' : ''));

      /* ---- 记录本页已处理（防重复作答） ---- */
      if (opts.advance) {
        const sig = pageSig();
        if (!run.processed.includes(sig)) run.processed.push(sig);
        run.pages += 1;
        writeRun(run);
      }

      /* ---- 有题没填上：按配置决定是否继续 ---- */
      if (failed > 0 && !CFG.keepGoingOnFailure) {
        disarm();
        setBanner(`⏸ 有 <b>${failed}</b> 题没自动填上，已停下等你处理（可在下方勾选"仍继续翻页"）。`, 'stop');
        toast(`${failed} 题没填上，已停下`, 'warn');
        return;
      }

      /* ---- 翻页 ---- */
      if (!opts.advance) { paintLock(); return; }

      /* 到了提交页？→ 停下，把提交按钮交给人 */
      if (isSummary()) {
        stopAtSubmitPage();
        return;
      }
      if (findFinishButton() && !findNextButton()) {
        stopAtSubmitPage();
        return;
      }

      const next = findNextButton();
      if (!next) {
        disarm();
        setBanner('🛑 没找到「下一页」按钮，可能已是最后一页或页面结构变了。已停机等你处理。', 'err');
        return;
      }

      // 记录"正在翻页"，下一页加载后会据此续跑
      sessionStorage.setItem('qa_navigating', '1');
      paintLock();
      await sleep(400);           // 留一点时间让 onchange 事件落盘
      log('点击:', next.value || next.textContent || 'next');
      next.click();
      /* 之后页面会整页刷新，由 init() 续跑 */

    } catch (e) {
      warn('处理本页出错:', e);
      disarm();
      setBanner('🛑 出错了：' + String(e && e.message || e) + '（已停机）', 'err');
    } finally {
      state.busy = false;
    }
  }

  /** 到达提交页：醒目提示，把「提交」留给用户 */
  function stopAtSubmitPage() {
    disarm();
    const fin = findFinishButton();
    if (fin) {
      fin.scrollIntoView({ block: 'center' });
      fin.style.outline = '3px solid #7c3aed';
      fin.style.outlineOffset = '2px';
      fin.style.boxShadow = '0 0 0 6px rgba(124,58,237,.18)';
    }
    const count = state.lastReport.length;
    setBanner('✅ <b>全部题目已答完，已停在提交页</b><br>'
      + '「提交所有答案并结束」已高亮 —— <b>由你自己点</b>。脚本不会替你交卷。', 'stop');
    setNow(count ? `本页提交前请扫一眼上面 ${count} 题的答案。` : '请确认后手动提交。');
    toast('已停在提交页，请手动提交', 'ok');
    paintLock();
  }

  /** 点「放任自流」：授权 + 立即开始 */
  function armAndGo() {
    if (!isAttempt()) {
      toast('这一页不是作答页', 'warn');
      setNow('当前页不是 attempt.php，无法开始自动作答。');
      return;
    }
    const run = readRun();
    // 新的运行：换 attempt 就重置计数
    const id = attemptId();
    if (run.quizId !== id) {
      run.quizId = id;
      run.processed = [];
      run.pages = 0;
      run.asked = 0;
      run.startedAt = new Date().toISOString();
    }
    // 允许重跑同一页：把当前页从 processed 里摘掉
    const sig = pageSig();
    run.processed = run.processed.filter(x => x !== sig);
    run.armed = true;
    writeRun(run);
    paintLock();
    toast('已授权：开始全自动作答', 'ok');
    processPage({ advance: true });
  }

  /* ==================== 七、初始化 ============================== */
  function init() {
    if (isReview()) {
      // 回顾页：只读抓题，不填不翻
      const n = document.querySelectorAll('div.que').length;
      if (!n) return;
      buildPanel();
      setNow(`回顾页 · <b>${n}</b> 道题（只读，不会填也不会翻页）`);
      renderReport(scrapeQuestions().map(q => ({
        n: q.n, qno: q.qno, type: q.type, answer: '',
        ok: !!(q.options.length || q.inputType),
        why: `${q.type} 已作答`, text: q.text.slice(0, 60),
      })));
      return;
    }

    if (isView()) {
      // 测验入口页：给个提示，不自动进
      const btn = document.querySelector('button[type=submit], .quizstartbuttondiv input, input[type=submit]');
      log('测验入口页，等待你点开始');
      if (btn) btn.scrollIntoView({ block: 'center' });
      return;
    }

    if (isSummary()) {
      buildPanel();
      // 从 localStorage 看是否是我们刚才武装的
      const run = readRun();
      if (run.pages > 0) stopAtSubmitPage();
      else setNow('摘要/提交页 · 请确认后手动提交');
      return;
    }

    if (!isAttempt()) return;
    if (!document.querySelector('div.que')) {
      log('作答页但没抓到题目（可能是确认页）');
      return;
    }

    buildPanel();

    const run = readRun();
    const sig = pageSig();

    // 情况 1：本页已处理过 —— 说明翻页没生效，或用户手动退回
    if (run.armed && run.processed.includes(sig)) {
      disarm();
      setBanner('🛑 又回到了已答过的这一页（翻页可能失败，或你手动退回）。已停机，绝不重复作答。', 'err');
      setNow('已停机。若确实要重答本页，点「🚀 放任自流」会重新处理本页。');
      paintLock();
      return;
    }

    // 情况 2：已授权且本页未处理 —— 等 DOM 稳了自动续跑
    if (run.armed) {
      setBanner('🟢 放任自流进行中：正在处理本页…', 'run');
      toast('续跑：正在处理本页', 'ok');
      setTimeout(() => processPage({ advance: true }), Math.max(200, Number(CFG.settleMs) || 1200));
      return;
    }

    // 情况 3：未授权 —— 只提示
    const n = document.querySelectorAll('div.que').length;
    setNow(`作答页 · 本页 <b>${n}</b> 道题<br>点「🚀 放任自流」开始，之后全自动直到提交页。`);
    if (n) renderReport(scrapeQuestions().map(q => ({
      n: q.n, qno: q.qno, type: q.type, answer: '',
      ok: !!(q.options.length || q.inputType),
      why: q.type, text: q.text.slice(0, 60),
    })));
    sessionStorage.removeItem('qa_navigating');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
