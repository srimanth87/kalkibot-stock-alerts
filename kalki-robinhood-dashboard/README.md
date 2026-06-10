# Kalki Robinhood Dashboard

Colorful Robinhood-first dashboard prototype for the MCP order-review flow.

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

The current prototype is static mock data. It is structured so the review panel can later call a Worker API that proxies Robinhood MCP/OAuth safely server-side.
