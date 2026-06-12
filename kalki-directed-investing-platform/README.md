# Kalki Directed Investing

A new self-directed platform concept for connecting customer alert sources, Kalki educational alerts, and the first broker integrations: Alpaca and Tradier.

## Core Positioning

This project is designed around account-holder control. Users connect their own alert source and broker account, review order intent, acknowledge required disclosures, and retain responsibility for every live-account decision.

Kalki Educational Source content defaults live-account orders to `Manual approval required`.

## Included In This Version

- Customer Source and Kalki Educational Source connection cards
- Telegram Customer Source setup surface with bot token, allowed chats, webhook secret, parser template, approval policy, and default account routing
- WhatsApp notification preference for pending review alerts
- Alpaca and Tradier as the first supported broker paths
- Manual approval queue for live-account order review
- Multi-account broker dashboard
- Separate realized, open, and total P&L views
- Disclosure acknowledgments for educational content, live orders, broker execution differences, and historical performance
- Audit log surface for alerts, approval records, disclosure acknowledgments, token refreshes, and broker events

## Suggested Data Model

```ts
type SourceType = "Customer Source" | "Kalki Educational Source";

type ApprovalPolicy =
  | "Manual approval required"
  | "Customer controlled approval";

type Broker = "Alpaca" | "Tradier";
```

## Compliance-Sensitive Defaults

- Live orders from Kalki Educational Source require manual approval by default.
- Educational content is labeled as educational only and not investment advice.
- Users are shown responsibility, risk, broker execution, slippage, fees, and performance disclosures.
- All order reviews, user approvals, broker status changes, and disclosure acknowledgments should be stored as durable audit events.

## Telegram Customer Source Requirements

- Telegram bot token from BotFather
- Allowed chat IDs or channel IDs
- Webhook URL such as `/api/sources/telegram/webhook`
- Private webhook secret for message verification
- Parser rules for symbol, side, quantity, optional price fields, and time in force
- Default broker account routing
- Approval policy before any live-account order is sent
- Audit events for received messages, parsed fields, rejected messages, review decisions, and broker status updates

## Broker Connection Requirements

Alpaca:

- API key ID
- API secret key
- Paper or live account selection
- Paper or production base URL
- Broker account verification before use

Tradier:

- Access token
- Account ID
- Sandbox or production base URL
- Broker account verification before use

Secrets should never be stored in the frontend. Production should send credentials to a secure backend, encrypt them, verify account access, and log every connection/status change.

## WhatsApp Pending Review Notifications

- Platform owner needs WhatsApp Business Cloud API access
- Customer only needs a regular WhatsApp number
- Customer must opt in to receive WhatsApp notifications
- Notification should send a dashboard review link, not collect live-account approval inside WhatsApp
- Message template should be approved in Meta before production use

## Development

```bash
npm install
npm run dev
```
