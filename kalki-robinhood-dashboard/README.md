# Kalki Robinhood Dashboard

Colorful Robinhood-first dashboard for live Robinhood MCP data and scorer alert order review.

## Local

```sh
npm run dev
npm run pages:dev
```

## Deploy

```sh
npm run deploy
npm run deploy:pages
```

## Production Wiring

The dashboard does not render dummy account balances, positions, orders, or alerts. It calls Worker API routes and shows setup states until the required secrets are configured.

Required Worker secrets/vars:

- `ROBINHOOD_MCP_BEARER_TOKEN`: bearer token for Robinhood MCP.
- `ROBINHOOD_ACCOUNT_NUMBER`: Robinhood account number used for reads and trading.
- `SCORER_WEBHOOK_SECRET`: bearer token expected from the scorer webhook.

Optional:

- `ROBINHOOD_AUTO_TRADE=true`: allows `/api/alerts/scorer` to place orders after broker review passes.
- `ROBINHOOD_POSITION_SIZE`: default notional used to size scorer alerts.
- `ROBINHOOD_ORDER_TYPE`: defaults to `limit`.

Scorer alerts post to:

```text
POST /api/alerts/scorer
Authorization: Bearer <SCORER_WEBHOOK_SECRET>
```
