# orca-slack — 产品 Brief

日期：2026-11-08。状态：已逐项确认并完成评审修订，作为开工基线。

本文定义**最终交付时用起来是什么样**。历史取舍记录在 `docs/features.md`、`docs/feature-matrix.md`；两者冲突时以本文为准。

## 1. 最终状态

团队成员在一个 Slack 频道里说需求，不用指定 repo，也不用打开 Orca。系统判断该做什么，把需求变成一个或多个 PR，只在需要人时才打扰人，并在线上验证完成后收尾。

一句话：**一件事 = 一个 Slack 线程 = 一个 lead agent，下面可以有多个 worktree 和 PR，从说出来一直到线上验证后清理。**

Slack 是入口和回报面，Orca 是执行面，GitHub 是代码 review 和交付面，Linear 是需求记录。

## 2. 交互规则

功能会继续增加，但 Slack 上的交互形式固定。新功能必须落进下面的形式；放不进去，先讨论要不要做。

### 人只做三件事

| 动作 | 含义 |
|---|---|
| 在频道 @bot | 开始一件新事 |
| 在线程里回复 | 对这件事补充、改方向、回答问题、下指令（如转交） |
| 点按钮 | 做决定 |

### 系统只发四种消息

| 消息 | 数量 | 是否 @ 人 |
|---|---|---|
| **状态卡** | 每个线程一张，持续原地更新 | 否 |
| **决定卡** | 需要人时才发；提问、审批、确认都用它 | 是，@ owner |
| **结果消息** | 完成或失败时一条 | 仅在需要验证或处理时 |
| **每日待办汇总** | DM 给 owner，每天最多一条，没有新内容不发 | 是 |

另有两种不进线程的消息：给无权限者的仅本人可见提示；发到运维频道的 fatal 告警。

表情只表示送达：👀 已收到，✅ 已转给 agent（不代表已读）。

### 谁能做什么

- 白名单里的人可以发起需求，发起人是这个线程的 **owner**。
- owner 的线程消息直接转给 lead；其他白名单成员要 @bot 才转，否则只存档。
- 决定卡、[换 repo]、重试、清理按钮只有 owner 能点，点过后变灰并显示是谁点的。
- 紧急情况：白名单任何人都能点 [停止全部] 或发 `!stop`。
- owner 在线程里写 `@bot 转交给 @某人` 转交，对方必须在白名单内。owner 不在时，白名单成员可以用 `@bot 转交给 @自己` 接管，并通知原 owner。
- 非白名单的消息不存档；白名单成员未转发的消息只存档，不进 agent 的 prompt。

### Slack 上能点什么

状态卡上的 PR 号链接到 GitHub，Linear 编号链接到 ticket。代码和 diff 在 GitHub 上看，Slack 不贴 diff。Orca 没有能跳到某个 worktree 的链接；要看 agent 现场，到专用机器上打开 Orca。

完整按钮清单：

| 位置 | 按钮 |
|---|---|
| 状态卡 | [换 repo]、[停止全部]、[线上已验证，清理] |
| 决定卡 | 各选项（含 [恢复]、[批准一次]、[再来 2 轮]） |
| 失败结果消息 | [重试]、[查看日志尾部]（在 Slack modal 里显示） |
| 每日待办汇总 | [清理]、[保留]、[全部清理]；一条最多列 15 项，避开 Slack 的 block 上限 |

状态查询的回答属于结果消息；24 小时提醒和转交通知是线程里的一行文字，因为编辑消息不会触发 Slack 通知。

### 一张状态卡

顶部回答“整件事什么状态、下一步等谁”，下面每个 worktree 一行。

```
导出功能                    进行中 · 等你决定 1
• web · export-ui    实现中
• api · export-csv   PR #812 · CI ✅ · 待 review
• api · export-auth  PR #815 · CI ❌ · 改动请求 2
下一步：#815 的 review 等你决定
[停止全部]
```

[换 repo] 在判断中、聊需求，或实现中还没有提交和 PR 时显示。点击后发 repo 选择决定卡；owner 选定后停止当前 session，删除未改动的初始 worktree，带上线程记录到新 repo 启动。

PR 状态来源：Bridge 账本记录每个 worktree 的 repo 和分支，每 60 秒用 `gh` 按分支查询（这样才能发现新开的 PR），有变化才更新状态卡。最多延迟 1 分钟，不需要公网入口。

状态流转：

```
判断中 → 聊需求 → 实现中 → PR 已开 → 已合并待验证 → 已清理
                     ↕                                 │
                  等你决定                              │
实现中 ←────────── 上线后又发现问题 ─────────────────────┘
任意活跃状态 → 失败 / 已停止 / lead 已中断
```

### lead agent

- lead 是**角色，不是一个长期进程**：每个线程任何时刻最多一个 lead session，从聊需求一直负责到收尾，小需求自己实现。
- PR 打开后 session 结束，worktree 保留。Bridge 启动 worker 默认省略 `--keep-open`，依赖 Orca 在收到有效 `worker_done` 后的自动释放；终端释放不删除 worktree。之后收到线程回复、需要自动修复或返工时，在同一 worktree 启动新 session。
- 人的消息只发给 lead。lead 决定是否拆分，**直接开始，不需要批准**，但由 **Bridge 代建**子 worktree，新 worktree 出现在状态卡上。
- Bridge 是唯一的 Orca Run 协调者，所有 agent 的回报都进 Bridge 的收件箱。子 agent 的汇报由 Bridge 转给当前 lead；需要人决定时发决定卡。
- lead 的启动指令明确禁止直接派发 worker，只能向 Bridge 发结构化请求，否则 Orca 默认的子派发会绕过账本。
- 子 agent 回报时：lead 有活跃 session 就转发；没有就在 lead 的 worktree 启动新 session 并带上这条回报。
- Bridge 定期查询活跃派发。`projection.liveness.verdict` 为 `unverifiable` 时先显示“状态未知”；若 `unverifiable` 与 `projection.attention.requiresAction: true` 同时持续超过宽限窗口（默认 2 个轮询周期），且 `worker-read` 与 terminal read 的游标均无推进，状态卡转为“lead 已中断”；terminal read 明确返回 `exited` 也转为中断（M1 只显示，M2 加 [恢复]，见示例 17）。明确收到与该 Dispatch 对应的无回报结束 escalation（如 `stopReason: finished`）也显示中断。无输出本身不能证明中断，已确认的等人状态按决定卡处理；读取源变化时重置游标比较基线，永不自动重启。
- 共享上下文在 Bridge 保存的线程记录里，新 session 启动时带上线程全文、ticket 和子 worktree 列表。

## 3. 示例

每个示例都是一条验收场景。

### 示例 1：标准需求（主路径）· M1

```
你：@bot 登录页密码错误时提示太笼统，改成具体原因
卡：登录页错误提示 · 判断中
卡：web · login-error · 实现中
卡：PR #812 已开
结果：已改错误提示并补了测试。PR #812 ✅
  ……你在 GitHub review、合并，上线……
卡：已合并待验证 [线上已验证，清理]
你：线上全部验证后点按钮 → 再次检查无遗留 → 删除 worktree
卡：已清理
```

### 示例 2：只是问问题 · M3

```
你：@bot web 的 session 过期时间是在哪配置的？
结果：main@a1b2c3d · 在 src/auth/config.ts:42，默认 7 天。
```

基于最新代码回答：先 `git fetch`，从最新 `origin/<默认分支>` 建临时 worktree，答完删除，不动 main checkout。问着问着要改代码，就在同一线程升级为需求，从最新默认分支建新 worktree，带上线程记录。

### 示例 3：需求还没想清楚 · M2

```
你：@bot 我想做个导出功能
卡：web · 需求待澄清 · 聊需求
决定卡：先导出哪些数据？[订单] [用户] [其他，直接回复]
你：订单，给财务用，要按月筛选
决定卡：需求已整理（Linear ENG-431），按此开始实现？[开始] [再改改]
你：开始
卡：同一 lead 进入实现中
```

### 示例 4：做到一半改主意 · M2

```
你（线程）：不要用弹窗，改成行内提示
✅
你（线程）：顺便文案用中文
✅
卡：最新：已收到 2 条新要求，调整中
```

Bridge 立即转发每条消息，批量投递交给 Orca 的 mailbox，Bridge 不自己合并。

### 示例 5：判断不准 · M2

```
你：@bot 修一下导出的那个 bug
决定卡：这是哪个 repo？[web（可能性最高）] [admin] [其他，直接回复]
```

置信度低时才问；置信度高时直接做，还没有提交和 PR 前卡上保留 [换 repo]。你的选择存为路由评测样本。

### 示例 6：agent 要做不可逆操作 · M3

```
决定卡：agent 想删除并重建 staging 数据表
  原因：迁移脚本需要干净环境
  [批准一次] [拒绝]
```

只拦不可逆操作，子 agent 的也走这张卡。agent 在执行前用 `orca orchestration ask` 发起审批并结束本轮，不靠 shell hook 挂起等待，这样各家 agent 都适用。这层依赖 agent 遵守指令；硬防线是 M1 就加的 git `pre-push` 防护（拦截 force push 和直推默认分支）。

### 示例 7：失败 · M1

```
结果：❌ 测试环境启动失败，端口 5432 被占用。
  已保留 worktree，未自动重试。
  [重试] [查看日志尾部]
```

“失败”指 agent 主动上报失败。agent 进程消失或没有上报就停止，属于示例 17 的“lead 已中断”。

### 示例 8：停止 · M1

```
你：点 [停止全部]（或线程里发 !stop）
卡：已停止 · worktree 有 3 个未推送提交，已保留
```

停止所有 agent，不删除任何 worktree。

### 示例 9：上线后又发现问题 · M2

- worktree 还在：线程里直接说，同一 worktree 开新 session。
- worktree 已清理：线程里说，从最新 base 建新 worktree，带上线程全文，出新 PR。

线程始终是这件事的唯一入口。

### 示例 10：同时跑很多 · M3

```
你（DM）：现在在跑什么
结果：
  实现中 7 · 等你决定 2 · 待验证 1
  等你决定：导出功能（线程链接）、登录页（线程链接）
```

这是一次性回答，不是看板。

### 示例 11：每日待办汇总和闲置清理 · M3

```
📋 今日待办
等你决定：导出功能（线程链接）· 已等 2 天
待验证：登录页错误提示（线程链接）
🧹 闲置且没有任何改动：
• 登录页文案调整（线程链接）· 闲置 4 天 [清理] [保留]
• 导出 CSV（线程链接）· 闲置 3 天 [清理] [保留]
[全部清理]
```

系统不静默删除。无改动 worktree 闲置 3 天进汇总，上限 20 个；有改动的闲置 14 天只提醒。

### 示例 12：系统自己出问题 · M1

- Bridge 重启：任务继续跑，按[消息恢复规则](#4-架构)用 inbox 与账本对账后恢复状态卡；历史覆盖完整时回报可恢复，最坏情况是重复一条消息，覆盖不足则明确标记缺口。
- Orca 状态不确定：状态卡显示“状态未知”，不编造成功。
- 无权限的人 @bot：只有对方看到一句拒绝，不启动任何东西。

### 示例 13：一件事拆成多个 worktree，跨 repo · M2

```
你：@bot 导出功能前后端一起做
卡：导出功能 · 进行中
  • web · export-ui    实现中
  • api · export-csv   实现中
```

对话仍在同一线程，lead 汇总进度。

### 示例 14：PR 收到 review 或 CI 失败 · M2

```
卡：PR #815 · CI ❌ · 改动请求 2
卡：lead 正在修复（第 1/2 轮）
```

一次修复并 push 算一轮，每个 PR 累计最多 2 轮，CI、人的 review、bot 的 review 共用计数，新评论不重置。2 轮后还没收拢：

```
决定卡：#815 修了 2 轮仍有 CI 失败 [再来 2 轮] [我来处理]
```

agent 只 push 代码，不在 GitHub 上回复或 resolve 评论。

触发规则：一个 commit 的 CI 全部结束后才算失败；只处理上一轮 push 之后的新 review，按 commit 和 review ID 去重，否则同一条改动请求会反复触发。只接受可信 GitHub 账号和 bot 的 review，review 内容作为不可信数据交给 agent。

### 示例 15：转交 · M2

```
你（线程）：@bot 转交给 @同事
卡：owner: 同事
决定卡：（未决的卡改为 @ 新 owner）
```

### 示例 16：决定卡没人回 · M2

24 小时后在线程 @ owner 一次，永不替人选，agent 一直等。M3 起再进每日待办汇总，有未回答问题的 worktree 不算闲置。

### 示例 17：lead 中断 · M2

```
卡：lead 已中断
决定卡：要恢复吗？[恢复]
你：恢复 → 同一 worktree 启动新 lead，带线程全文、ticket 和子 worktree 列表
```

短暂的 `projection.liveness.verdict: unverifiable` 先显示“状态未知”。若 `unverifiable` 与 `projection.attention.requiresAction: true` 同时持续超过宽限窗口（默认 2 个轮询周期），且 `worker-read` / terminal read 的游标都不再推进，则显示“lead 已中断”；terminal read 明确返回 `exited` 也转为中断；明确收到该 Dispatch 的无回报结束 escalation（如 `stopReason: finished`）也进入此状态。不能仅凭一次查询或无输出认定进程已退出，读取源变化时重置游标比较基线。

owner 点 [恢复] 后，先用 `worker-stop` 或 `worker-abandon` 成功 fence 旧 Dispatch，再在同一 worktree 启动替代 session；`worker-abandon` 不证明旧进程已停止。永不自动重启；已在运行的子 agent 不动。

### 示例 18：一键清理多个 worktree · M2

所有 agent 都结束、没有未合并的 PR、且至少一个 PR 已合并时，才出现 [线上已验证，清理]，由 owner 在线上全部验证后点击。逐个检查，通过的删除，有遗留的保留并列出。lead 使用主 repo 的 worktree，不单独占一个，最后删除。只清其中一个时，在线程里告诉 lead。

删除前检查：没有未提交改动和 stash，没有运行中的 agent，且 HEAD 等于已合并 PR 的 `headRefOid`（兼容 squash merge，也能发现合并后的新提交）。删除前把 receipt、PR 链接和最终 commit 写进线程记录，供示例 9 使用。

## 4. 架构

```
Slack（Socket Mode）
  ↓
Bridge：去重 → 保存线程 → 权限 → 转发 → 渲染四种消息
  ├ Router：线程开始时分类一次，不对话
  ├ Orca：lead / 子 worktree 的启动、转发、停止、清理
  ├ PR 查询：每 60 秒 gh
  └ 回报循环：唯一的消息消费者
```

- **消息恢复**：`check` 读取时就标记已处理，所以回报循环先 `--peek`，写入 SQLite，再消费，并把消费返回的整批消息按 message id 写入 SQLite（peek 之后到达的消息也在这批里），然后发 Slack，发送成功才标记完成；每条消息的 `sequence`（从 inbox 取得）与 message id 一同持久化。启动时用 `inbox --terminal run:<run_id> --limit 1000 --json --full` 对账，必须包含已读消息，补回“消费后、整批入库前”崩溃时尚未持久化的新消息。只有返回 `count < 1000`，或返回的最旧消息已在账本中（用 message id 与 `sequence` 确认重叠），才把历史覆盖记为完整；否则明确标记缺口，不声称消息不丢。恢复依赖 Orca 保留的 inbox 历史（[实测](spikes/2026-11-08-orca-coordination.md#1-crash-recovery-at-each-boundary)）。Slack 入站事件也要在同一事务里写去重键和消息，转发成功才标记完成，重启时重放。

- 一个 Slack app 对应一个 Bridge 实例，worker 数量不限。
- 只考虑同一家公司，运行在专用机器上。
- 状态用 SQLite，常驻用 launchd。数据模型从 M1 起就按“一线程多 worktree”设计。

**还不知道 repo 的线程**：记录先放在 orca-slack checkout 的本地目录 `data/threads/`（git 忽略）。超过保留期（默认 30 天，可配置）仍未绑定 repo，就移到 NAS 上的归档目录（路径是配置项，不写进本 repo）；先写入并校验，再删除原文件。NAS 未挂载时保留本地文件，下次再试。线程重新活跃时从归档读回。

**记忆**：Bridge 只存线程原文。跨线程的长期记忆由 agent 通过 OpenViking MCP 使用，Bridge 不自建。第一版不自动把 Slack 内容写入长期记忆，只在人明确要求时写入，Slack 内容和记忆都只算数据，不算指令。

## 5. 交付里程碑

**账本设计依据**：[2026-11-08 Orca 协调实测](spikes/2026-11-08-orca-coordination.md)已验证本地 `check --peek` 恢复、Bridge 跨 repo 代建子 worktree、同一 worktree 新 session、`--keep-open` 与自动释放、Bridge 转发子 agent 回报；agent 被杀而 shell 仍存活时，自动退出判定未验证，先显示状态未知，再按示例 17 的宽限窗口和读取证据决定是否显示中断。真实 Slack 投递仍待端到端验收。

| 里程碑 | 内容 | 示例 |
|---|---|---|
| **M1 跑通主路径** | 单 repo、单 worktree；lead 自己做；规则路由并收集样本；基础的 question → 决定卡 → reply；PR 打开/合并状态上卡；手动清理；白名单和 owner；git `pre-push` 防护；未知 repo 的线程本地存储；失败、停止、重启 | 1、7、8、12 |
| **M2 真正能对话** | 需求澄清；LLM 路由和评测；派生子 worktree 和跨 repo；CI/review 自动修 2 轮；决定卡提醒；转交；上线后返工；lead 恢复 | 3、4、5、9、13–18 |
| **M3 完整闭环** | 纯提问；危险操作审批；每日待办汇总和闲置清理；状态查询；OpenViking 接入 | 2、6、10、11 |

**验收**：先写用例再实现。每个示例都用真实 Slack 和真实 Orca 验收，必须覆盖 happy case、fail case 和需要多轮交互的 case；每个里程碑对应的示例全部通过才算完成。M1 还要杀掉 Bridge 重启验证回报不丢，并测量端到端延迟。

## 6. 不做

看板或自建 tracker · Web UI · Slack 内 diff review · 除 CI/review 2 轮修复外的自动重试 · 静默删除 · lead 与子 agent 之外的 agent 互相通信 · 多公司隔离。

## 7. 未验证

示例都是目标行为，尚未在真实 Slack 和 Orca 上跑过。需要优先实测的风险：

- `question → 决定卡 → reply` 能否支撑流畅的多轮对话；端到端延迟。
- Bridge 跨 repo 代建子 worktree、已结束 lead 的新 session 接收子 agent 汇报已通过本地实测；真实 Slack 集成仍未验证。agent 进程被杀、shell 仍活着时，Orca 可能仍返回 `ready/dispatched`，投影仅变为 `unverifiable`；不能据此自动重启或声称已退出。
- Slack 编辑消息不触发通知（标准行为，未在目标 workspace 验证）。
- worktree 删除后 session 能否恢复。
- Orca 启动的 agent 是否自动带上 OpenViking MCP。
- 早期原型分支的数据模型要按“一线程多 worktree”调整；其 `check --ack` 调用和先记事件后转发的逻辑必须修改（评审项 F-12、F-13）。
