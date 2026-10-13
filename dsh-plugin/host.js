/**
 * scnu-course-helper — HOST half.
 *
 * 砺儒云课堂（moodle.scnu.edu.cn）课程助手的 DSH 侧能力。
 *
 * 分两层，各自独立，任何一层单独工作都不影响另一层：
 *
 *   1) **给 DSH 智能体用的 Tool**（主用途）
 *      - `scnu_helper_status`      : 读本地记录，汇总已抓到的题/已得到的答案
 *      - `scnu_helper_ask`         : 把题目（或任意 prompt）发给 OpenAI 兼容接口，返回答案
 *      - `scnu_helper_questions`   : 存取本地题目/答案库（JSON），供人工复核与复用
 *      浏览器里的 userscript 负责抓题与填表；智能体负责解题、复核、归档。
 *
 *   2) **可选的本地桥 `POST /scnu-bridge/ask`**（默认关闭）
 *      给「想让 userscript 直接调用 DSH 里的模型、而不在浏览器里放 key」的场景。
 *      只有显式把 config.bridgeEnabled 设为 true 才会挂路由。
 *      开启时：
 *        - 只接受来自白名单 Origin（默认 moodle.scnu.edu.cn）的请求，其它一律 403
 *        - 只回答提问，不写任何远程状态；所有数据留在本机
 *
 * 不做什么：
 *   - 不代用户登录、不保存用户口令
 *   - 不直接向 moodle.scnu.edu.cn 发任何提交类请求（填表与提交都在浏览器里，
 *     由用户自己在页面上完成确认）
 *   - 不在日志里输出 API key
 *
 * 密钥来源（按优先级）：
 *   1. 插件 config.apiKey
 *   2. 环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY / SCNU_HELPER_API_KEY
 *   3. 都没有 → ask 工具返回明确错误，不静默失败
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 本地数据目录（与 DSH 主目录同级，便于备份） */
const DATA_DIR = join(homedir(), '.dsh', 'scnu-course-helper');
const QUESTIONS_FILE = join(DATA_DIR, 'questions.json');

/** 可选桥的路径 */
const BRIDGE_PATH = '/scnu-bridge/ask';
/** 只读状态路径（给 GUI 侧的状态徽标用，同源请求，无跨域问题） */
const STATUS_PATH = '/scnu-bridge/status';
const BODY_LIMIT = 512 * 1024;

export const name = 'scnu-course-helper';

/*
 * ==================== 关于 inject（踩过一个坑） ====================
 *
 * 必须把 `webServer` **声明在 inject 里**，不能只写 'tools'。
 *
 * 为什么：cordis 按声明的依赖做**作用域隔离** —— 没声明 webServer 时
 * `ctx.get('webServer')` 解析不到，直接返回 undefined。
 * 第一版就是只写了 `['tools']`，结果两条路由（状态 + 本地桥）
 * 全被下面那句 `if (ws === undefined)` 静默跳过：
 *
 *   症状：GET /scnu-bridge/status 恒 404，
 *         心跳文件里 hasWebServer:false，
 *         但 Service 目录里 webServer 明明存在（有 register 方法）。
 *   对照：dsh-session-delete 写的是 inject: [..., 'webServer']，它的路由是好的。
 *
 * webServer 由 `@deepseek-ai/dsh-web-app` 的 `webserver` 行提供。
 * 它是**运行时服务**，所以声明后激活时会正常解析。
 * 下面仍然保留 `ws !== undefined` 检查：将来某个 profile 没有 web 承载时，
 * 插件只是少两条路由，不该整个挂掉。
 * ==================================================================
 */
export const inject = ['tools', 'webServer'];

/*
 * ============================ 关于 Config ============================
 * 这里**绝对不要导出 `Config`**。
 *
 * cordis 的实现是（从 app.asar 提取的原文）：
 *
 *   function resolveConfig(runtime, config) {
 *     if (!runtime.Config) return config;                       // ← 没导出就安全返回
 *     const result = runtime.Config["~standard"].validate(config);
 *     ...
 *   }
 *
 * 也就是说 `Config` 必须是实现了 **Standard Schema** 规范的对象
 * （要带 `~standard` 属性，例如 schemastery 造出来的），
 * 导出普通 JSON Schema 对象会让它取 `["~standard"].validate` 时炸掉：
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 * 而且这个错误**发生在 apply() 之前**，整个 entry 无法激活。
 * 同 profile 的 dsh-infinite-gen-2 / dsh-session-delete 都没导出 Config，一切正常。
 *
 * 配置仍然能进来，走两条路，在 apply(ctx, config) 里读到：
 *   1) dsh.bundle.patch 指向的 cordis.patch.yml 里该行的 `config:`
 *   2) 用户在 profile 的 cordis.patch.yml 里按 id 覆盖的 `config:`
 * DEFAULT_CONFIG 负责补齐缺省值。
 * ====================================================================
 */
const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0,
  maxTokens: 2048,
  bridgeEnabled: false,
  bridgeOrigins: ['https://moodle.scnu.edu.cn'],
};

/** 把用户配置与缺省值合并，并对类型做一次宽松规整 */
function normalizeConfig(raw) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, (raw && typeof raw === 'object') ? raw : {});
  cfg.baseUrl = (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim())
    ? cfg.baseUrl.trim() : DEFAULT_CONFIG.baseUrl;
  cfg.apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  cfg.model = (typeof cfg.model === 'string' && cfg.model.trim())
    ? cfg.model.trim() : DEFAULT_CONFIG.model;
  cfg.temperature = Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0;
  cfg.maxTokens = (Number.isFinite(Number(cfg.maxTokens)) && Number(cfg.maxTokens) > 0)
    ? Number(cfg.maxTokens) : DEFAULT_CONFIG.maxTokens;
  cfg.bridgeEnabled = cfg.bridgeEnabled === true;
  cfg.bridgeOrigins = (Array.isArray(cfg.bridgeOrigins) && cfg.bridgeOrigins.length)
    ? cfg.bridgeOrigins.map((s) => String(s)) : DEFAULT_CONFIG.bridgeOrigins.slice();
  return cfg;
}

/* ------------------------------------------------------------------ 工具函数 */

function ensureDir() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function readQuestions() {
  try {
    if (!existsSync(QUESTIONS_FILE)) return { updatedAt: null, items: [] };
    const parsed = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.items)) return parsed;
    return { updatedAt: null, items: [] };
  } catch {
    return { updatedAt: null, items: [] };
  }
}

function writeQuestions(doc) {
  if (!ensureDir()) throw new Error('无法创建数据目录: ' + DATA_DIR);
  writeFileSync(QUESTIONS_FILE, JSON.stringify(doc, null, 2), 'utf8');
}

function resolveKey(config) {
  const fromConfig = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';
  if (fromConfig) return { key: fromConfig, from: 'plugin config' };
  for (const e of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'SCNU_HELPER_API_KEY']) {
    const v = process.env[e];
    if (typeof v === 'string' && v.trim()) return { key: v.trim(), from: 'env ' + e };
  }
  return { key: '', from: null };
}

/** 单次 chat/completions 调用。不打印 key。 */
async function askModel(config, messages, opts = {}) {
  const { key, from } = resolveKey(config);
  if (!key) {
    throw new Error('没有可用的 API key。请在插件配置里填 apiKey，或设置环境变量 DEEPSEEK_API_KEY。');
  }
  const base = String(config?.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = {
    model: String(opts.model || config?.model || 'deepseek-chat'),
    temperature: Number(opts.temperature !== undefined ? opts.temperature : (config?.temperature ?? 0)),
    max_tokens: Number(opts.maxTokens || config?.maxTokens || 2048),
    messages,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err && err.name === 'AbortError'
      ? '接口请求超时（120s）' : String((err && err.message) || err);
    throw new Error(msg);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) throw new Error('接口返回 HTTP ' + res.status + '：' + text.slice(0, 400));
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('接口返回不是 JSON：' + text.slice(0, 400));
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('接口返回里没有 choices[0].message.content：' + text.slice(0, 400));
  }
  return { content, usage: json?.usage ?? null, keyFrom: from, model: body.model };
}

/** 从模型输出里抽出 JSON（容忍 ``` 围栏与前后废话） */
function extractJson(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

const OBJECT_OUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

const ANSWER_SYS = [
  '你是一位严谨的学科答题助手，请给出**最可能正确**的答案。',
  '只输出 JSON，不要解释、不要 markdown 围栏。格式：{"answers":[{"n":题号,"answer":"答案"}]}',
  '选择题 answer 用选项字母（多选按字母升序连写，如 ABD）；判断题同样用字母。',
  '填空题直接给内容；数值题只给数字；简答题给一段完整作答。',
  '无法判断时 answer 用空字符串。',
].join('\n');

/* ------------------------------------------------------------------ 插件体 */

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);

  /*
   * 落盘心跳：用来确认 apply() 到底有没有真的被调用。
   * 排查装载问题时非常有用 —— 如果这个文件没出现，说明 fiber 是 active 但
   * apply 根本没跑（模块被缓存 / 入口解析到了别处）。
   * 正常工作后它可以留着，成本是一次 writeFileSync。
   */
  const heartbeat = (stage, extra) => {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(join(DATA_DIR, 'last-apply.json'),
        JSON.stringify({
          stage,
          at: new Date().toISOString(),
          pid: process.pid,
          dataDir: DATA_DIR,
          home: homedir(),
          configReceived: config !== undefined && config !== null,
          bridgeEnabled: cfg.bridgeEnabled,
          ...(extra || {}),
        }, null, 2), 'utf8');
    } catch { /* 心跳失败不影响功能 */ }
  };
  heartbeat('apply-enter');

  /** 本地状态快照（只读本机文件，不触网） */
  const statusPayload = () => {
    const { key, from } = resolveKey(cfg);
    const doc = readQuestions();
    const answered = doc.items.filter((i) => i.answer !== undefined && i.answer !== '').length;
    return {
      dataDir: DATA_DIR,
      questions: doc.items.length,
      answered,
      updatedAt: doc.updatedAt,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      keyReady: key !== '',
      keyFrom: from,
      bridgeEnabled: cfg.bridgeEnabled,
    };
  };

  /* ---- Tool 1：状态 ---- */
  const statusTool = {
    name: 'scnu_helper_status',
    description: '查看砺儒云课堂答题助手的本地状态：数据目录、题库条目数、接口配置是否就绪（不打印密钥）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OBJECT_OUT,
    execute() {
      return {
        ...statusPayload(),
        questionsFile: QUESTIONS_FILE,
        bridgePath: BRIDGE_PATH,
        statusPath: STATUS_PATH,
      };
    },
  };

  /* ---- Tool 2：问模型 ---- */
  const askTool = {
    name: 'scnu_helper_ask',
    description:
      '把题目发给配置好的大模型接口并返回答案。可用于复核浏览器助手给出的答案，'
      + '或对导出到本地的错题做批量解析。输入 questions 为题目文本（每题一段），返回结构化 answers。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        questions: {
          type: 'string',
          description: '题目正文。多题用空行分隔；题目可自带选项 A. B. C. D.。',
        },
        instruction: {
          type: 'string',
          description: '额外要求（可选）。例如"本课程为劳动教育"。',
        },
        jsonMode: {
          type: 'boolean',
          description: '是否要求返回 JSON（默认 true）。选择题答案用字母，多选按字母升序连写。',
        },
      },
      required: ['questions'],
    },
    output: OBJECT_OUT,
    async execute(args) {
      const questions = String(args?.questions || '').trim();
      if (!questions) throw new Error('questions 不能为空');
      const wantJson = args?.jsonMode !== false;

      const sysParts = [
        '你是一位严谨的学科答题助手，请给出**最可能正确**的答案。',
        wantJson
          ? '只输出 JSON，不要解释、不要 markdown 围栏。格式：{"answers":[{"n":题号,"answer":"答案"}]}'
          : '逐题给出答案，格式：第1题：X',
        '选择题 answer 用选项字母（多选按字母升序连写，如 ABD）；判断题同样用字母。',
        '填空题直接给内容；数值题只给数字；简答题给一段完整作答。',
        '无法判断时 answer 用空字符串。',
      ];
      const extra = String(args?.instruction || '').trim();
      if (extra) sysParts.push('补充信息：' + extra);

      const out = await askModel(cfg, [
        { role: 'system', content: sysParts.join('\n') },
        { role: 'user', content: questions },
      ]);

      const result = { content: out.content, usage: out.usage, model: out.model };
      if (wantJson) {
        try {
          result.answers = extractJson(out.content);
        } catch (err) {
          result.answersParseError = '模型输出不是合法 JSON：' + String((err && err.message) || err);
        }
      }
      return result;
    },
  };

  /* ---- Tool 3：本地题库 ---- */
  const bankTool = {
    name: 'scnu_helper_questions',
    description:
      '读写本机题库文件（' + QUESTIONS_FILE + '）。action=save 追加/更新题目与答案；'
      + 'action=list 读取；action=clear 清空。只写本机文件，不触网、不碰学校服务器。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'clear'], description: '操作。' },
        items: {
          type: 'array',
          description: '要保存的条目。每项至少 { text }，可带 { answer, options, type, source }。',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['action'],
    },
    output: OBJECT_OUT,
    execute(args) {
      const action = String(args?.action || '');
      if (action === 'clear') {
        writeQuestions({ updatedAt: new Date().toISOString(), items: [] });
        return { ok: true, cleared: true, file: QUESTIONS_FILE };
      }
      if (action === 'save') {
        const incoming = Array.isArray(args?.items) ? args.items : [];
        const doc = readQuestions();
        let added = 0;
        let updated = 0;
        for (const it of incoming) {
          if (!it || typeof it !== 'object') continue;
          const key = JSON.stringify(it.text ?? '');
          const at = doc.items.findIndex((x) => JSON.stringify(x.text ?? '') === key);
          if (at >= 0) {
            doc.items[at] = { ...doc.items[at], ...it };
            updated += 1;
          } else {
            doc.items.push(it);
            added += 1;
          }
        }
        doc.updatedAt = new Date().toISOString();
        if (doc.items.length > 2000) doc.items = doc.items.slice(-2000);
        writeQuestions(doc);
        return { ok: true, added, updated, total: doc.items.length, file: QUESTIONS_FILE };
      }
      const doc = readQuestions();
      return {
        ok: true, total: doc.items.length, updatedAt: doc.updatedAt,
        items: doc.items, file: QUESTIONS_FILE,
      };
    },
  };

  /* ---- 状态路由（只读、不含密钥，给本机 GUI 徽标用） ---- */
  /*
   * 因为 inject 里已经声明了 'webServer'，这里能直接拿到。
   * 仍然保留 undefined 检查：将来某个 profile 没有 web 承载时，
   * 插件只是少两条路由，不该整个挂掉。
   */
  const ws = ctx.get('webServer');

  if (ws !== undefined) {
    ctx.effect(() => ws.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        // 同源请求不需要 CORS，但浏览器可能带 Origin 发过来；
        // 明确回一个 no-store 的 JSON，并处理 OPTIONS，避免预检被 404。
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        if (req.method === 'OPTIONS') { res.end(); return; }
        res.end(JSON.stringify({ ok: true, ...statusPayload() }));
      },
    }), 'scnu-course-helper: ' + STATUS_PATH);
  } else {
    ctx.logger?.warn?.('scnu-course-helper: 拿不到 webServer，状态路由与本地桥均未挂载');
  }

  ctx.effect(() => ctx.tools.register(statusTool), 'scnu-course-helper: status tool');
  ctx.effect(() => ctx.tools.register(askTool), 'scnu-course-helper: ask tool');
  ctx.effect(() => ctx.tools.register(bankTool), 'scnu-course-helper: questions tool');

  heartbeat('tools-registered', {
    hasWebServer: ws !== undefined,
    hasTools: ctx.get('tools') !== undefined,
    statusPath: STATUS_PATH,
  });

  /* ---- 可选：本地桥 ---- */
  if (cfg.bridgeEnabled === true) {
    const webServer = ws;
    if (webServer === undefined) {
      ctx.logger?.warn?.('scnu-course-helper: bridgeEnabled=true 但拿不到 webServer，桥未挂载');
    } else {
      const allowed = new Set(
        cfg.bridgeOrigins.map((s) => String(s).replace(/\/+$/, '')),
      );

      const cors = (req, res) => {
        const origin = String(req.headers?.origin || '');
        const ok = allowed.has(origin.replace(/\/+$/, ''));
        res.setHeader('Access-Control-Allow-Origin', ok ? origin : 'null');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
        res.setHeader('Access-Control-Max-Age', '600');
        /*
         * Private Network Access：页面来自公网站点（https://moodle.xxx），
         * 请求目标是本机地址（http://127.0.0.1），Chrome 会额外要这个头，
         * 否则预检直接失败。只对白名单 Origin 回 true。
         */
        if (ok && String(req.headers?.['access-control-request-private-network'] || '') === 'true') {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
        return ok;
      };

      const readBody = async (req) => {
        const chunks = [];
        let total = 0;
        for await (const chunk of req) {
          total += chunk.length;
          if (total > BODY_LIMIT) throw new Error('请求体过大');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf8');
      };

      const send = (res, code, payload) => {
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(payload));
      };

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: BRIDGE_PATH,
        handler: async (req, res) => {
          const originOk = cors(req, res);
          if (req.method === 'OPTIONS') { res.writeHead(originOk ? 204 : 403); res.end(); return; }
          if (!originOk) { send(res, 403, { ok: false, error: 'origin not allowed' }); return; }
          if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return; }

          let payload;
          try {
            payload = JSON.parse(await readBody(req));
          } catch (err) {
            send(res, 400, { ok: false, error: 'JSON 解析失败：' + String((err && err.message) || err) });
            return;
          }
          const questions = typeof payload?.questions === 'string' ? payload.questions.trim() : '';
          if (!questions) { send(res, 400, { ok: false, error: 'questions 不能为空' }); return; }

          try {
            const out = await askModel(cfg, [
              { role: 'system', content: ANSWER_SYS },
              { role: 'user', content: questions },
            ]);
            let answers = null;
            try { answers = extractJson(out.content); } catch { /* 把原文给客户端 */ }
            send(res, 200, { ok: true, answers, content: out.content, model: out.model });
          } catch (err) {
            ctx.logger?.warn?.('scnu-course-helper bridge ask failed: ' + String((err && err.message) || err));
            send(res, 502, { ok: false, error: String((err && err.message) || err) });
          }
        },
      }), 'scnu-course-helper: ' + BRIDGE_PATH);
    }
  }

  ctx.logger?.info?.('scnu-course-helper: 已加载（数据目录 ' + DATA_DIR + '）');
}
