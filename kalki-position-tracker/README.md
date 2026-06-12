# Kalki Position Tracker

Separate Worker that monitors open D1 portfolio positions and alerts `nasdaq_scanner`
when a target or stop is hit.

## Role

- Reads open rows from `portfolio_positions`.
- Fetches latest prices.
- Sends Telegram alerts to `NASDAQ_SCANNER_CHAT_ID`.
- Safely updates only the matching `portfolio_positions` row with `currentPrice`,
  `tpsHit`, `nextTP`, `status`, and tracker timestamps.

It does not score, forward, ingest source Telegram alerts, or trade.

## Price Sources

The worker checks price sources in this order:

1. `TEST_PRICES` JSON map, useful for dry runs: `{ "TSLA": 190.25 }`
2. Yahoo proxy through the `YAHOO_PROXY` service binding or `YAHOO_PROXY_BASE_URL`.
3. Alpaca market data when `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` are set.
4. Tradier market data when `TRADIER_TOKEN` is set.

Secrets should be configured with `wrangler secret put`, not written to config:

```sh
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put KALKI_TRACKER_KEY
```

Alpaca and Tradier secrets are optional fallback price providers. The default path is the
same Yahoo proxy used by the swing UI and AI trade agent.

## Endpoints

- `GET /health`: service health.
- `POST /check`: authenticated manual check. Header: `X-Kalki-Key`.
- `GET /check?dryRun=1`: authenticated preview without D1 writes or Telegram sends.

## Checks

```sh
npm run check
```
