#!/usr/bin/env bash
set -euo pipefail

API_BASE="${KALKI_API_BASE:-https://api.kalkianalysis.com}"
POLL_SECONDS="${KALKI_POLL_SECONDS:-5}"
BATCH_SECONDS="${KALKI_BATCH_SECONDS:-20}"
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
echo "Batching approvals for up to ${BATCH_SECONDS}s before one Claude run."

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
  batch_file="$STATE_DIR/pending-batch.jsonl"
  : > "$batch_file"
  batch_count=0

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
    printf '%s\n' "$signal" >> "$batch_file"
    batch_count=$((batch_count + 1))
  done < <(node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    for (const signal of data.signals || []) {
      console.log(JSON.stringify(signal));
    }
  ' <<< "$signals_json")

  if [ "$batch_count" -gt 0 ]; then
    deadline=$((SECONDS + BATCH_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
      sleep "$POLL_SECONDS"
      signals_json="$(curl -fsS "$API_BASE/api/signals/approved" || echo '{"signals":[]}')"

      while IFS= read -r signal; do
        [ -n "$signal" ] || continue
        id="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.id||""))' "$signal")"
        ticker="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.ticker||""))' "$signal")"
        [ -n "$id" ] || continue

        if grep -Fxq "$id" "$SEEN_FILE"; then
          continue
        fi

        echo "[$(date)] Added to current Claude batch: ${ticker:-UNKNOWN} ($id)"
        printf '%s\n' "$id" >> "$SEEN_FILE"
        printf '%s\n' "$signal" >> "$batch_file"
        batch_count=$((batch_count + 1))
      done < <(node -e '
        const fs = require("fs");
        const data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
        for (const signal of data.signals || []) {
          console.log(JSON.stringify(signal));
        }
      ' <<< "$signals_json")
    done

    batch_json="$(node -e '
      const fs = require("fs");
      const lines = fs.readFileSync(process.argv[1], "utf8").trim().split(/\n+/).filter(Boolean);
      const signals = lines.map((line) => JSON.parse(line));
      process.stdout.write(JSON.stringify({ signals }, null, 2));
    ' "$batch_file")"
    echo "[$(date)] Running Claude once for ${batch_count} approved signal(s)."
    prompt="$(cat "$PROMPT_FILE"; printf '\n\nProcess this batch of approved signals in one run. Execute each signal at most once, mark executed or dismissed, then sync dashboard. Batch JSON:\n'; printf '%s\n' "$batch_json")"
    claude -p --dangerously-skip-permissions "$prompt"
    : > "$batch_file"
  fi

  sleep "$POLL_SECONDS"
done
