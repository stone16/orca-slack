# Run the resident Bridge

The entry point requires Node.js 24 or newer, a logged-in Orca application, authenticated `gh`, and Git.
Run the service on the Mac that runs Orca.

## Configure the operator account

Copy `config.example.json` to the ignored `config.local.json` and replace every placeholder.
Keep `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in the ignored `.env` file.
The entry point reads credentials from its environment.
`npm start` and the LaunchAgent load `.env` through Node's environment-file option.
The LaunchAgent contains file paths, never token values.

```sh
npm ci
npm run typecheck
npm test
npm run build
cp config.example.json config.local.json
chmod 600 .env config.local.json
```

The required settings are:

| Field | Value |
|---|---|
| `botId` | Slack bot user ID. |
| `ownerId` | Operator's Slack user ID, included in `allowedUsers`. Each thread still belongs to its initiating user. |
| `allowedUsers` | Nonempty, unique Slack user IDs allowed to use the Bridge. |
| `runId` | Dedicated Orca Run ID, retained across service restarts. |
| `coordinatorTerminal` | Dedicated live Orca shell terminal that owns that Run. Keep this terminal open. |
| `agent` | Enabled Orca agent ID. |
| `archiveDirectory` | Archive directory with its existing `.orca-slack-archive` marker. An unavailable archive retains local files. |
| `hooksDirectory` | Hooks directory outside every configured repository's worktrees. Existing conflicting hooks cause startup to fail. |
| `repositories` | Nonempty array of repository records. |

Each repository needs its Orca `id`, routing `name`, `aliases` array, checkout `path`, and GitHub `github` name such as `example/project`.
The runtime translates Orca IDs to GitHub names only at the `gh` command boundary.
Paths in the config resolve relative to the Bridge checkout.
`retentionDays` defaults to 30.
`shutdownTimeoutMs` defaults to 25000 and must be positive and at most 25000.
Set `BRIDGE_CONFIG` to select another local config file.

Create a dedicated shell terminal and Run before filling in their IDs:

```sh
mkdir -p data
orca terminal create --worktree current --title 'Bridge coordinator' \
  --command 'orca orchestration run-create --objective "Slack Bridge" --json --full > data/service-run.json' --json
```

Use the returned `terminal.handle` for `coordinatorTerminal` and the receipt's `result.run.id` for `runId`.
Keep this coordinator separate from agent terminals and other Runs.
The service uses its identity for Orca calls and recovers that same Run's inbox after restart.

## Start and stop

Run `npm start` in the checkout to run in the foreground.
At startup, the Bridge installs the push guard on every configured repository, reconciles reports, replays pending Slack input, and refreshes state before connecting Socket Mode.
It polls reports and lead activity every five seconds, pull requests every 60 seconds, and retention every hour.
Pull requests and retention also run once at startup.
Only the runtime owns the ledger and its asynchronous handlers.

`SIGINT` and `SIGTERM` stop future timer ticks and incoming handlers, disconnect Socket Mode, drain existing work, and close the ledger.
The lifecycle gate runs before Bolt acknowledges a delivery. Already admitted deliveries drain before the ledger closes. Later deliveries remain unacknowledged for Slack to redeliver.
Normal shutdown exits with code 0.
A shutdown that exceeds its configured deadline exits with code 1 and relies on ledger recovery at restart.
An abrupt kill can repeat a delivery accepted by Slack before its durable sent marker, as described in the core recovery contract.
An Orca history coverage gap stays explicit in the ledger and startup log.

The runtime connects the existing renderer, permission checks, lead management, failure retry, PR poller, cleanup checks, archive storage, and push guard.
Retries require the failed thread's owner and save the retry request before starting a replacement lead.
Cleanup uses the existing fresh GitHub, Git, and Orca safety checks.
Resident polling and Socket Mode reconnects replay pending input and retry missing reactions. Unexpected reconnects appear in the operational log. Unhandled rejections and uncaught exceptions pass through credential redaction and a failed shutdown.
Repository switching remains an M2 feature and unbound M1 threads do not display its button.

## Install the user LaunchAgent

Use the checkout that should continue running after the shell closes.
Build it before installation.

```sh
npm run build
npm run service:install
launchctl list dev.orca-slack.bridge
```

The installer renders `deploy/launch-agent.plist.template` into the user's LaunchAgents directory and loads it with `launchctl bootstrap`.
It finds executable links for Node, Orca, `gh`, and Git on the installing shell's PATH. It preserves those executable paths rather than resolving package-manager links into Cellar. Installation fails before unloading an existing service if a required executable is available only under Cellar.
The generated service PATH contains only the discovered executable directories and `/usr/bin:/bin:/usr/sbin:/sbin`. Unrelated shell and agent-session directories stay out. The installer also resolves the checkout, config, `.env`, and log paths at install time.
Logs go to the ignored `data/logs/bridge.log` and `data/logs/bridge-error.log`.
The generated plist restarts the service after exit, with a five-second launch throttle and a 30-second launchd exit limit.
Repeated installation replaces the same label.
For another label, pass it to both commands:

```sh
npm run service:install -- dev.example.bridge
npm run service:uninstall -- dev.example.bridge
```

Uninstall the default service with:

```sh
npm run service:uninstall
```

Uninstallation unloads the service and removes only its plist.
It preserves the ledger, config, logs, coordinator terminal, and installed push guards.
A kill check must target the exact PID reported by `launchctl list`.
Confirm a new PID and the `Socket Mode connected`, `Orca inbox reconciled`, and `startup replay complete` lines afterward.
Do not run a second Bridge against the same Slack app or ledger.
