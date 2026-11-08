# orca-slack — 功能点清单

日期：2026-11-07。状态：**11-07 晚已按 `docs/feature-matrix.md` 的 64 条对齐**；下面表格是对齐前的草案，差异见文末「对齐后的改动」。

## 一句话

公司 runner（跑着 `orca serve` 的那台机）上的一个常驻进程：**Slack 线程 ⇄ Orca orchestration**。
一线程 = 一任务 = 一 worktree = 一 PR。Slack 是入口和回报面，Orca 是执行面，PR 是交付面。
不替代 Linear/Jira，不做看板，不做 agent 之间互相叫醒。

参考实现：`dnhynk/dev-infra` `apps/orca-slack-bridge`（MIT，TypeScript，46k 行 src / 52k 行测试，Windows only，韩文注释）。
代码审读（2026-11-07，gpt-6.1-sol，scratchpad `09-code-dev-infra-bridge.md`）核实：

- **纯出口**。没有任何 `worker-start` / `worktree create` / `agent launch` 调用；普通 Slack 消息直接丢弃，只有决策门按钮、
  门的"自由输入"modal、终端提示卡三种入口（`src/cli.ts:2182`）。入口和线程→worker 派发必须自己写。
- **macOS 跑不起来**。启动时的快照租约 `platform !== 'linux'` 直接抛错（`src/operational/status-capability.ts:1271`），
  owner 锁要 `/usr/bin/flock`，channel 默认 Windows 命名管道。不是加个 launchd 包一层就行。
- 本地实测：`pnpm install` 过，`tsc` 过，vitest **84 失败 / 1705 通过 / 30 跳过**（Node 25.8，包要求 ≥26；失败多为平台围栏）。
- god files：`store/sqlite.ts` 8281 行、`cli.ts` 2673、`orca/client.ts` 1550、`slack/socket.ts` 1008。**不整文件抄**。
- 真正值得拿的是它对 `orca orchestration` 的实测结论（见下"Orca CLI 实测"）和几个小文件：`orca/envelope.ts`（71 行）、
  `orca/coerce.ts`（110）、`gate/actions.ts`（56）、`gate/render.ts`（198）、`operational/health.ts`（156）。
  Socket Mode 用 `@slack/bolt`，不抄它 1008 行的 socket.ts。

### Orca CLI 实测（来自 dnhynk 注释，M=他实测，C=他实现的契约）

1. M/C `check` 默认就消费并标记 delivery，`--ack` 只是确认；观察者**别用 `check`**，用 `inbox`（`src/orca/client.ts:1330`）。→ 我们的回报循环是唯一消费者，用 `check --wait`；任何只读查询走 `inbox`/`worker-list`。
2. M `inbox` 无分页；`--terminal run:<id>` 过滤收件人；563 条 worker_done 全走这条路（`:1349`）。
3. M `worker_done` 的 `body` 是三句话，`payload` 是 **JSON 字串**（taskId/dispatchId/outcome/filesModified），`thread_id=null`（`:1243`）。→ 解析要 `JSON.parse(payload)`。
4. M `question` 自成线程；回答是同 `thread_id` 的 status 行；**没有直接读 question 的命令**（`:1445`）。
5. M `deps/options/result` 可能是 JSON 字串而不是对象（`coerce.ts:4`）；时间戳混用 naive SQL 和 ISO 毫秒（`client.ts:255`）。
6. M `worker-list` 含历史资源，`agentWait` 只有 `worker-show` 给；只查活跃 dispatch（`:838`）。Orca 1.4.216 起每页 100 条（`:845`）。
7. C `gate-resolve --from <coordinator> --id <gate> --resolution <text> --retry-request <uuid> --json`（`:782`）。
8. M `terminal send` 传原始转义字节，Enter=13；Codex 的 `--interrupt` 会杀掉空闲 TUI，所以叫醒用 `--enter`（`terminal/client.ts:9`）。
9. 设计教训：Slack 3 秒 ACK 先于任何 Orca 调用；先落盘再叫醒；叫醒只带 id 不带内容；不确定就显示 unknown 不编成功。

### 第二个参照：`pawel-kotowski/slack-agent`（Python 单文件 2,222 行，无 LICENSE → 只学设计不抄代码）

审读 2026-11-07（gpt-6.1-sol，scratchpad `10-code-slack-agent.md`）。它是真正的**入口**桥：Slack → `orca worktree create` →
`orca terminal create --command claude …`，任务文本走 Claude 的 argv，后续消息走 `terminal send`——完全不用 `orca orchestration`，
生命周期全靠终端文本，这是我们不学的地方。但下面这些是它一周真机跑出来的教训，**直接改我们的 P0/P1**：

| 教训 | 出处 | 对我们的改动 |
|---|---|---|
| 一条消息同时触发 `app_mention` 和 `message.channels`，顺序不定、event_id 不同 | `NOTES.md:110-113` | P0 行 3：去重键加 `UNIQUE(channel, ts)`，不能只靠 event_id（已发给 P0 worker） |
| "没人看终端"：agent 的提问工具（Claude `AskUserQuestion`）会渲染在终端里；要用 `--disallowedTools=AskUserQuestion` 关掉 | `NOTES.md:18-26` | P0 行 1：spec 头部写明"别用交互提问工具，用 orchestration question" |
| 按钮答案回给 agent 时**带上原问题**，多轮之后才看得懂 | `NOTES.md:22-26` | P0 行 6：`reply --body` 内容 = `<user> chose "A" in answer to "<question>"` |
| 审批疲劳：一周 17 次审批 15 次放行，只有 4 次是真的（PR merge/close）；`--force-with-lease`、`rm -rf` 构建产物、heredoc 里的文字全是误报；`gh api …/merge-async` 正则漏掉 | `NOTES.md:27-38` | P1 行 17：门要 shlex 拆命令、heredoc 剔掉、看 `bash -c`/`eval`/`$(…)`、`cd` 跟踪；只拦不可逆的；显示 agent 的 Bash description 当理由；"本任务内同类都批" |
| SDK 重连在机器睡眠后会"活着但不通" | `NOTES.md:129-136`；`slack-agent:1838-1848` | P0 行 11：每 30 s 探一次连通性，>90 s 不通就 exit 让 launchd 重启，别信 SDK 的 reconnect |
| `starting` 期间的跟进消息被丢弃 | `slack-agent:1491-1492` | P0 行 4：worker 没就绪前的跟进进队列，就绪后补发 |
| 关闭任务时若有未推送提交或脏文件，**保留 worktree** 并告知 | `slack-agent:1676-1683` | P0 行 7/9：`worker-release` 前查 `git status --porcelain` + `@{upstream}..HEAD`，有东西就不删 worktree |
| `orca worktree create --setup skip` 返回后 seeded tab 还会晚一步出现 | `NOTES.md:66-72` | 我们走 `worker-start` 不碰这个；记着就行 |
| Slack app 用 **manifest.json** 发布，不手点 scope | `manifest.example.json` | `docs/setup.md` 改成给 manifest 文件 |
| Orca 包装层忽略 exit code、接受任意 JSON | `slack-agent:481-486` | 反例：我们的 `orca.ts` 对 `ok:false` 和非零 exit 必须抛 |

它有、我们明确不做的：10 秒 diff watcher 贴 Code tab、Tailscale Funnel 实时面板、每 workspace 一个 PostgreSQL 的 app 预览、
wake 分类器（LLM 判断陌生人消息能不能叫醒 agent）、transcript 复活。

## 术语

- **dispatch**：Orca 的一次任务尝试（`ctx_…`）。线程状态表的主键之一。
- **角色**：协调者路由表的一行（agent, model, effort, skill）。桥只读它，不自己定义人设。
- **回报**：worker 通过 `orca orchestration send` 发出的 `worker_done / question / escalation / merge_ready / decision_gate / heartbeat`。

---

## P0 — 第一版（一个人、一个公司、一个 Slack app 能跑）

| # | 功能 | 触发 | 行为 | Orca 命令 | Slack 面 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 派发 | 配置频道里 `@bot <任务>`（新消息或线程首条） | 路由 `channel → repo`（yaml）；选默认角色；开新 worktree 起 worker | `orca orchestration worker-start --spec <text> --worktree new --repo … --agent … --model … --effort …` | ≤1 s 加 👀；回帖 `dispatch ctx_… · worktree …` | 写入 threads 表 |
| 2 | 线程状态 | 每次派发 | `thread_ts → {run, task, dispatch, worktree, repo, requester, status, created_at}` | — | — | SQLite 单文件；进程重启不丢 |
| 3 | 幂等 | Slack 重发 / 重连；同一消息的 `app_mention` + `message` 双事件 | 同一 `event_id` 只处理一次；同一 `(channel, ts)` 只派一次 | — | — | events 表 + threads 上 `UNIQUE(channel, ts)` |
| 4 | 跟进 | 线程内后续消息 | 有未答 question → `reply`；否则作为高优先级 status 发给 dispatch；worker 未就绪时先排队 | `orca orchestration reply --id …` / `send --to <dispatch> --type status --priority high` | 加 ✅ 表示已送达（送达≠已读，文案要写清） | — |
| 5 | 回报循环 | 进程内**唯一**消费者 | `check --wait --types worker_done,question,escalation,merge_ready,decision_gate` → 按 dispatch 找线程 → 回帖 → `--ack` | `orca orchestration check --wait --ack … --json` | 见 6–8 | 处理完再 ack；崩溃后重放 |
| 6 | 提问卡 | worker `question` | ≤5 个选项按钮 + "自由输入"；点按钮或在线程回复 → `reply` | `reply --id <message_id> --body …` | Block Kit 按钮；点过后卡变灰、显示谁答的 | pending_questions 表 |
| 7 | 完成 | `worker_done --outcome succeeded` | 三句摘要 + PR 链接 + receipt 路径；✅ 反应；释放 worker | `worker-release --dispatch …` | 回帖 | status=done |
| 8 | 失败 | `worker_done --outcome failed` / `escalation` | ❌ + 摘要 + 终端尾 40 行 | `worker-read --dispatch … --source terminal` | 回帖 | status=failed；**不**自动重试 |
| 9 | 停止 | 线程里 ⏹ 按钮或 `!stop` | 停 worker，释放，回帖 | `worker-stop` → `worker-release` | 按钮 | status=stopped |
| 10 | 权限 | 任何入口 | 只有配置里的 user id 能派发/停止/答题；其他人收到一句拒绝 | — | ephemeral 回复 | 配置文件 |
| 11 | 运维 | 进程生命周期 | launchd plist；heartbeat 文件（给 `orca_automations` watchdog 看）；每 30 s 探 Socket 连通，>90 s 不通就退出让 launchd 重启；fatal → 发到运维频道 | — | #ops 频道 | 日志按大小滚动 |
| 12 | 凭据 | 启动 | token 从 macOS keychain（现有 `slack-gateway` / `bot-token`）读，配置文件只放频道/用户 id；日志永不打 token | — | — | — |

**P0 验收（手动，一次跑通）**
1. 在测试频道 @bot "给 repo X 的 README 加一行 hello" → 1 s 内 👀 → ≤2 min 回帖 dispatch id → 之后线程出现 PR 链接。
2. 跑着的任务线程里 `!stop` → `worker-list` 显示该 dispatch 已停。
3. 任务运行中杀掉桥进程再起 → 完成回报仍到线程（状态落盘 + check 重放）。
4. 非白名单用户 @bot → 收到拒绝，`worker-list` 无新 dispatch。

---

## P1 — 给团队用之前

| # | 功能 | 说明 | 抄哪里 |
|---|---|---|---|
| 13 | 决策门卡 | coordinator `decision_gate` → 一个选项一个按钮 → `orca orchestration gate-resolve` → 叫醒 coordinator | dnhynk `gate/actions.ts`、`gate/render.ts` 抄；`gate/resolve.ts` 只参考（先落盘再 resolve 再叫醒的状态机） |
| 14 | 状态卡 + 限频 | 每线程**一条**状态消息，heartbeat/status 更新靠 `chat.update` 改它，不刷屏；里程碑 ≤1 条/分钟 | dnhynk `run/publish.ts` 的内容指纹（没变不发）只参考；facumoyano 限频 |
| 15 | 角色选择 | `@bot research: …` / `code:` / `review:` 前缀选路由表的行；表从协调者的配置仓库读，不在桥里复制 | — |
| 16 | 运行控制 | 硬 deadline（默认 90 min）到点 `worker-stop` 并回帖；重复任务检测（同一 issue URL 已在别的线程 → 指过去） | facumoyano 重复检测 |
| 17 | 危险命令审批 | agent 的 hook（Claude PreToolUse / Codex approval）把 force-push、`rm -rf`、`git reset --hard` 等打到 Slack 按钮，只有 owner 能批 | pawel-kotowski 的 gate；需每家 agent 分别接 |
| 18 | 身份 | PR 作者是 bot 账号，PR body 带线程链接 + 发起人；tracker 评论只在需要人动手时写，走现有 `orca-linear` / `orca-jira` skill | — |
| 19 | 一公司一进程 | 两家公司 = 两个 Slack app + 两份配置 + 两台 runner。**不**做一进程多租户 | 反例：pawel 的多公司单进程 |

## P2 — 以后

| # | 功能 | 说明 |
|---|---|---|
| 20 | Lark 入口 | 同一核心，第二个 adapter（公司 Z 用）。入口层从第一天就隔成 `adapter` 接口，别把 Slack 类型漏进核心 |
| 21 | 接管 | 线程里 `!takeover` → 回一行本地打开该 worktree 的 `orca` 命令 |
| 22 | 评审链 | `worker_done` 后自动起不同模型的 evaluator——这属于协调者工作流的 coordinator 链，**不**在桥里做；桥只派第一跳 |

## 不做

- 看板 / 自己的 tracker / 跑记录数据库（run 记录是 Orca 的 receipt + 线程本身）
- PR 状态卡、checks 汇总（GitHub 自带的 Slack app 够用；dnhynk 的 `github/*`、`digest/*` 不抄）
- 桥内 LLM 摘要（dnhynk 的 `summarize/openai`）；摘要由 worker 的 `worker_done` 三句话给
- Web UI、Windows 支持、agent 互相叫醒

## 技术选择（待拍板）

- **TypeScript**，Node ≥22，`@slack/bolt`（Socket Mode）+ `node:sqlite`，单进程，目标 ≤1500 行。
  选 TS 是为了直接抄 dnhynk 的 MIT 模块；代价是和 Python 的 `orca_automations` 两套运行时。
  替代：Python + `slack_bolt`，复用 `orca_automations/bin/orca-jobs` 的 `slack_post` 和 keychain 读取，但 dnhynk 的代码只能看不能抄。
- 仓库：`~/dev/orca-slack`，独立 repo（不是 `orca_automations` 子目录——两者生命周期不同，桥要常驻，jobs 是 cron）。
- 测试：核心纯函数（路由、消息→命令映射、回报→Block Kit）单测；Orca CLI 和 Slack 都 mock 成可注入的接口。

## 待所有者决定

1. TS 还是 Python？（上面默认 TS）
2. 第一个试点用哪个 Slack workspace / 频道，哪个 repo 做 P0 验收任务？（默认：一个测试频道 + 一个个人 repo）
3. GitHub 远端叫什么、放哪个 org？（本地先建，不推）

## 对齐后的改动（2026-11-07，来源 `docs/feature-matrix.md` §对齐结果）

P0 变化：
- 2.2 → **一线程多 dispatch 复用 worktree**：线程完成后再 @ = 同 worktree 新开 dispatch；store 从 `threads` 1:1 改成 `threads 1:N dispatches` + 当前 dispatch 指针。
- 6.4 → **P0**：先做 git 侧护栏（worktree `pre-push` hook 拦 force / 推 main + 仓库 branch protection），对所有 agent 生效。
- 6.6 → 门的 hooks/settings 放 worktree 外（runner 状态目录，`--settings` 传入），agent 改 worktree 里的东西不影响门。
- 5.2 → release 不删 worktree；14 天空闲后 `worktree rm`，删前把 transcript 路径 + receipt 写进线程记录。
- 11.6 → **桥统一转发**，worker 只发 orchestration 消息，不直贴 Slack。
- 验收加一条：端到端延迟测量（Slack 消息 → worker 收到；worker_done → 线程出现）。

P1 变化：1.6 LLM 判意图 + eval（先用 P0 收样本）· 1.7 owner DM 入口 · 5.7 14 天空闲关闭 · 6.2 非白名单 hold 开关（默认关）· 7.3 并发不限。

先不定：1.4 ticket 当任务源（取决于 1.8）· 6.6 · 7.2 成本上限 · **1.8 外环需求代理**（新）。

原则：两环（外环聊需求 → Linear ticket；内环由协调者和执行者工作流完成开发与验证）· 一个频道 + 模型按 mapping 选 repo · 多厂商按协调者路由表 · SQLite 不换 Postgres · 不另建 queue · launchd 不换 Docker · PR 暂用本人 gh 身份。

## 2026-11-08 对齐：worktree 生命周期与架构

本节覆盖上文冲突的内容（"一线程 = 一 worktree"、5.7 的 14 天空闲关闭、#19 一公司一进程）。

> 已被 `docs/brief.md` 取代的结论：一线程可以有多个 worktree 和 PR；Spec 和实现合并为 lead 角色；纯提问使用临时 worktree。冲突时以 brief 为准。

- **范围**：只考虑同一家公司，不设计多公司隔离；#19 和多租户问题搁置。
- **运行位置**：专门的机器长期运行。
- **一需求一 worktree**：一个需求 = 一个线程 = 一个 worktree = 一个 PR；10 个需求就是 10 个 worktree。同一需求的跟进在自己的 worktree 里开新 session。纯提问不建 worktree。
- **不做** per-repo quick-lane，也不在 repo 主 checkout 里写代码。
- **Router 不对话**：只在线程开始时跑一次分类，输出 repo / 档位 / 角色 / 置信度。
- **上下文共享靠 Bridge**：Bridge 保存线程全文；启动任何 worker 时写进 spec，后续消息继续转发。
- **Spec 阶段就建 worktree**：Spec worker 和实现 worker 用同一个 worktree、不同 dispatch，交接物是线程全文 + ticket + worktree 文件。
- **一个 Slack app 对应一个 Bridge 实例**：原因是 `check` 消费消息，不能有两个消费者；这不限制 worker 数量。

### Worktree 清理

| 情况 | 触发 | 行为 |
|---|---|---|
| 已交付 | PR 合并后，状态卡上点"已验证，清理" | 检查通过后删除 |
| 空 worktree | 每日定时扫描，**无改动**且超过 N 天 | 在 Slack 提醒 owner，给"清理 / 保留"按钮；点"清理"且检查通过后才删除，**绝不静默删除** |
| 有改动但没走完 | 空闲 14 天 | 只提醒，不删 |

**无改动**必须同时满足：`git status --porcelain` 为空；相对 base 没有新提交；没有关联 PR；没有运行中的 worker；没有未回答的 question。

删除前把 transcript 路径和 receipt 写进线程记录；删除不使用 force。任一条件拿不准就视为有改动。

**提醒**：每天最多一条汇总消息，只在出现新的待清理项时发送。每项写明需求名、线程链接、闲置天数、为什么判定为无改动，并带"清理 / 保留"按钮；另有"全部清理"。点"保留"的项重新开始计算 N 天。没有人回应时不删除。

**限制**：无改动 worktree 的数量设上限，达到上限后新的 Spec 请求要先提示清理，并列出待清理项。上限只管这一类，不改变 7.3 的"并发不限"。

默认值（可配置）：N = 3 天；上限 = 20 个。
