# Lead routing and lifecycle verification

Date: 2026-11-08. Verdict: **verified** for this slice. Live Slack delivery and milestone acceptance remain outside this drive.

The data model adds one immutable routing sample per thread, durable lead events, read observations, and an in-flight launch record. Existing lead sessions retain history. See `src/store.ts:29`, `src/store.ts:77`, and `src/store.ts:227`.

The Bridge supplies the only Run ID. A lead is launched on a separately created worktree without `--keep-open`, with forwarded thread text, ticket, worktrees, and lead history. Archived text is excluded. The prompt prohibits direct dispatch and documents the structured `CHILD_REQUEST` report. See `src/leads.ts:64` and `src/leads.ts:74`.

Per-thread queues serialize forwarding, reports, answers, and stop. Question events and decisions commit together under the report message ID. Interrupted sessions remain active in the ledger to prevent automatic replacement. In-flight launches without a complete receipt remain unknown; a retained partial Dispatch ID permits an exact guarded stop. See `src/leads.ts:20`, `src/leads.ts:111`, `src/leads.ts:123`, and `src/leads.ts:134`.

## Acceptance evidence

All named tests below are in `test/lead.test.ts` unless another file is named.

| Criterion | Verdict | Passing tests or drive |
|---|---|---|
| 1. Classify repository and intent once; save sample | Verified | `classifies %s once and saves its routing sample for %s` covers question, unclear request, direct implementation, and unknown repository, each followed by a conflicting second message. `test/routing.test.ts` adds English and Chinese intent cases, aliases, substring rejection, and conflicting repositories. |
| 2. New worktree, full forwarded context, Bridge-only coordination | Verified | `starts a Bridge-coordinated lead on a new worktree with all forwarded text and no archived text` asserts exact command arguments, thread context, ticket, prompt restrictions, child request contract, and omission of keep-open. |
| 3. New session on the same worktree after completion | Verified | `a completed session is replaced on the same worktree with lead history and full forwarded thread`. |
| 4. One decision per question; one owner reply | Verified | `a question report saves one decision, owner answer replies once, and duplicate reports stay idempotent`; `plain Orca questions accept an owner thread reply without forwarding it as a new prompt`; `a failed reply leaves the saved decision unanswered`. |
| 5. Failure, stop, unknown, interruption | Verified | `failure reports become failed events while late reports cannot end the replacement lead`; `stop records a stopped event and leaves the worktree in place`; `unverifiable status is unknown before two frozen polls and interrupted only past the grace window`; `an exited terminal becomes interrupted without starting a replacement`; `a correlated finished-without-report escalation becomes interrupted`. Additional tests cover cursor and source changes, read failures, human waits, missing wait evidence, live silence, failed stop, and partial-launch cancellation. |
| 6. Restart without a second session | Verified | `restart resumes ledger leads and pending decisions without starting a second session` reopens SQLite, polls the existing Dispatch, and answers its persisted question. `a launch with uncertain effects stays unknown across replay instead of creating a second session` covers an ambiguous launch. |
| 7. Real lead asks, receives an answer, and reports done | Verified | `scripts/lead-integration.mjs` drives the real Orca CLI through `Bridge`, `Leads`, SQLite, and the sole `ReportLoop`. The output below contains the exact Dispatch, question, and completion IDs. |

The scripted tests fake only Orca command responses and Slack delivery functions. SQLite, Bridge, routing, lifecycle, and report-loop code run unchanged. The initial suite failed before the new modules existed. Later regression runs failed on frozen evidence after read failure, partial-launch stop, actual nested receipts, structured source-change errors, and implementation phrasing before each repair.

## Reproduce

Run with Node.js 24 or newer, npm, a running Orca runtime, and the configured default Codex agent.

```sh
npm ci
npm run typecheck
npm test
npm run build
node scripts/lead-integration.mjs
```

The final clean install added 48 packages and audited 49 with zero vulnerabilities. Typecheck passed both production and test TypeScript projects. Vitest passed 105 tests in 7 files. Build passed. No lint command or CI workflow is defined in this checkout.

The installed npm printed an optional `fsevents` install-script notice. Installation and all checks completed successfully.

## Real Orca drive

The driver creates a temporary Git repository and configures its worktrees inside the same temporary root. It opens a dedicated authenticated Bridge terminal, creates one Run, launches the lead on a new worktree, and sends an owner answer through the decision action. It also saves real worker-read and terminal-read cursors. See `scripts/lead-integration.mjs:34`.

The driver releases the exact worker, closes only its own terminals, removes its worktree, deregisters its repository, and removes its temporary root. It verifies the disposable main checkout's HEAD and status and checks that no repository or worktree registration remains for its generated repository ID. Inert Orca audit history remains. See `scripts/lead-integration.mjs:120`.

The final run returned this output.

```json
{
  "verdict": "verified",
  "runId": "run_e0fb228030fb",
  "dispatchId": "ctx_ec287d6fe44d",
  "questionId": "msg_31af2f571de8",
  "doneId": "msg_9fdffedf8d65",
  "decisionSaved": true,
  "ownerReplySaved": true,
  "leadCompleted": true,
  "readCursorsSaved": true,
  "cleanup": {
    "workerReleased": true,
    "worktreeRemoved": true,
    "bridgeTerminalClosed": true,
    "repositoryRemoved": true,
    "temporaryFilesRemoved": true,
    "mainCheckoutUnchanged": true,
    "auditHistoryRetained": true
  }
}
```

## Limits

This slice provides lifecycle events for the Slack layer. It does not render Slack cards, call a real Slack workspace, alter Linear, poll pull requests, implement child dispatch, or offer a recovery button.

Rules use explicit configured repository names and aliases. Missing or conflicting repository matches remain unresolved and are saved for later selection and evaluation. The rules are not a semantic classifier.

Interruption means the assignment has stalled under the brief's policy, not proven process death. Missing output alone does not interrupt a lead, source changes reset the comparison, human waits remain waiting, and no interruption automatically starts a replacement. See `src/leads.ts:165`.

Delivery retains the base Bridge's at-least-once boundary. A crash after an Orca reply succeeds but before the SQLite answer marker may repeat that reply on recovery. A launch without a recoverable Dispatch identity stays unknown and requires reconciliation before a successful stop or another launch.
