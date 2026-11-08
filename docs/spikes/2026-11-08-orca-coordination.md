# STO-186: Orca coordination measurements

Measured on 2026-11-08 with installed Orca `1.4.253`, on one local macOS host. These are runtime observations, not claims about other versions, remote hosts, Chat-surface workers, or retention across Orca restarts. The Orca runtime stayed running throughout; disposable consumer processes and one agent process were killed.

The Bridge should own one Run, keep the Run/task/Dispatch/session/worktree identities separate, create child worktrees itself, and start all workers in that Run. Its single report consumer must reconcile read **and** unread inbox history by message id after a crash. Treat unavailable agent evidence as unknown: this build did not reliably detect an agent killed inside its still-live shell.

## Verdicts

| Acceptance | Verdict | Evidence below |
|---|---|---|
| 1. Crash points in peek/persist/consume/send | Verified for Orca recovery and a local sink; actual Slack delivery inconclusive | SIGKILL matrix and consumed-message recovery |
| 2. Arrival between peek and consume | Verified | Both ids in consuming batch |
| 3. Bridge-created child in second repository, same Run | Verified | Explicit lineage and child worker_done |
| 4. Sequential sessions, keep-open, release | Verified | Distinct Dispatches/terminals; automatic close and retained terminal |
| 5. Bridge-only lead and report to settled lead | Verified in this trial | Run-list comparison and new session acknowledgement |
| 6. Detect agent exit without worker_done | Not verified for a killed agent; normal turn end detected | Section 6.1 measures reads/agentWait and a finished-without-report escalation |
| 7. Cleanup | Verified | Before/after inventories and unchanged main checkout; inert audit history retained |
| 8. Public-safe report | Verified | Redaction probe with no matches |

No Bridge product code, SQLite product schema, Slack calls, or Linear mutations were made. Test scripts and temporary SQLite databases lived outside the product checkout. Three trivial successful Codex sessions used the configured default (`gpt-6-astra`); the fault-injection worker requested `gpt-6-luna` with low effort. The successful sessions lasted roughly 10–13 seconds each; a cheaper model was not explicitly selected for those three runs, so cost optimization is a limitation of this spike.

## Isolation and command conventions

First captured, before any test registration:

```sh
orca repo list --json
orca worktree list --limit 10000 --json
git -C <main-checkout> status --porcelain=v1
git -C <main-checkout> rev-parse HEAD
```

`<tmp>` below replaces the generated temporary root, and `<main-checkout>` replaces the existing main checkout. No real machine paths or pre-existing workspace names are published. JSON excerpts preserve actual message, Dispatch, terminal, and test-repository ids; irrelevant fields are omitted explicitly. Existing inventory entries are consistently anonymized below. Commands with variables describe the executed arguments after this path normalization.

```json
{
  "repoA": "df767302-9c0d-435e-b5c5-db8e08b996de",
  "repoB": "093de9db-9bba-45bd-b243-ed22a7d8ca08",
  "bridgeRun": "run_e8f9932d93e5",
  "bridgeTerminal": "term_fcc8d706-d4a1-46a2-ae1a-2bd14f28f547",
  "worktreeA": "df767302-9c0d-435e-b5c5-db8e08b996de::<tmp>/coord-spike-a",
  "worktreeB": "093de9db-9bba-45bd-b243-ed22a7d8ca08::<tmp>/coord-spike-b",
  "childWorktree": "093de9db-9bba-45bd-b243-ed22a7d8ca08::<tmp>/worktrees-b/coord-spike-b/coord-spike-child"
}
```

Created two repositories using `mkdtemp`, `git init -b main`, one README, and a seed commit; registered each with `orca repo add --path <tmp>/coord-spike-{a,b} --json`. Set only those two new setup ids' `--worktree-base-path` to temporary directories. Started a shell in A:

```sh
orca terminal create --worktree "id:$WA" --title coord-spike-bridge --command '/bin/zsh -f' --json
# Executed inside that shell:
orca orchestration run-create --objective 'Temporary Bridge coordination spike' --json
```

A preliminary attempt to use `run-create --from <Bridge-terminal>` from another dispatched pane returned `consumer_fenced` with `effectsApplied:false`. The same command actually executed in the Bridge shell succeeded. The Bridge must have its own authenticated caller identity; substituting another pane's `--from` is refused. All subsequent mutations of the test Run were executed in the test Bridge shell, leaving the task's supervising Run alone.

## 1. Crash recovery at each boundary

A disposable consumer inherited the test Bridge shell's identity. The driver sent one status report to its Run, forked the consumer, waited for an explicit boundary marker, issued `SIGKILL` to that exact child PID, and waited for its exit (`-9`). Each recovery was a new CLI invocation in the surviving Bridge shell. This models a report-loop process crash, not a runtime crash or a complete production Bridge implementation.

Commands executed per case:

```sh
orca orchestration send --to "run:$RUN" --type status --subject "$CASE" --body "$CASE" --json
orca orchestration check --run "$RUN" --peek --json --full
# Persist the peek batch into temporary SQLite; commit with synchronous=FULL.
orca orchestration check --run "$RUN" --json --full
# Persist the whole consuming batch; write a local sink in place of Slack.
# Mark sent only after the sink returns. Kill at each selected boundary.
kill -KILL "$CONSUMER_PID"
# Recover:
orca orchestration check --run "$RUN" --peek --json --full
orca orchestration inbox --terminal "run:$RUN" --limit 100 --json --full
# INSERT OR IGNORE by message id, including inbox rows already read.
```

The harness stopped before the next step at each boundary. The sink was a local file: **no Slack message was sent**. Each case used its own SQLite database. Original pre-consume JSON-file probes were repeated with actual committed SQLite persistence; the following table is the stronger SQLite run. `P/C` are ids returned by peek and consume before the kill; `R` is the unread peek after recovery. The “Inbox after kill” column shows only ids belonging to that row’s probe, extracted from the full inbox response; other retained messages are omitted. A dash means that step had not run.

| Kill boundary | P | C | Durable ledger at kill | R | Inbox after kill |
|---|---|---|---|---|---|
| Before peek | — | — | `[]` | `["msg_25e1dc663f32"]` | `[{"id":"msg_25e1dc663f32","read":0}]` |
| After peek, before persist | `["msg_964d5e51ef57"]` | — | `[]` | `["msg_964d5e51ef57"]` | `[{"id":"msg_964d5e51ef57","read":0}]` |
| After persist, before consume | `["msg_af7a61d15456"]` | — | `[["msg_af7a61d15456",0]]` | `["msg_af7a61d15456"]` | `[{"id":"msg_af7a61d15456","read":0}]` |
| After consume, before next persist/send | `["msg_c24cc35c277c"]` | `["msg_c24cc35c277c"]` | `[["msg_c24cc35c277c",0]]` | `[]` | `[{"id":"msg_c24cc35c277c","read":1}]` |
| After local send, before sent marker | `["msg_6c87643014af"]` | `["msg_6c87643014af"]` | `[["msg_6c87643014af",0]]` | `[]` | `[{"id":"msg_6c87643014af","read":1}]` |
| After sent marker | `["msg_1c267563064f"]` | `["msg_1c267563064f"]` | `[["msg_1c267563064f",1]]` | `[]` | `[{"id":"msg_1c267563064f","read":1}]` |
| Late arrival: after consume, before batch persist | `["msg_1f1133835b6b"]` | `["msg_1f1133835b6b","msg_750dca464cd5"]` | `[["msg_1f1133835b6b",0]]` | `[]` | `[{"id":"msg_750dca464cd5","read":1},{"id":"msg_1f1133835b6b","read":1}]` |

Ledger tuples are `[message_id, sent]`; inbox tuples show actual `read` values. Every listed id remained recoverable in inbox. Before consumption it also remained unread. After consumption, a plain check could not recover it: startup reconciliation of **read** history is necessary. The final race row proves the dangerous window: the late id was consumed and absent from SQLite at the kill, but present in inbox with `read:1`; replay inserted it successfully.

After local send but before the sent marker, the surviving ledger still had `sent:0`; after the marker it had `sent:1`. A replaying outbox can use that marker to suppress resends, while the unmarked case can duplicate a send; these are design consequences, not a measured production retry loop. Actual Slack request acknowledgement, duplicate suppression, API failures, and end-to-end crash behavior are **inconclusive** because Slack was deliberately not contacted. The measured guarantee is recoverability from this live runtime's retained inbox, not exactly-once delivery or unlimited historical retention. The initial reads requested 100 rows; section 6.1 adds a successful limit-1000 read with two returned rows, but truncation/retention at that boundary and runtime restarts were not measured; the Bridge must not claim losslessness if reconciliation coverage is unknown.

## 2. Arrival after peek

The driver sent `race-first`, peeked, sent `race-second`, then consumed. Commands:

```sh
orca orchestration send --to "run:$RUN" --subject race-first --body 'Temporary crash recovery probe race-first' --type status --json
orca orchestration check --run "$RUN" --peek --json --full
orca orchestration send --to "run:$RUN" --subject race-second --body 'Temporary crash recovery probe race-second' --type status --json
orca orchestration check --run "$RUN" --json --full
orca orchestration check --run "$RUN" --peek --json --full
```

```json
{
  "peekIds": [
    "msg_92c1f5fa3b06"
  ],
  "consumeIds": [
    "msg_92c1f5fa3b06",
    "msg_e2f562c55312"
  ],
  "afterIds": [],
  "deliveryId": "delivery_2b4754715276",
  "deliveryAcknowledged": true
}
```

Consumption is not an acknowledgement of a previously peeked id list. Persist the **returned consuming batch**, including new arrivals. No extra `--ack` was needed.

## 3. Cross-repository child under the Bridge Run

The Bridge shell in repository A executed:

```sh
orca worktree create --repo "id:$B" --name coord-spike-child --parent-worktree "id:$WA" --setup skip --json
orca orchestration worker-start --run "$RUN" --spec "$CHILD_SPEC" --worktree "id:$CHILD" --agent codex --json
orca orchestration check --run "$RUN" --json --full
```

`CHILD_SPEC` required an immediate `worker_done` with `CHILD_OK`, no edits, helpers, or new Runs. The child was pre-created by the Bridge, then passed as an existing exact worktree selector. This route was measured; `worker-start --worktree new-child --repo ...` was not measured.

Creation JSON excerpt:

```json
{
  "id": "093de9db-9bba-45bd-b243-ed22a7d8ca08::<tmp>/worktrees-b/coord-spike-b/coord-spike-child",
  "repoId": "093de9db-9bba-45bd-b243-ed22a7d8ca08",
  "parentWorktreeId": "df767302-9c0d-435e-b5c5-db8e08b996de::<tmp>/coord-spike-a",
  "lineage": {
    "worktreeId": "093de9db-9bba-45bd-b243-ed22a7d8ca08::<tmp>/worktrees-b/coord-spike-b/coord-spike-child",
    "worktreeInstanceId": "996a48a6-07aa-4bb6-9863-5ca1bb4dbb37",
    "parentWorktreeId": "df767302-9c0d-435e-b5c5-db8e08b996de::<tmp>/coord-spike-a",
    "parentWorktreeInstanceId": "40ed0f40-fe8b-462e-ae0e-5328958991f5",
    "origin": "cli",
    "capture": {
      "source": "explicit-cli-flag",
      "confidence": "explicit"
    },
    "createdAt": 1794138335022
  }
}
```

Worker launch and received report excerpts:

```json
{
  "dispatchId": "ctx_b92c4738daf5",
  "taskId": "task_dd30193c4b2e",
  "runId": "run_e8f9932d93e5",
  "terminal": "term_4eb8e1db-2ba6-4476-b40e-1b0ca132917c",
  "workspace": "093de9db-9bba-45bd-b243-ed22a7d8ca08::<tmp>/worktrees-b/coord-spike-b/coord-spike-child",
  "received": [
    {
      "id": "msg_40f9201510b9",
      "run_id": "run_e8f9932d93e5",
      "delivery_contract": "current_delivery",
      "from_handle": "term_4eb8e1db-2ba6-4476-b40e-1b0ca132917c",
      "to_handle": "run:run_e8f9932d93e5",
      "subject": "Child complete",
      "body": "Ran the requested trivial child. CHILD_OK. Nothing remains.",
      "type": "worker_done",
      "priority": "normal",
      "thread_id": null,
      "payload": "{\"taskId\":\"task_dd30193c4b2e\",\"dispatchId\":\"ctx_b92c4738daf5\",\"outcome\":\"succeeded\"}",
      "created_at": "2026-11-08T11:47:22Z",
      "delivered_at": null
    }
  ]
}
```

`worker_done.payload` was a JSON **string**, not an object. Parse it before using task/Dispatch/outcome fields. The child worktree's lineage and the worker's Run are independent records: one must not be inferred from the other.

## 4. Repeated sessions and terminal lifetime

The first lead ran on A without keep-open. After it completed, the Bridge started a fresh worker on the same exact selector with `--keep-open` and a new spec. It omitted `--terminal`, so Orca created a new session and terminal rather than resuming the old chat.

```sh
orca orchestration worker-start --run "$RUN" --spec "$LEAD_SPEC" --worktree "id:$WA" --agent codex --json
orca orchestration worker-show --dispatch "$D1" --json --full
orca terminal list --worktree "id:$WA" --json
# After settlement:
orca orchestration worker-start --run "$RUN" --spec "$FOLLOWUP_SPEC" --worktree "id:$WA" --agent codex --keep-open --json
orca terminal list --worktree "id:$WA" --json
```

```json
{
  "first": {
    "dispatchId": "ctx_33f556d00691",
    "terminal": "term_38f0eca6-b90f-4a21-97d5-ef6193e4e895",
    "completedAt": "2026-11-08T11:45:48.974Z",
    "autoReleaseAt": "2026-11-08T11:47:48Z",
    "releaseRequestedAt": "2026-11-08 11:47:48",
    "releaseCompletedAt": "2026-11-08 11:47:50",
    "finalResource": {
      "state": "released",
      "id": "wtr_fadbb58e5215",
      "ownerDispatchId": "ctx_33f556d00691",
      "releaseState": "released",
      "terminalState": "released"
    }
  },
  "second": {
    "dispatchId": "ctx_147eb74831cd",
    "terminal": "term_e25b4c09-17a4-4d07-962b-1abed04d25bd",
    "completedAt": "2026-11-08T11:47:33.552Z",
    "autoReleaseAt": null,
    "observedAt": "2026-11-08T11:50:16.843+00:00",
    "resource": {
      "state": "owned",
      "id": "wtr_778af97ede06",
      "ownerDispatchId": "ctx_147eb74831cd",
      "releaseState": "retained",
      "terminalState": "retained"
    }
  }
}
```

The default worker's release was requested about 119 seconds after its fractional completion time and completed about 121 seconds after it. The two-minute deadline is observed behavior, not a Bridge timer contract. The first worker was sampled while retained, then found absent after automatic release; no release command was issued before that close. The kept-open worker still existed 163 seconds after settlement, with no auto-release deadline. An explicit `worker-release --dispatch <second-id>` then released it and captured a transcript archive.

Terminal-list excerpts (only handles; all rows in A, including the Bridge shell):

```json
{
  "lead1-terminals-immediate": [
    "term_fcc8d706-d4a1-46a2-ae1a-2bd14f28f547",
    "term_38f0eca6-b90f-4a21-97d5-ef6193e4e895"
  ],
  "lead1-terminals-settled": [
    "term_fcc8d706-d4a1-46a2-ae1a-2bd14f28f547",
    "term_38f0eca6-b90f-4a21-97d5-ef6193e4e895"
  ],
  "lead2-terminals-settled": [
    "term_fcc8d706-d4a1-46a2-ae1a-2bd14f28f547",
    "term_38f0eca6-b90f-4a21-97d5-ef6193e4e895",
    "term_e25b4c09-17a4-4d07-962b-1abed04d25bd"
  ],
  "lead2-terminals-after-12s": [
    "term_fcc8d706-d4a1-46a2-ae1a-2bd14f28f547",
    "term_38f0eca6-b90f-4a21-97d5-ef6193e4e895",
    "term_e25b4c09-17a4-4d07-962b-1abed04d25bd"
  ],
  "release-late-list": [
    "term_fcc8d706-d4a1-46a2-ae1a-2bd14f28f547",
    "term_e25b4c09-17a4-4d07-962b-1abed04d25bd"
  ],
  "cleanup-lead2-terminals-before": [
    "term_fcc8d706-d4a1-46a2-ae1a-2bd14f28f547",
    "term_e25b4c09-17a4-4d07-962b-1abed04d25bd"
  ],
  "remaining-terminals-a": [
    "term_fcc8d706-d4a1-46a2-ae1a-2bd14f28f547"
  ]
}
```

Bridge workers should omit `--keep-open` by default and rely on automatic release after settlement. The child worker, also started on an existing worktree without keep-open, auto-released too. A shell that `worktree create` had created in the child remained separately; releasing a worker did not close that shell. Keep session history and terminal-resource ownership separate from whether the Task completed.

## 5. Lead requests through the Bridge; settled-lead delivery

The exact control instruction in the first lead spec was:

> The Bridge alone owns orchestration and worktree creation. Do not run run-create, worker-start, dispatch, or any sub-dispatch, and do not launch agents. If you need child work, send a status message to your coordinator with subject CHILD_REQUEST and body {"request":"trivial-child","instruction":"Return CHILD_OK"}, using your injected --from and task/dispatch IDs.

It then had to report settlement while the child was pending. This prompt was additional to Orca's injected dispatch preamble. This is a measured prompt convention, not technical prevention of sub-dispatch by an adversarial agent.

Observed request and settlement:

```json
[
  {
    "id": "msg_09031acca202",
    "type": "status",
    "body": "{\"request\":\"trivial-child\",\"instruction\":\"Return CHILD_OK\"}",
    "payload": "{\"taskId\":\"task_285d1846b2f3\",\"dispatchId\":\"ctx_33f556d00691\"}"
  },
  {
    "id": "msg_f09d10076f73",
    "type": "worker_done",
    "body": "Requested child work from the Bridge. Child work is pending. The Bridge must deliver its result in a fresh session.",
    "payload": "{\"taskId\":\"task_285d1846b2f3\",\"dispatchId\":\"ctx_33f556d00691\",\"outcome\":\"succeeded\"}"
  }
]
```

Run-list commands at launch, first settlement, and follow-up settlement all returned the same id set (no next cursor). Other Run ids are opaque pre-existing history; no objectives or workspace names are exposed:

```json
{
  "runs-after-lead-start": [
    "run_455d8f43bf17",
    "run_c6869b75b912",
    "run_e8f9932d93e5",
    "run_legacy_local"
  ],
  "runs-after-lead-settled": [
    "run_455d8f43bf17",
    "run_c6869b75b912",
    "run_e8f9932d93e5",
    "run_legacy_local"
  ],
  "runs-after-lead2": [
    "run_455d8f43bf17",
    "run_c6869b75b912",
    "run_e8f9932d93e5",
    "run_legacy_local"
  ]
}
```

The Bridge received the child report in section 3, then used `worker-start --run "$RUN" --worktree "id:$WA"` with the child's message in the **new spec**. The old lead was already completed. This measured a new session, not a resumed session, and did not use `send` to reactivate a settled Dispatch.

New-session acknowledgement:

```json
[
  {
    "id": "msg_9bdd0b48f9dc",
    "type": "worker_done",
    "body": "Received CHILD_OK from the Bridge in a new session. The child Dispatch was ctx_b92c4738daf5. Nothing remains.",
    "payload": "{\"taskId\":\"task_eb3166eff56b\",\"dispatchId\":\"ctx_147eb74831cd\",\"outcome\":\"succeeded\"}"
  }
]
```

A production spec must include the durable thread context, child request identity, and child result identity; the Bridge must not assume the new session remembers its predecessor.

## 6. Agent killed without reporting

Started a fourth worker on the otherwise unused main worktree in repository B:

```sh
orca orchestration worker-start --run "$RUN" --worktree "id:$WB" --agent codex --model gpt-6-luna --effort low --spec "$FAULT_SPEC" --json
orca orchestration worker-show --dispatch "$FAULT_DISPATCH" --json --full
lsof -a -d cwd +d <tmp>/coord-spike-b -Fpcn
kill -KILL "$EXACT_CODEX_PID"
orca orchestration worker-show --dispatch "$FAULT_DISPATCH" --json --full
orca orchestration worker-list --run "$RUN" --json --full
```

The spec asked it to run a 60-second sleep and send no worker_done yet. `lsof` identified exactly one `codex` process with the new B main worktree as cwd; the driver killed that PID only. The worker-start receipt was ready; provider status before kill did not yet identify a model, so successful model selection/first task execution is not claimed. The process kill itself was real. The agent's enclosing shell remained alive.

```json
{
  "before": {
    "dispatchId": "ctx_a86d74ac2438",
    "dispatchStatus": "dispatched",
    "workerState": "ready",
    "observation": {
      "status": "live",
      "exactWorker": true,
      "agentWait": null
    },
    "projection": {
      "stage": {
        "worker": "ready",
        "dispatch": "dispatched",
        "detail": "input_accepted",
        "activity": "working"
      },
      "liveness": {
        "verdict": "live",
        "observedAt": 1794138477377,
        "source": "agent_status"
      },
      "attention": {
        "categories": [],
        "requiresAction": false
      }
    }
  }
}
```

```json
{
  "after": {
    "dispatchId": "ctx_a86d74ac2438",
    "dispatchStatus": "dispatched",
    "workerState": "ready",
    "observation": {
      "status": "live",
      "exactWorker": true,
      "agentWait": null
    },
    "projection": {
      "stage": {
        "worker": "ready",
        "dispatch": "dispatched",
        "detail": "input_accepted",
        "activity": "unknown"
      },
      "liveness": {
        "verdict": "unverifiable",
        "reason": "missing_status"
      },
      "attention": {
        "categories": [
          "unverifiable"
        ],
        "requiresAction": true
      }
    }
  }
}
```

Kill at `2026-11-08T11:47:57.757+00:00`. The first sampled `unverifiable/missing_status` projection occurred about `0.12` seconds later. After `32.84` seconds (50 bounded samples), the Dispatch was still `dispatched`, worker `ready`, outcome `in_progress`, and top-level observation `live/exactWorker:true`. There was no completion or exit escalation in the subsequent Run check. The projection and top-level observation therefore disagreed about what was knowable. No later automatic-exit deadline was established.

**Design:** use projection liveness/attention to display unknown when status evidence disappears; neither `ready` nor top-level `live` proves that the agent is working. This trial does not establish a reliable automatic "agent exited" signal for an agent killed within a live shell. Do not infer success, failure, or authorize automatic restart from missing status alone. This criterion is **not verified**, rather than guessed. For authorized test cleanup, guarded `worker-stop` then returned `stopped`, `processAction:closed_agent_terminal`, `ptyKilled:true`; release confirmed the resource was released. That proves cleanup, not autonomous exit detection.

### 6.1. Follow-up: read evidence, agentWait, and an unreported turn end

A second isolated run on the same Orca build measured the missing read paths, using two short `codex --model gpt-6-luna --effort low` workers. One new temporary Git repository was registered after fresh repository/worktree snapshots. Its only sessions were the test Bridge shell and these two workers, started sequentially without `--keep-open`:

```json
{
  "repoId": "4556580a-6f68-4fd4-8da7-db115b1d091a",
  "runId": "run_769570c66e4a",
  "killedDispatch": "ctx_51a075eb48b7",
  "killedTerminal": "term_422d3089-e48e-42b9-825f-84d2b76f7931",
  "unreportedDispatch": "ctx_455391daa66f",
  "unreportedTerminal": "term_e902bdb8-5360-4de4-a848-aed8b95e08e3"
}
```
Both workers used an existing exact selector in the disposable repository. Commands were actually run for both cases; `D`/`H` were the corresponding Dispatch/terminal ids above:

```sh
orca orchestration worker-start --run "$FOLLOWUP_RUN" --worktree "$FOLLOWUP_WORKTREE" --agent codex --model gpt-6-luna --effort low --spec "$PROBE_SPEC" --json
orca orchestration worker-show --dispatch "$D" --json --full
orca orchestration worker-read --dispatch "$D" --json --full
orca terminal read --terminal "$H" --screen --json
orca terminal read --terminal "$H" --json
# For the unreported turn, also page using the last observed cursor:
orca orchestration worker-read --dispatch "$D" --cursor "$WORKER_CURSOR" --json --full
orca terminal read --terminal "$H" --cursor 1 --json
```

The first spec required a `KILL_PROBE_READY` status before a 45-second sleep, with no completion report. After receipt of that status, `lsof -a -d cwd +d <temporary-repo> -Fpcn` found exactly one `codex` PID in that repository. `SIGKILL` targeted that exact PID. Unlike the original fault trial, this worker had already executed a status-send tool call; its transcript and screen identified GPT-6-Luna. The second spec explicitly instructed the agent to end its turn with `NO_REPORT_PROBE_ENDED`, without tools or any orchestration report. The transcript's final assistant message, rather than an echo of the user prompt, confirmed that behavior.

Measured reads (four post-event samples, nominal waits of 2, 2, and 4 seconds between complete read groups; actual elapsed times include RPC overhead). Kill-case elapsed time is relative to SIGKILL (negative for the before read); the unreported-turn elapsed time is relative to worker-start returning:

| Sample | Elapsed seconds | Projection liveness / requiresAction | activity | observation.agentWait | worker-read source / cursor hash | screen status / nextCursor |
|---|---:|---|---|---|---|---|
| kill-before | -0.44 | `live / false` | `working` | `null` | `transcript / 8b87a52575b68ac6` | `running / 1` |
| kill-after-0 | 0.42 | `unverifiable / true` | `unknown` | `null` | `terminal / 540c92b1426fd076` | `running / 1` |
| kill-after-1 | 3.00 | `unverifiable / true` | `unknown` | `null` | `terminal / 540c92b1426fd076` | `running / 1` |
| kill-after-2 | 5.57 | `unverifiable / true` | `unknown` | `null` | `terminal / 540c92b1426fd076` | `running / 1` |
| kill-after-3 | 10.11 | `unverifiable / true` | `unknown` | `null` | `terminal / 540c92b1426fd076` | `running / 1` |
| no-report-after-0 | 6.39 | `live / false` | `done` | `null` | `transcript / 1554c002838fa9c2` | `running / 1` |
| no-report-after-1 | 8.95 | `live / false` | `done` | `null` | `transcript / 1554c002838fa9c2` | `running / 1` |
| no-report-after-2 | 11.52 | `live / false` | `done` | `null` | `transcript / 1554c002838fa9c2` | `running / 1` |
| no-report-after-3 | 16.06 | `live / false` | `done` | `null` | `transcript / 1554c002838fa9c2` | `running / 1` |

Cursor hashes are the first 16 hexadecimal characters of SHA-256 of the actual opaque `worker-read.result.cursor`, used only to show equality without dumping opaque tokens. `observation.agentWait` was present and null on **every** sample: Orca had no detected human-wait evidence in either test. This is not an exercise of the non-null wait path; that behavior remains inconclusive.

For the killed agent, `worker-read` switched from `source:transcript` to `source:terminal` with `sourceExact:false` and `contentComplete:false`; its exact `fallbackReason` was `session_not_reported`, while projection liveness reported `missing_status`. All four post-kill cursor values matched. The rendered screen changed from the agent TUI to an idle shell prompt, while terminal status stayed `running`; no `exited` result was observed. Plain terminal reads after the kill returned `source:stream` with `nextCursor:"1"` and `latestCursor:"1"`, unchanged across samples. These readings corroborate a stalled assignment inside a live shell; they do not prove a generic automatic process-exit signal.

For the unreported turn, the screen showed the final marker and an idle agent prompt. The exact transcript read contained this final assistant message:

```json
{
  "dispatchId": "ctx_455391daa66f",
  "finalAssistantMessage": {
    "role": "assistant",
    "text": "NO_REPORT_PROBE_ENDED",
    "timestamp": 1794139696035
  },
  "observation": {
    "status": "live",
    "exactWorker": true,
    "agentWait": null
  },
  "projection": {
    "stage": {
      "worker": "ready",
      "dispatch": "dispatched",
      "detail": "input_accepted",
      "activity": "done"
    },
    "liveness": {
      "verdict": "live",
      "observedAt": 1794139696088,
      "source": "agent_status"
    },
    "attention": {
      "categories": [],
      "requiresAction": false
    }
  }
}
```
Its four `worker-read` cursors were unchanged, yet `projection.liveness.verdict` stayed `live`, activity was `done`, and `projection.attention.requiresAction` remained false. Subsequent three reads **with** the stored worker cursor returned `transcript.messages:[]`, `returnedMessageCount:0`, unchanged cursor, and `contentComplete:true`; matching terminal cursor reads returned:

```json
{
  "terminal": {
    "status": "running",
    "source": "stream",
    "nextCursor": "1",
    "latestCursor": "1",
    "returnedLineCount": 0,
    "limited": false,
    "truncated": false
  }
}
```
The screen reads also returned cursor `"1"` while the agent UI changed, so screen cursor equality alone is weak progress evidence. Use cursor paging and record the returned source; reset the baseline when `worker-read` changes source. Initial whole-transcript reads were clipped (`contentComplete:false`), so their text is not claimed complete. The subsequent empty cursor pages were complete.

Crucially, Orca sent an explicit escalation for the normally ended, unreported turn, even while the above status fields stayed live/ready:

```json
{
  "id": "msg_stop_939fc0d84bfd5d3a8eb0d2d2",
  "type": "escalation",
  "subject": "Worker stopped without reporting",
  "payload": "{\"taskId\":\"task_ff841d6019ae\",\"dispatchId\":\"ctx_455391daa66f\",\"handle\":\"term_e902bdb8-5360-4de4-a848-aed8b95e08e3\",\"stopReason\":\"finished\"}",
  "sequence": 30,
  "created_at": "2026-11-08T12:08:17Z"
}
```
The payload's `stopReason:"finished"` and exact Dispatch identity are a usable interruption signal for this case; the process itself has not exited. No corresponding missing-report escalation for the killed worker appeared in this run's inbox. Thus ordinary turn-end detection is **verified in this trial**, while reliable detection of a killed agent inside its live shell remains **not verified**. Human-wait detection and a terminal read returning `exited` remain **inconclusive**, because neither occurred in these probes.

The Bridge policy now connects these findings to the card states: transient unverifiable evidence shows status unknown; persisting unverifiable evidence with requiresAction, past a grace window of two poll cycles and no cursor progress, shows lead interrupted. An explicit terminal `exited` or a correlated stopped-without-reporting escalation also shows interrupted. This is a proposed Bridge policy, not a measured Slack UI. M2 offers owner-directed recovery; fence the predecessor using worker-stop or worker-abandon before replacement. Never auto-restart, never equate interrupted work with proven OS process death, and do not classify human waits or silence alone as interruption.

Follow-up recovery read, actually executed:

```sh
orca orchestration inbox --terminal "run:$FOLLOWUP_RUN" --limit 1000 --json --full
```

```json
{
  "count": 2,
  "messages": [
    {
      "id": "msg_stop_939fc0d84bfd5d3a8eb0d2d2",
      "sequence": 30,
      "type": "escalation",
      "read": 0
    },
    {
      "id": "msg_2dabb004381b",
      "sequence": 29,
      "type": "status",
      "read": 0
    }
  ]
}
```

The 1000-row request succeeded and returned two rows. The ledger must retain each message id and its `sequence` from inbox (the original consuming-check excerpts did not include sequence). On startup, coverage is complete only if `count < 1000` or the oldest returned message overlaps an existing ledger row with the same id and sequence; otherwise flag a gap instead of promising no loss. The full-1000/overlap boundary and historical retention were not exercised here; those remain design rules requiring later tests, not measured guarantees. [Example 12 and the recovery paragraph](../brief.md#4-架构) use the same rule.

Cleanup stopped and released both exact Dispatches (`state:stopped`, `processAction:closed_agent_terminal`, followed by `state:released`), closed only the created Bridge shell, deregistered only the new setup id, and removed the temporary repository and private probe files. Both resources were recorded `terminalState:released`; no default worker auto-release is expected before an accepted worker_done, which neither test sent. No reset was run; inert audit history remains as in the original trial. Main checkout HEAD and clean status matched the fresh baseline. New before/after inventory projection:

```json
{
  "repos": {
    "beforeCount": 25,
    "afterCount": 25,
    "added": [],
    "removed": [],
    "beforeOriginalIdsSha256": "4c97d3bf606a23b0bdacf3059191581b0d4ce1b459ebf54919ba2e3f720862c6",
    "afterOriginalIdsSha256": "4c97d3bf606a23b0bdacf3059191581b0d4ce1b459ebf54919ba2e3f720862c6"
  },
  "worktrees": {
    "beforeCount": 27,
    "afterCount": 27,
    "added": [],
    "removed": [],
    "beforeOriginalIdsSha256": "556e5d47f5e97f6e06d444a568e0b6035b4e1e08e81ab02192574bcf7b10474e",
    "afterOriginalIdsSha256": "556e5d47f5e97f6e06d444a568e0b6035b4e1e08e81ab02192574bcf7b10474e"
  }
}
```

## 7. Cleanup and before/after inventories

Cleanup targeted only ids created by this spike:

```sh
orca orchestration worker-stop --dispatch ctx_a86d74ac2438 --json --full
orca orchestration worker-release --dispatch "$CREATED_DISPATCH" --json --full
orca terminal close --terminal "$CREATED_BRIDGE_OR_CHILD_SHELL" --json
orca worktree rm --worktree "id:$CHILD" --json
orca project setup-delete --setup "$B" --host local --force --json
orca project setup-delete --setup "$A" --host local --force --json
orca repo list --json
orca worktree list --limit 10000 --json
```

`CREATED_DISPATCH` ranged over the four ids recorded above; default-released resources returned `already_released`. The two shell handles explicitly closed were the Bridge and `term_965f6993-6f40-492b-9bfb-99c1b10da42b` (child's unused default shell). The temporary root was deleted after deregistration; its existence check returned false. The private harness/evidence scratch directory was also removed after extracting this report. No existing terminal was closed and no existing worktree was removed.

The following normalized lists are the actual before/after inventory projections. `R01…` and `W01…` are stable aliases assigned to the same original ids in both snapshots, so private names and paths do not enter the public repository. SHA-256 values below hash sorted **original id lists**, serialized as compact JSON, before aliasing. Full raw envelopes are not claimed byte-identical: repository records matched; worktree UI sortOrder changed throughout, and three rows also changed isUnread or lastActivityAt. Those fields were not restored because doing so would mutate unrelated workspaces. Worktree membership, repository assignment, instance identity, Git branch and HEAD, and lineage all matched.

```json
{
  "repos": {
    "before": [
      "R01",
      "R02",
      "R03",
      "R04",
      "R05",
      "R06",
      "R07",
      "R08",
      "R09",
      "R10",
      "R11",
      "R12",
      "R13",
      "R14",
      "R15",
      "R16",
      "R17",
      "R18",
      "R19",
      "R20",
      "R21",
      "R22",
      "R23",
      "R24",
      "R25"
    ],
    "after": [
      "R01",
      "R02",
      "R03",
      "R04",
      "R05",
      "R06",
      "R07",
      "R08",
      "R09",
      "R10",
      "R11",
      "R12",
      "R13",
      "R14",
      "R15",
      "R16",
      "R17",
      "R18",
      "R19",
      "R20",
      "R21",
      "R22",
      "R23",
      "R24",
      "R25"
    ],
    "added": [],
    "removed": [],
    "beforeOriginalIdsSha256": "4c97d3bf606a23b0bdacf3059191581b0d4ce1b459ebf54919ba2e3f720862c6",
    "afterOriginalIdsSha256": "4c97d3bf606a23b0bdacf3059191581b0d4ce1b459ebf54919ba2e3f720862c6"
  }
}
```

```json
{
  "worktrees": {
    "before": [
      "W01",
      "W02",
      "W03",
      "W04",
      "W05",
      "W06",
      "W07",
      "W08",
      "W09",
      "W10",
      "W11",
      "W12",
      "W13",
      "W14",
      "W15",
      "W16",
      "W17",
      "W18",
      "W19",
      "W20",
      "W21",
      "W22",
      "W23",
      "W24",
      "W25",
      "W26",
      "W27"
    ],
    "after": [
      "W01",
      "W02",
      "W03",
      "W04",
      "W05",
      "W06",
      "W07",
      "W08",
      "W09",
      "W10",
      "W11",
      "W12",
      "W13",
      "W14",
      "W15",
      "W16",
      "W17",
      "W18",
      "W19",
      "W20",
      "W21",
      "W22",
      "W23",
      "W24",
      "W25",
      "W26",
      "W27"
    ],
    "added": [],
    "removed": [],
    "beforeOriginalIdsSha256": "556e5d47f5e97f6e06d444a568e0b6035b4e1e08e81ab02192574bcf7b10474e",
    "afterOriginalIdsSha256": "556e5d47f5e97f6e06d444a568e0b6035b4e1e08e81ab02192574bcf7b10474e"
  }
}
```

Main checkout check:

```text
before HEAD: 51949c7d618060ebe25cf89343372107d9adadd2
after  HEAD: 51949c7d618060ebe25cf89343372107d9adadd2
before git status --porcelain=v1: <empty>
after  git status --porcelain=v1: <empty>
```

**Retained audit history:** Orca preserves the test Run, four Tasks/Dispatches, message history, and release archives after resources are removed. All four worker resources were released, and no test repository, worktree, terminal, agent, or temporary repository file remains. The installed CLI exposes reset scopes `--all`, `--tasks`, and `--messages`, without an explicit Run selector. A global reset was not attempted because it could touch pre-existing coordination state. Criterion 7 checks repository/worktree inventories and the main checkout; retained inert audit history does not change that invariant. No reset was run. An attempted final Run-list `--limit 1000` was rejected (maximum 100); the final valid read used 100. That refusal had no effects.

## Bridge design and brief updates

Use the measured path: own authenticated Bridge caller → one Run → exact worktree creation with explicit parent → worker-start with the same Run. Make leads request child work as durable messages. Start a new lead session on the retained worktree to deliver a child result after settlement, supplying all context explicitly. Track Task outcome, Dispatch identity, session/terminal resource, worktree lineage, and liveness evidence independently. Keep-open is a resource choice, not a Task state.

For reporting, persist peek, consume, persist the entire returned batch, send, then mark sent; reconcile inbox including read messages on startup. Retain each message’s sequence from inbox, request 1000 rows, and mark coverage complete only when count is below 1000 or the oldest returned row overlaps the ledger; otherwise flag a gap (section 6.1). The late-message crash test shows why peek persistence alone is insufficient. Use message-id deduplication and a replayable outbox; possible duplicate downstream sends remain part of the design. Reconciliation coverage/retention must be explicit before promising no lost messages. Store unknown liveness when evidence disappears and leave recovery decisions to the authorized owner.

Changes to the product brief are deliberately narrow:

1. Recovery uses `inbox --terminal run:<run_id> --limit 1000 --json --full`, records message sequence, and checks oldest-row ledger overlap before accepting a full page as complete; Example 12 links the rule.
2. Lead status and Example 17 connect transient unknown evidence to interruption after the default two-cycle grace window and stalled cursors, terminal exit, or a correlated missing-report escalation; recovery fences the old Dispatch first and never auto-restarts.
3. Bridge workers omit `--keep-open` by default and rely on auto-release after settlement.
4. The measurement links and remaining-risk list distinguish measured local behavior from unverified Slack integration; personal and prototype-branch labels use neutral wording.

References: [docs/brief.md:299](../brief.md#4-架构), [docs/brief.md:311](../brief.md#5-交付里程碑), [docs/brief.md:330](../brief.md#7-未验证). Slack behavior, worktree deletion/session recovery, remote execution, and OpenViking attachment remain outside this experiment.

## 8. Public-safety and validation probe

The report was scanned for home/volume paths, common credential forms, and a private denylist generated from pre-existing repository/workspace names. Existing machine paths were normalized before writing; raw private snapshots were never added to git. The public probe below represents the path pattern with a variable supplied by the private scanner so the pattern itself is not embedded in this report:

```sh
rg -n -i "${PRIVATE_PATH_PATTERN:?Supply the private scanner path pattern}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----" docs/spikes/2026-11-08-orca-coordination.md
# stdout: <empty>; exit 1 (no matches)
# Private pre-existing-name denylist: no matches.
git diff --check
# stdout: <empty>; exit 0
```

No code test suite applies to this documentation-only change. Validation consists of the real runtime probes above, inventory/cleanup comparisons, privacy checks, report-id consistency, and diff whitespace checks. No PR was opened or merged.
