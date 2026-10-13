# moodle-scnu-toolkit
天下苦水课已久——网课尤甚！今有神助众生于水火之中：

砺儒云课堂（华南师范大学 Moodle）**自动化工具集** —— 视频自动连播 + 测验自动作答 +
进度核查脚本 + DSH 插件。

> 本站点用的是自装的 `mod_fsresource` 视频插件（腾讯 `tcplayer` + 站点自加的
> 防挂机验证），所以**连播部分只适用于本校**。测验作答部分依赖的是 Moodle 内核，
> 理论上跨站点可用 —— 通用版见 [moodle-quiz-solver](https://github.com/)。
>
> ⚠️ 使用前请阅读 [docs/使用边界.md](docs/使用边界.md)。

---

## 包含什么

| 目录 | 内容 |
|---|---|
| `userscripts/` | 三个 Tampermonkey 脚本：**视频自动连播**、**答题助手**、测验内容导出 |
| `tools/` | Python 工具：测验导出、完成状态解析、视频时长、课程侦察、进度核查 |
| `tests/` | 离线回归测试（55 项），无需浏览器 |
| `dsh-plugin/` | DeepSeek Harness 插件：给智能体提供「出题→问模型→存题库」能力 |
| `docs/` | 使用说明、机制文档、cookie 导出说明 |

## 视频自动连播（本校专用）

按平台规则累积**真实观看时长**到 95% 自动切换，并自动完成「按住通过」人机验证。

- 时长累加是 `viewTotalTime += 250`（**墙上时钟**），所以**倍速对达标无用**
- 达标线 95%，由服务端判定，脚本读页面上的「我的观看时长」
- 验证分档：≤10min 不验；10~15min 每 10 分钟；15~30min 每 15 分钟；>30min 每 20 分钟
- 验证按钮监听器**不检查 `isTrusted`**，所以可按真实指针序列自动完成
- `ended` 会让 `playerState=3` 并停止计时（时长永久冻结）→ 必须重置重播

细节见 [docs/自动连播与答题助手说明.md](docs/自动连播与答题助手说明.md)。

## 答题助手

一次确认（点「🚀 放任自流」）→ 全自动抓题/作答/翻页 → **到提交页停下等你交卷**。
详见通用版 README 的说明；本站版本额外带站点命名，功能一致。

## 工具脚本

```bash
python tools/completion.py            # 正确解析课程完成状态（只读）
python tools/requirements.py --video  # 每项活动的完成要求
python tools/quiz_export.py exportall # 批量导出已作答测验
python tools/recon_moodle.py          # 复勘登录态与课程现状
```

> ⚠️ 这些脚本**只做 GET 只读**，不向学校服务器提交任何数据。
> 需要 `cookie.txt`（你自己从浏览器导出，见 `docs/cookie使用说明.md`）。

## DSH 插件

给 DeepSeek Harness 用的插件，提供三个工具：
`scnu_helper_status` / `scnu_helper_ask` / `scnu_helper_questions`，
并在对话界面显示状态徽标。装法与踩坑记录见 `dsh-plugin/README.md`。

> 写 DSH 插件的一个坑：**不要导出 `Config`**（除非用 schemastery 造 schema），
> 否则 cordis 会在 `runtime.Config["~standard"].validate(config)` 处抛错，
> 且该错误发生在 `apply()` 之前，整个 entry 无法激活。

## 测试

```bash
pip install lxml
python tests/test_selectors.py      # 29 项
python tests/test_autoadvance.py    # 26 项
python tests/portability_probe.py   # 机动性分层
```

## 边界

- 只在你**自己已登录的浏览器**里操作页面；不代登录、不保存口令
- 视频时长上报走播放器**已有的**接口，值取真实累计 —— **不伪造进度**
- **不自动交卷**，最后一步永远留给人
- Python 脚本只做 GET 只读，不提交、不修改服务端状态

## License

MIT
