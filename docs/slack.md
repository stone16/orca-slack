# Slack adapter

[`src/render.ts:69`](../src/render.ts#L69) exports pure `renderStatus`, `renderDecision`, and `renderResult` functions.
Their inputs are plain `StatusView`, `DecisionView`, and `ResultView` objects, without a Store or Orca dependency.
The caller supplies worktree state, commit presence, PR metadata, and the Linear link.
Unknown and interrupted are distinct display states. Rendering does not infer process exit or restart an agent.

## Connect the boundary

[`createSocketMode(store, options, log)`](../src/bolt.ts#L193) returns `{ app, adapter, socket }`.
The factory reads `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` from the environment. It accepts no credential arguments or credential files.
Its Bolt, Socket Mode, and Web API logger sends redacted strings to the optional `log(level, message)` callback.
Tokens embedded in error messages or structured logger arguments are redacted too.

The caller supplies these [`AdapterOptions`](../src/bolt.ts#L17) members:

| Member | Responsibility |
|---|---|
| `orca` | The existing Orca port. |
| `allowedUsers` | The configured Slack user allowlist. |
| `botId` | The Slack bot user ID used in mentions. |
| `statusView(threadId)` | Return the current plain status view, or `undefined` before a view exists. |
| `ownerAction(action)` | Execute an authorized retry, repository switch, or cleanup. |
| `logTail(threadId)` | Read the thread's log tail for the modal. |

Call `app.start()` to connect, and `app.stop()` to disconnect. This slice does not start a daemon.
The returned `socket` is available for connection monitoring in the later daemon task.
Use `adapter.bridge.replay()` for the existing durable inbound recovery path.

Call [`adapter.status(view)`](../src/bolt.ts#L67), [`adapter.decision(view)`](../src/bolt.ts#L75), and [`adapter.result(view)`](../src/bolt.ts#L89) to publish the three message types.
The thread must already exist in Store. Decision publication also saves the options and Slack timestamp for the existing Bridge authorization path.
Result IDs must identify the report, so replay updates its existing message rather than creating another result.
The caller must keep owner-action handlers idempotent across a crash after an external effect and before its local receipt.

[`Store.saveSlackCard`](../src/store.ts#L206) persists each message timestamp and its last view.
Status publications use one key per thread. Decision and result publications use their respective IDs.
Updates target the saved timestamp, including after reopening the database.
A crash between a successful initial Slack post and saving its timestamp can still duplicate that first post.

## Interactions

The [real Bolt listeners](../src/bolt.ts#L173) accept message, mention, and button payloads.
Inbound normalization keeps the app and installation identity, event ID, channel, message timestamp, and thread timestamp.
The existing Bridge stores and deduplicates the normalized event before forwarding.
Bot output, edits, deletions, and unrelated message subtypes are ignored.

Button envelopes are [acknowledged before Bridge actions execute](../src/bolt.ts#L185).
The adapter binds each click to a saved channel, thread, and message timestamp, checks current status eligibility, and then uses Bridge authorization.
Only allowlisted users can stop work. Decisions, repository switches, retries, cleanup, and log tails require the owner.
[Refusals use `chat.postEphemeral`](../src/bolt.ts#L36), addressed only to the refused user.
The [log-tail action](../src/bolt.ts#L39) uses `views.open` with plain text, limited to the last 40 lines and 3,000 characters.

Slack buttons have no disabled field. After an accepted decision, repository switch, cleanup, or retry, the card replaces the used controls with muted context text naming the user.
The documented button fields are in the [Slack button reference](https://docs.slack.dev/reference/block-kit/block-elements/button-element).
The [adapter uses `eyes`](../src/bolt.ts#L105) only for a received prompt and `white_check_mark` only after Store marks that prompt forwarded.
Neither reaction indicates that the agent read the prompt or that work succeeded.

## Verification boundary

[`test/render.test.ts:27`](../test/render.test.ts#L27) asserts block content and a state-by-button matrix without snapshots.
[`test/bolt.test.ts:76`](../test/bolt.test.ts#L76) feeds fixed payload fixtures through real Bolt listeners, the real Bridge, and SQLite.
It also feeds envelopes through the actual Socket Mode receiver, without opening a socket connection.
Only Slack API calls and the Orca command boundary are scripted.
The fixtures in `test/fixtures/` record representative wire shapes with fabricated IDs and text, without workspace credentials.

The [event payload](https://docs.slack.dev/reference/events/message/) and [button payload](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/) references define those external shapes.
No real Slack workspace, Linear ticket, Orca worktree, or Git worktree is driven by these tests.
Live workspace acceptance and daemon wiring remain for the milestone acceptance task.
