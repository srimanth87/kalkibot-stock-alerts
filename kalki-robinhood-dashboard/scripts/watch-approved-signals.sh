#!/usr/bin/env bash
set -euo pipefail

API_BASE="${KALKI_API_BASE:-https://kalki-robinhood-dashboard.srimanthgada87.workers.dev}"
POLL_SECONDS="${KALKI_POLL_SECONDS:-5}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.kalki-agent-state"
SEEN_FILE="$STATE_DIR/seen-signals.txt"
PROMPT_FILE="$ROOT_DIR/KALKI_AGENT_ONCE.md"

mkdir -p "$STATE_DIR"
touch "$SEEN_FILE"

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

    echo "[$(date)] Approved signal detected: ${ticker:-UNKNOWN} ($id)"
    printf '%s\n' "$id" >> "$SEEN_FILE"

    prompt="$(cat "$PROMPT_FILE"; printf '\n'; printf '%s\n' "$signal")"
    claude --dangerously-skip-permissions "$prompt"
  done < <(node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    for (const signal of data.signals || []) {
      console.log(JSON.stringify(signal));
    }
  ' <<< "$signals_json")

  sleep "$POLL_SECONDS"
done
