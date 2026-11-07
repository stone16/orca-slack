# orca-slack — 功能点清单

日期：2026-11-07。状态：草案，待 Stometa 砍。

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

## 术语

- **dispatch**：Orca 的一次任务尝试（`ctx_…`）。线程状态表的主键之一。
- **角色**：`stometa-mode/SKILL.md` 的路由表一行（agent, model, effort, skill）。桥只读它，不自己定义人设。
- **回报**：worker 通过 `orca orchestration send` 发出的 `worker_done / question / escalation / merge_ready / decision_gate / heartbeat`。

---

## P0 — 第一版（一个人、一个公司、一个 Slack app 能跑）

| # | 功能 | 触发 | 行为 | Orca 命令 | Slack 面 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 派发 | 配置频道里 `@bot <任务>`（新消息或线程首条） | 路由 `channel → repo`（yaml）；选默认角色；开新 worktree 起 worker | `orca orchestration worker-start --spec <text> --worktree new --repo … --agent … --model … --effort …` | ≤1 s 加 👀；回帖 `dispatch ctx_… · worktree …` | 写入 threads 表 |
| 2 | 线程状态 | 每次派发 | `thread_ts → {run, task, dispatch, worktree, repo, requester, status, created_at}` | — | — | SQLite 单文件；进程重启不丢 |
| 3 | 幂等 | Slack 重发 / 重连 | 同一 `event_id` 或同一 `message ts` 只派一次 | — | — | events 表 |
| 4 | 跟进 | 线程内后续消息 | 有未答 question → `reply`；否则作为高优先级 status 发给 dispatch | `orca orchestration reply --id …` / `send --to <dispatch> --type status --priority high` | 加 ✅ 表示已送达（送达≠已读，文案要写清） | — |
| 5 | 回报循环 | 进程内**唯一**消费者 | `check --wait --types worker_done,question,escalation,merge_ready,decision_gate` → 按 dispatch 找线程 → 回帖 → `--ack` | `orca orchestration check --wait --ack … --json` | 见 6–8 | 处理完再 ack；崩溃后重放 |
| 6 | 提问卡 | worker `question` | ≤5 个选项按钮 + "自由输入"；点按钮或在线程回复 → `reply` | `reply --id <message_id> --body …` | Block Kit 按钮；点过后卡变灰、显示谁答的 | pending_questions 表 |
| 7 | 完成 | `worker_done --outcome succeeded` | 三句摘要 + PR 链接 + receipt 路径；✅ 反应；释放 worker | `worker-release --dispatch …` | 回帖 | status=done |
| 8 | 失败 | `worker_done --outcome failed` / `escalation` | ❌ + 摘要 + 终端尾 40 行 | `worker-read --dispatch … --source terminal` | 回帖 | status=failed；**不**自动重试 |
| 9 | 停止 | 线程里 ⏹ 按钮或 `!stop` | 停 worker，释放，回帖 | `worker-stop` → `worker-release` | 按钮 | status=stopped |
| 10 | 权限 | 任何入口 | 只有配置里的 user id 能派发/停止/答题；其他人收到一句拒绝 | — | ephemeral 回复 | 配置文件 |
| 11 | 运维 | 进程生命周期 | launchd plist；heartbeat 文件（给 `orca_automations` watchdog 看）；Socket Mode 自动重连；fatal → 发到运维频道 | — | #ops 频道 | 日志按大小滚动 |
| 12 | 凭据 | 启动 | token 从 macOS keychain（现有 `slack-gateway` / `bot-token`）读，配置文件只放频道/用户 id；日志永不打 token | — | — | — |

> impl note: P0 #8：当前 Orca 只释放已结算 worker，escalation 仍活跃时 release 可能返回 retained，桥不自动 stop，仍可显式 !stop/按钮停止；chat worker 无 terminal source 时显示“终端输出不可用”。

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
| 15 | 角色选择 | `@bot research: …` / `code:` / `review:` 前缀选路由表的行；表从 `stometa-mode` 仓库读，不在桥里复制 | — |
| 16 | 运行控制 | 硬 deadline（默认 90 min）到点 `worker-stop` 并回帖；重复任务检测（同一 issue URL 已在别的线程 → 指过去） | facumoyano 重复检测 |
| 17 | 危险命令审批 | agent 的 hook（Claude PreToolUse / Codex approval）把 force-push、`rm -rf`、`git reset --hard` 等打到 Slack 按钮，只有 owner 能批 | pawel-kotowski 的 gate；需每家 agent 分别接 |
| 18 | 身份 | PR 作者是 bot 账号，PR body 带线程链接 + 发起人；tracker 评论只在需要人动手时写，走现有 `orca-linear` / `orca-jira` skill | — |
| 19 | 一公司一进程 | 两家公司 = 两个 Slack app + 两份配置 + 两台 runner。**不**做一进程多租户 | 反例：pawel 的多公司单进程 |

## P2 — 以后

| # | 功能 | 说明 |
|---|---|---|
| 20 | Lark 入口 | 同一核心，第二个 adapter（Zentastone 用）。入口层从第一天就隔成 `adapter` 接口，别把 Slack 类型漏进核心 |
| 21 | 接管 | 线程里 `!takeover` → 回一行本地打开该 worktree 的 `orca` 命令 |
| 22 | 评审链 | `worker_done` 后自动起不同模型的 evaluator——这属于 `stometa-mode` 的 coordinator 链，**不**在桥里做；桥只派第一跳 |

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

## 待 Stometa 决定

1. TS 还是 Python？（上面默认 TS）
2. 第一个试点用哪个 Slack workspace / 频道，哪个 repo 做 P0 验收任务？（默认：#leilei-orca + 一个个人 repo）
3. GitHub 远端叫什么、放哪个 org？（本地先建，不推）
