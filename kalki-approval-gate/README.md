# Kalki Approval Gate

This Worker adds an approval step between the Kalki pattern scorer output chat and the existing `Kalki-stocks` forwarder source chat.

## Flow

1. The scorer posts a generated alert into `WATCH_CHAT_IDS` (`1026720092`).
2. This Worker sends a separate approval message in that same chat with `Accept` and `Reject` buttons.
3. `Accept` sends the original alert into `DESTINATION_CHAT_ID` (`Kalki-stocks`, `-1003967721534`).
4. The existing `telegram-forwarder` continues to forward from `Kalki-stocks` to all final groups and D1.
5. `Reject` marks the alert rejected and sends nothing downstream.

## Secrets

Do not put Telegram tokens in `wrangler.jsonc`.

```bash
cd /Users/srimanth/Documents/codex/kalki-bot/kalki-approval-gate
npm install
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

If you want only specific Telegram users to approve alerts:

```bash
wrangler secret put APPROVER_USER_IDS
```

Use comma-separated user ids, for example `12345,67890`.

## Deploy

```bash
cd /Users/srimanth/Documents/codex/kalki-bot/kalki-approval-gate
npm install
npm run deploy
```

## Register Webhook

Open this URL once after deploy:

```text
https://kalki-approval-gate.srimanthgada87.workers.dev/telegram/set-webhook
```

The webhook registers `message`, `channel_post`, and `callback_query` updates.

## Telegram Bot Setup

- Add the approval bot to the scorer output target chat `1026720092`.
- Add the same bot to `Kalki-stocks` (`-1003967721534`) with permission to post messages.
- If the target is a group and the bot does not see scorer messages, disable privacy mode in BotFather or make the bot an admin.

## Test

```bash
npm test
```
