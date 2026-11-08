# orca-slack

Slack thread ⇄ [Orca](https://onorca.dev) orchestration bridge. One requirement = one thread = one worktree = one PR; questions that change no code need no worktree.

A small always-on process on the machine that runs Orca: it listens to Slack (Socket Mode), starts an Orca coordinator per thread with `orca orchestration worker-start`, relays the coordinator's questions and reports back into the thread, and lets the thread stop it. No board, no tracker, no agent mesh.

Status: requirements aligned, tech spec in progress, P0 code exists on a side branch and has not run against a live Slack app yet.

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

## Layout

```
docs/features.md         requirement list (P0 / P1 / P2 / not doing) and lessons folded in
docs/feature-matrix.md   64 feature points × us × three references, with decisions
```

The P0 implementation lives on branch `stone/p0-bridge` until the tech spec settles.
