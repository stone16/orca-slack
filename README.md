# orca-slack

Slack thread ⇄ [Orca](https://onorca.dev) orchestration bridge. One piece of work = one Slack thread with one lead agent, which can drive several worktrees and PRs; see docs/brief.md.

The Bridge runs on the machine that runs Orca. Slack is the entry and reporting surface; Orca runs the agents. The product behavior is defined in [docs/brief.md](docs/brief.md).

Status: the TypeScript runtime composes the core modules and runs as a user LaunchAgent. Full product acceptance remains for the milestone acceptance task.

See [the runtime guide](docs/runtime.md) for ignored operator configuration, environment secrets, startup recovery, shutdown, and installation.

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

[Store](src/store.ts#L38) uses `node:sqlite` for threads, worktrees, pull requests, lead sessions, decisions, and delivery records.
[Bridge](src/slack.ts#L16) saves inbound Slack messages before forwarding and gates actions by allowlist and owner.
The caller supplies normalized Slack events, refusal delivery, and the authorized retry, cleanup, and repository-switch handlers.
The [Slack adapter guide](docs/slack.md) describes rendering, saved card timestamps, and the Socket Mode boundary.

Use one [ReportLoop](src/report-loop.ts#L7) per Orca Run and one Bridge instance per Slack app.
At startup, call `ReportLoop.recover()` and `Bridge.replay()` before scheduling `ReportLoop.poll()`.
With the Slack adapter, use `adapter.replay()` so queued prompts also receive delivery reactions.
The report sender receives a durable report and resolves after the downstream send succeeds.
A crash after send and before its sent marker can repeat that report on recovery.
A known inbox coverage gap stays recorded in `Store.coverage(runId)`.

## Track pull requests and confirm cleanup

[PrPoller](src/pr-poller.ts#L5) queries `gh pr list` for every retained worktree with its repository, branch, and all PR states.
`poll()` returns and acknowledges pending PR changes, plus per-worktree failures; unchanged PRs produce no new update.
`poll(threadId, onChange)` acknowledges each change only after its callback succeeds.
`start(onChange, onFailure)` schedules a poll every 60 seconds, skips overlapping timer ticks, and returns a function that stops future ticks.
Callbacks may complete asynchronously; a poll remains busy until they settle.
Use `poll(undefined, onChange)` for startup delivery with acknowledgment after the callback succeeds.
Callback exceptions do not stop other PR updates or polling ticks; change-callback errors are reported through `onFailure`.
Failed changes remain in SQLite for retry, including across restarts and worktree cleanup, with later transitions for the same PR held behind them.
A crash after delivery and before acknowledgment can repeat a change.
Malformed responses, truncated results, and command failures preserve the last known state and retry on the next poll.

Use one [Cleanup](src/cleanup.ts#L20) instance per Bridge.
`check(worktreeId)` reads a fresh GitHub snapshot without consuming the periodic poller's changes, then checks the thread's PRs and agents before inspecting the target worktree with Git.
It refuses missing PRs, unknown activity, unmerged PRs, the main checkout, changed branches, dirty files including ignored files, stashes, and a HEAD different from the target's latest merged PR head.
The latest PR is the one with the highest PR number.
It compares `headRefOid`, so squash merges pass.

After an explicit owner confirmation, call `confirm(worktreeId, ownerId)` through the existing Bridge owner-action handler.
It saves the PR links and merged state atomically with the final commit, confirmation receipt, session identities, and matching reports before asking Orca to remove that exact worktree instance.
It checks safety again after saving and never passes `--force` or `--delete-branch`.
Retrying a saved confirmation rechecks safety; an absent Orca entry and absent directory complete recovery without another deletion.
`Store.cleanupReceipts(threadId)` retains the history after cleanup, and cleaned worktrees leave the poller's active set.
Deleted worktrees' PR history does not block cleanup of the remaining worktrees.
The ledger file must remain outside any worktree being removed.
The runtime connects cleanup to the owner-confirmed Slack action.

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

Use [Leads](src/leads.ts#L16) with a [LeadCli](src/lead-orca.ts#L10), the existing Store, one Bridge-owned Run ID, configured repository IDs and aliases, bot ID, and agent ID. Pass that Leads instance as the seventh Bridge constructor argument. The existing inbound and permission handling remains the entry point.

Call `leads.report(report)` from the ReportLoop delivery callback before rendering the report. Schedule `leads.poll()` to update durable lead events from Orca read evidence. Active sessions and unresolved questions are read from SQLite after restart. The [integration driver](scripts/lead-integration.mjs#L34) shows the composition with scripted Slack events and real Orca execution.

```sh
npm run build
node scripts/lead-integration.mjs
```

The driver uses only a disposable repository, worktree, terminal, and Run. It asks one question, saves and answers the decision, receives completion, and removes its live resources.

## Retain threads before repository selection

[UnboundThreads](src/unbound-threads.ts) stores original Slack messages in the ignored `data/threads/` directory.
Pass it as the eighth Bridge constructor argument, after the optional Leads instance.
Bridge registers the Store so retention checks current repository bindings even when no new Slack message arrives.

```ts
const unboundThreads = new UnboundThreads({
  checkout,
  archiveDirectory: settings.archiveDirectory,
  retentionDays: settings.retentionDays,
});
const bridge = new Bridge(orca, slack, store, allowedUsers, botId, undefined, leads, unboundThreads);
```

The archive location has no default and belongs in operator configuration.
After mounting the intended archive, create its marker once:

```sh
touch "$ARCHIVE_DIRECTORY/.orca-slack-archive"
```

The archive is available only while that regular marker file exists inside the configured directory.
Create the marker on the mounted share, never in its unmounted directory stub.
Missing markers and unavailable shares keep incoming messages local for the next run, regardless of device numbers.
The code never creates the configured archive directory or marker.
Overlapping storage paths, including aliases and nested directories, are rejected.

Call `archiveExpired()` from the host's retention job.
The default retention is 30 days after the last activity; `retentionDays` accepts a positive number.
Bound threads stay out of the sweep.
Standalone users can supply `isBound(id)` in the options or call `trackBindings(store)`.

`read(id)` merges local and available archived history, deduplicates Slack redelivery, and orders messages by timestamp.
`append(thread, event)` and `reactivate(id)` durably save that merged history locally before removing the archived snapshot.
Replies received while the archive is unavailable stay local and merge when the mounted archive returns.

Archive writes use a verified temporary file and atomic rename before deleting the unchanged local source.
Older valid archives merge into the replacement; damaged or non-regular archive records stay untouched and appear in `retained`.
They do not block local reads or incoming replies.
Legacy recovery files also appear in `retained`, including when no local record exists; retention cannot declare a clean archive until an operator resolves them.
One corrupt local record is reported without blocking the remaining records.
SQLite locks under `data/` serialize each thread's writes and retention across processes and release on process exit.
Reads use read-only transactions, and a sweep releases each record's lock before processing another.
A slow archive copy does not lock out other threads.
Processes using the same archive namespace must share the checkout and its lock directory.

The archive tests use `hdiutil` on macOS to mount and remove a disposable disk image.
They also exercise an ordinary local directory as an unmounted stub and a full archive filesystem.

## Protect Git pushes across worktrees

[installPushGuard](src/push-guard.ts) accepts a repository checkout and a configured hooks directory outside every worktree.
It installs an executable `pre-push` hook and sets shared local `core.hooksPath` for existing and future worktrees.
Conflicting hook configuration and existing hooks that would otherwise be disabled are preserved by refusing installation.
Installation on real repositories belongs to deployment.

The hook queries the destination's symbolic `HEAD` and blocks every default-branch update or deletion.
It rejects non-fast-forward feature updates, including history rewrites requested with `--force` or `--force-with-lease`.
New feature branches, new tags, and feature fast-forwards remain allowed even with force flags because they rewrite no history.
Unknown defaults, unavailable ancestry, feature deletions, replacement or deletion of existing tags, and arbitrary ref namespaces fail closed.

A client hook can be bypassed with `--no-verify` or Git configuration, so server branch protection remains the backstop.
The hook cannot distinguish a normal push from the same new-ref or fast-forward push with a force flag.

Run the real push drive against disposable repositories:

```sh
PUSH_GUARD_EVIDENCE=1 npm test -- test/push-guard.test.ts --reporter=verbose --silent=false
```
