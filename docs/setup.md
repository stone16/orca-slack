# Running orca-slack P0 on macOS

Use Node 24 or newer, pnpm 12 (pinned in `package.json`), and the installed `orca` CLI with a running Orca runtime. Run from this checkout (a repository registered with Orca), so `new-child` has a current parent worktree. Verify the configured repo selector, agent, model and effort against your Orca installation. P1/P2 are not implemented.

## Slack app

Create an app in the target workspace and enable **Socket Mode**. Create an app-level token with `connections:write`. Give the bot these OAuth scopes:

- `app_mentions:read`
- `chat:write`
- `reactions:write`
- `channels:history`
- `groups:history`

Under Event Subscriptions subscribe to **bot events** `app_mention`, `message.channels`, and `message.groups`. Turn **Interactivity** on. Socket Mode delivers these events and actions without a public request URL. Install/reinstall the app after changing scopes, then invite the bot to every configured channel and the ops channel, including private channels.

The bot token type is `xoxb`; the app-level token type is `xapp`. Do not put either token in a config file, plist, shell history, or repository. Only `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` supply tokens to Node.

Create/update the two login Keychain items using password prompts (keep `-w` last):

```sh
security add-generic-password -U -s slack-gateway -a bot-token -w
security add-generic-password -U -s slack-gateway -a app-token -w
```

`bin/run.sh` reads these items without echoing them and execs Node. Grant the Keychain access prompt interactively before relying on launchd; the login Keychain must be unlocked for the runner user.

## Configure and verify

```sh
cp config.example.json config.json
# Edit channel IDs, allowed Slack user IDs, the ops channel, and routing.
pnpm install
pnpm typecheck
pnpm test
pnpm build
node dist/main.js --check-config config.example.json
node dist/main.js --check-config config.json
```

Config is JSON. Only `channels`, `allowedUsers`, `opsChannel`, `heartbeatFile`, and `dbFile` are accepted; channel entries contain only `repo`, `agent`, `model`, and `effort`. `~/` paths use the runner user's home and relative paths resolve beside the config file. `ORCA_SLACK_CONFIG` selects a different config file (default `config.json` in the working directory). Config checking needs no tokens, makes no Orca calls and does not connect to Slack.

The process creates one Run with objective `orca-slack bridge <hostname>` and saves its ID in SQLite `meta`; restarts reuse that Run. Preserve the SQLite file and its WAL when moving or backing up state. Never run two bridge processes against the same state/Run: there must be exactly one mailbox consumer. Each dispatch receives the requester, channel, thread permalink and worker reporting instructions before its task text, including an explicit ban on interactive terminal question tools. Dispatch rows also enforce a unique `(channel, ts)` for the initiating Slack message; `app_mention` and `message.channels` deliveries can arrive in either order.

When `HTTPS_PROXY` is set, the same HTTPS proxy agent is passed to Bolt's Web API client and the Socket Mode client's options (covering session opening and websocket connections). With no variable set, no agent is installed. Bolt 4 does not forward these options from its default receiver, so startup replaces its Socket Mode client while preserving the receiver's event adapter; an offline construction test covers this dependency seam.

For an authorized live trial, start `bin/run.sh` in the foreground first. A ✅ on a user reply means **durably delivered to Orca, not read or accepted by the worker**. Answers can use a question's option buttons (up to five) or free text in the thread. Buttons use unique action IDs and respect Slack's [button text/value limits](https://docs.slack.dev/reference/block-kit/block-elements/button-element/). Only `allowedUsers` can dispatch, follow up, answer or stop. `!stop` and the receipt's stop button both stop then release the worker; repeated stops are ignored after settlement.

## Install launchd

The checked-in plist is a template because launchd requires absolute paths and does not expand `~`. From the deployment checkout, render it using the current Node executable and home directory; the snippet also carries `HTTPS_PROXY` from the current shell when set. No tokens enter the plist.

```sh
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/orca-slack"
python3 - "$PWD" "$(command -v node)" "$HOME" <<'PY'
import os, pathlib, plistlib, sys
repo, node, home = sys.argv[1:]
replacements = {'__REPO_DIR__': repo, '__NODE_BIN__': node,
                '__NODE_DIR__': str(pathlib.Path(node).parent), '__HOME__': home}
with open(pathlib.Path(repo) / 'launchd/com.stometa.orca-slack.plist', 'rb') as f:
    template = plistlib.load(f)
def render(value):
    if isinstance(value, dict): return {k: render(v) for k, v in value.items()}
    if isinstance(value, list): return [render(v) for v in value]
    if isinstance(value, str):
        for old, new in replacements.items(): value = value.replace(old, new)
    return value
result = render(template)
if os.environ.get('HTTPS_PROXY'):
    result['EnvironmentVariables']['HTTPS_PROXY'] = os.environ['HTTPS_PROXY']
with open(pathlib.Path(home) / 'Library/LaunchAgents/com.stometa.orca-slack.plist', 'wb') as f:
    plistlib.dump(result, f)
PY
plutil -lint "$HOME/Library/LaunchAgents/com.stometa.orca-slack.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.stometa.orca-slack.plist"
launchctl kickstart "gui/$(id -u)/com.stometa.orca-slack"
launchctl print "gui/$(id -u)/com.stometa.orca-slack"
```

Stop/unload before a foreground session or changing the installed plist:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.stometa.orca-slack.plist"
```

The plist uses `KeepAlive` and `RunAtLoad`. Standard output/error go to `~/Library/Logs/orca-slack/stdout.log` and `stderr.log`. Application and Bolt logs are one-line JSON on stdout with known credentials redacted; Node's SQLite experimental warning may appear on stderr. There is **no log rotation in code**: launchd captures the logs, and the host must configure newsyslog with a size limit (restart the service after rotation to reopen its file descriptors).

The heartbeat file contains an ISO timestamp at startup, every 30 seconds, and after each processed delivery. Point the external `orca_automations` watchdog at that configured file. An uncaught error or a Socket Mode outage lasting 60 seconds triggers one best-effort ops-channel notification and exit 1; launchd restarts. If Slack is unreachable the notification cannot be guaranteed, so fatal notification has a bounded wait and still exits. Report-loop errors log and retry after five seconds without acknowledging the delivery.

## Four live acceptance checks

These are the four checks in [features.md](features.md); execute them only after installing an app/token in a test channel. The automated suite uses fake Orca and Slack clients; it does not replace these live checks. No live Slack check was run during implementation.

1. **Dispatch and completion:** mention the bot with “给 repo X 的 README 加一行 hello”; include an explicit instruction to open a PR in that smoke task if you want a PR link. Verify 👀 within one second, a receipt with dispatch/worktree/run within two minutes, and a completion thread reply with the worker's PR link/report path plus ✅ on the root. Read the exact dispatch via `orca orchestration worker-show --dispatch <dispatch-id> --json`; use `worker-list --run <run-id> --json` to inspect the fleet. The bridge does not manufacture a PR or open one itself.
2. **Stop:** dispatch a long enough task, then send `!stop` in its thread (also try the stop button on a separate task). Verify “已停止 by …” and inspect the dispatch with `worker-show`/`worker-list` to confirm it is stopped/released. The worktree is preserved.
3. **Restart/replay:** while a worker is running, use `launchctl kill SIGKILL "gui/$(id -u)/com.stometa.orca-slack"` and let KeepAlive restart it. Confirm the same SQLite Run/thread mapping remains, the heartbeat advances and the eventual worker report reaches the original thread. Do not manually consume this Run with `check`; read with `inbox` or `worker-list` instead.
4. **Permission:** have a user outside `allowedUsers` mention the bot, post in a tracked thread and click its buttons. Verify ephemeral refusals and no new dispatch/answer/stop in `worker-list` or `inbox` for the configured Run.

## P0 recovery limits

- A delivery is acknowledged only after all its messages are posted and lifecycle operations finish. A crash before acknowledgment can replay posts; duplicate reports are accepted in P0.
- Slack event IDs and message timestamps are claimed before side effects, preventing duplicate workers. A crash between claiming the event and finishing dispatch requires operator inspection of the saved `dispatching`/`failed` thread and Orca receipts; the bridge does not automatically retry an uncertain start. SQLite event history is retained in P0.
- An escalation posts the message and the terminal tail with ❌ but does not release or stop the worker: it is still live and waiting for a human. Reply in the thread or use `!stop` / the stop button. Only `worker_done` releases. No automatic retry is implemented.
- `worker-read --source terminal` can fail for chat workers (which have no terminal) or an unavailable host. The failure report then states that output is unavailable and still attempts release; inspect the dispatch with `worker-read --source auto` manually. Terminal excerpts otherwise contain the last 40 lines with braille spinner characters removed.
- Unknown dispatch reports go to the ops channel and are acknowledged with the batch. Malformed deliveries or failing lifecycle calls remain unacknowledged and log/retry; investigate repeated `report_error` entries rather than running a second consumer.
