# dsh-browseruse

browser-use 风格的浏览器自动化插件，专为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 打造。

通过 [playwright-core](https://www.npmjs.com/package/playwright-core) 驱动一个**专用 Google Chrome 实例**（独立资料目录、cookie 持久），像真人一样"看页面 → 决策 → 操作"，不影响你日常使用的 Chrome。

> A browser-use style automation plugin for DeepSeek Harness. It drives a dedicated Google Chrome instance (independent profile, persistent cookies) through playwright-core, so an agent can browse the web like a human — without touching your everyday Chrome.

## ✨ 功能 / Features

| 能力 | 说明 |
|---|---|
| 👀 细粒度工具 | `browser_open` / `browser_snapshot`（文本+元素序号+截图）/ `browser_click` / `browser_type` / `browser_scroll` / `browser_navigate` / `browser_tabs` / `browser_fill_form` / `browser_download` |
| 🧠 自主任务 | `browser_task("自然语言目标")` —— 插件内部循环"看页面 → 调用当前模型决策 → 操作"，默认上限 30 步，后台运行可用 `job_output` 跟踪 |
| ⏰ 定时任务 | `browser_schedule("目标", "HH:MM" / ISO 时间 / 秒数)` —— 到点自动开跑（抢购/抢票场景），本会话内有效 |
| 🛡️ 危险操作确认 | 支付/下单/删除/注销等敏感动作自动识别，动手前弹窗征求用户同意 |
| 🧩 验证码人工接管 | 检测到验证码时暂停并截图询问，用户可在专用 Chrome 窗口亲自处理后继续 |
| 🖼️ 截图回传 | 每步操作截图进入对话（模型支持图片输入时） |
| 🍪 登录态持久 | 独立 profile（默认 `$DSH_HOME/.browseruse/chrome-profile`），登录一次长期记住，密码不落盘 |

## 📦 安装 / Install

需要本机装有 **Google Chrome**（插件通过 CDP 连接已安装的 Chrome，无需下载浏览器二进制）。

### 方式一：作为 profile bundle（推荐）

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:yzd6552/dsh-browseruse

# 或从 npm 安装
dsh plugin --profile web add dsh-browseruse
```

安装后 `browser_*` 工具对该 profile 的所有会话可见。重启 `dsh web` 后生效。

### 方式二：作为 agent 预设插件行

```sh
mkdir -p ~/.dsh/.agent-presets/<你的预设>/plugins/browseruse
cd ~/.dsh/.agent-presets/<你的预设>/plugins/browseruse
npm init -y && npm install dsh-browseruse
```

在预设的 `agent.cordis.yml` 中追加：

```yaml
- id: tool-browseruse
  name: ./plugins/browseruse/node_modules/dsh-browseruse/index.js
```

## 🚀 使用 / Usage

```
1. browser_open "https://www.baidu.com"     # 打开页面（自动弹出专用 Chrome 窗口）
2. browser_snapshot                          # 读取页面文本 + 元素序号 + 截图
3. browser_type {"text": "苹果发布会"}        # 输入搜索词
4. browser_task "搜索苹果发布会并总结前三条结果"  # 或一句话全自动
5. browser_schedule {"goal": "抢购...", "at": "20:00:00"}  # 定时开跑
```

首次调用任意 browser 工具会自动启动专用 Chrome（可见窗口）；你在窗口里登录一次，之后 cookie 一直记住。

## 🔧 工具清单 / Tools

| 工具 | 作用 |
|---|---|
| `browser_open` | 打开网址（自动启动浏览器，可新标签） |
| `browser_snapshot` | 页面快照：URL、标题、文本、可交互元素序号、截图 |
| `browser_click` | 按序号或文字点击（敏感元素先确认） |
| `browser_type` | 输入文字（支持回车提交） |
| `browser_scroll` | 滚动页面 |
| `browser_navigate` | 后退 / 前进 / 刷新 |
| `browser_tabs` | 标签页列表 / 切换 / 关闭 / 新建 |
| `browser_fill_form` | 按字段批量填表（可选提交，敏感提交先确认） |
| `browser_download` | 触发并保存下载到 `~/Downloads` |
| `browser_task` | 自主任务（后台运行，`job_output` 跟踪） |
| `browser_schedule` | 定时任务（本会话内有效） |
| `browser_status` | 运行状态、标签页、配置目录、待执行排程 |
| `browser_close` | 关闭专用 Chrome（登录态保留） |

## ⚙️ 默认路径 / Defaults

| 项 | 路径 |
|---|---|
| Chrome 资料目录（登录态） | `$DSH_HOME/.browseruse/chrome-profile`（无 `DSH_HOME` 时为 `~/.dsh/...`） |
| 下载目录 | `~/Downloads` |

## ⚠️ 说明 / Notes

- 插件运行在 DSH 主进程，只消费宿主服务（`tools`/`llm`/`userQuestions`/`attachments`/`jobs`），不发布服务。
- 定时任务在会话内有效；DSH 重启后需重新排程。
- 危险操作确认与验证码暂停依赖会话的 `ask_user_question` 通道；子代理上下文中无法询问时会采取保守策略（阻止危险操作）。
- 纯 JavaScript 实现，无构建步骤；需要 Node >= 20、本机已装 Google Chrome。

## 👥 贡献者 / Contributors

- **DeepSeek Harness Agent（deepseek-v4-pro）** — 架构设计、全部代码实现与验证

> 本插件由 DeepSeek Harness 上的 AI 代理开发完成。

## 📄 License

[MIT](./LICENSE)
