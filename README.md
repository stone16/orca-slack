# orca-slack

Slack thread ⇄ [Orca](https://onorca.dev) orchestration bridge. One piece of work = one Slack thread with one lead agent, which can drive several worktrees and PRs; see docs/brief.md.

The Bridge runs on the machine that runs Orca. Slack is the entry and reporting surface; Orca runs the agents. The product behavior is defined in [docs/brief.md](docs/brief.md).

Status: M1 slice 1 provides the tested TypeScript core with scripted Slack delivery. Live Slack integration and deployment remain for milestone acceptance.

- Product brief, the baseline for what we build: [docs/brief.md](docs/brief.md)
- Requirements and priorities: [docs/features.md](docs/features.md)
- Feature matrix against three reference bridges, with the 2026-11-07 decisions: [docs/feature-matrix.md](docs/feature-matrix.md)

## What we studied, and what we did not copy

Before writing anything we read the source of three open Slack→Orca bridges and one agent platform, and wrote per-feature inventories of each. **We studied their designs and recorded lessons; we did not copy code from any of them.** All code in this repository is written from our own requirements.

| Project | Licence | What we took from it |
|---|---|---|
| [dnhynk/dev-infra](https://github.com/dnhynk/dev-infra) `apps/orca-slack-bridge` | MIT | Measured facts about the `orca orchestration` CLI (e.g. `check` consumes deliveries, `worker_done.payload` is a JSON string), the "ack after persisting" discipline, decision-gate card design |
| [pawel-kotowski/slack-agent](https://github.com/pawel-kotowski/slack-agent) | none stated | Operational lessons from its `NOTES.md`: dual `app_mention` + `message` events for one message, disabling terminal question tools, approval fatigue and what a dangerous-command gate should actually catch, keeping worktrees that hold unpushed work |
| [facumoyano/slack-bot](https://github.com/facumoyano/slack-bot) | none stated | The thread → `worker-start` → `send`/`reply` → `worker-release` shape, one-dispatch-per-follow-up on a shared worktree, rate-limited progress messages, "post first, then record" |
| [multica-ai/multica](https://github.com/multica-ai/multica) | Apache-2.0 | Its Slack ingestion dedup key `(installation, ts)` and its WebSocket wake + batch-claim transport, which told us we do not need a claim queue when the bridge and Orca share a machine |

Where a referenced project has no licence, we treated it as all-rights-reserved: design observations only, cited by file and line in `docs/feature-matrix.md`, nothing reused.

## Develop the core

Node.js 24 or newer is required.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

[Store](src/store.ts#L37) uses `node:sqlite` for threads, worktrees, pull requests, lead sessions, decisions, and delivery records.
[Bridge](src/slack.ts#L16) saves inbound Slack messages before forwarding and gates actions by allowlist and owner.
The caller supplies normalized Slack events, refusal delivery, and the authorized retry, cleanup, and repository-switch handlers.

Use one [ReportLoop](src/report-loop.ts#L7) per Orca Run and one Bridge instance per Slack app.
At startup, call `ReportLoop.recover()` and `Bridge.replay()` before scheduling `ReportLoop.poll()`.
The report sender receives a durable report and resolves after the downstream send succeeds.
A crash after send and before its sent marker can repeat that report on recovery.
A known inbox coverage gap stays recorded in `Store.coverage(runId)`.

## Track pull requests and confirm cleanup

[PrPoller](src/pr-poller.ts#L5) queries `gh pr list` for every retained worktree with its repository, branch, and all PR states.
`poll()` returns changed PRs and per-worktree failures; unchanged PRs produce no update.
`start(onChange, onFailure)` schedules a poll every 60 seconds, skips overlapping timer ticks, and returns a function that stops future ticks.
Callbacks may complete asynchronously; a poll remains busy until they settle.
Call `poll()` directly for startup reconciliation.
Callback exceptions do not stop later updates or polling ticks; change-callback errors are reported through `onFailure`.
Malformed responses, truncated results, and command failures preserve the last known state and retry on the next poll.

Use one [Cleanup](src/cleanup.ts#L20) instance per Bridge.
`check(worktreeId)` reads a fresh GitHub snapshot without consuming the periodic poller's changes, then checks the thread's PRs and agents before inspecting the target worktree with Git.
It refuses missing PRs, unknown activity, unmerged PRs, the main checkout, changed branches, dirty files including ignored files, stashes, and a HEAD different from the target's latest merged PR head.
The latest PR is the one with the highest PR number.
It compares `headRefOid`, so squash merges pass.

After an explicit owner confirmation, call `confirm(worktreeId, ownerId)` through the existing Bridge owner-action handler.
It saves the PR links, final commit, confirmation receipt, session identities, and matching reports before asking Orca to remove that exact worktree instance.
It checks safety again after saving and never passes `--force` or `--delete-branch`.
Retrying a saved confirmation rechecks safety; an absent Orca entry and absent directory complete recovery without another deletion.
`Store.cleanupReceipts(threadId)` retains the history after cleanup, and cleaned worktrees leave the poller's active set.
The ledger file must remain outside any worktree being removed.
Button rendering and live Slack integration remain for the runtime slice.

Run the disposable Git safety drive after building:

```sh
npm run build
node scripts/cleanup-integration.mjs
```

The driver uses real Git and scripted GitHub and Orca boundaries.
It exercises dirty files, a stash, a running-agent response, a changed HEAD, and a real squash merge, then removes its temporary repositories.

## Check the real Orca boundary

With Orca running and its default Codex agent available:

```sh
npm run test:orca
```

[The integration driver](scripts/orca-integration.mjs#L98) creates a temporary repository, an authenticated Bridge terminal, one Run, and one trivial worker.
It sends reports to a local sink and prints message ids, inbox sequence, and cleanup evidence.
It releases the worker, closes its terminal, deregisters its repository, removes temporary files, and compares repository/worktree membership.
Orca retains inert Run, Task, Dispatch, and message audit history.
On an uncertain worker failure, the driver retains its disposable resources for exact recovery and exits unsuccessfully.

The earlier prototype remains on branch `stone/p0-bridge`.

## Route threads and manage leads

Use [Leads](src/leads.ts#L16) with a [LeadCli](src/lead-orca.ts#L10), the existing Store, one Bridge-owned Run ID, configured repository IDs and aliases, bot ID, and agent ID. Pass that Leads instance as the final Bridge constructor argument. The existing inbound and permission handling remains the entry point.

Call `leads.report(report)` from the ReportLoop delivery callback before rendering the report. Schedule `leads.poll()` to update durable lead events from Orca read evidence. Active sessions and unresolved questions are read from SQLite after restart. The [integration driver](scripts/lead-integration.mjs#L34) shows the composition with scripted Slack events and real Orca execution.

```sh
npm run build
node scripts/lead-integration.mjs
```

The driver uses only a disposable repository, worktree, terminal, and Run. It asks one question, saves and answers the decision, receives completion, and removes its live resources.
