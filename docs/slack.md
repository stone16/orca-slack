# Slack adapter

[`src/render.ts:91`](../src/render.ts#L91) exports pure `renderStatus`, `renderDecision`, and `renderResult` functions.
Their inputs are plain `StatusView`, `DecisionView`, and `ResultView` objects, without a Store or Orca dependency.
The caller supplies worktree state, commit presence, PR metadata, and the Linear link.
Unknown and interrupted are distinct display states. Rendering does not infer process exit or restart an agent.

## Connect the boundary

[`createSocketMode(store, options, log)`](../src/bolt.ts#L247) returns `{ app, adapter, socket }`.
The factory reads `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` from the environment. It accepts no credential arguments or credential files.
Its Bolt, Socket Mode, and Web API logger sends redacted strings to the optional `log(level, message)` callback.
Tokens embedded in error messages or structured logger arguments are redacted too.

The caller supplies these [`AdapterOptions`](../src/bolt.ts#L17) members:

| Member | Responsibility |
|---|---|
| `orca` | The existing Orca port. |
| `allowedUsers` | The configured Slack user allowlist. |
| `botId` | The Slack bot user ID used in mentions. |
| `statusView(threadId)` | Read the current plain status view, or return `undefined` before a view exists. Do not publish cards from this callback. |
| `ownerAction(action)` | Execute an authorized retry, repository switch, or cleanup. |
| `logTail(threadId)` | Read the thread's log tail for the modal. |

Call `app.start()` to connect, and `app.stop()` to disconnect. This slice does not start a daemon.
The returned `socket` is available for connection monitoring in the later daemon task.
Use [`adapter.replay(threadId?)`](../src/bolt.ts#L154) at startup and after a lead becomes available.
It replays durable inbound prompts and completes their delivery reactions, including prompts forwarded by a later message.

Call [`adapter.status(view)`](../src/bolt.ts#L81), [`adapter.decision(view)`](../src/bolt.ts#L100), and [`adapter.result(view)`](../src/bolt.ts#L120) to publish the three message types.
The thread must already exist in Store. Decision publication also saves the options and Slack timestamp for the existing Bridge authorization path.
Result IDs must identify the report, so replay updates its existing message rather than creating another result.
The caller must keep owner-action handlers idempotent across a crash after an external effect and before its local receipt.
For button actions, `action.operationKey` identifies that operation and remains stable across UI retries.

[`Store.saveSlackCard`](../src/store.ts#L319) persists each message timestamp and its confirmed displayed view after Slack accepts the post or update.
Status publications use one key per thread. Decision and result publications use their respective IDs.
Updates target the saved timestamp, including after reopening the database.
Completed actions and delivered reactions have separate durable receipts.
A failed update leaves the displayed view unchanged; another click retries the UI update without repeating a completed owner action.
A crash between a successful initial Slack post and saving its timestamp can still duplicate that first post.

## Interactions

The [real Bolt listeners](../src/bolt.ts#L227) accept message, mention, and button payloads.
Inbound normalization keeps the app and installation identity, event ID, channel, message timestamp, and thread timestamp.
The existing Bridge stores and deduplicates the normalized event before forwarding.
Bot output, message edit/delete subtypes, and unrelated message subtypes are ignored.

Button envelopes are [acknowledged before Bridge actions execute](../src/bolt.ts#L239).
The adapter binds each click to a saved channel, thread, and message timestamp, checks current status eligibility, and then uses Bridge authorization.
Clicks against an outdated worktree set refresh the card without executing the owner action.
Only allowlisted users can stop work. Decisions, repository switches, retries, cleanup, and log tails require the owner.
[Refusals use `chat.postEphemeral`](../src/bolt.ts#L38), addressed only to the refused user.
The [log-tail action](../src/bolt.ts#L41) uses `views.open` with plain text, limited to the last 40 lines and 3,000 characters.

Slack buttons have no disabled field. After an accepted decision, repository switch, cleanup, or retry, the card replaces the used controls with muted context text naming the user.
The documented button fields are in the [Slack button reference](https://docs.slack.dev/reference/block-kit/block-elements/button-element).
The [adapter uses `eyes`](../src/bolt.ts#L158) only for a received prompt and `white_check_mark` only after Store marks that prompt forwarded.
Neither reaction indicates that the agent read the prompt or that work succeeded.
The log-tail button remains available after retry.
[Oversized message text](../src/render.ts#L58) truncates at 3,000 characters per section, 50 blocks, and 4,000 characters in the notification fallback, while keeping entities, links, and Unicode pairs intact.
