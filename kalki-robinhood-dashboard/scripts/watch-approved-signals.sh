#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Kalki Auto-Trader Agent
#  Polls approved signals and executes via Robinhood MCP
#  Usage: ./scripts/watch-approved-signals.sh
# ═══════════════════════════════════════════════════════════

set -e

API_KEY="${KALKI_API_KEY:-}"
API_URL="${KALKI_API_URL:-https://api.kalkianalysis.com}"
POLL_INTERVAL="${KALKI_POLL_INTERVAL:-30}"

# ── color helpers ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }
sep()  { echo -e "${BLUE}────────────────────────────────────────${NC}"; }

# ── check API key ──
if [ -z "$API_KEY" ]; then
  if [ -f "$HOME/.kalki/api_key" ]; then
    API_KEY=$(cat "$HOME/.kalki/api_key")
  else
    echo ""
    echo -e "${BOLD}Kalki Auto-Trader${NC}"
    sep
    echo "API key not found. Set it one of two ways:"
    echo ""
    echo "  Option A — env var (this session only):"
    echo "    export KALKI_API_KEY=KALKI-XXXX"
    echo ""
    echo "  Option B — save permanently:"
    echo "    mkdir -p ~/.kalki && echo 'KALKI-XXXX' > ~/.kalki/api_key"
    echo ""
    exit 1
  fi
fi

# ── check claude is installed ──
if ! command -v claude &> /dev/null; then
  err "Claude Code not found. Install it: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# ── startup ──
clear
echo ""
echo -e "${BOLD}${GREEN}▶ Kalki Auto-Trader${NC}"
sep
log "API: ${API_URL}"
log "Key: ${API_KEY:0:8}••••"
log "Poll interval: ${POLL_INTERVAL}s"
sep

# track signals executed this session
declare -A EXECUTED

poll_count=0

while true; do
  poll_count=$((poll_count + 1))
  echo ""
  log "${BOLD}Poll #${poll_count}${NC}"

  # fetch approved signals
  response=$(curl -s -f \
    -H "X-Kalki-Key: ${API_KEY}" \
    "${API_URL}/api/signals/approved" 2>/dev/null) || {
    warn "Could not reach API — retrying in ${POLL_INTERVAL}s"
    sleep "$POLL_INTERVAL"
    continue
  }

  # parse signal count
  count=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('signals',[])))" 2>/dev/null || echo "0")

  if [ "$count" -eq 0 ]; then
    log "No approved signals — watching..."
  else
    log "${YELLOW}${count} approved signal(s) found${NC}"

    # extract signal list
    signals=$(echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for s in d.get('signals', []):
    print(f\"{s['id']}|{s['ticker']}|{s['grade']}|{s.get('entry_mid','?')}|{s.get('stop','?')}|{s.get('t1','?')}|{s.get('ai_why','')}\")
" 2>/dev/null)

    while IFS='|' read -r sig_id ticker grade entry stop t1 why; do
      # skip already executed this session
      if [ "${EXECUTED[$sig_id]+isset}" ]; then
        log "  ${ticker} — already executed this session, skipping"
        continue
      fi

      echo ""
      echo -e "  ${BOLD}${ticker}${NC} ${YELLOW}${grade}${NC}"
      echo -e "  Entry: ${CYAN}${entry}${NC}  Stop: ${RED}${stop}${NC}  T1: ${GREEN}${t1}${NC}"
      [ -n "$why" ] && echo -e "  ${BLUE}${why:0:80}${NC}"

      # build claude prompt for this signal
      PROMPT="You are executing a pre-approved Kalki trade signal on Robinhood.

Signal details:
- Ticker: ${ticker}
- Grade: ${grade}
- Entry: ${entry}
- Stop: ${stop}
- T1: ${t1}
- Signal ID: ${sig_id}
- AI reasoning: ${why}

Steps to execute:
1. Call get_accounts — find agentic account, save account_number
2. Call get_portfolio — check buying power (must be > 200)
3. Call get_equity_tradability for ${ticker}
4. Call get_equity_quotes for ${ticker} — get current price
5. If current price > entry * 1.03: print 'SKIP: price ran' and stop
6. If current price < entry * 0.97: print 'SKIP: price dropped' and stop
7. shares = floor(500 / current_price), minimum 1
8. Call review_equity_order: symbol=${ticker}, side=buy, type=limit, quantity=shares, limit_price=${entry}, time_in_force=gfd, market_hours=regular_hours
9. If review has warnings: print them and stop
10. Call place_equity_order with same params
11. Print: PLACED ${ticker} Nsh @ \$price order_id=XXX

Do not ask for confirmation. Execute now."

      log "  Sending to Claude Code..."
      
      # run claude with the prompt
      result=$(claude --dangerously-skip-permissions --print "$PROMPT" 2>&1)
      
      echo ""
      echo "$result" | head -20
      
      # mark executed in API
      curl -s -X POST \
        -H "X-Kalki-Key: ${API_KEY}" \
        -H "Content-Type: application/json" \
        "${API_URL}/api/signals/${sig_id}/executed" > /dev/null 2>&1

      EXECUTED[$sig_id]=1
      ok "  ${ticker} — marked executed"

    done <<< "$signals"
  fi

  # check market hours (skip orders outside 9:30-15:45 ET)
  et_hour=$(TZ="America/New_York" date '+%H')
  et_min=$(TZ="America/New_York" date '+%M')
  et_day=$(TZ="America/New_York" date '+%u')
  
  if [ "$et_day" -ge 6 ]; then
    log "Weekend — market closed, watching for Monday signals"
  elif [ "$et_hour" -lt 9 ] || ([ "$et_hour" -eq 9 ] && [ "$et_min" -lt 30 ]); then
    log "Pre-market ($(TZ="America/New_York" date '+%H:%M') ET) — watching"
  elif [ "$et_hour" -gt 15 ] || ([ "$et_hour" -eq 15 ] && [ "$et_min" -gt 45 ]); then
    log "After market close — watching for tomorrow"
  fi

  sep
  log "Next poll in ${POLL_INTERVAL}s  (Ctrl+C to stop)"
  sleep "$POLL_INTERVAL"
done
