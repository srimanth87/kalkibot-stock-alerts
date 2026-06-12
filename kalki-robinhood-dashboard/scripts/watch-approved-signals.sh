#!/usr/bin/env bash
set -euo pipefail

API_BASE="${KALKI_API_BASE:-https://api.kalkianalysis.com}"
POLL_SECONDS="${KALKI_POLL_SECONDS:-5}"
PROCESS_EXISTING="${KALKI_PROCESS_EXISTING:-false}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.kalki-agent-state"
SEEN_FILE="$STATE_DIR/seen-signals.txt"
PROMPT_FILE="$ROOT_DIR/KALKI_AGENT_ONCE.md"
SNAPSHOT_TOKEN_FILE="$STATE_DIR/dashboard-snapshot-token"

mkdir -p "$STATE_DIR"
touch "$SEEN_FILE"

if [ -z "${DASHBOARD_SNAPSHOT_TOKEN:-}" ] && [ -s "$SNAPSHOT_TOKEN_FILE" ]; then
  export DASHBOARD_SNAPSHOT_TOKEN="$(cat "$SNAPSHOT_TOKEN_FILE")"
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude command not found in PATH" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node command not found in PATH" >&2
  exit 1
fi

echo "Kalki approval watcher started."
echo "API: $API_BASE"
echo "Polling every ${POLL_SECONDS}s. Press Ctrl+C to stop."

if [ "$PROCESS_EXISTING" != "true" ]; then
  baseline_json="$(curl -fsS "$API_BASE/api/signals/approved" || echo '{"signals":[]}')"
  baseline_count="$(node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    let count = 0;
    for (const signal of data.signals || []) {
      if (signal.id) {
        console.log(signal.id);
        count += 1;
      }
    }
    process.stderr.write(String(count));
  ' <<< "$baseline_json" 2>"$STATE_DIR/baseline-count.tmp" | while IFS= read -r id; do
    grep -Fxq "$id" "$SEEN_FILE" || printf '%s\n' "$id" >> "$SEEN_FILE"
  done; cat "$STATE_DIR/baseline-count.tmp")"
  rm -f "$STATE_DIR/baseline-count.tmp"
  if [ "${baseline_count:-0}" != "0" ]; then
    echo "Ignored ${baseline_count} already-approved signal(s) at startup. New approvals will trigger Claude."
    echo "To process existing approved signals, run: KALKI_PROCESS_EXISTING=true ./scripts/watch-approved-signals.sh"
  fi
fi

while true; do
  signals_json="$(curl -fsS "$API_BASE/api/signals/approved" || echo '{"signals":[]}')"

  while IFS= read -r signal; do
    [ -n "$signal" ] || continue
    id="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.id||""))' "$signal")"
    ticker="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.ticker||""))' "$signal")"
    [ -n "$id" ] || continue

    if grep -Fxq "$id" "$SEEN_FILE"; then
      continue
    fi

    echo "[$(date)] Approved signal ready: ${ticker:-UNKNOWN} ($id)"
    printf '%s\n' "$id" >> "$SEEN_FILE"

    prompt="$(cat "$PROMPT_FILE"; printf '\n'; printf '%s\n' "$signal")"
    claude -p --dangerously-skip-permissions "$prompt"
  done < <(node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    for (const signal of data.signals || []) {
      console.log(JSON.stringify(signal));
    }
  ' <<< "$signals_json")

  sleep "$POLL_SECONDS"
done
