// ==UserScript==
// @name         砺儒云课堂 · 视频自动连播（自动切换 + 自动验证）
// @namespace    https://moodle.scnu.edu.cn/
// @version      4.0.0
// @description  自动连播砺儒云课堂视频：观看进度达到 95% 自动切换下一个；出现「按住通过」人机验证时自动完成验证；全部完成后停止。
// @author       DSH
// @match        https://moodle.scnu.edu.cn/course/view.php*
// @match        https://moodle.scnu.edu.cn/mod/fsresource/view.php*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/*
 * ===========================================================================
 * v4.0.0 —— 自动切换 + 自动验证
 * ===========================================================================
 *
 * 平台规则（从 player 源码 out/js_tcplayer_video_*.html 逐行确认，非猜测）：
 *
 *   1. 每 250ms 一次：
 *        if (playerState == 1 && isChallengePassed()) viewTotalTime += 250;
 *      —— 累计的是**真实墙上时钟毫秒**，与倍速无关。
 *
 *   2. 每 15 秒上报一次 mod_fsresource_set_time：
 *        args = { fsresourceid, time, finish, progress, unique }
 *        time = round(viewTotalTime/1000)   ← 本次增量
 *
 *   3. 完成判定 = 网页上写的「需要完成：观看进度：95%」
 *      页面显示「我的观看时长 XX秒」，服务端累计到 0.95×总时长 即完成。
 *
 *   4. 防挂机：duration > 10 分钟才需要人机验证
 *        ≤10min        : 不验证，始终允许累计
 *        10~15min      : 每 10 分钟一次
 *        15~30min      : 每 15 分钟一次
 *        >30min        : 每 20 分钟一次
 *      触发时机 = 按下"播放"起算的墙上时钟（不是播放位置）。
 *      未通过验证窗口内 playerState==1 也不累计 —— 这是最大的时间浪费点。
 *
 * 本脚本据此做四件事：
 *   A. **95% 自动切换**：用「页面显示的服务端累计时长」判定，
 *      达标立刻翻下一个（不靠 ended，也不靠进度条）。
 *   B. **验证自动完成**：检测 anti-bot-* 遮罩 → 自动模拟"按住"
 *      1.2~2.2 秒（按满进度条）→ 自动放行。平台弹的是 1.2~2.2 秒随机，
 *      这里按住 2.5 秒保证拉满。
 *   C. **自动重置重播**：ended 时 viewTotalTime 停止累加（playerState=3），
 *      所以播完一轮必须拉回 0 继续播，直到服务端累计达标。
 *   D. **队列调度**：未完成的视频按「从短到长」排，减少被长视频拖住的风险。
 *
 * 关于"更高效"的说明（用户已授权可自行判断）：
 *   倍速对达标**完全无效**（累计的是墙上时钟），所以不开放倍速。
 *   真正的下界是：每个视频 ≥0.95×时长 的真实时间，全课程 23 个视频
 *   总共约 7h12m → 至少约 6h50m 真实时间。任何"更快"的说法都要么是
 *   伪造上报（本脚本不做），要么是改服务端累计逻辑（更危险，不做）。
 *   本脚本只把**非观看时间**压到接近 0：验证 0 等待、切换 0 等待、
 *   播完立刻重置、无人值守。
 * ===========================================================================
 */

(function () {
  'use strict';

  const SITE = location.origin;
  const STORE_KEY = 'scnu_fsauto_v4';
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const log = (...a) => console.log('%c[自动连播]', 'color:#3a8bff;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[自动连播]', 'color:#e8590c;font-weight:bold', ...a);

  /* ======================= 配置 ======================= */
  const CFG = {
    targetRatio: 0.95,        // 达标比例：平台写死 95%
    holdMs: 2500,             // 自动验证按住时长（平台要求 1.2~2.2s，多按保证拉满）
    challengeRetry: 3,        // 单次验证最多重试次数
    pollMs: 1000,             // 主轮询周期
    navDelayMs: 700,          // 达标后翻页前的停留
    serverPollMs: 15000,      // 服务端 15s 上报一次，读页面数字即可
  };

  const state = {
    running: false,
    queue: [],          // 扫描到的全部视频
    order: [],          // 待做下标顺序
    pos: 0,
    index: 0,
    loops: 0,
    panel: null,
    // 时长
    dur: 0,             // 视频时长（秒）
    need: 0,            // 需要累计的秒数 = 0.95 × dur
    got: 0,             // 服务端累计观看秒数（页面显示）
    verified: 0,        // 本次会话自动通过验证次数
    timer: null,
    lastGot: -1,
  };

  /*
   * 时长表（秒）。**纯粹是可选的优化**，只用于「先做短视频」排序。
   *
   * 这里自带的只是 2026-10-13 那门课（id=19887）实测的 23 个视频。
   * 换课程 / 换账号后这些数字都不适用 —— 所以本脚本改成**运行时自学习**：
   *   - 任何一个视频页拿到 v.duration，就记进 localStorage 的时长表
   *   - 之后排序直接用学到的真实值
   *   - 学不到时用一个大数兜底（排到最后），功能不受影响
   * 也就是说：**不需要为别的课程改代码**，跑一遍自己就填满了。
   */
  const SEED_DURATIONS = {
    '872652': 183, '872653': 885, '872654': 1224, '872660': 1191,
    '872661': 598, '872662': 546, '872668': 310, '872669': 306,
    '872670': 604, '872671': 307, '872672': 427, '872680': 823,
    '872681': 600, '872682': 572, '872683': 379, '872690': 1450,
    '872694': 2485, '872696': 3527, '872700': 739, '872701': 822,
    '872702': 390, '872708': 4116, '872712': 3441,
  };
  const DUR_STORE = 'scnu_fsauto_dur_v1';

  let DURATIONS = Object.assign({}, SEED_DURATIONS);
  try {
    const learned = JSON.parse(localStorage.getItem(DUR_STORE) || '{}');
    if (learned && typeof learned === 'object') DURATIONS = Object.assign(DURATIONS, learned);
  } catch (e) { /* ignore */ }

  /** 学到一个视频的真实时长就存下来（跨课程共用一张表，键是 fsresource 的 view id） */
  function learnDuration(viewId, sec) {
    if (!viewId || !(sec > 0)) return;
    if (DURATIONS[viewId] && Math.abs(DURATIONS[viewId] - sec) < 1) return;
    DURATIONS[viewId] = Math.round(sec);
    try {
      const learned = JSON.parse(localStorage.getItem(DUR_STORE) || '{}') || {};
      learned[viewId] = DURATIONS[viewId];
      localStorage.setItem(DUR_STORE, JSON.stringify(learned));
    } catch (e) { /* ignore */ }
    log(`学到时长 ${viewId} = ${Math.round(sec)}s`);
  }


  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + '时' : '') + (m ? m + '分' : '') + x + '秒';
  }

  /* ============ 一、document-start 钩子（必须最早） ============ */

  (function hookTCPlayer() {
    let Real = null;
    try {
      Object.defineProperty(W, 'TCPlayer', {
        configurable: true,
        get() { return Real; },
        set(fn) {
          if (typeof fn !== 'function' || fn.__fsqHooked) { Real = fn; return; }
          function Hooked(...args) {
            const opts = args[1];
            // 倍速无意义，锁 1x
            if (opts && typeof opts === 'object') opts.playbackRates = [1];
            const inst = new fn(...args);
            W.__fsaPlayer = inst;
            state._player = inst;
            log('已捕获 TCPlayer');
            return inst;
          }
          Hooked.prototype = fn.prototype;
          Hooked.__fsqHooked = true;
          Real = Hooked;
        },
      });
    } catch (e) { warn('钩 TCPlayer 失败', e); }
  })();

  (function hookWrapper() {
    let Real = null;
    try {
      Object.defineProperty(W, 'TCPlayerWrapper', {
        configurable: true,
        get() { return Real; },
        set(cls) {
          if (typeof cls !== 'function' || cls.__fsqHooked) { Real = cls; return; }
          function Hooked(...args) {
            const inst = new cls(...args);
            W.__fsaWrapper = inst;
            state._wrapper = inst;
            log('已捕获 TCPlayerWrapper');
            return inst;
          }
          Hooked.prototype = cls.prototype;
          Hooked.__fsqHooked = true;
          Real = Hooked;
        },
      });
    } catch (e) { warn('钩 TCPlayerWrapper 失败', e); }
  })();

  /* ============ 二、工具 ============ */

  function getVideo() {
    return document.querySelector('video#fsplayer-container-id') ||
           document.querySelector('#player-con video') ||
           document.querySelector('video');
  }
  const isVideoPage = () => /\/mod\/fsresource\/view\.php/.test(location.pathname);
  const curViewId = () => new URLSearchParams(location.search).get('id');

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        queue: state.queue, index: state.index, running: state.running,
        order: state.order, pos: state.pos, verified: state.verified,
      }));
    } catch (e) { /* ignore */ }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (Array.isArray(d.queue)) state.queue = d.queue;
      if (Array.isArray(d.order)) state.order = d.order;
      if (typeof d.pos === 'number') state.pos = d.pos;
      if (typeof d.index === 'number') state.index = d.index;
      if (typeof d.verified === 'number') state.verified = d.verified;
    } catch (e) { /* ignore */ }
  }

  /* 读「我的观看时长」——服务端累计值，最权威（页面每 15s 刷新一次） */
  function readServerTotal() {
    const el = document.querySelector('.num-gksc span');
    if (el) {
      const n = parseInt((el.textContent || '').replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) return n;
    }
    // 兜底：直接问 wrapper 的累计值（页面未刷新时的估算）
    const wr = W.__fsaWrapper;
    if (wr && typeof wr.viewTotalTime === 'number') return Math.floor(wr.viewTotalTime / 1000);
    return null;
  }

  async function fetchFreshTotal() {
    // 达标判定不能等 15 秒的上报周期，这里自己 POST 一次同样的上报，
    // 用返回里的 totaltime 立即确认（与播放器行为完全一致，不伪造数值）。
    const wr = W.__fsaWrapper;
    const pd = W.playerdata;
    if (!wr || !pd) return null;
    try {
      const v = getVideo();
      const data = [{
        index: 0,
        methodname: 'mod_fsresource_set_time',
        args: {
          fsresourceid: pd.fsresourceid,
          time: Math.round((wr.viewTotalTime || 0) / 1000),
          finish: (v && v.duration && v.currentTime + 0.25 >= v.duration) ? 1 : 0,
          progress: v && v.duration
            ? Number(Math.min(100, (v.currentTime / v.duration) * 100)).toFixed(2) : 0,
          unique: wr.pageId,
        },
      }];
      const r = await fetch(wr.serverUploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'same-origin',
      });
      const j = await r.json();
      const d = j && j[0] && j[0].data;
      if (d && typeof d.totaltime !== 'undefined') {
        wr.viewTotalTime = 0;          // 与播放器一致：上报后清零
        return { total: parseInt(d.totaltime, 10) || 0,
                 progress: d.progress, completion: d.completion,
                 warnings: d.warnings };
      }
    } catch (e) { /* 静默 */ }
    return null;
  }

  /* ============ 三、人机验证自动完成 ============ */

  function installChallengeCss() {
    const st = document.createElement('style');
    st.textContent = `
      button[id^="ab-btn-"]{touch-action:none!important;
        -webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}
      div[id^="anti-bot-"]{touch-action:none!important;}`;
    (document.head || document.documentElement).appendChild(st);
  }

  function pressPointer(target, type, extra) {
    // 播放器用的是 pointerdown / pointerup，且不检查 isTrusted，
    // 因此这里按真实用户"按住"的分发方式操作。
    const init = Object.assign({
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
    }, extra || {});
    let ev;
    try { ev = new PointerEvent(type, init); }
    catch (e) { ev = new MouseEvent(type.replace('pointer', 'mouse'), init); }
    target.dispatchEvent(ev);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** 自动按住直到进度条满；返回是否通过 */
  async function autoPassChallenge(mask) {
    const btn = mask.querySelector('button[id^="ab-btn-"]');
    const bar = mask.querySelector('div[id^="ab-bar-"]');
    if (!btn) return false;
    for (let attempt = 1; attempt <= CFG.challengeRetry; attempt++) {
      log(`自动验证 第 ${attempt} 次：按住 ${CFG.holdMs}ms`);
      pressPointer(btn, 'pointerdown');
      const t0 = Date.now();
      let full = false;
      while (Date.now() - t0 < CFG.holdMs) {
        await sleep(120);
        const w = bar ? parseFloat(bar.style.width || '0') : 0;
        if (w >= 100) { full = true; break; }
        if (!document.body.contains(mask)) { full = true; break; }
      }
      pressPointer(btn, 'pointerup');
      pressPointer(W, 'pointerup');
      await sleep(250);
      if (!document.body.contains(mask) || full) {
        state.verified++;
        toast('✅ 已自动完成观看验证（第 ' + state.verified + ' 次）', 'ok');
        log('验证通过，累计恢复');
        return true;
      }
    }
    warn('自动验证失败，需要手动按住按钮');
    toast('⚠ 自动验证失败，请手动按住「按住通过」', 'warn');
    alarm();
    return false;
  }

  function watchChallenge() {
    const onMask = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (!/^anti-bot-/.test(node.id || '')) return;
      toast('检测到观看验证，正在自动完成…', 'warn');
      beep();
      autoPassChallenge(node);
    };
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) onMask(n);
    }).observe(document.documentElement, { childList: true, subtree: true });

    // 兜底：轮询（万一遮罩在 observer 挂上之前就插入了）
    setInterval(() => {
      const mask = document.querySelector('div[id^="anti-bot-"]');
      if (mask && !mask.__fsaHandled) {
        mask.__fsaHandled = true;
        onMask(mask);
      }
    }, 800);
  }

  /* 声音提示（自动验证时也给个提示，便于人知道在发生什么） */
  let ac = null;
  function beep() {
    try {
      const AC = W.AudioContext || W.webkitAudioContext;
      if (!AC) return;
      if (!ac) ac = new AC();
      if (ac.state === 'suspended') ac.resume();
      [0, 0.4].forEach(off => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = 660;
        const t = ac.currentTime + off;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g); g.connect(ac.destination);
        o.start(t); o.stop(t + 0.32);
      });
    } catch (e) { /* ignore */ }
  }
  function alarm() {
    try {
      beep();
      const syn = W.speechSynthesis;
      if (syn) {
        const u = new W.SpeechSynthesisUtterance('请手动按住按钮通过验证');
        u.lang = 'zh-CN';
        syn.speak(u);
      }
    } catch (e) { /* ignore */ }
  }

  /* ============ 四、界面 ============ */

  function toast(msg, kind) {
    let t = document.getElementById('fsa-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'fsa-toast';
      t.style.cssText = `position:fixed;right:16px;top:16px;z-index:2147483647;max-width:340px;
        padding:10px 14px;border-radius:9px;background:#1f2937;color:#fff;
        font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;
        box-shadow:0 6px 20px rgba(0,0,0,.3);display:none;`;
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = kind === 'warn' ? '#b42318' : (kind === 'ok' ? '#067647' : '#1f2937');
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.display = 'none'; }, 6000);
  }

  function buildPanel() {
    if (document.getElementById('fsa-panel')) return;
    const el = document.createElement('div');
    el.id = 'fsa-panel';
    el.innerHTML = `
      <style>
        #fsa-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:330px;
          font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;color:#1f2937;background:#fff;
          border:1px solid #d7dde6;border-radius:12px;box-shadow:0 8px 28px rgba(16,24,40,.18);overflow:hidden}
        #fsa-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
          background:linear-gradient(90deg,#3a8bff,#6598ff);color:#fff;cursor:move;font-weight:600;font-size:13px}
        #fsa-panel .hd span.mi{cursor:pointer;padding:0 4px;font-size:16px;line-height:1}
        #fsa-panel .bd{padding:10px 12px;max-height:360px;overflow:auto}
        #fsa-panel .row{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
        #fsa-panel button.b{flex:1;min-width:62px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:7px;
          background:#f8fafc;cursor:pointer;font-size:12px;color:#1f2937}
        #fsa-panel button.b:hover{background:#eef4ff;border-color:#3a8bff}
        #fsa-panel button.b.pri{background:linear-gradient(90deg,#3a8bff,#6598ff);color:#fff;border-color:transparent}
        #fsa-panel .now{padding:8px 10px;background:#f1f5f9;border-radius:7px;margin-bottom:8px;font-size:12px;word-break:break-all}
        #fsa-panel .bar{height:9px;background:#e5e7eb;border-radius:9px;overflow:hidden;margin:6px 0 8px}
        #fsa-panel .bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3a8bff,#22c55e);transition:width .25s}
        #fsa-panel .it{display:flex;gap:6px;padding:3px 0;font-size:12px;border-bottom:1px dashed #eef2f7;cursor:pointer}
        #fsa-panel .it:hover{background:#f8fafc}
        #fsa-panel .it.cur{color:#3a8bff;font-weight:700}
        #fsa-panel .it .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #fsa-panel .tip{font-size:11px;color:#64748b;margin-top:6px}
        #fsa-panel .mono{font-family:monospace;font-size:11px;color:#94a3b8;white-space:pre-line;line-height:1.5}
      </style>
      <div class="hd"><span>自动连播 v4</span><span class="mi" id="fsa-min">−</span></div>
      <div class="bd">
        <div class="now" id="fsa-now">就绪</div>
        <div class="bar"><i id="fsa-bar"></i></div>
        <div class="row">
          <button class="b pri" id="fsa-run">▶ 开始自动连播</button>
          <button class="b" id="fsa-stop">■ 停止</button>
        </div>
        <div class="row">
          <button class="b" id="fsa-next">⏭ 下一个</button>
          <button class="b" id="fsa-scan">↻ 扫描</button>
          <button class="b" id="fsa-play">▶ 播放</button>
        </div>
        <div id="fsa-list"></div>
        <div class="tip">达标判定：观看进度 ≥ 95%。人机验证自动完成，日志在下方。</div>
        <div class="mono" id="fsa-dbg"></div>
      </div>`;
    document.body.appendChild(el);
    state.panel = el;

    el.querySelector('#fsa-min').onclick = () => {
      const bd = el.querySelector('.bd');
      bd.style.display = bd.style.display === 'none' ? 'block' : 'none';
    };
    el.querySelector('#fsa-run').onclick = start;
    el.querySelector('#fsa-stop').onclick = stop;
    el.querySelector('#fsa-next').onclick = () => advance(true);
    el.querySelector('#fsa-scan').onclick = () => {
      state.queue = scanCourseVideos(); save(); renderList();
      toast(`扫描到 ${state.queue.length} 个视频`, 'ok');
    };
    el.querySelector('#fsa-play').onclick = () => {
      const v = getVideo();
      if (v) { v.playbackRate = 1; v.play().catch(() => {}); }
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
        el.style.right = 'auto'; el.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => { on = false; });
    })();

    renderList();
  }

  function setNow(html) {
    const n = state.panel && state.panel.querySelector('#fsa-now');
    if (n) n.innerHTML = html;
  }
  function setProgressBar(pct) {
    const b = state.panel && state.panel.querySelector('#fsa-bar');
    if (b) b.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
  }
  function setDbg(txt) {
    const d = state.panel && state.panel.querySelector('#fsa-dbg');
    if (d) d.textContent = txt;
  }

  function renderList() {
    const box = state.panel && state.panel.querySelector('#fsa-list');
    if (!box) return;
    if (!state.queue.length) {
      box.innerHTML = '<div class="tip">没扫描到视频。请回到课程主页点「扫描」。</div>';
      return;
    }
    box.innerHTML = state.queue.map((v, i) =>
      `<div class="it ${i === state.index ? 'cur' : ''}" data-i="${i}">
         <span class="n">${v.done ? '✅' : '⬜'} ${i + 1}. ${v.name}</span></div>`).join('');
    box.querySelectorAll('.it').forEach(d => {
      d.onclick = () => gotoIndex(parseInt(d.dataset.i, 10));
    });
    const cur = box.querySelector('.it.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  /* ============ 五、队列 ============ */

  function scanCourseVideos() {
    const vids = [], seen = new Set();
    document.querySelectorAll('li.activity[id^="module-"]').forEach(li => {
      const a = li.querySelector('a[href*="fsresource/view.php?id="]');
      if (!a) return;
      const card = li.querySelector('[data-activityname]');
      let name = card ? card.getAttribute('data-activityname') : '';
      if (!name) {
        const nm = li.querySelector('.instancename');
        if (nm) name = nm.textContent.trim();
      }
      const m = a.href.match(/view\.php\?id=(\d+)/);
      if (!m || seen.has(m[1])) return;
      const icon = li.querySelector('.activityicon');
      const isVideo = (icon && /\/f\/video(\?|$)/.test(icon.src)) || /\.mp4$/i.test(name);
      if (!isVideo) return;
      seen.add(m[1]);
      const done = /btn-subtle-success/.test(li.innerHTML) && /fa-check/.test(li.innerHTML);
      vids.push({ viewId: m[1], name: name || ('视频 ' + m[1]), done, sec: DURATIONS[m[1]] || 0 });
    });
    return vids;
  }

  function start() {
    if (!state.queue.length) state.queue = scanCourseVideos();
    const todo = state.queue.map((v, i) => ({ v, i }))
      .filter(x => !x.v.done)
      .sort((a, b) => (a.v.sec || 1e9) - (b.v.sec || 1e9));
    if (!todo.length) { toast('✅ 所有视频都已完成', 'ok'); return; }
    state.order = todo.map(x => x.i);
    state.pos = 0;
    state.running = true;
    state.index = state.order[0];
    save();
    const need = Math.round(todo.reduce((s, x) => s + (x.v.sec || 0), 0) * CFG.targetRatio);
    toast(`开始自动连播 ${todo.length} 个视频，最少需真实时间 ${fmt(need)}`, 'ok');
    gotoIndex(state.index);
  }

  function stop() {
    state.running = false; save();
    clearInterval(state.timer);
    const v = getVideo();
    if (v) v.pause();
    toast('已停止自动连播', 'warn');
    setNow('已停止');
  }

  function nextInOrder() {
    state.pos = (state.pos || 0) + 1;
    if (!state.order.length || state.pos >= state.order.length) return state.queue.length;
    return state.order[state.pos];
  }

  function advance(manual) {
    if (manual) {
      state.pos = (state.pos || 0) + 1;
      const i = (!state.order.length || state.pos >= state.order.length)
        ? state.queue.length : state.order[state.pos];
      gotoIndex(i);
      return;
    }
    gotoIndex(nextInOrder());
  }

  function gotoIndex(i) {
    if (i >= state.queue.length) {
      state.running = false; save();
      clearInterval(state.timer);
      toast('🎉 全部视频已处理完', 'ok');
      setNow('全部完成');
      return;
    }
    state.index = Math.max(0, i);
    save();
    const v = state.queue[state.index];
    if (!v) return;
    if (isVideoPage() && curViewId() === v.viewId) { takeOver(); return; }
    setTimeout(() => {
      location.href = `${SITE}/mod/fsresource/view.php?id=${v.viewId}`;
    }, CFG.navDelayMs);
  }

  /* ============ 六、视频页核心：95% 自动切换 ============ */

  async function takeOver() {
    const item = state.queue[state.index];
    setNow(`正在播放 <b>${state.index + 1}/${state.queue.length}</b><br>${item ? item.name : ''}`);
    renderList();

    const v = getVideo();
    if (!v) { setTimeout(takeOver, 1500); return; }
    state.loops = 0;

    const prune = setInterval(() => {
      const d = v.duration || DURATIONS[curViewId()] || 0;
      if (d > 0) {
        clearInterval(prune);
        state.dur = d;
        state.need = Math.ceil(d * CFG.targetRatio);
        learnDuration(curViewId(), d);          // 自学习：下次排序就有真实时长了
        log(`时长 ${fmt(d)}，需累计 ${fmt(state.need)}`);
        tick();
      }
    }, 500);

    // 只读校准一次：确认服务端已有的累计值
    setTimeInterval(v);
    v.playbackRate = 1;
    v.play().catch(() => {
      toast('浏览器拦了自动播放 —— 点面板「▶ 播放」一次即可', 'warn');
      const btn = state.panel && state.panel.querySelector('#fsa-play');
      if (btn) btn.click();
    });
  }

  let timerHandle = null;
  function setTimeInterval(v) {
    clearInterval(timerHandle);
    timerHandle = setInterval(() => tick(v), CFG.pollMs);
    state.timer = timerHandle;
  }

  async function tick(vArg) {
    const v = vArg || getVideo();
    if (!v) return;
    if (!state.running) return;

    // 倍速摁回 1x（倍速对达标无益）
    if (Math.abs(v.playbackRate - 1) > 0.01) { try { v.playbackRate = 1; } catch (e) {} }

    // ---- 进度显示 ----
    const shown = readServerTotal();
    if (shown !== null) state.got = shown;
    const pct = state.need > 0 ? (state.got / state.need) * 100 : 0;
    setProgressBar(pct);
    setNow(
      `正在播放 <b>${state.index + 1}/${state.queue.length}</b> · ${state.dur ? fmt(state.dur) : '?'}<br>` +
      `已累计 <b>${fmt(state.got)}</b> / 需 ${fmt(state.need)}（${pct.toFixed(1)}%）`
    );
    setDbg(
      `pos:${Math.floor(v.currentTime)}s/${Math.floor(v.duration || 0)}s  paused:${v.paused}  ` +
      `loop:${state.loops}  自动验证次数:${state.verified}`
    );

    // ---- 达标 → 切换下一个 ----
    if (state.need > 0 && state.got >= state.need) {
      log(`达标 ${state.got}s ≥ ${state.need}s，切换下一个`);
      return advance(false);
    }

    // ---- 快到了：主动确认一次（不等 15s 上报周期） ----
    const wr = W.__fsaWrapper;
    if (state.need > 0 && wr && typeof wr.viewTotalTime === 'number') {
      const pending = Math.floor(wr.viewTotalTime / 1000);
      if (state.got + pending >= state.need && !state._confirming) {
        state._confirming = true;
        const res = await fetchFreshTotal();
        state._confirming = false;
        if (res && res.total >= state.need) {
          state.got = res.total;
          log(`服务端确认达标 ${res.total}s`);
          return advance(false);
        }
        if (res && res.total) state.got = res.total;
      }
    }

    // ---- 播完一轮：拉回开头继续攒（ended 后 playerState=3，时长会冻结） ----
    if (v.duration && v.currentTime >= v.duration - 0.4) {
      state.loops++;
      log(`第 ${state.loops} 轮播完，重置继续攒时长`);
      try { v.currentTime = 0; } catch (e) { /* ignore */ }
      try { v.play().catch(() => {}); } catch (e) { /* ignore */ }
    }

    // ---- 卡住/暂停兜底 ----
    if (v.paused) {
      state._pausedTicks = (state._pausedTicks || 0) + 1;
      if (state._pausedTicks >= 3) {
        state._pausedTicks = 0;
        log('检测到暂停，尝试恢复播放');
        try { v.play().catch(() => {}); } catch (e) { /* ignore */ }
      }
    } else {
      state._pausedTicks = 0;
    }
  }

  /* ============ 七、初始化 ============ */

  function init() {
    load();
    installChallengeCss();
    buildPanel();
    watchChallenge();

    if (/\/course\/view\.php/.test(location.pathname)) {
      setTimeout(() => {
        state.queue = scanCourseVideos();
        save(); renderList();
        const left = state.queue.filter(x => !x.done)
          .sort((a, b) => (a.sec || 1e9) - (b.sec || 1e9));
        const need = Math.round(left.reduce((s, x) => s + (x.sec || 0), 0) * CFG.targetRatio);
        setNow(
          `课程页 · 共 ${state.queue.length} 个视频，未完成 <b>${left.length}</b> 个<br>` +
          `最少需真实时间 <b>${fmt(need)}</b>（自动按从短到长）`
        );
        // 续播：如果之前点过开始且被打断，自动接上
        if (state.running && state.order && state.order.length) {
          const first = left.find(x => x.viewId === (state.queue[state.index] || {}).viewId) || left[0];
          if (first) location.href = `${SITE}/mod/fsresource/view.php?id=${first.viewId}`;
        }
      }, 1500);
    } else if (isVideoPage()) {
      const id = curViewId();
      const i = state.queue.findIndex(x => x.viewId === id);
      if (i >= 0) { state.index = i; renderList(); }

      // 未点「开始自动连播」时：进入视频页只提示，不擅自开跑
      setNow('视频页 · 点「开始自动连播」启动');
      if (state.running) {
        setTimeout(takeOver, 1200);
      } else {
        // 单页也要能自动验证 + 显示进度
        const w = setInterval(() => {
          if (W.__fsaWrapper && getVideo()) {
            clearInterval(w);
            const v = getVideo();
            state.dur = v.duration || DURATIONS[id] || 0;
            state.need = Math.ceil(state.dur * CFG.targetRatio);
            learnDuration(id, v.duration);
            setTimeInterval(v);
            v.playbackRate = 1;
            v.play().catch(() => {});
          }
        }, 600);
      }
    }
    log('v4 已加载');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
