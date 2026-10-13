/**
 * scnu-course-helper — CLIENT half.
 *
 * 在对话输入框上方显示一枚状态徽标，实时反映本机答题助手的准备情况：
 *   - 绿点：接口 key 已就绪  → 「答题助手 · 就绪」
 *   - 灰点：没配 key        → 「答题助手 · 未配 Key」
 *   - 数字：本地题库已有多少题 / 其中已得到答案多少题
 *
 * 数据来自 Host half 的只读路由 GET /scnu-bridge/status（同源请求，无跨域）。
 * 这里只读、不写、不触网，纯粹是观察窗。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-scnu-helper2',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Host half 的只读状态路由 */
    const STATUS_PATH = '/scnu-bridge/status';
    /** 轮询间隔（状态是本地文件，变化不频繁） */
    const POLL_MS = 30000;

    const WRAP_STYLE = { display: 'flex', justifyContent: 'center', width: '100%' };

    const BADGE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      width: 'fit-content',
      padding: '3px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(148, 163, 184, 0.4)',
      background: 'rgba(148, 163, 184, 0.1)',
      color: 'inherit',
      fontSize: '11px',
      lineHeight: '16px',
      fontFamily: 'inherit',
      userSelect: 'none',
      whiteSpace: 'nowrap',
    };

    const DOT_STYLE = {
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: '#94a3b8',
      flex: 'none',
    };

    function HelperBadge() {
      const [status, setStatus] = React.useState(null);
      const [failed, setFailed] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        let timer = null;

        const load = async () => {
          try {
            const res = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } });
            const body = await res.json();
            if (!alive) return;
            setStatus(body && typeof body === 'object' ? body : null);
            setFailed(false);
          } catch {
            if (alive) setFailed(true);
          }
          if (alive) timer = setTimeout(load, POLL_MS);
        };

        load();
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, []);

      const ready = !!(status && status.keyReady);
      const dot = Object.assign({}, DOT_STYLE);
      const badge = Object.assign({}, BADGE_STYLE);

      let text = '答题助手 · …';
      if (failed) {
        text = '答题助手 · 未加载';
      } else if (status) {
        const n = Number(status.questions) || 0;
        const a = Number(status.answered) || 0;
        text = ready
          ? '答题助手 · 就绪 · 题库 ' + n + '/' + a
          : '答题助手 · 未配 Key · 题库 ' + n;
        if (ready) {
          dot.background = '#22c55e';
          badge.borderColor = 'rgba(34, 197, 94, 0.4)';
          badge.background = 'rgba(34, 197, 94, 0.1)';
        } else {
          dot.background = '#f59e0b';
          badge.borderColor = 'rgba(245, 158, 11, 0.45)';
          badge.background = 'rgba(245, 158, 11, 0.1)';
        }
      }

      const title = status
        ? ('数据目录: ' + (status.dataDir || '?')
          + ' · 模型: ' + (status.model || '?')
          + ' · 来源: ' + (status.keyFrom || '未配置')
          + (status.bridgeEnabled ? ' · 本地桥已开启' : ' · 本地桥未开启'))
        : '砺儒云课堂答题助手';

      return h('div', { style: WRAP_STYLE },
        h('div', { style: badge, 'data-scnu-helper': 'status', title },
          h('span', { style: dot }),
          h('span', null, text)));
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'scnu-course-helper',
          order: 32,
        }, HelperBadge));
    }

    return { name: 'dsh-scnu-course-helper', inject: ['slots'], apply };
  },
});
