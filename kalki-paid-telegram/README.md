# Kalki Paid Telegram

Stripe subscription checkout plus Telegram invite automation for the Kalki Alerts paid group.

## Flow

1. Customer visits `/join`.
2. Customer enters email and Telegram username.
3. Worker creates a Stripe Checkout Session for `STRIPE_PRICE_ID`.
4. Stripe redirects to `/success?session_id=...`.
5. Stripe webhook confirms payment/subscription.
6. Worker creates a one-use Telegram group invite link and stores it in D1.
7. Success page shows the invite link once it is available.

## Required Cloudflare secrets

Set these with `wrangler secret put`:

```bash
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put STRIPE_PRICE_ID
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ADMIN_KEY
```

Optional join notifications:

```bash
wrangler secret put JOIN_NOTIFY_CHAT_ID
```

Set this to the Telegram chat id where confirmed Telegram join notifications should be posted.

Group routing is configured with `TELEGRAM_GROUP_MAP` in `wrangler.jsonc`. The bot must be an admin with invite-link permission in each group.
People who join without an access code are routed to the `other` group.

Example:

```json
{
  "charlotte": "-1003812424739",
  "cincinnati": "-1003563826357",
  "other": "-1003377752970"
}
```

## D1 setup

```bash
wrangler d1 create kalki-paid-telegram
```

Copy the database id into `wrangler.jsonc`, then:

```bash
npm install
npm run db:migrate
```

## Deploy

```bash
npm run deploy
```

After deploy, set the Stripe webhook endpoint to:

```text
https://YOUR_WORKER_URL/api/stripe-webhook
```

Listen at minimum for:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`
