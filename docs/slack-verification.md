# Slack slice verification

Branch `stone16/m1-slack-ui`. The commit is recorded in the worker completion receipt.

## Acceptance evidence

All six criteria are **verified** against their specified test or probe boundary.
Real workspace acceptance is **inconclusive** and remains outside this slice.

| Criterion | Verdict | Named passing evidence |
|---|---|---|
| 1. Repository, branch, state, PR, Linear, and one row per worktree, including unknown and interrupted. | Verified | [`status content and button matrix for %s`](../test/render.test.ts#L27), including all 11 states; [`each worktree gets one row with its repository, branch, state, and PR link`](../test/render.test.ts#L39). |
| 2. Buttons appear only in allowed states. | Verified | The 11-state matrix above; [`switch repository in %s requires no commits and no PR on any worktree`](../test/render.test.ts#L53); [`cleanup matrix with active=$active and pr=$pr`](../test/render.test.ts#L64); [`cleanup needs at least one merged PR and no remaining unmerged PR`](../test/render.test.ts#L80); [`decision options include resume, one approval, and two more rounds, and mention the owner`](../test/render.test.ts#L91); [`result button matrix for %s`](../test/render.test.ts#L115). |
| 3. One saved status message updated in place; reactions indicate delivery only. | Verified | [`status updates use the saved timestamp after reopening and concurrent first updates post once`](../test/bolt.test.ts#L91); [`a received prompt gets no forwarded check mark until Orca delivery succeeds`](../test/bolt.test.ts#L108); [`a failed Orca forward keeps a durable prompt and only the received reaction`](../test/bolt.test.ts#L228); [`a failed update retries the original card without posting another message`](../test/bolt.test.ts#L200). |
| 4. Socket Mode messages, mentions, and buttons reach Bridge with dedup fields; bot messages are ignored. | Verified | [`recorded message and mention payloads retain dedup fields and bot or edited messages are ignored`](../test/bolt.test.ts#L76); [`decision button acknowledges then replies through Bridge once and updates the decision in place`](../test/bolt.test.ts#L117); [`status and failure buttons reach Bridge actions and stale message timestamps cannot act`](../test/bolt.test.ts#L155); [`the Socket Mode receiver carries recorded envelopes to the real Bridge and redacts listener errors`](../test/bolt.test.ts#L257). |
| 5. Refusals are ephemeral and log tails open a modal. | Verified | [`a refusal reaches only the refused user and log tail opens a plain text modal`](../test/bolt.test.ts#L132) asserts the exact ephemeral recipients, trigger ID, modal blocks, and absence of extra public posts. |
| 6. Credentials come from the environment and do not reach logs. | Verified | [`tokens are required from the environment and library logs redact both tokens`](../test/bolt.test.ts#L176) also checks the Web API client's configured token; the Socket Mode receiver test above injects a boundary error containing both fake credentials and asserts redacted output; the diff probes below have no matches. |

The payload fixtures contain fabricated IDs and text in representative Slack wire shapes.
Tests use real Bolt listeners, the real Socket Mode receiver, Bridge, and SQLite.
Only the Slack API and Orca command boundaries are scripted.
The receiver is exercised without connecting to a workspace.

## Clean-install checks

Runtime Node.js `v26.13.0`, npm `11.20.0`, satisfying Node.js >=24.

```text
npm ci
added 155 packages, and audited 156 packages
found 0 vulnerabilities

npm run typecheck
tsc --noEmit && tsc -p tsconfig.test.json
exit 0, both TypeScript programs passed

npm test
Test Files  6 passed (6)
Tests       101 passed (101)

npm run build
tsc
exit 0, 6 JavaScript modules emitted

git diff --cached --check
stdout empty, exit 0
```

npm reports an unapproved optional `fsevents` install script. Installation and all checks succeed without changing script approval settings.

## Diff probes

The following staged-diff scans produced empty stdout and exit 1, meaning no matches.

```sh
git diff --cached --unified=0 | rg -n -i '/[U]sers/|/[V]olumes/|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
git diff --cached --unified=0 -- src | rg -n 'console\.|log(ger)?\.(debug|info|warn|error)\([^)]*\b(token|appToken)\b|log\([^)]*\b(token|appToken)\b'
```

The production logger routes arguments through the [redactor](../src/bolt.ts#L197).
Tests intentionally pass fabricated credentials into that logger to verify its behavior.

## Remaining work

No PR is opened and nothing is deployed.
Daemon wiring, live Socket Mode delivery, and visual acceptance in a real Slack workspace remain for milestone acceptance.
The [adapter guide](slack.md) records the initial-post crash window and the caller's owner-action idempotency responsibility.
