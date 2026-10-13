# @local/dsh-scnu-helper2

砺儒云课堂（`moodle.scnu.edu.cn`）课程助手的 **DSH 侧**能力。

> **关于包名**：刻意用 `helper2`。早期版本叫 `@local/dsh-scnu-course-helper`，
> 因为导出了普通对象形式的 `Config` 导致模块加载失败，而 **Node 的 ESM 加载器按
> 解析后的文件路径缓存失败结果** —— 同一路径改好了也加载不出来，**换包名没用**
> （路径没变）。必须**换路径**。详见 `cordis.patch.yml` 顶部注释。

浏览器里的抓题/填表由 userscript 负责；这个插件负责**解题、复核、归档**，
以及给浏览器一个可选的本地桥。

---

## 提供的 Tool

| Tool | 作用 |
|---|---|
| `scnu_helper_status` | 读本地状态：数据目录、题库条数、key 是否就绪（不打印密钥） |
| `scnu_helper_ask` | 把题目发给 OpenAI 兼容接口，返回结构化 `answers` |
| `scnu_helper_questions` | 读写本机题库 `~/.dsh/scnu-course-helper/questions.json`（save / list / clear） |

## 提供的 HTTP 路由

| 路由 | 默认 | 说明 |
|---|---|---|
| `GET /scnu-bridge/status` | 总是启用 | 只读状态，供 GUI 徽标轮询 |
| `POST /scnu-bridge/ask` | 默认关闭 | 给浏览器 userscript 用，让密钥留在本机。需 `bridgeEnabled: true` |

`/scnu-bridge/ask` 开启后只接受 **Origin 白名单**（默认 `https://moodle.scnu.edu.cn`）的请求，
其它一律 `403`；请求体上限 512KB；只回答提问，不写任何远程状态。

## 客户端

`client.js` 在对话输入框上方注册一枚状态徽标（`conversation.input.dock`，order 32）：

- 绿点 = key 就绪 → 「答题助手 · 就绪 · 题库 N/M」
- 黄点 = 没配 key → 「答题助手 · 未配 Key · 题库 N」

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: scnu-helper2
  config:
    baseUrl: https://api.deepseek.com/v1
    model: deepseek-chat
    apiKey: ''             # 留空则读 DEEPSEEK_API_KEY / OPENAI_API_KEY / SCNU_HELPER_API_KEY
    bridgeEnabled: false   # 想让浏览器直接调用本机桥时改 true
    bridgeOrigins:
      - https://moodle.scnu.edu.cn
```

密钥解析优先级：`config.apiKey` → 环境变量。都没有时 `scnu_helper_ask` 会**明确报错**，
不静默返回空答案。

---

## ⚠️ 三个坑（都踩过，都值得记）

### 坑 1：`inject` 必须声明 `webServer`

**症状**：`GET /scnu-bridge/status` 恒 404，心跳里 `hasWebServer: false`，
但 `listService` 里 `webServer` 明明存在（有 `register` 方法）。

**根因**：cordis 按**声明的依赖**做作用域隔离。第一版只写了

```js
export const inject = ['tools'];        // ❌ 少了 webServer
```

于是 `ctx.get('webServer')` 解析不到 → 返回 `undefined` → 被
`if (ws !== undefined)` 静默跳过，两条路由都没挂上，**而且不报任何错**。

**修法**：

```js
export const inject = ['tools', 'webServer'];   // ✅
```

对照：`dsh-session-delete` 写的是 `inject: [..., 'webServer']`，它的路由是好的。
**凡是 `ctx.get(X)` 一个服务，X 就得在 `inject` 里。**

顺带补的两处（跨域到本机必需）：

| 补什么 | 为什么 |
|---|---|
| 状态路由也处理 `OPTIONS` | 浏览器预检是 `OPTIONS`，原实现只当 GET 处理 |
| `Access-Control-Allow-Private-Network: true` | 页面在公网站点、目标是本机 `127.0.0.1` → Chrome 的 PNA 检查要求这个头，否则预检直接失败。只对白名单 Origin 回 |

### 坑 2：千万别导出 `Config`

cordis 的原文（从 `app.asar` 提取）：

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;                          // 没导出就安全返回
  const result = runtime.Config["~standard"].validate(config);  // ← 这里炸
  ...
}
```

`Config` 必须是实现 **Standard Schema** 规范的对象（带 `~standard` 属性）。
导出普通 JSON Schema 对象 → `TypeError: Cannot read properties of undefined
(reading 'validate')`，而该错误发生在 `apply()` **之前**，整个 entry 无法激活。
`cordis.patch.yml` 里也**不要**写 `config:` 块，同一个坑。

同 profile 的 `dsh-infinite-gen-2` / `dsh-session-delete` 都没导出 `Config`，一切正常。

### 坑 3：改完必须重启 DSH

插件管理器只把装载行写进 profile，**运行中的进程不会重新实例化 entry**。
`list_plugins` 报 `fiberPhase: active` **也不代表 `apply()` 跑过**（实测遇到过）。

判定方法：看 `~/.dsh/scnu-course-helper/last-apply.json` 里的
`hasWebServer` 有没有变成 `true`。同时 `GET /scnu-bridge/status` 会从 404 变 200。

---

## 边界

- 不代登录、不保存口令
- 不向 `moodle.scnu.edu.cn` 发任何提交类请求
- 日志里不输出 API key
- 只写本机 `~/.dsh/scnu-course-helper/` 下的一个 JSON 文件

## 自检

```bash
node --check host.js && node --check client.js
```
