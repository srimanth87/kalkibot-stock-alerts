# Telegram Chat Forwarder on Cloudflare Workers

This Worker listens for Telegram messages or channel posts on a webhook and fans each one out to multiple destination chats.

## What it does

- Watches one source chat or channel.
- Copies or forwards each new message/post to every destination chat.
- Verifies Telegram webhook requests with `X-Telegram-Bot-Api-Secret-Token`.
- Optionally uses a KV binding named `FORWARD_STATE` to prevent duplicate fan-out during retries.
- Stores source-to-destination message ids in KV so replies can stay threaded in destination chats.

## Files

- `src/index.js`: Worker implementation.
- `wrangler.jsonc`: Cloudflare Worker configuration.
- `.dev.vars.example`: local environment example.

## Required setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather).
2. Add the bot as an admin in the source channel and every destination channel.
3. Give the bot permission to read the source chat and post messages in the destination chats.
4. Deploy the Worker to Cloudflare.
5. Point Telegram to your Worker webhook URL with `setWebhook`.

## Environment variables

Required:

- `TELEGRAM_BOT_TOKEN`: Bot token from BotFather.
- `SOURCE_CHAT_ID` or `SOURCE_CHANNEL_ID`: Numeric id for the source chat, usually like `-100...`.
- `TARGET_CHANNEL_IDS`: Comma-separated or newline-separated destination chat ids.

Optional:

- `TELEGRAM_WEBHOOK_SECRET`: Secret checked against Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
- `FORWARD_MODE`: `copy` or `forward`. Default is `copy`.
- `DISABLE_NOTIFICATION`: `true` or `false`.
- `PROTECT_CONTENT`: `true` or `false`.
- `FORWARD_EDITED_POSTS`: `true` to also fan out `edited_channel_post` updates.
- `TELEGRAM_WEBHOOK_PATH`: Defaults to `/telegram/webhook`.
- `DEDUPE_TTL_SECONDS`: KV dedupe TTL, defaults to 7 days.
- `MESSAGE_MAP_TTL_SECONDS`: KV retention for source→destination message id mappings, defaults to 60 days.

## Recommended secret setup

Use Wrangler secrets for sensitive values:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

You can keep the non-secret values in `wrangler.jsonc` vars later, or provide them through your deployment environment.

## Optional KV dedupe

If you want retries without duplicates, create a KV namespace and bind it as `FORWARD_STATE`.

Example `wrangler.jsonc` addition:

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "FORWARD_STATE",
      "id": "your-kv-namespace-id"
    }
  ]
}
```

With `FORWARD_STATE` configured:

- successful target deliveries are remembered
- failed targets can be retried safely
- source reply targets are mapped to destination reply targets
- the Worker returns `500` on partial failure so Telegram retries only the missing deliveries

Without `FORWARD_STATE`:

- the Worker still works
- partial failures return `200` to reduce accidental duplicate posts

## Local development

```bash
cd /Users/srimanth/Documents/codex/kalki-bot/telegram-forwarder
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Deploy

```bash
cd /Users/srimanth/Documents/codex/kalki-bot/telegram-forwarder
npm install
npm run deploy
```

## Register the Telegram webhook

After deploy, replace the URL with your Worker URL:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-worker.your-subdomain.workers.dev/telegram/webhook",
    "secret_token": "replace-with-your-secret",
    "allowed_updates": ["message", "edited_message", "channel_post", "edited_channel_post"]
  }'
```

## Notes

- `copyMessage` is the default because it avoids Telegram's forwarded attribution and is usually the cleanest channel-to-channel mirror.
- `forwardMessage` preserves forwarding metadata but can fail for protected content.
- Telegram sends message updates only if the bot is a member/admin of the source chat with the right permissions.
- Reply threading across destination chats works only for messages first copied by this Worker, because it depends on stored source→destination message-id mappings.
