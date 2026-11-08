# 功能点矩阵：我们要什么 × 三个参照各做了什么

日期：2026-11-07。这是**决定清单**，不是实现计划。"我们"一列是提案，待 Stometa 逐行拍板；带 ❓ 的是我拿不准、需要他答的。

参照仓库（代码审读，不是 README）：

| 列名 | 仓库 | 形态 | 许可 | 审读 |
|---|---|---|---|---|
| **D** | `dnhynk/dev-infra` `apps/orca-slack-bridge` @13a8163 | TS 46.7k 行 src，Windows only，**纯出口** | MIT | scratchpad `09-code-dev-infra-bridge.md` |
| **P** | `pawel-kotowski/slack-agent` @8bb8e0a | Python 单文件 2,222 行，入口桥，终端文本驱动 | 无 | `10-code-slack-agent.md` |
| **F** | `facumoyano/slack-bot`（Alfred）@27e9c02 | TS 4,832 行 / 24 文件，入口桥，**走 orchestration** | 无 | `11-code-facumoyano-slack-bot.md`（本地 `npm test` 294/297，3 个失败是 macOS 路径） |

图例：✅ 有 · ◐ 部分/变体 · ✗ 无 · — 不适用。引用是 `文件:行`。

## 1. 入口与路由

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 1.1 | 频道里 @bot 开任务 | **P0** | ✗ 普通消息直接丢（`cli.ts:2182`） | ✅ @mention 或 DM，owner 才行（`slack-agent:1147-1209`） | ✅ 公开/私有频道 @；owner DM；GitHub issue URL 或 `#123`（`slack.ts:50,77`）|
| 1.2 | 线程内后续消息 = 跟进 | **P0** | ✗ | ✅ `terminal send --text` + `--enter`（`:1601-1603`） | ✅ `orchestration send --to dispatch:…`；有未答问题则 `reply`（`bot.ts:816`）|
| 1.3 | 频道 → repo 静态映射 | **P0** | — （它映射 repo → 频道，反向） | ◐ 一个配置一个 repo（`config.example.json`） | ✅ 频道默认 repo 或本地文件夹；没默认时 **Claude Haiku 推断 repo**（`resolve.ts:36`）|
| 1.4 | GitHub issue / Linear / Jira 链接作为任务来源 | **先不定**（11-07：Linear 走现有 orca-linear skill 就够；见 2.3 两环——Linear ticket 是外环的产物） | ✗ | ✗ | ✅ issue 线程→分支→worktree；PR body `Closes #`（`jobs.ts:133`，`spec.ts:219`）|
| 1.5 | 角色前缀（`research:` / `code:` / `review:`）选路由表的行 | **P1** | ✗ | ✗ | ◐ 有模式：quick ask（只读无 worker）/ investigate / review / plan / change（`ask.ts:32`，`jobs.ts:60`），但靠 LLM 判不靠前缀 |
| 1.6 | LLM 做意图/路由判断（而不是规则） | **P1**（11-07 他选 LLM 判意图 + eval；我的保留：先用 P0 规则版收集路由样本，再上 LLM + eval） | ✗ | ◐ 有 LLM "wake 分类器"判断陌生人消息能不能叫醒 agent（`:1503-1595`） | ✅ TypeSafe `jev-latest` 意图分类，5 s 超时，阈值 .5/.8，没 key 就默认 change（`route.ts:23-86`）；`eval/` 校准阈值 |
| 1.7 | DM 私聊入口 | **P1** owner 可 DM 查状态 / 指挥已有任务（11-07） | ✗ | ✅ | ✅ owner DM 可私下查/指挥已有任务（`bot.ts:108`）|

## 2. 执行派发

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 2.1 | 走 `orca orchestration`（Run/Task/Dispatch 有生命周期权威） | **P0** | ✅ 读：`run-list/task-list/worker-list/inbox`；写：`gate-resolve`（`orca/client.ts:68-1401`） | ✗ 完全不用 | ✅ `run-use`/`run-create` + `worker-start --spec --worktree new-top-level --repo id:… --agent claude --timeout-ms 600000`；跟进 `send`，答题 `reply`，完成 `worker-release`（`orca.ts:31-259`）|
| 2.2 | 一任务一 worktree；**一线程多 dispatch 复用 worktree**（11-07 定） | **P0** | — 不派发 | ✅ `orca worktree create --setup skip`（`:1436-1465`） | ✅ `new-top-level`；跟进复用 worktree 但**每次跟进新开 dispatch**（`jobs.ts:48,133`）|
| 2.3 | 任务文本如何到 agent | **P0** spec + 头部（请求人、线程链接、回报规则） | — | argv `$(cat prompt)` + `--append-system-prompt-file`（`:1420-1465`） | ✅ `--spec`；spec 里要求 `pstack:poteto-mode`、里程碑 status、报告文件、worker_done（`spec.ts:93-166`）|
| 2.4 | 多厂商 agent（Claude / Codex / Grok / Argon）按路由表 | **P0** 配置里 agent/model/effort | ◐ Claude + Codex coordinator（叫醒方式不同） | ✗ Claude only（门、helper 全绑 Claude hooks） | ✗ Claude only，硬编码 `--agent claude`（`orca.ts:69`）|
| 2.5 | 同一 issue 已在别的线程 → 指过去 | **P1** | ✗ | ✗ | ✅ 最多列 3 个前例带摘要，只警告不阻止（`antecedents.ts:20`）|
| 2.6 | 评审链（worker_done 后起不同模型 evaluator） | **P2，且在 stometa-mode 不在桥** | ✗ | ✗ | ✗ |

## 3. 状态与幂等

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 3.1 | 线程状态持久化（重启不丢） | **P0** SQLite | ✅ SQLite 30+ 表（`store/schema.ts`） | ◐ JSON 文件原子替换（`:151-160`） | ✅ `data/state.json` 原子写：jobs、run/dispatch/worktree/session id、待批、DM 关联（`store.ts:7`，`jobs.ts:70`）|
| 3.2 | Slack 事件去重（event_id） | **P0** | ✅ `pr_thread_event(dedupe_key)` | ◐ 内存 `channel:ts`，重启即忘（`:1094,1164-1184`） | ✗ **没有** event_id / channel+ts 账本；只记 Orca 消息 id 上限 1000（`jobs.ts:477`）|
| 3.3 | 同一消息双事件（app_mention + message）只派一次 | **P0** `UNIQUE(channel, ts)` | — | ✅ 作者踩过（`NOTES.md:110-113`） | ◐ 带 @ 的消息跳过 message handler（`slack.ts:69,80`），靠 handler 分流不靠账本 |
| 3.4 | 回报消费者唯一（`check` 会消费，观察用 `inbox`） | **P0** | ✅ 他实测出来的（`orca/client.ts:1330`） | — | ✅ 单进程 inbox 循环，出错 5 s 重试（`inbox.ts:154-166`）|
| 3.5 | 处理完再 ack；崩溃重放可接受 | **P0** | ✅ 先落盘再 ack（`gate/action-handler.ts:523`） | — | ✅ 明写"先贴再记，崩溃最多重贴一次绝不丢"（`inbox.ts:110`）|

## 4. 交互：跟进、提问、里程碑

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 4.1 | agent 提问 → Slack 按钮 | **P0** ≤5 按钮 + 自由输入 | ✅ Gate 卡，一选项一按钮 + 自由输入 modal（`gate/render.ts`，`direct-input-handler.ts`） | ✅ ≤10 按钮，**不阻塞** agent（`:2086-2129`） | ✅ 1–5 按钮否则文字列表，自由输入总可；owner 或请求人答（`blocks.ts:75`，`bot.ts:795`）|
| 4.2 | 答案回 agent 时带原问题 | **P0**（P 的教训） | ◐ | ✅ `<name> chose "A" in answer to "…"`（`NOTES.md:22-26`） | ✗ reply 只带答案；Slack 卡上保留问题（`bot.ts:800`）|
| 4.3 | 跟进送达后 ✅（送达≠已读，文案写清） | **P0** | — | ◐ | ✅ 👀 / ✅ 反应（`bot.ts:833`）|
| 4.4 | worker 未就绪时跟进排队不丢 | **P0** | — | ✗ `starting` 期间丢弃（`:1491-1492`） | ◐ 已 settle 的线程跟进会 `claude --resume` 重开（`bot.ts:841`）|
| 4.5 | 每线程**一条**状态卡 `chat.update`，不刷屏 | **P1** | ✅ Run 卡内容指纹，没变不发（`run/publish.ts:207`） | ◐ Slack "stream"，10 分钟过期要续（`NOTES.md:108-173`） | ✗ 新消息不是编辑；只有起始/提问卡会改掉按钮（`bot.ts:413,806`）|
| 4.6 | 里程碑限频 | **P1** ≤1/分钟 | ✅ 指纹去重 | ✗ 实时 `step` | ✅ ⏳ ≤1/分钟，中间只留最新一条，300 字截断（`jobs.ts:450`，`inbox.ts:147`）|
| 4.7 | 10 秒 diff watcher 贴改动 | **不做** | ✗ | ✅（`:1718-1749`） | ✗ |
| 4.8 | 实时面板 / 预览环境（Tailscale Funnel、每 workspace 一个 DB） | **不做** | ✗ | ✅（`:823-957`） | ✗ |

## 5. 结束：完成、失败、停止、清理

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 5.1 | 完成 = 三句摘要 + PR 链接 + receipt 路径 + ✅ | **P0** | ✅ PR 卡（但来源是 GitHub 轮询不是 worker_done） | ✅ `finish` 发摘要并归档（`:2118-2131`） | ✅ 报告 + PR 按钮，找不到就按分支查（`jobs.ts:396`，`blocks.ts:153`）|
| 5.2 | 完成后 `worker-release` | **P0** | — | — 关终端（`:1636-1699`） | ✅ `worker-release --dispatch`（`orca.ts:259`）|
| 5.3 | 关闭时若有脏文件/未推送提交 → **保留 worktree** 并告知 | **P0**（P 的教训） | — | ✅（`:1676-1683`） | ◐ 桥从不删 worktree，交给 Orca（`README.md:138`）|
| 5.4 | 失败 = ❌ + 摘要 + 终端尾 40 行 | **P0** | ◐ Run 卡显示 unknown/degraded 不编成功（`run/liveness.ts:110`） | ◐ T3 后端才有失败通知（`:1752-1771`） | ◐ 起错贴出来、escalation 转发；无终端尾（`bot.ts:777`）|
| 5.5 | 不自动重试 | **P0** | ✅ | ✅ | ◐ resume 失败等 60/120 s 再退回全新会话（`bot.ts:603-650`）|
| 5.6 | 停止：⏹ 按钮 / `!stop` → `worker-stop` + release | **P0** | ✗ | ◐ 给终端发 Escape，workspace 可恢复（`:1636-1648`） | ✅ `Parar`/`!parar` → `worker-stop`，要求回执 `stopped`，保留分支；owner 可"换 repo"重派（`orca.ts:154`，`bot.ts:376,738`）|
| 5.7 | 空闲线程自动关闭 | **P1** 14 天（11-07） | ✗ | ✅（`:1701-1713`） | ✗ |
| 5.8 | 已关线程恢复 Claude transcript | **不做** | ✗ | ✅（`:1211-1229`） | ✗ |

## 6. 安全：权限、危险命令、决策门

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 6.1 | 白名单：谁能派发/跟进/答题/停止 | **P0** | ✅ owner 列表（`config.example.json`） | ✅ owners / wakers / channels 三层（`:218-223,1503-1505`） | ✅ owners 直跑；审批名单成员的请求 DM owner 批，先到先得，24 h 过期（`approvals.ts:35`）|
| 6.2 | 非白名单人的消息 → 需 owner 批准才叫醒 agent | **P1** 做开关，默认关（11-07） | ✗ | ✅ "hold unsafe non-owner messages"（`:1503-1541`） | ✅ 同上；名单外的人 DM 直接忽略（`README.md:49-55`）|
| 6.3 | 危险命令审批门（PreToolUse → Slack 按钮） | **P1** | ✗ | ✅ shlex 拆命令、剔 heredoc、钻 `bash -c`、只拦不可逆、"同类都批"、30 分钟超时 fail-closed（`:286-433,1860-1892`） | ✗ resume 直接 `--dangerously-skip-permissions`（`bot.ts:647`）|
| 6.4 | 门对非 Claude agent 也生效 | **P0**（11-07 他升到 P0；我的方案：P0 先做 git 侧护栏——worktree pre-push hook 拦 force/main + 仓库 branch protection，对所有 agent 生效；Codex 逐命令门仍待设计） | — | ✗ Claude hooks only | — |
| 6.5 | coordinator 决策门 → 卡 → `gate-resolve` → 叫醒 | **P1** | ✅ 这是它的核心（`gate/*`） | ✗ | ✗ |
| 6.6 | agent 不能改自己的规则/hook/权限 | **先不定**（11-07 他问"为什么不能改"——答：不是禁改，是门不放在它能改的地方：hooks/settings 放 worktree 外，用 `--settings` 传入，像 P `:587-609`） | ✗ | ◐ 只是分类器 prompt，代码不强制（`:177-207`） | ✗ |

## 7. 运行控制

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 7.1 | 硬 deadline 到点停 | **P1** 90 min | ✗ | ◐ 只有审批 30 分钟超时 | ✗ 只有 worker-start 600 s 启动超时（`orca.ts:69`）|
| 7.2 | 成本上限 | **先不定**（11-07） | ✗ | ◐ 启动前 `usage_check` 看订阅额度（`:1374-1376`） | ✗ |
| 7.3 | 并发上限 | **不限**（11-07） | ◐ `capacity` 配置 | ✗ | ◐ 每个绑定目录同时一个请求，无全局上限（`jobs.ts:173`）|

## 8. 身份与 tracker

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 8.1 | PR 作者 = bot，body 带线程链接 + 发起人 | **P1** | ◐ PR body 里埋 run/task/dispatch id 做关联（`correlate/metadata.ts:56`） | ◐ 继承 runner 上登录的 `gh`（`README.md:86-88`） | ◐ 同样是宿主 `gh` 身份；spec 里记请求人 Slack id（`spec.ts:231`）|
| 8.2 | tracker 评论只在需要人动手时写 | **P1**（走现有 orca-linear/jira skill） | ✗ | ✗ | ◐ PR `Closes #`；review 评论要明确要求；无 Linear/Jira（`spec.ts:133,219`）|
| 8.3 | 不建自己的看板/tracker | **原则** | ✅ 没有 | ✅ 没有 | ✅ 没有 |

## 9. 运维与凭据

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 9.1 | 常驻方式 | **P0** launchd | Windows Task Scheduler | systemd | ◐ `start-in-orca.sh` 开 Orca 终端 → `setsid nohup node` 脱离 → 关终端；查重复进程；无 watchdog（`scripts/start-in-orca.sh:10-38`）|
| 9.2 | heartbeat 文件给外部 watchdog | **P0** | ✅ `daemon_health` 表 + 15/90 s（`operational/health.ts`） | ◐ | ✗ |
| 9.3 | Socket 连通探测，不信 SDK reconnect | **P0** 30 s 探 / 90 s 退出 | ✅ 自管重连 500–8000 ms（`slack/socket.ts:149`） | ✅ 30 s 探 / 90 s exec 重启（`:1838-1848`） | ✗ 全交给 Bolt（`slack.ts:145`）|
| 9.4 | fatal → 运维频道 | **P0** | ✅ 一次性 fatal ledger（`fatal-alert.ts:114`） | ◐ | ✗ 只写 `data/bot.log` |
| 9.5 | token 只从 keychain/env，日志不打 | **P0** | ✅ | ✅ macOS `security`（`:229-235`） | ◐ `.env` 文件（`main.ts:24`）|
| 9.6 | Slack app 用 manifest 文件发布 | **P1** | ✗ | ✅ `manifest.example.json` | ✅ `slack-manifest.yaml` |
| 9.7 | Orca CLI 包装层对非零 exit / `ok:false` 抛错 | **P0** | ✅ envelope + coerce（`orca/envelope.ts`） | ✗ 忽略 exit code（`:481-486`） | ◐ 读 `result.taskId/dispatchId`，stop 要求回执 `stopped`（`orca.ts:66,154`）|

## 10. 多租户、第二入口、接管

| # | 功能点 | 我们 | D | P | F |
|---|---|---|---|---|---|
| 10.1 | 一公司一进程一 Slack app 一 runner | **P1 原则** | — 单人 | ✅ 一配置一进程；注意 state_dir 用配置文件名，同名会撞（`NOTES.md:60-65`） | ✗ 单 token 对、单 store，无租户键（`main.ts:24`）|
| 10.2 | Lark/Feishu 第二入口（adapter 接口第一天就隔开） | **P2** | ✗ | ✗ | ✗ |
| 10.3 | `!takeover` 给出本地打开 worktree 的命令 | **P2** | ✗ | ◐ 终端来源的消息有约定（`:999-1002`） | ◐ worktree 保留，任何 Claude 会话可用它的 `slack-thread` skill 接着聊（`README.md:124`）|
| 10.4 | agent 自己迁线程到专用代码频道 | **不做** | ✗ | ✅ `open-channel`（`:1821-1825`） | ✗ |

## 11. 它们有、我们明确不做

PR/CI 状态卡与 digest（D `digest/*`、`github/*`——GitHub 自带 Slack app 够用）· 桥内 LLM 摘要（D `summarize/openai`）· diff watcher、Funnel 面板、预览环境（P）· transcript 复活（P）· 计划画布/评论 helper（P `:2191-2214`）· T3 后端（P）· Windows（D）· 文件收发 50 MiB/1 GiB（F `files.ts`）· 营销内容审批队列 `/contenido`（F `intake.ts`、`content.ts`）· 给其他 Claude 会话用的独立 Slack CLI skill（F `skills/slack-thread`——❓ 这个其实有点意思：worker 自己能往线程里贴，桥就不用转发 status）。

## 2026-11-07 对齐结果（Lavish 面，64/64 条）

改动 1 条：6.4 P1→P0。❓ 10 条全答：1.4 先不定 · 1.6 LLM+eval · 1.7 要 DM · 5.7 14 天 · 6.2 P1 开关默认关 · 6.6 先不定 · 7.2 先不定 · 7.3 不限 · 11.6 **桥统一转发** · 11.7 **一线程多 dispatch 复用 worktree**。

他的批注里定下来的原则：

- **两环**（2.3）：外环 = Slack 线程里把需求聊清楚 → 产物是一张 Linear ticket；内环 = `stometa-mode` / `poteto-mode` 做开发和验证。桥派的是内环；外环需要一个"需求代理"角色——**这是清单里还没有的一行**，见下。
- 入口不要很多频道（1.3）：一个频道，由模型按 mapping 判断上下文属于哪个 repo（和 1.6 一致；F 的 Haiku 推断 + 置信度阈值 + 低置信度弹确认按钮）。
- 多厂商按 `stometa-mode` 路由表，不硬编码 Claude（2.4）。
- 账本必须有（3.2/3.3），跟进要排队（4.4），不建看板、依赖 Linear（8.3），PR 暂用他自己的 GitHub 身份（8.1 P1 不变，P0 用本人 gh）。

他提的问题，我的回答：

- **3.1 SQLite 还是本地 Postgres** → SQLite。单进程、单消费者、几千行状态，Postgres 多养一个守护进程换不来任何东西；要换的那天是多 runner 共享状态的那天，那时再说。
- **3.4 要不要 queue、看 Multica、改 Socket 加速** → 看了 `~/dev/multica` @54eb546ac（2026-10-17）。它的链路：Slack Socket Mode（每个安装一条连接，`integrations/slack/slack_channel.go:19`）→ server 归一化并按 `(installation, message_id=ts)` 去重（`inbound.go:129-133`，顺带也解决了双事件）→ 落 Postgres 成 issue/task → **WebSocket `task_available` 推给 daemon**（`CLI_AND_DAEMON.md:305`）→ daemon 批量 `POST /api/daemon/tasks/claim` 认领（WS 优先、HTTP 兜底，`daemon/client.go:306`，`daemon.go:5270-5282`）→ 起 agent。30 s 轮询只是漏信号的兜底，WS 健康时兜底拉长到 3 分钟（`daemon/config.go:25-29`）。**所以它不是靠轮询，"慢"不在传输层**——在 claim 往返 + 环境准备 + `claude -p` 冷启动。
  它需要 claim 队列是因为 **server 和 daemon 不在一台机**、多台 daemon 从一个 server 抢任务。我们一公司一 runner、桥和 `orca serve` 同机，桥收到 Slack 事件直接 `worker-start`，没有 claim 这一跳；桥→worker 的回报走 Orca Run mailbox（持久、FIFO、ack），`check --wait` 是长轮询。结论不变：不另建 queue，也没有要"改 Socket"的地方——两头都已经是 socket。要追的是 agent 冷启动，P0 验收加端到端延迟测量。
  可抄的一点：Multica 的去重键就是 `(installation, ts)`，和我们 3.3 的 `UNIQUE(channel, ts)` 同构。
- **5.2 清理 worktree 会不会把 session 也清掉、没法 retro** → 会有影响：Claude Code 的 transcript 在 `~/.claude/projects/<按 cwd 路径哈希>/`，目录删了文件还在，但 `--resume` 按 cwd 找会话，worktree 没了就不好接（UNVERIFIED，要实测）；Codex 的在 `~/.codex/sessions/` 不依赖路径。方案：release 不删 worktree；按 5.7 的 14 天空闲再 `worktree rm`，删之前把 transcript 路径和 receipt 写进线程记录。
- **6.6 为什么不能改规则和 hook** → 可以改 worktree 里的东西；但如果危险命令门是 worktree 里的一个 hook 文件，agent 改掉它就等于拆了门。所以门不放在 worktree 里：settings/hook 放 runner 的状态目录，启动时 `--settings` 传给 Claude（P 就这么做）。这样 6.6 不用禁，只要 6.3/6.4 的门放对地方。
- **9.1 要不要换成本地 Docker image** → 不换。桥要调 `orca` CLI、开宿主机上的 worktree、读 keychain——放进 Docker 等于先隔离再把每个口子打回去。Mac runner 上 launchd 就是对的工具；runner 变成 Linux、`orca serve` 和桥同容器时再 Docker。
- **1.5 不懂什么意思** → 路由表就是 `stometa-mode/SKILL.md:44-49` 那张表：每行 = 一种活（research / code / review）对应 agent + model + effort + skill。"角色前缀"是让人在 Slack 里写 `review: …` 直接选行。你选了 1.6 LLM 判意图之后，前缀就退化成可选的手动覆盖。

新增一行待定：

| # | 功能点 | 我们 | 说明 |
|---|---|---|---|
| 1.8 | **外环：需求代理**——线程里和人把需求聊清楚，产出 Linear ticket（含可执行验收），再派内环 | ❓ | 2.3 批注直接推出来的；是桥派一个"spec 角色"的 worker 来聊，还是桥外的 Grok Bot/Slack 人工聊好再 @？决定了 1.4 的答案 |

## 待 Stometa 拍板（11-07 之前的版本，保留对照）

1. **1.4** issue/ticket 链接当任务源要不要？要的话 Linear/Jira 读取就进 P1，整个"tracker 边界"要重新说清楚。
2. **1.6** 路由靠规则还是 LLM？F 做了 eval 说明它觉得规则不够。
3. **6.2** 非白名单消息"hold 等 owner 批"要不要？公司 Z 三人不需要，公司 M 可能需要——两家配置不同就行，但代码要先有这个开关。
4. **7.2/7.3** 成本和并发上限怎么定、能不能测。
5. **5.7** 空闲线程要不要自动关、多久。
6. **6.4** Codex 没有 PreToolUse，危险命令门对 Codex 怎么做（Orca 层？`--sandbox`？不做？）。

## 没核实的

5.2 关于 Claude `--resume` 依赖 cwd 的说法未实测。三列引用我各抽查 2–3 处（D：`cli.ts:2182`、`status-capability.ts:1271`；P：`NOTES.md:18-38`、`slack-agent:1676`；F：`orca.ts:69`、`bot.ts:647`、`inbox.ts:110`），其余以审读笔记为准。三个仓库都没真机跑过。
