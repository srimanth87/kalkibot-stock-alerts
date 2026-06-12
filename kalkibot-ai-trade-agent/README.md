# Kalkibot AI Trade Agent

Separate shadow-mode AI project for Kalki Telegram alerts.

This project does not place broker orders. It listens to the same Telegram alert channel, parses alerts, stores them in D1, scores them with an AI confirmation agent when `AI_API_KEY` is configured, and shows the results in a standalone dashboard.

## Flow

```text
Telegram alert
→ Worker parser
→ D1 alert log
→ Yahoo proxy market enrichment
→ Alpha Scanner style scoring
→ AI confirmation score
→ D1 decision log
→ Dashboard: TAKE / WATCH / SKIP
```

## Trade Decision Model

The agent treats the Telegram alert as a human charting idea and asks whether the setup is worth acting on now.

It calculates Alpha Scanner style fields before calling AI:

- `c13_score`: structure/trend quality, modeled after the scanner's strict setup score.
- `c1_score`: entry timing/momentum quality.
- `best_trade_score`: 0-100 combined score.
- `trade_quality`: `A+`, `A`, `B`, or `C`.
- `entry_timing`: `ready`, `early`, `late`, `extended`, or `unknown`.
- `volume_score`: live volume confirmation from Yahoo chart data.
- `market_score`: SPY/QQQ market condition from Yahoo chart data.
- `relative_strength_score`: ticker performance relative to QQQ/SPY.
- `confirmations`: evidence supporting the trade.
- `red_flags`: missing or weak evidence.

Decision labels:

- `TAKE`: best-quality setup, usually `A+`, with C13/C1 confirmation and clean entry timing.
- `WATCH`: interesting chart alert, but missing one or more confirmations.
- `SKIP`: weak/invalid/extended setup or too many red flags.

Live chart/volume/market enrichment uses the Cloudflare Yahoo proxy:

```text
YAHOO_PROXY_BASE_URL=https://yahoo-proxy.srimanthgada87.workers.dev
```

The agent fetches the ticker, SPY, and QQQ 5-minute chart data before scoring. News/catalyst enrichment is still a later layer.

## Setup

```bash
cd /Users/srimanth/Documents/codex/kalki-bot/kalkibot-ai-trade-agent
npm install
cp .dev.vars.example .dev.vars
```

Create the D1 database:

```bash
wrangler d1 create kalkibot-ai-trade-agent-db
```

Copy the returned database id into `wrangler.jsonc`, then apply the schema:

```bash
npm run d1:apply
```

Required AI secret:

```bash
wrangler secret put AI_API_KEY
```

Optional variables:

- `AI_PROVIDER`: `openai` or `nvidia`
- `AI_API_BASE_URL`: OpenAI default `https://api.openai.com`, NVIDIA default `https://integrate.api.nvidia.com`
- `AI_MODEL`: default `gpt-4.1-mini`
- `SOURCE_CHAT_ID`: Telegram source channel/group id
- `SECRET_PATH`: webhook path suffix, default `kalki2026`

For NVIDIA, set:

```text
AI_PROVIDER=nvidia
AI_API_BASE_URL=https://integrate.api.nvidia.com
AI_MODEL=<your NVIDIA model name>
AI_API_KEY=<your NVIDIA API key as a secret>
```

The older `OPENAI_API_KEY` and `OPENAI_MODEL` names are still accepted as fallback for existing deployments.

## Deploy

Worker:

```bash
npm run deploy -- --keep-vars
```

Pages dashboard:

```bash
npm run pages:deploy
```

Set this Pages variable:

```text
AI_AGENT_API_ORIGIN=https://kalkibot-ai-trade-agent.<your-subdomain>.workers.dev
```

## Telegram Webhook

Use a separate Telegram bot for the AI shadow agent or reuse the auto-trader bot only if you are comfortable with the same alert stream hitting both systems.

```bash
curl "https://api.telegram.org/bot<AI_AGENT_BOT_TOKEN>/setWebhook?url=https://<ai-agent-worker>.workers.dev/telegram/kalki2026"
```

The agent ignores messages from other chats when `SOURCE_CHAT_ID` is set.

## API

- `GET /health` and `GET /api/health`: service status.
- `POST /test` and `POST /api/test`: preview AI scoring without saving.
- `POST /telegram/<SECRET_PATH>`: Telegram webhook, saves alert and AI decision.
- `GET /api/alerts`: latest alerts with AI decisions and outcomes.
- `GET /api/summary`: aggregate performance summary.
- `POST /api/outcome`: manually record win/loss/open outcome for an alert.
- `POST /api/daily-review`: generate a daily learning summary.

## Shadow Mode Rule

This service is intentionally read/analyze/store only. Broker execution remains in `kalki-alpaca-autotrader` until the AI agent has enough history to trust.
