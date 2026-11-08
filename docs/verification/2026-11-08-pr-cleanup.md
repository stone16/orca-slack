# PR polling and confirmed cleanup verification

Measured on 2026-11-08 with Node.js 26.13.0 and npm 11.20.0. Node.js 24 or newer remains the package requirement.

The slice discovers PRs and retains their state, then permits owner-confirmed worktree removal only after fresh GitHub, agent, and Git checks.
Implementation evidence is in [the poller](../../src/pr-poller.ts#L19), [the safety check](../../src/cleanup.ts#L46), and [confirmed deletion](../../src/cleanup.ts#L109).
No real Slack workspace or Linear record was used or changed. No deployment or PR was created.

## Acceptance verdicts

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 1. Discover PRs with all states and a branch filter, retain merge state, emit changes only | verified | Passing test `poll discovers no PR, records an open PR, emits no unchanged update, and tracks its merge` in [pr-poller.test.ts:17](../../test/pr-poller.test.ts#L17); passing timer test `the 60-second poller emits changes only, retries failures, stops, and never overlaps a slow poll` at [line 70](../../test/pr-poller.test.ts#L70). |
| 2. Preserve known state on gh failure and retry | verified | Passing test `gh failure preserves the last known PR and retries successfully on the next poll` in [pr-poller.test.ts:39](../../test/pr-poller.test.ts#L39). |
| 3. Require ended agents, no unmerged PR, and at least one merged PR | verified | All 10 `cleanup availability matrix` cases pass in [cleanup.test.ts:63](../../test/cleanup.test.ts#L63), covering no PR, open, closed, merged, mixed states, running, unknown, and exited agents; the active-ledger-session test at [line 110](../../test/cleanup.test.ts#L110) and the two other-worktree cases at [line 279](../../test/cleanup.test.ts#L279) pass. |
| 4. Refuse dirty work, stash, running agent, and changed HEAD; allow squash merge | verified | The seven-case disposable real-Git drive below passes, including a real squash merge with different feature-head and squash-commit OIDs. GitHub and agent responses are scripted; the running-agent case returns before invoking Git. An additional disposable live-Orca deletion also passed. |
| 5. Save receipt, PR links, and final commit before deletion; recover without duplicate deletion | verified | Passing tests `confirmed cleanup durably saves the receipt, PR link, final commit, and session report before deletion` at [cleanup.test.ts:128](../../test/cleanup.test.ts#L128), `a crash after saving survives reopen and retries exactly one deletion` at [line 159](../../test/cleanup.test.ts#L159), and `a crash after deletion reconciles absence on reopen without deleting twice` at [line 179](../../test/cleanup.test.ts#L179). The lost-response and duplicate-confirmation tests at [line 227](../../test/cleanup.test.ts#L227) also pass. |

These verdicts cover this slice's requested command-boundary tests and disposable drive. Real GitHub polling, live Slack button delivery, and milestone end-to-end acceptance remain unverified here.

## Clean-install checks

Executed from a clean dependency installation:

```sh
npm ci
npm run typecheck
npm test
npm run build
node scripts/cleanup-integration.mjs
```

| Check | Result |
| --- | --- |
| Clean install | Passed; 48 packages added, 49 audited, 0 vulnerabilities. npm reported an unapproved optional `fsevents` install script. |
| Typecheck | Passed for both source and test TypeScript configurations. |
| Tests | 110 passed across 6 passing files; 14 poller tests and 35 cleanup tests, plus 61 existing tests. |
| Build | Passed with `tsc`. |
| Git drive | 7 verified cases; temporary repositories removed. |

The observed test summary was:

```text
Test Files  6 passed (6)
     Tests  110 passed (110)
```

No lint script is defined in [package.json:8](../../package.json#L8), and this checkout has no CI workflow. The configured typecheck, test, and build commands all ran.

Tests were added before their implementations. Initial runs failed on the absent poller and cleanup modules; later red runs exposed failure handling, malformed output, missing safety checks, crash recovery, duplicate confirmation, and branch-ref normalization before the corresponding repairs.

## Disposable Git drive

The driver is [scripts/cleanup-integration.mjs:100](../../scripts/cleanup-integration.mjs#L100).
It creates a separate throwaway repository and linked worktree for each case, makes two feature commits, and performs a real squash merge into the disposable main checkout.
Only that case's generated directory is used for Git inspection and deletion, as enforced at [line 46](../../scripts/cleanup-integration.mjs#L46).
It checks the disposable main checkout's clean status and unchanged HEAD at [line 88](../../scripts/cleanup-integration.mjs#L88).

Command output from the final clean-install run:

```jsonl
{"case":"uncommitted","allowed":false,"reasons":["Uncommitted or untracked changes"],"realGitInspections":5,"verdict":"verified"}
{"case":"untracked","allowed":false,"reasons":["Uncommitted or untracked changes"],"realGitInspections":5,"verdict":"verified"}
{"case":"ignored","allowed":false,"reasons":["Uncommitted or untracked changes"],"realGitInspections":5,"verdict":"verified"}
{"case":"stash","allowed":false,"reasons":["Stash present"],"realGitInspections":5,"verdict":"verified"}
{"case":"running-agent","allowed":false,"reasons":["Running agent"],"realGitInspections":0,"verdict":"verified"}
{"case":"head-mismatch","allowed":false,"reasons":["HEAD differs from merged pull request head commit"],"realGitInspections":5,"verdict":"verified"}
{"case":"squash-merge","allowed":true,"reasons":[],"realGitInspections":15,"verdict":"verified","finalCommit":"83263941978e78a69f838b5fc0ef279414f3c633","squashCommit":"9ab89c07617f971d89f94364a55c09f219a0dd72","receiptSavedBeforeDeletion":true,"deletionCommands":1}
{"verdict":"verified","cases":7,"boundaries":{"git":"real","github":"scripted","orca":"scripted"},"temporaryFilesRemoved":true}
```

`realGitInspections` counts product safety commands, excluding repository setup and the driver's assertions. The agent refusal requires no Git inspection. The squash case performs one direct check and two confirmation checks, each with five Git commands. Setup and the squash merge themselves use real Git for every case.

## Additional disposable live-Orca check

A separate one-off probe registered a new temporary repository, set only its own worktree base directory, and created one Orca-managed feature worktree without launching an agent.
It committed a feature, squash-merged it locally, and ran `Cleanup.check` and `Cleanup.confirm` with real Git and real Orca; only gh was scripted.
Removal used `worktree rm --worktree identity:<returned-identity> --json` without force or branch-deletion flags.
The repeated confirmation returned `already-deleted` and issued no second removal.
The probe deregistered its repository, checked that no worktrees for its repository remained, and removed its temporary files.

Observed output:

```jsonl
{"verdict":"verified","boundaries":{"git":"real","orca":"real","github":"scripted"},"safetyAllowed":true,"receiptSaved":true,"deletionCommands":1,"repeat":"already-deleted","mainCheckoutUnchanged":true}
{"disposableRepositoryDeregistered":true,"disposableWorktreesRemaining":0,"temporaryFilesRemoved":true}
```

An initial probe stopped before product cleanup because the driver assumed the wrong worktree-create response shape. It deregistered its disposable repository and removed its files; subsequent repo, worktree, and process-summary inventories contained zero matching disposable rows. The successful probe selected its exact worktree from inventory instead.

## Integration contract and limits

[Store's new tables](../../src/store.ts#L72) append to the merged ledger schema; existing thread, worktree, PR, session, and report records remain the base.
[PR observation persistence](../../src/store.ts#L227) adopts an existing PR identity by link instead of duplicating it.
[Cleanup confirmation](../../src/cleanup.ts#L137) snapshots the owner confirmation, worktree instance, PR links and heads, final commit, sessions, and matching reports before removal.
The saved/deleted receipt states permit restart reconciliation, and cleanup rechecks safety after saving.

One Bridge process owns the ledger, with one Cleanup instance serializing duplicate confirmations for each worktree.
The ledger belongs outside removable worktrees. Remote worktrees and incomplete or unknown agent evidence refuse cleanup.
Ignored files also block cleanup, and a repository-wide stash blocks cleanup conservatively.
A changed worktree after a saved confirmation refuses retry rather than replacing the saved evidence.
The UI renderer and runtime wiring remain outside this slice.
