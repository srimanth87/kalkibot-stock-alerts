# Kalki D1 Ingestion

Dedicated D1 ingestion worker for final scored Kalki Telegram alerts.

## Flow

Telegram ticker source -> `kalki-telegram-scorer` -> pattern scorer -> scored alert in `nasdaq_scanner` -> `kalki-d1-ingestion` -> D1 exact upserts.

The scorer and Telegram forwarder should not write D1. This worker writes only:

- `portfolio_positions`
- `group_alerts`
- `watchlist_items`

It never writes `app_state` and never rewrites the full app payload.

## Endpoints

- `GET /health`: returns service health and the current `portfolio_positions` count.
- `GET /api/alerts`: lists recent final scored alerts from `group_alerts`.
- `GET /api/portfolio`: lists portfolio positions. Optional `state=open|closed`.
- `GET /api/watchlist`: lists watchlist rows.
- `GET /api/reports`: returns reporting totals, grade/state rollups, recent alerts, and recent positions.
- `POST /ingest`: manual JSON ingestion with `X-Kalki-Key`.
- `POST /api/portfolio` or `POST /api/portfolio/correct`: authenticated manual add/edit/correction for one portfolio row.
- `POST /telegram/webhook`: Telegram webhook ingestion for final scored alerts.

Manual ingestion body:

```json
{
  "text": "final scored Telegram alert",
  "sourceChatId": "-100...",
  "sourceMessageId": "123"
}
```

Manual portfolio correction body:

```json
{
  "id": "tg--1001-42",
  "currentPrice": 192,
  "notes": "Manual close review"
}
```

Corrections merge into the single matching `portfolio_positions` row. They do not overwrite `group_alerts`,
`watchlist_items`, or any full frontend state blob.

## Checks

```sh
npm run check
```
