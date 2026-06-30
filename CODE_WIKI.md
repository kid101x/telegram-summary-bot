# Code Wiki — telegram-summary-bot

> 一份对 `telegram-summary-bot` 仓库的结构化代码文档，涵盖整体架构、模块职责、关键类与函数、依赖关系、运行方式，以及分支 / 上游仓库关系与该形式的利弊分析。

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [主要模块职责](#4-主要模块职责)
5. [关键类与函数说明](#5-关键类与函数说明)
6. [依赖关系](#6-依赖关系)
7. [项目运行方式](#7-项目运行方式)
8. [分支策略与上游关系](#8-分支策略与上游关系)
9. [当前仓库形式的利弊分析](#9-当前仓库形式的利弊分析)

---

## 1. 项目概述

`telegram-summary-bot` 是一个部署在 **Cloudflare Workers** 上的 Telegram 群聊机器人。它把群聊消息持久化到 **Cloudflare D1**（Serverless SQLite）中，再通过 **LLM**（默认 Google AI Studio 的 `gemini-2.0-flash` / `gemini-2.5-flash`，经 Cloudflare AI Gateway 走 OpenAI 兼容协议）为用户完成：

- 群聊消息**总结**（按条数或时间范围）
- 群聊内容**关键词检索**（支持 CJK，使用 SQLite `GLOB`）
- 基于群聊上下文**回答问题**
- 每日定时自动总结 + 定时清理过期数据
- 图片消息（JPEG）摘要（以 base64 直接喂给多模态模型）
- URL 链接的 OpenGraph 元信息提取

技术栈：TypeScript + Cloudflare Workers + D1 + AI Gateway + `@codebam/cf-workers-telegram-bot`（Telegram Bot 框架）+ OpenAI SDK（兼容调用）。

成本几乎为 0：D1 免费额度 + Workers 免费额度 + Gemini Flash 免费额度。

---

## 2. 整体架构

```
                         ┌──────────────────────────────────────┐
                         │           Cloudflare Worker          │
                         │     (src/index.ts 默认导出对象)        │
                         └──────────────────────────────────────┘
            fetch(HTTP Webhook)                    scheduled(Cron Trigger)
                       │                                     │
                       ▼                                     ▼
        ┌──────────────────────────┐         ┌────────────────────────────┐
        │  new TelegramBot(token)  │         │  handleScheduledSummary    │
        │  bot.on(...) 注册 handler │         │  handleScheduledCleanup    │
        │  bot.handle(request)     │         │  (src/cron.ts)             │
        └──────────────────────────┘         └────────────────────────────┘
                       │                                     │
                       ▼                                     │
   ┌──────────────── handlers/ ───────────────────┐          │
   │ version status test_summary query ask summary │          │
   │            message (新消息/编辑/图片)            │          │
   └───────────────────────────────────────────────┘          │
                       │                                       │
        ┌──────────────┼─────────────────────────┐             │
        ▼              ▼                          ▼             ▼
   ┌─────────┐   ┌──────────┐              ┌──────────────────────┐
   │  ai.ts  │   │  db.ts   │              │   db.ts (cleanup)    │
   │ LLM 调用 │   │ D1 读写  │              │ cleanupOldMessages   │
   └────┬────┘   └────┬─────┘              │ cleanupOldImages     │
        │             │                    └──────────────────────┘
        ▼             ▼
   ┌──────────────────────┐        ┌─────────────────────┐
   │ Cloudflare AI Gateway│        │  Cloudflare D1      │
   │  (OpenAI 兼容接口)     │        │  Messages 表        │
   └──────────┬───────────┘        └─────────────────────┘
              ▼
   ┌──────────────────────┐
   │ Gemini / 其他 LLM     │
   └──────────────────────┘

            ┌──────────────────────────────────┐
            │  Telegram Bot API (sendMessage)   │
            │  由 handlers & cron 直接 fetch 调用 │
            └──────────────────────────────────┘
```

核心运行模型：

- **入口**：`src/index.ts` 默认导出一个含 `scheduled` 和 `fetch` 方法的对象，这是 Cloudflare Workers 的 ES Module 标准入口。
- **HTTP 入口（`fetch`）**：Telegram 把 webhook update POST 到 Worker。Worker 实例化 `TelegramBot`，把不同的 `update_type` / 命令路由到 `src/handlers/*`。
- **定时入口（`scheduled`）**：由 `wrangler.toml` 中的 `triggers.crons` 触发，分别执行每日总结与每日清理。
- **存储层**：所有消息都进 D1 的 `Messages` 表；图片以 `data:image/jpeg;base64,...` 形式直接存进 `content` 字段。
- **AI 层**：`src/ai.ts` 用 OpenAI SDK 走 Cloudflare AI Gateway 的 `/compat` 端点；本地开发可强制回退到自定义 `AI_BASE_URL`（如本地 ollama 的 `http://localhost:11434/v1`）。

---

## 3. 目录结构

```
.
├── .github/
│   ├── workflows/format.yml        # CI：master 分支 push/PR 时跑 tsc --noEmit
│   └── FUNDING.yml
├── .vscode/settings.json
├── src/
│   ├── handlers/                   # 命令与事件处理（路由层）
│   │   ├── index.ts                # 统一 re-export
│   │   ├── version.ts              # /version
│   │   ├── status.ts               # /status
│   │   ├── test_summary.ts         # /test_summary（仅管理员，手动触发每日总结）
│   │   ├── query.ts                # /query 关键词搜索
│   │   ├── ask.ts                  # /ask 基于群聊回答问题（私聊回复）
│   │   ├── summary.ts              # /summary 摘要
│   │   └── message.ts              # 普通消息 / 编辑消息 / 图片消息入库
│   ├── utils/
│   │   ├── telegram.ts             # 消息链接生成、用户名提取、回复模板
│   │   ├── markdown.ts             # MarkdownV2 转义、链接折叠、上标、可折叠块
│   │   ├── og.ts                   # HTMLRewriter 提取 OG / meta 元信息
│   │   └── isJpeg.ts               # 通过 SOI/EOI 标记校验 JPEG base64
│   ├── ai.ts                       # OpenAI SDK 客户端 + getSummary / answerQuestion
│   ├── config.ts                   # 全部静态常量与系统 prompt 集中管理
│   ├── cron.ts                     # 定时任务：每日总结 / 清理
│   ├── db.ts                       # D1 数据访问层
│   ├── index.ts                    # Worker 入口（fetch + scheduled）
│   └── types.ts                    # Env / BotContext / MessageRecord 类型
├── test/
│   ├── index.spec.ts               # vitest 单测（processMarkdownLinks / toSuperscript）
│   └── tsconfig.json
├── schema.sql                      # D1 表结构（Messages + 索引）
├── wrangler.toml                   # CF Workers 配置：环境、D1、cron
├── worker-configuration.d.ts       # wrangler types 生成的 Env 类型
├── package.json
├── tsconfig.json
└── README.md
```

---

## 4. 主要模块职责

### 4.1 入口层 — `src/index.ts`

Worker 的总入口，负责：

1. 在 `scheduled` 中根据 `controller.cron` 字符串分发到 `handleScheduledSummary` / `handleScheduledCleanup`。
2. 在 `fetch` 中创建 `TelegramBot` 实例，注册各命令与 `:message` / `:edited_message` 事件回调，然后调用 `bot.handle(request)` 完成 webhook 处理。
3. 通过 `getRuntimeEnvironment(env)` 打印当前环境（`prod` / `dev-test` / `local-demo`）。

### 4.2 配置层 — `src/config.ts`

集中存放：

- `IGNORED_KEYWORDS`：消息以这些词开头时直接忽略（`签到`/`打卡`/`查找`）。
- `aiConfig`：`temperature = 0.4`，`timeout = 30000ms`。
- `SYSTEM_PROMPTS`：`summarizeChat` 与 `answerQuestion` 两套系统提示词。
- `cronConfig`：每日总结最小消息数阈值、消息保留上限（5000）、图片保留期（2 天）、跳过总结的群组 ID 列表。
- `botConfig.repoUrl`：开源项目地址。
- `PROMPT_FORMATTING.messageSeparator`：拼接历史消息的分隔符 `---`。
- `getRuntimeEnvironment(env)`：返回当前运行环境标识。

### 4.3 数据访问层 — `src/db.ts`

封装所有 D1 SQL：

| 函数 | 作用 |
|---|---|
| `saveMessage` | 插入/替换一条消息（主键 `id` = 消息链接） |
| `getMessagesByCount` | 取某群最近 N 条（最多 4000） |
| `getMessagesByHours` | 取某群最近 N 小时的消息 |
| `searchMessages` | 按 `GLOB` 模糊搜索（`*关键词*`） |
| `getActiveGroups` | 取过去 24h 消息数 > 阈值的活跃群 |
| `cleanupOldMessages` | 每群按时间倒序保留前 N 条，删除其余 |
| `cleanupOldImages` | 删除早于保留期的 JPEG base64 消息 |

### 4.4 AI 层 — `src/ai.ts`

- `createOpenAIClient(env)`：根据环境变量选择 baseURL——
  - 默认走 AI Gateway：`https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{AI_GATEWAY_ID}/compat`
  - 回退模式：`FORCE_USE_AI_BASE_URL === 'true'` 时使用 `AI_BASE_URL`（本地 ollama 等）
  - 都没配置则抛错。
- `dispatchContent(content)`：判断 content 是 JPEG base64（返回 `image_url` part）还是纯文本。
- `getAIResponse(env, messages, promptType, question?)`：把 `MessageRecord[]` 拼成 OpenAI 多模态 `content` 数组（文本 + 图片），调 `chat.completions.create`，`max_tokens=4096`。
- `getSummary(env, messages)` 与 `answerQuestion(env, messages, question)`：分别对应两种 promptType 的对外门面。

### 4.5 路由 / Handler 层 — `src/handlers/`

每个文件对应一个用户命令或事件类型，统一签名为 `(ctx: BotContext, env: Env, ...) => Promise<Response>`：

- `version.ts` — `/version`：返回 `GIT_COMMIT_SHA` 前 7 位（CI 注入）。
- `status.ts` — `/status`：存活探针。
- `test_summary.ts` — `/test_summary`：仅 `TELEGRAM_ADMIN_ID` 可触发，手动跑每日总结（注意：文件注释里写了这会造成与 `cron.ts` 的循环依赖，是个已知 TODO）。
- `query.ts` — `/query word`：D1 `GLOB` 搜索，结果以 MarkdownV2 输出，带消息链接。
- `ask.ts` — `/ask question`：取最近 1000 条作为上下文，调 `answerQuestion`，结果以**私聊**形式回复用户（先发"思考中…"来检测用户是否已 /start 私聊过 bot）。
- `summary.ts` — `/summary 10` 或 `/summary 10h`：按条数或小时取消息，调 `getSummary`，结果用 `telegramifyMarkdown` + `processMarkdownLinks` + `foldText` + `fixLink` 加工后回复。
- `message.ts` — `:message` / `:edited_message`：
  - 仅处理群聊；
  - `IGNORED_KEYWORDS` 命中则跳过；
  - 命中回复时拼接被回复消息的链接；
  - 内容为单条 URL 时调 `extractAllOGInfo` 抓 OG 元信息；
  - 图片消息：通过 `ctx.getFile` 下载，`isJPEGBase64` 校验后以 base64 存库；
  - 编辑消息：直接覆盖同 `id` 记录（`INSERT OR REPLACE`）。

### 4.6 定时任务层 — `src/cron.ts`

- `handleScheduledSummary(env, summary_period_minutes)`：取活跃群 → 跳过 `skipSummaryGroupIds` → 按时间窗取消息 → `getSummary` → 经 MarkdownV2 加工 → 直接 `fetch` Telegram `sendMessage` 发到群里，标签 `#summary`。
- `handleScheduledCleanup(env)`：先 `cleanupOldMessages(5000)`，再 `cleanupOldImages(2 天)`，输出删除数量日志。

### 4.7 工具层 — `src/utils/`

- `telegram.ts`
  - `getMessageLink({groupId, messageId})`：处理 `-100xxxxxxxxxx` 超级群前缀，生成 `https://t.me/c/{id}/{messageId}`。
  - `getUserName(msg)`：优先用频道匿名身份 `sender_chat.title`，否则 `from.first_name`，再否则 `anonymous`。
  - `fixLink(text)`：修复 LLM 错误生成的 `tme.cat` → `t.me/c`、`/c/c` → `/c`。
  - `getCommandVar(str, delim)`：从命令里取参数。
  - `messageTemplate(s, modelName)`：在摘要前加一行"下面由财大气粗的 {model} 概括群聊信息"。
- `markdown.ts`
  - `escapeMarkdownV2(text)`：转义 MarkdownV2 保留字符。
  - `toSuperscript(num)`：数字转上标（用于引用编号）。
  - `processMarkdownLinks(text, options)`：把 `[url](url)` 这种"显示文本==链接"的重复链接，去重并替换为 `[引用¹](url)`、`[引用²](url)` 形式。
  - `foldText(text)`：把文本包装成 Telegram 可折叠的 `**>...||` 块。
- `og.ts` — `extractAllOGInfo(url)`：用 `HTMLRewriter` 流式解析 `<meta>`，抓 `og:*` 与其他 meta，返回 `"{url} 的相关信息为:\nkey: value\n…"`。
- `isJpeg.ts` — `isJPEGBase64(b64)`：通过 SOI(`FF D8`) / EOI(`FF D9`) 校验 JPEG 头尾。

### 4.8 类型层 — `src/types.ts`

- `Env`：Worker 绑定——`DB: D1Database`、`ENV`、`AI_MODEL_NAME`、`FORCE_USE_AI_BASE_URL`、`AI_BASE_URL`，以及 secrets：`SECRET_TELEGRAM_API_TOKEN` / `TELEGRAM_ADMIN_ID` / `ACCOUNT_ID` / `AI_GATEWAY_ID` / `AI_API_KEY`。
- `BotContext`：handler 接收的上下文，含 `update`、`reply`、`getFile`、`api`、`bot`、`update_type`。
- `MessageRecord`：D1 中一条消息的结构（`id`/`groupId`/`userName`/`content`/`messageId`/`timeStamp`/`groupName`）。

### 4.9 数据库结构 — `schema.sql`

```sql
CREATE TABLE IF NOT EXISTS Messages (
    id TEXT PRIMARY KEY,          -- 消息永久链接
    groupId TEXT,
    timeStamp INTEGER NOT NULL,
    userName TEXT,
    content TEXT,                 -- 文本或 data:image/jpeg;base64,...
    messageId INTEGER,
    groupName TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_groupid_timestamp
            ON Messages(groupId, timeStamp DESC);
```

主键即消息链接，因此同一条消息被编辑时通过 `INSERT OR REPLACE` 自然覆盖；索引支撑按群组、按时间倒序检索的场景。

---

## 5. 关键类与函数说明

### 5.1 `src/index.ts`

```ts
export default {
  async scheduled(controller, env, ctx) { ... }   // 路由 cron 字符串
  async fetch(request, env, _ctx) { ... }          // 实例化 TelegramBot、注册 handler、处理 webhook
}
```

- `scheduled` 内硬编码两个 cron：`23 15 * * *`（上海 23:23，总结 24h42min 的内容，42 分钟用于和前一天重叠）与 `42 18 * * *`（上海 02:42，清理）。
- `fetch` 通过 `bot.on('command', fn)` 与 `bot.on(':message', fn)` 注册所有回调；用 `ctx.waitUntil` 把长任务挂起避免 Worker 提前回收。

### 5.2 `src/ai.ts`

```ts
function createOpenAIClient(env: Env): OpenAI
async function getAIResponse(env, messages, promptType, question?): Promise<string>
export async function getSummary(env, messages): Promise<string>
export async function answerQuestion(env, messages, question): Promise<string>
```

- 多模态拼装：文本部分聚合成一个 `text` part 放在数组开头，图片单独作为 `image_url` part，避免每条消息都重复 system prompt 浪费 token。
- 超时统一用 SDK 的 `timeout` 选项（30s），而非自定义头，便于跨供应商兼容。

### 5.3 `src/db.ts`

```ts
saveMessage(db, message)
getMessagesByCount(db, groupId, limit)        // Math.min(limit, 4000) 保护
getMessagesByHours(db, groupId, hours)
searchMessages(db, groupId, searchTerm)       // LIMIT 2000
getActiveGroups(db, threshold)
cleanupOldMessages(db, threshold)             // 窗口函数 ROW_NUMBER() OVER PARTITION BY groupId
cleanupOldImages(db, retentionPeriodMs)
```

- `cleanupOldMessages` 用 `ROW_NUMBER() OVER (PARTITION BY groupId ORDER BY timeStamp DESC)` 删除每群排名 > threshold 的旧消息，是单条 SQL 完成的"每群保留最新 N 条"。
- 所有写操作都 `try/catch`，错误只打日志不抛，保证 webhook 总能返回 200。

### 5.4 `src/handlers/`

| 函数 | 关键行为 |
|---|---|
| `handleVersionCommand` | 读 `env.GIT_COMMIT_SHA`，回 MarkdownV2 |
| `handleStatusCommand` | 回固定字符串 `'我家还蛮大的'` |
| `handleTestSummaryCommand` | 仅管理员，调 `handleScheduledSummary`（已知循环依赖 TODO） |
| `handleQueryCommand` | `searchMessages(db, gid, '*'+term+'*')`，结果转义后带 `[link](...)` |
| `handleAskCommand` | 取最近 1000 条上下文 → `answerQuestion` → **私聊**回复；先发"思考中…"探测私聊是否被 /start |
| `handleSummaryCommand` | 解析 `Nh` 或 `N`，取消息 → `getSummary` → MarkdownV2 加工 → 回复 |
| `handleMessage` | 群聊判断 / 关键词过滤 / 回复链接拼接 / URL→OG / 图片入库 |
| `handleEditedMessage` | 直接 `saveMessage` 覆盖 |

### 5.5 `src/utils/markdown.ts`

- `processMarkdownLinks`：用 `Map<url, number>` 去重，把 `[url](url)` 改写成 `[引用¹](url)`；只有"显示文本 === URL"的链接才处理，避免误伤正常命名链接。
- `foldText`：Telegram 折叠块语法要求 `**>` 开头、`||` 结尾，且每行都要以 `>` 开头，所以是 `**>` + `text.replace(/\n/g, '\n>')` + `||`。

### 5.6 `src/utils/telegram.ts`

- `getMessageLink` 关键点：D1 里 `groupId` 可能是浮点（如 `-1002803482189.0`），所以先 `Math.trunc`；超级群 ID 以 `-100` 开头，需要去掉前 4 个字符再拼 `t.me/c/...`。

---

## 6. 依赖关系

### 6.1 运行时外部依赖

| 依赖 | 用途 | 备注 |
|---|---|---|
| `@codebam/cf-workers-telegram-bot` | Telegram Bot 框架（webhook 解析、命令路由、API 客户端） | README 里指明其源：`https://github.com/codebam/cf-workers-telegram-bot` |
| `openai` | 通过 OpenAI SDK 调用 Cloudflare AI Gateway 的 OpenAI 兼容端点 | `^4.96.2` |
| `telegramify-markdown` | 把 LLM 输出的标准 Markdown 转成 Telegram MarkdownV2 安全文本 | `^1.2.2` |

### 6.2 开发依赖（关键）

- `wrangler ^4.20.5` —— CF Workers 本地/部署工具链。
- `@cloudflare/workers-types` —— Workers 运行时类型。
- `@cloudflare/vitest-pool-workers` + `vitest ^3.2.4` —— Workers 环境下的单测。
- `gts ^6.0.2` —— Google TypeScript Style，提供 `lint`/`fix`/`clean`。
- `typescript ^5.6.3`、`@types/node ^22`。

### 6.3 `overrides`

```json
"overrides": { "is-core-module": "npm:@nolyfill/is-core-module@^1" }
```
用 `@nolyfill` 替换 `is-core-module`，常见于减小 Workers 打包体积、绕过 Node 内置模块 polyfill 的兼容问题。

### 6.4 模块内依赖图（简化）

```
index.ts ─┬─> config.ts (getRuntimeEnvironment)
          ├─> cron.ts ─┬─> config.ts (cronConfig)
          │            ├─> db.ts (getActiveGroups, getMessagesByHours, cleanup*)
          │            ├─> ai.ts (getSummary)
          │            ├─> utils/markdown.ts
          │            └─> utils/telegram.ts
          └─> handlers/* ─┬─> db.ts
                          ├─> ai.ts
                          ├─> config.ts (IGNORED_KEYWORDS)
                          ├─> utils/{telegram,markdown,og,isJpeg}.ts
                          └─> cron.ts (test_summary.ts 反向依赖 ← 已知循环依赖)
```

外部服务依赖：Telegram Bot API、Cloudflare D1、Cloudflare AI Gateway、底层 LLM（Gemini Flash 等）。

---

## 7. 项目运行方式

### 7.1 前置条件

1. 一个 Telegram Bot Token（找 `@BotFather` 创建）。
2. 一个 Cloudflare 账号，开通 Workers + D1 + AI Gateway。
3. （可选）一个 LLM API Key（如 Google AI Studio 的 Gemini key）。

### 7.2 安装

```bash
npm install
```

### 7.3 D1 数据库初始化

在 Cloudflare 控制台创建 D1 数据库后，把 `database_id` 写进 `wrangler.toml`，然后执行：

```bash
npx wrangler d1 execute <DB_NAME> --file=./schema.sql --remote
# 本地测试用 --local
```

### 7.4 配置 Secrets（生产 `env.prod`）

```bash
npx wrangler secret put SECRET_TELEGRAM_API_TOKEN --env prod
npx wrangler secret put TELEGRAM_ADMIN_ID         --env prod
npx wrangler secret put ACCOUNT_ID                --env prod
npx wrangler secret put AI_GATEWAY_ID             --env prod
npx wrangler secret put AI_API_KEY                --env prod
# 可选：CI 注入
npx wrangler secret put GIT_COMMIT_SHA            --env prod
```

### 7.5 三套环境（`wrangler.toml`）

| 环境 | `ENV` | Worker 名 | D1 | AI 接入 |
|---|---|---|---|---|
| `env.prod` | `prod` | `telegram-summary-bot` | `baijia-bot-db` | AI Gateway（用 secrets 自动拼 baseURL） |
| `env.dev-test` | `dev-test` | `telegram-summary-test` | `baijiabot-t-db` | 同上，指向测试资源 |
| `env.local-demo` | `local-demo` | `telegram-summary-local` | `baijiabot-t-db` | `FORCE_USE_AI_BASE_URL=true`，走 `AI_BASE_URL`（默认 `http://localhost:11434/v1`，即 ollama，模型 `llama3`） |

> 注意：`wrangler dev` 因为 Telegram webhook 需要公网 HTTPS，无法端到端本地调试。`local-demo` 环境的目的是部署到一个测试 Worker，再通过 cloudflared tunnel 等方式把本地 LLM 暴露给 Worker 调用。

### 7.6 本地开发 / 部署 / 测试命令

```bash
npm run dev          # wrangler dev（注意上述 webhook 限制）
npm run deploy       # wrangler deploy（默认 env）
npm run deploy -- --env prod
npm run test         # vitest（基于 wrangler.toml 的 Workers pool）
npm run compile      # tsc --noEmit
npm run lint         # gts lint
npm run fix          # gts fix
npm run cf-typegen   # wrangler types，重新生成 worker-configuration.d.ts
```

### 7.7 设置 Telegram Webhook

部署后需要把 Worker URL 注册为 bot 的 webhook：

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER>.workers.dev/"
```

### 7.8 用户命令一览

| 命令 | 作用 |
|---|---|
| `/version` | 显示当前 commit SHA |
| `/status` | 存活探针 |
| `/summary 10` | 总结最近 10 条消息 |
| `/summary 10h` | 总结最近 10 小时消息 |
| `/query 关键词` | 在群里搜索（支持 CJK），返回带链接结果 |
| `/ask 问题` | 基于最近 1000 条群聊上下文回答（私聊回复） |
| `/test_summary` | 管理员手动触发当日每日总结 |

### 7.9 CI

`.github/workflows/format.yml`：在 `push` / `pull_request` 到 `master` 时跑 `npm ci` + `npx tsc --noEmit` 做类型检查。

---

## 8. 分支策略与上游关系

### 8.1 仓库身份（来自 GitHub 元数据 + 本地 `.git/config`）

- **当前仓库（origin）**：`https://github.com/kid101x/telegram-summary-bot`
- **fork 源（parent / network root）**：`https://github.com/asukaminato0721/telegram-summary-bot`
- GitHub 页 meta 明确：`repository_is_fork: true`、`repository_parent_nwo: asukaminato0721/telegram-summary-bot`、`repository_network_root_nwo: asukaminato0721/telegram-summary-bot`。
- `src/config.ts` 里的 `botConfig.repoUrl` 仍指向**上游** `asukaminato0721/telegram-summary-bot`，说明 fork 后未改这一项。

### 8.2 分支情况

GitHub 显示该 fork 有 **3 个分支**，默认分支为 **`master`**。本地工作目录由于是浅克隆 + fetch refspec 被收窄为：

```ini
[remote "origin"]
    url = https://...@github.com/kid101x/telegram-summary-bot
    fetch = +refs/heads/dev:refs/remotes/origin/dev
[branch "dev"]
    remote = origin
    merge = refs/heads/dev
```

所以本地只看得到：

- `dev`（HEAD，grafted 浅提交 `b7d87b9 改动一下prompt，为每日总结增加标题`）
- `remotes/origin/dev`

GitHub 上的 `master` 与上游 `asukaminato0721/telegram-summary-bot:master` 比较，显示 **"9 commits behind"**，即 fork 的 `master` 比上游落后 9 个提交，未做自定义修改——这是一个**纯镜像型 fork**（fork 后 master 跟随上游，自定义开发在 `dev`）。

### 8.3 上游与下游的关系图

```
asukaminato0721/telegram-summary-bot  (上游 original, master)
                 │
                 │  fork
                 ▼
   kid101x/telegram-summary-bot  (本仓库)
        ├── master      ← 与上游 master 同步（落后 9 commits，无本地改动）
        └── dev         ← 本地自定义开发分支
                            顶层提交："改动一下prompt，为每日总结增加标题"
```

依赖层面还有第二层"上游"：

```
codebam/cf-workers-telegram-bot   (npm: @codebam/cf-workers-telegram-bot)
                 ▲
                 │ 作为 npm 依赖被引入
   asukaminato0721/telegram-summary-bot
                 │
                 │ fork
                 ▼
   kid101x/telegram-summary-bot
```

即：`codebam/cf-workers-telegram-bot` 提供 Telegram bot 框架，`asukaminato0721/telegram-summary-bot` 在其之上实现"群聊总结/检索/问答"业务，`kid101x/telegram-summary-bot` 在其基础上做了少量本地化定制（如本仓库顶层那个 prompt 调整提交）。

### 8.4 为何呈现当前形式

1. **fork 而非 clone-and-rewrite**：作者希望保留与上游的可见关联，便于将来 `git pull upstream master` 拉取上游 bugfix / 新特性，也方便通过 PR 回馈上游。
2. **`master` 保持纯净、`dev` 承载定制**：这是 fork 工作流的常见做法——把 `master` 作为"可合并上游"的镜像分支，避免本地修改与上游更新冲突；自己的改动放在 `dev` 上，部署时按需选分支。
3. **本地 refspec 收窄到 `dev`**：CI 沙箱或部署机只关心自己定制的 `dev` 分支，不需要把 `master` 拉下来；这样克隆更小、更快。
4. **CI 仍以 `master` 为准**：`.github/workflows/format.yml` 触发条件是 `branches: [master]`，因为 fork 继承了上游的工作流文件，且 fork 的 `master` 是默认分支——意味着实际推到 `dev` 的 PR 不会触发 CI 类型检查（除非把 workflow 改成 `dev`）。这是当前形式下一个**已知的不一致**。

---

## 9. 当前仓库形式的利弊分析

### 9.1 利（Pros）

1. **能持续享受上游更新**
   - `master` 与上游同源，`git fetch upstream && git merge upstream/master` 即可同步上游修复与功能，不必手动 cherry-pick。
2. **定制与上游解耦**
   - 把定制改动隔离在 `dev`，避免本地修改污染 `master`，merge 上游时冲突面最小。
3. **GitHub 上的 fork 元数据保留可追溯性**
   - 任何访问者都能看到 "forked from asukaminato0721/..."，便于回溯原始项目、贡献 PR、对比差异。
4. **复用底层框架**
   - 直接 npm 依赖 `@codebam/cf-workers-telegram-bot`，不必自己维护 webhook 解析、Bot API 客户端，业务层只关心 handler。
5. **多环境配置成熟**
   - `wrangler.toml` 已分 `prod` / `dev-test` / `local-demo` 三套环境，本地用 ollama、生产用 AI Gateway，互不干扰。
6. **本地克隆轻量**
   - refspec 只抓 `dev`、浅克隆 grafted，CI/部署机拉取快、占用小。

### 9.2 弊（Cons）

1. **CI 触发分支与实际开发分支不一致**
   - workflow 监听 `master`，但开发在 `dev`，导致 `dev` 上的改动不会自动跑 `tsc --noEmit`；要么改 workflow，要么在合并 `dev → master` 时才检查，类型错误发现滞后。
2. **fork 的 `master` 落后上游 9 commits**
   - 说明并未定期 `sync fork`，长此以往偏移越大，未来合并冲突越难处理；理想应建立定期同步或自动 sync workflow。
3. **循环依赖 TODO 未解**
   - `handlers/test_summary.ts` 反向依赖 `cron.ts` 的 `handleScheduledSummary`，文件内注释自承"will cause a circular dependency, we need to fix this"。当前能跑只是因为 ES Module 的惰性求值掩盖了问题，应把共享逻辑下沉到独立模块。
4. **`botConfig.repoUrl` 仍指向上游**
   - fork 后没有把 README / config 里的仓库地址、部署指引改成本仓自己的，使用者按 README 跳转可能跑到上游去。
5. **`wrangler.toml` 提交了真实 D1 `database_id`**
   - `env.prod.d1_databases.database_id = 804695f9-...` 写在仓库里，虽然 D1 ID 不算高敏感，但生产资源标识入库一般不推荐；且 fork 出去后其他人需要改成自己的 ID，否则部署会失败。
6. **测试与源码路径不匹配**
   - `test/index.spec.ts` 从 `./../src/index` 导入 `processMarkdownLinks, toSuperscript`，但这两个函数实际定义在 `src/utils/markdown.ts`，`src/index.ts` 并未 re-export 它们。该测试用例在当前代码上**会编译失败**，CI 又不覆盖 `dev`，问题被掩盖。
7. **浅克隆 + refspec 收窄降低可观测性**
   - 本地看不到 `master` 与上游历史，做分支对比、bisect、追溯变更都受限；对新人上手不友好。
8. **单测覆盖面极小**
   - 仅一个 spec 文件测两个纯函数，对 `db.ts` / `ai.ts` / handlers 这些核心路径没有回归保护，重构风险高。
9. **图片以 base64 入库**
   - 把 JPEG 直接以 `data:image/jpeg;base64,...` 存进 D1 的 `content`，2 天后才清理；D1 单行大小与总配额都吃紧（README 里上游已出现 `Exceeded maximum DB size 500M`）。这种形式简单但容量风险高，更优解是 R2/KV 存图、DB 只存链接。

### 9.3 改进建议（速览）

- 把 `.github/workflows/format.yml` 的触发分支改为 `master` + `dev`，或干脆改为 `on: [push, pull_request]`。
- 定期 `git merge upstream/master` 保持 `master` 同步，或加一个 GitHub Action 自动 sync。
- 修复 `test_summary.ts` ↔ `cron.ts` 循环依赖：把 `handleScheduledSummary` 的核心抽到 `services/summary.ts`，让 `cron.ts` 与 `test_summary.ts` 都依赖它。
- 修正 `test/index.spec.ts` 的导入路径为 `../src/utils/markdown`，并让 CI 在 `dev` 上跑测试。
- 把 `wrangler.toml` 里的 `database_id` 改成占位符，真实 ID 通过 `wrangler.toml` 之外的 secret/CI 注入。
- 把 `botConfig.repoUrl` 与 README 中的部署链接改成当前 fork 的地址。
- 图片改走 R2，DB 只存对象 key，缓解 D1 容量压力。

---

> 文档生成依据：仓库当前工作树（`dev` 分支 `b7d87b9`）+ GitHub 仓库元数据（fork 关系、分支数、落后 commit 数）。如仓库后续有更新，请以最新代码为准。
