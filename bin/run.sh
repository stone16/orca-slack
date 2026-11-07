#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
export SLACK_BOT_TOKEN="$(security find-generic-password -s slack-gateway -a bot-token -w)"
export SLACK_APP_TOKEN="$(security find-generic-password -s slack-gateway -a app-token -w)"
exec "${NODE_BIN:-node}" dist/main.js
