import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  KeyRound,
  Lock,
  MessageCircle,
  Plus,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
  WalletCards,
  Webhook,
  XCircle,
} from "lucide-react";
import "./styles.css";

type Page = "overview" | "connections" | "accounts" | "pnl" | "controls" | "order" | "logs" | "review" | "disclosures" | "audit" | "settings";
type SourceType = "Customer Source" | "Kalki Educational Source";
type Broker = "Alpaca" | "Tradier";

type TradeControls = {
  minGrade: string;
  orderType: string;
  exitStrategy: string;
  timeInForce: string;
  sizingMode: string;
  positionSize: string;
  portfolioSize: string;
  riskPercent: string;
  maxTradesPerDay: string;
  maxDollarsPerDay: string;
};

type BrokerAccount = {
  id: string;
  broker: Broker;
  label: string;
  accountType: "Paper" | "Live";
  status: "Ready" | "Restricted";
  buyingPower: string;
  realizedPnl: number;
  openPnl: number;
  accountDayPnl: number;
  portfolioValue?: string;
  controls: TradeControls;
  source: "Live data";
  updatedAt: string;
};

type ReviewItem = {
  id: string;
  accountId: string;
  approvalId: string;
  symbol: string;
  source: SourceType;
  broker: Broker;
  account: string;
  side: "Buy" | "Sell";
  quantity: string;
  riskNote: string;
  receivedAt: string;
  entry?: number | string;
  stop?: number | string;
  target?: number | string;
};

type TradeLogEntry = {
  id: string;
  client_id?: string;
  accountLabel: string;
  logged_at?: string;
  created_at?: string;
  type?: string;
  status?: string;
  source?: string;
  broker?: string;
  ticker?: string;
  reason?: string;
  message?: string;
  broker_order_id?: string;
  parent_order_id?: string;
  alpaca_order_id?: string;
  approval_id?: string;
  whatsapp_status?: string;
  whatsapp_error?: string;
  broker_order?: {
    qty?: number | string;
    limit_price?: number | string;
  };
  exit_reason?: string;
  entry_fill_price?: number | string;
  exit_fill_price?: number | string;
  filled_qty?: number | string;
  realized_pnl?: number | string;
  alert?: {
    ticker?: string;
    grade?: string;
    entryPrice?: number | string;
    stopPrice?: number | string;
    t1?: number | string;
  };
  decision?: {
    shares?: number | string;
    notional?: number | string;
  };
};

type AlertPreview = {
  ticker?: string;
  grade?: string;
  entryPrice?: number | string;
  stopPrice?: number | string;
  t1?: number | string;
};

type TradeDecisionPreview = {
  shares?: number | string;
  notional?: number | string;
  reason?: string;
  tradeable?: boolean;
};

const navItems: { id: Page; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "accounts", label: "Accounts" },
  { id: "connections", label: "Sources" },
  { id: "pnl", label: "P/L" },
  { id: "controls", label: "Controls" },
  { id: "order", label: "Order" },
  { id: "review", label: "Review" },
  { id: "logs", label: "Logs" },
];

const initialAccounts: BrokerAccount[] = [];

const reviewQueue: ReviewItem[] = [];

const auditEvents: { time: string; actor: string; action: string; detail: string }[] = [];

const AUTOTRADER_API = "https://kalki-alpaca-autotrader.srimanthgada87.workers.dev";
const SESSION_STORAGE_KEY = "kalkiDirectedClientSessions";

type StoredSession = {
  clientId: string;
  clientToken: string;
  label?: string;
};

type ClientResponse = {
  ok?: boolean;
  error?: string;
  skipped?: string;
  token?: string;
  client?: {
    id?: string;
    name?: string;
    broker?: string;
    environment?: string;
    brokerLabel?: string;
    enabled?: boolean;
    minGrade?: string;
    orderType?: string;
    exitStrategy?: string;
    timeInForce?: string;
    sizingMode?: string;
    positionSize?: number | string | null;
    portfolioSize?: number | string | null;
    riskPercent?: number | string | null;
    maxTradesPerDay?: number | string | null;
    maxDollarsPerDay?: number | string | null;
  };
  pnl?: {
    buyingPower?: number | string | null;
    portfolioValue?: number | string | null;
    accountDayPnl?: number | string | null;
    accountDayPnlPct?: number | string | null;
    realizedPnl?: number | string | null;
    openPnl?: number | string | null;
    totalPnl?: number | string | null;
  };
  logs?: TradeLogEntry[];
  alert?: AlertPreview;
  decision?: TradeDecisionPreview;
  result?: TradeLogEntry;
  preview?: boolean;
  whatsapp?: {
    messages?: Array<{ id?: string }>;
  };
  closed?: number;
  open?: number;
};

const disclosures = [
  "Educational content is not investment advice or a recommendation.",
  "Kalki Educational Source live-account orders require account holder approval by default.",
  "Broker execution, slippage, fees, and availability may vary by account and market conditions.",
  "Historical performance, examples, and educational material do not guarantee future results.",
  "The account holder is responsible for deciding whether any order is appropriate.",
];

const defaultTradeControls: TradeControls = {
  minGrade: "C",
  orderType: "market",
  exitStrategy: "bracket",
  timeInForce: "gtc",
  sizingMode: "fixed",
  positionSize: "200",
  portfolioSize: "",
  riskPercent: "",
  maxTradesPerDay: "5",
  maxDollarsPerDay: "",
};

const formatCurrency = (value: number) => {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const formatBalance = (value: number | string | null | undefined) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const sign = number < 0 ? "-" : "";
  return `${sign}$${Math.abs(number).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const toNumber = (value: number | string | null | undefined) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const formatEtTime = (value: string | undefined) => {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
};

const logTicker = (log: TradeLogEntry) => log.ticker || log.alert?.ticker || "--";

const logKind = (log: TradeLogEntry) => {
  if (log.type === "realized_pnl") return "Closed";
  if (log.status === "submitted") return "Submitted";
  if (log.status === "skipped") return "Skipped";
  if (log.status === "error") return "Error";
  if (log.type?.startsWith("client_")) return "Account";
  return log.type || log.source || "Event";
};

const logTone = (log: TradeLogEntry) => {
  if (log.status === "profit") return "gain";
  if (log.status === "loss" || log.status === "error") return "loss";
  if (log.status === "skipped") return "warn-text";
  return "";
};

const logDetail = (log: TradeLogEntry) => {
  if (log.type === "realized_pnl") {
    return `${log.exit_reason || "Exit"} · ${Number(log.filled_qty || 0)} sh · ${formatBalance(log.entry_fill_price)} -> ${formatBalance(log.exit_fill_price)}`;
  }
  if (log.status === "submitted") {
    const shares = log.decision?.shares || log.filled_qty || "--";
    const entry = log.alert?.entryPrice ? ` @ ${formatBalance(log.alert.entryPrice)}` : "";
    return `Order submitted · ${shares} sh${entry}`;
  }
  return log.message || log.reason || log.broker_order_id || log.alpaca_order_id || "--";
};

const logPnl = (log: TradeLogEntry) => {
  if (log.type !== "realized_pnl") return "--";
  return formatCurrency(toNumber(log.realized_pnl));
};

function pendingReviewItems(logs: TradeLogEntry[]): ReviewItem[] {
  const resolved = new Set(
    logs
      .filter((log) => log.approval_id && (log.type === "approval_declined" || log.type === "approval_approved"))
      .map((log) => log.approval_id as string)
  );

  return logs
    .filter((log) => log.type === "pending_approval" && log.approval_id && !resolved.has(log.approval_id))
    .map((log) => ({
      id: `${log.accountLabel}-${log.approval_id}`,
      accountId: String(log.client_id || ""),
      approvalId: String(log.approval_id),
      symbol: logTicker(log),
      source: "Kalki Educational Source" as SourceType,
      broker: normalizeBroker(log.broker),
      account: log.accountLabel,
      side: "Buy" as const,
      quantity: `${log.decision?.shares || "--"} shares`,
      riskNote:
        log.whatsapp_status === "sent"
          ? "WhatsApp sent. Awaiting account-holder approval."
          : log.whatsapp_error || log.reason || "Awaiting account-holder approval.",
      receivedAt: formatEtTime(log.logged_at || log.created_at),
      entry: log.alert?.entryPrice,
      stop: log.alert?.stopPrice,
      target: log.alert?.t1,
    }));
}

const hasOrderQuantity = (log: TradeLogEntry) =>
  Boolean(log.decision?.shares || log.filled_qty || log.broker_order?.qty);

const hasBrokerOrderId = (log: TradeLogEntry) =>
  Boolean(log.parent_order_id || log.broker_order_id || log.alpaca_order_id);

function normalizeBroker(value: string | undefined): Broker {
  return value?.toLowerCase() === "tradier" ? "Tradier" : "Alpaca";
}

function normalizeAccountType(value: string | undefined): BrokerAccount["accountType"] {
  return value?.toLowerCase() === "live" ? "Live" : "Paper";
}

function readStoredSessions(): StoredSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "[]") as StoredSession[];
    return parsed.filter((session) => session.clientId && session.clientToken);
  } catch {
    return [];
  }
}

function writeStoredSessions(sessions: StoredSession[]) {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions.slice(0, 20)));
}

function upsertStoredSession(session: StoredSession) {
  const sessions = readStoredSessions().filter((item) => item.clientId !== session.clientId);
  sessions.unshift(session);
  writeStoredSessions(sessions);
  return sessions;
}

function clientHeaders(session: StoredSession) {
  return {
    "content-type": "application/json",
    "x-client-id": session.clientId,
    "x-client-token": session.clientToken,
  };
}

async function autotraderPost(path: string, body: unknown, session?: StoredSession): Promise<ClientResponse> {
  const response = await fetch(`${AUTOTRADER_API}${path}`, {
    method: "POST",
    headers: session ? clientHeaders(session) : { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => ({}))) as ClientResponse;
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.skipped || `Autotrader request failed with HTTP ${response.status}`);
  }
  return data;
}

function accountFromClient(data: ClientResponse, session: StoredSession): BrokerAccount {
  const client = data.client;
  if (!client?.id) throw new Error("Autotrader response did not include a client profile");
  const realizedPnl = toNumber(data.pnl?.realizedPnl);
  const openPnl = toNumber(data.pnl?.openPnl);
  const accountDayPnl = toNumber(data.pnl?.accountDayPnl);
  const label = client.name || client.brokerLabel || session.label || "Broker account";
  const valueText = (value: number | string | null | undefined, fallback = "") =>
    value === null || value === undefined || value === "" ? fallback : String(value);
  return {
    id: client.id,
    broker: normalizeBroker(client.broker),
    label,
    accountType: normalizeAccountType(client.environment),
    status: client.enabled ? "Ready" : "Restricted",
    buyingPower: formatBalance(data.pnl?.buyingPower),
    realizedPnl,
    openPnl,
    accountDayPnl,
    portfolioValue: formatBalance(data.pnl?.portfolioValue),
    controls: {
      minGrade: client.minGrade || defaultTradeControls.minGrade,
      orderType: client.orderType || defaultTradeControls.orderType,
      exitStrategy: client.exitStrategy || defaultTradeControls.exitStrategy,
      timeInForce: client.timeInForce || defaultTradeControls.timeInForce,
      sizingMode: client.sizingMode || defaultTradeControls.sizingMode,
      positionSize: valueText(client.positionSize, defaultTradeControls.positionSize),
      portfolioSize: valueText(client.portfolioSize, defaultTradeControls.portfolioSize),
      riskPercent: valueText(client.riskPercent, defaultTradeControls.riskPercent),
      maxTradesPerDay: valueText(client.maxTradesPerDay, defaultTradeControls.maxTradesPerDay),
      maxDollarsPerDay: valueText(client.maxDollarsPerDay, defaultTradeControls.maxDollarsPerDay),
    },
    source: "Live data",
    updatedAt: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  };
}

function Pill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "warn" | "danger" }) {
  return <span className={`pill ${tone}`}>{label}</span>;
}

function SectionHeading({ icon: Icon, eyebrow, title }: { icon: typeof Activity; eyebrow: string; title: string }) {
  return (
    <div className="section-heading">
      <span className="icon-frame">
        <Icon size={18} />
      </span>
      <div>
        <p>{eyebrow}</p>
        <h2>{title}</h2>
      </div>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <section className="page-header">
      <Pill label={eyebrow} tone="good" />
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Activity;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <span className="icon-frame">
        <Icon size={18} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}

function RiskBanner() {
  return (
    <section className="risk-banner" aria-label="Important disclosure">
      <AlertTriangle size={22} />
      <p>
        This platform is for self-directed account holders. Kalki Educational Source content is educational only, is not
        investment advice, and does not guarantee results. The account holder is solely responsible for reviewing risks,
        approving orders, and deciding whether any order is appropriate for their circumstances.
      </p>
    </section>
  );
}

function Metrics({
  accountDayPnl,
  realized,
  open,
  total,
}: {
  accountDayPnl: number;
  realized: number;
  open: number;
  total: number;
}) {
  return (
    <section className="metrics" aria-label="Profit and loss summary">
      <article>
        <span>Broker Day P&amp;L</span>
        <strong className={accountDayPnl >= 0 ? "gain" : "loss"}>{formatCurrency(accountDayPnl)}</strong>
        <small>Broker equity change today</small>
      </article>
      <article>
        <span>Kalki Today Realized</span>
        <strong className={realized >= 0 ? "gain" : "loss"}>{formatCurrency(realized)}</strong>
        <small>Closed trades logged by Kalki today</small>
      </article>
      <article>
        <span>Open Position P&amp;L</span>
        <strong className={open >= 0 ? "gain" : "loss"}>{formatCurrency(open)}</strong>
        <small>Current unrealized open positions</small>
      </article>
      <article>
        <span>Kalki Today + Open</span>
        <strong className={total >= 0 ? "gain" : "loss"}>{formatCurrency(total)}</strong>
        <small>Kalki realized today plus open P/L</small>
      </article>
    </section>
  );
}

function AccountTable({ accounts, onRemove }: { accounts: BrokerAccount[]; onRemove?: (accountId: string) => void }) {
  return (
    <div className="account-table" role="table" aria-label="Broker accounts">
      <div className="table-row table-head" role="row">
        <span>Account</span>
        <span>Broker</span>
        <span>Type</span>
        <span>Status</span>
        <span>Portfolio</span>
        <span>Buying power</span>
        <span>Realized</span>
        <span>Open</span>
        <span>Total</span>
        <span>Action</span>
      </div>
      {accounts.length === 0 && (
        <div className="table-empty" role="row">
          <WalletCards size={22} />
          <div>
            <strong>No broker accounts connected</strong>
            <p>Add your Alpaca or Tradier account to see buying power and P/L here.</p>
          </div>
        </div>
      )}
      {accounts.map((account) => (
        <div className="table-row" role="row" key={account.id}>
          <span>{account.label}</span>
          <span>{account.broker}</span>
          <span>{account.accountType}</span>
          <span>
            <Pill label={account.status} tone={account.status === "Ready" ? "good" : "warn"} />
          </span>
          <span>{account.portfolioValue || "--"}</span>
          <span>{account.buyingPower}</span>
          <span className={account.realizedPnl >= 0 ? "gain" : "loss"}>{formatCurrency(account.realizedPnl)}</span>
          <span className={account.openPnl >= 0 ? "gain" : "loss"}>{formatCurrency(account.openPnl)}</span>
          <span className={account.realizedPnl + account.openPnl >= 0 ? "gain" : "loss"}>
            {formatCurrency(account.realizedPnl + account.openPnl)}
          </span>
          <span>
            {onRemove && (
              <button className="text-action danger" type="button" onClick={() => onRemove(account.id)}>
                Remove
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

type PnlTrackerRow = {
  id: string;
  openedAt?: string;
  accountLabel: string;
  ticker: string;
  grade: string;
  shares: string;
  entry: string;
  closeCurrent: string;
  status: "Open - not closed" | "Closed";
  pnl: number | null;
};

const logOrderId = (log: TradeLogEntry) =>
  log.parent_order_id || log.broker_order_id || log.alpaca_order_id || `${log.accountLabel}-${logTicker(log)}-${log.logged_at || log.created_at || log.id}`;

function buildPnlRows(logs: TradeLogEntry[]): PnlTrackerRow[] {
  const rows = new Map<string, PnlTrackerRow>();
  const sorted = [...logs].sort((left, right) =>
    String(left.logged_at || left.created_at || "").localeCompare(String(right.logged_at || right.created_at || ""))
  );

  sorted.forEach((log) => {
    const key = logOrderId(log);
    const ticker = logTicker(log);
    const existing = rows.get(key);

    if (log.type === "realized_pnl") {
      const closeLabel = log.exit_reason || "Exit";
      rows.set(key, {
        id: key,
        openedAt: existing?.openedAt || log.logged_at || log.created_at,
        accountLabel: existing?.accountLabel || log.accountLabel,
        ticker: existing?.ticker || ticker,
        grade: existing?.grade || log.alert?.grade || "--",
        shares: existing?.shares || String(log.filled_qty || "--"),
        entry: existing?.entry || formatBalance(log.entry_fill_price),
        closeCurrent: `${formatBalance(log.exit_fill_price)} ${closeLabel}`,
        status: "Closed",
        pnl: toNumber(log.realized_pnl),
      });
      return;
    }

    if (log.status === "submitted" && hasBrokerOrderId(log) && hasOrderQuantity(log)) {
      rows.set(key, {
        id: key,
        openedAt: log.logged_at || log.created_at,
        accountLabel: log.accountLabel,
        ticker,
        grade: log.alert?.grade || "--",
        shares: String(log.decision?.shares || log.filled_qty || log.broker_order?.qty || "--"),
        entry: formatBalance(log.alert?.entryPrice || log.entry_fill_price || log.broker_order?.limit_price),
        closeCurrent: "Not closed yet",
        status: "Open - not closed",
        pnl: null,
      });
      return;
    }
  });

  return [...rows.values()].sort((left, right) =>
    String(right.openedAt || "").localeCompare(String(left.openedAt || ""))
  );
}

function AlertPnlTracker({
  logs,
  loading,
  emptyDescription,
}: {
  logs: TradeLogEntry[];
  loading: boolean;
  emptyDescription: string;
}) {
  const rows = buildPnlRows(logs);

  return (
    <div className="tracker-table" role="table" aria-label="Alert P/L tracker">
      <div className="tracker-row tracker-head" role="row">
        <span>Opened</span>
        <span>Account</span>
        <span>Ticker</span>
        <span>Grade</span>
        <span>Shares</span>
        <span>Entry</span>
        <span>Close / Current</span>
        <span>Status</span>
        <span>P/L</span>
      </div>
      {rows.length === 0 && (
        <EmptyState
          icon={Activity}
          title={loading ? "Loading P/L tracker" : "No tracked alerts yet"}
          description={emptyDescription}
        />
      )}
      {rows.map((row) => (
        <div className="tracker-row" role="row" key={row.id}>
          <span>{formatEtTime(row.openedAt)}</span>
          <span>{row.accountLabel}</span>
          <span>{row.ticker}</span>
          <span>{row.grade}</span>
          <span>{row.shares}</span>
          <span>{row.entry}</span>
          <span>{row.closeCurrent}</span>
          <span className={row.status === "Closed" ? "gain" : "warn-text"}>{row.status}</span>
          <span className={(row.pnl || 0) >= 0 ? "gain" : "loss"}>{row.pnl === null ? "--" : formatCurrency(row.pnl)}</span>
        </div>
      ))}
    </div>
  );
}

function PnlPage({
  logs,
  loading,
  notice,
  onRefresh,
  onRefreshPnl,
}: {
  logs: TradeLogEntry[];
  loading: boolean;
  notice: string;
  onRefresh: () => Promise<void>;
  onRefreshPnl: () => Promise<void>;
}) {
  const rows = buildPnlRows(logs);
  const closedRows = rows.filter((row) => row.status === "Closed");
  const openRows = rows.filter((row) => row.status !== "Closed");
  const netPnl = closedRows.reduce((sum, row) => sum + (row.pnl || 0), 0);

  return (
    <>
      <PageHeader
        eyebrow="P/L"
        title="Track each alert from entry to exit."
        description="Match submitted orders with realized exits so customers can see which alert created each closed gain or loss."
      />
      <section className="log-summary">
        <article>
          <span>Tracked Alerts</span>
          <strong>{rows.length}</strong>
          <small>Submitted orders with alert context</small>
        </article>
        <article>
          <span>Closed</span>
          <strong>{closedRows.length}</strong>
          <small>Exited trades with realized P/L</small>
        </article>
        <article>
          <span>Net Realized</span>
          <strong className={netPnl >= 0 ? "gain" : "loss"}>{formatCurrency(netPnl)}</strong>
          <small>From closed tracker rows</small>
        </article>
      </section>
      <section className="panel">
        <div className="log-toolbar">
          <SectionHeading icon={Activity} eyebrow="Alert P/L Tracker" title="Alert outcomes" />
          <div className="table-actions">
            <button className="secondary" onClick={onRefresh} disabled={loading}>Refresh</button>
            <button className="secondary" onClick={onRefreshPnl} disabled={loading}>Refresh P/L</button>
          </div>
        </div>
        {notice && <p className="status-note">{notice}</p>}
        <AlertPnlTracker
          logs={logs}
          loading={loading}
          emptyDescription="Submitted orders and realized exits from connected accounts will appear here."
        />
        {openRows.length > 0 && (
          <p className="muted">
            Open rows show as not closed until the broker reports a filled exit or a P/L refresh records the realized exit.
          </p>
        )}
      </section>
    </>
  );
}

function LogsPage({
  logs,
  loading,
  notice,
  onRefresh,
  onRefreshPnl,
}: {
  logs: TradeLogEntry[];
  loading: boolean;
  notice: string;
  onRefresh: () => Promise<void>;
  onRefreshPnl: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<"all" | "closed" | "orders" | "issues">("all");
  const closedLogs = logs.filter((log) => log.type === "realized_pnl");
  const orderLogs = logs.filter((log) => log.status === "submitted");
  const issueLogs = logs.filter((log) => log.status === "skipped" || log.status === "error" || log.status === "loss");
  const filteredLogs =
    filter === "closed" ? closedLogs : filter === "orders" ? orderLogs : filter === "issues" ? issueLogs : logs;
  const netRealized = closedLogs.reduce((sum, log) => sum + toNumber(log.realized_pnl), 0);

  return (
    <>
      <PageHeader
        eyebrow="Logs"
        title="Trade activity and realized exits."
        description="Review submitted orders, closed exits, skipped trades, errors, and account events from the connected autotrader profiles."
      />
      <section className="log-summary">
        <article>
          <span>Closed</span>
          <strong>{closedLogs.length}</strong>
          <small>Realized exit rows</small>
        </article>
        <article>
          <span>Net Realized</span>
          <strong className={netRealized >= 0 ? "gain" : "loss"}>{formatCurrency(netRealized)}</strong>
          <small>From visible closed logs</small>
        </article>
        <article>
          <span>Issues</span>
          <strong className={issueLogs.length ? "loss" : "gain"}>{issueLogs.length}</strong>
          <small>Skipped, errors, losses</small>
        </article>
      </section>
      <section className="panel">
        <div className="log-toolbar">
          <SectionHeading icon={Clock3} eyebrow="Activity" title="Trade log" />
          <div className="table-actions">
            <button className={filter === "all" ? "" : "secondary"} onClick={() => setFilter("all")}>All</button>
            <button className={filter === "closed" ? "" : "secondary"} onClick={() => setFilter("closed")}>Closed</button>
            <button className={filter === "orders" ? "" : "secondary"} onClick={() => setFilter("orders")}>Orders</button>
            <button className={filter === "issues" ? "" : "secondary"} onClick={() => setFilter("issues")}>Issues</button>
            <button className="secondary" onClick={onRefresh} disabled={loading}>Refresh</button>
            <button className="secondary" onClick={onRefreshPnl} disabled={loading}>Refresh P/L</button>
          </div>
        </div>
        {notice && <p className="status-note">{notice}</p>}
        <div className="activity-table" role="table" aria-label="Trade log">
          <div className="activity-row activity-head" role="row">
            <span>Time (ET)</span>
            <span>Account</span>
            <span>Ticker</span>
            <span>Type</span>
            <span>Status</span>
            <span>Detail</span>
            <span>P/L</span>
          </div>
          {filteredLogs.length === 0 && (
            <EmptyState
              icon={ClipboardCheck}
              title={loading ? "Loading logs" : "No trade logs yet"}
              description="Submitted orders, closed exits, skipped trades, and account events will appear here."
            />
          )}
          {filteredLogs.map((log) => (
            <div className="activity-row" role="row" key={log.id}>
              <span>{formatEtTime(log.logged_at || log.created_at)}</span>
              <span>{log.accountLabel}</span>
              <span>{logTicker(log)}</span>
              <span>{logKind(log)}</span>
              <span className={logTone(log)}>{log.status || "--"}</span>
              <span>{logDetail(log)}</span>
              <span className={toNumber(log.realized_pnl) >= 0 ? "gain" : "loss"}>{logPnl(log)}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function ReviewList({
  items,
  onApprove,
  onDecline,
  busy,
}: {
  items: ReviewItem[];
  onApprove: (accountId: string, approvalId: string) => void;
  onDecline: (accountId: string, approvalId: string) => void;
  busy: boolean;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={UserCheck}
        title="No pending approvals"
        description="Orders that require account-holder approval will appear here before anything is sent to a broker."
      />
    );
  }

  return (
    <div className="review-list">
      {items.map((item) => (
        <article className="review-item" key={item.id}>
          <div className="review-symbol">
            <strong>{item.symbol}</strong>
            <span>{item.side}</span>
          </div>
          <div>
            <h3>{item.quantity}</h3>
            <p>
              {item.source} to {item.broker} · {item.account}
            </p>
            <small>
              Entry {formatBalance(item.entry)} · Stop {formatBalance(item.stop)} · T1 {formatBalance(item.target)}
            </small>
            <small>{item.riskNote}</small>
          </div>
          <div className="review-actions">
            <span>{item.receivedAt}</span>
            <button aria-label={`Approve ${item.symbol}`} onClick={() => onApprove(item.accountId, item.approvalId)} disabled={busy}>
              <CheckCircle2 size={18} />
            </button>
            <button className="danger" aria-label={`Decline ${item.symbol}`} onClick={() => onDecline(item.accountId, item.approvalId)} disabled={busy}>
              <XCircle size={18} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function DisclosureList() {
  return (
    <ul className="checklist">
      {disclosures.map((disclosure) => (
        <li key={disclosure}>
          <BadgeCheck size={18} />
          {disclosure}
        </li>
      ))}
    </ul>
  );
}

function AuditTimeline() {
  if (auditEvents.length === 0) {
    return (
      <EmptyState
        icon={Clock3}
        title="No audit events yet"
        description="Alert intake, broker connection, disclosure, approval, and order events will appear here."
      />
    );
  }

  return (
    <div className="timeline">
      {auditEvents.map((event) => (
        <article key={`${event.time}-${event.action}`}>
          <span>{event.time}</span>
          <div>
            <strong>{event.action}</strong>
            <p>
              {event.actor} · {event.detail}
            </p>
          </div>
          <ArrowUpRight size={18} />
        </article>
      ))}
    </div>
  );
}

function TelegramSourceConnector({ accounts }: { accounts: BrokerAccount[] }) {
  const [sourceName, setSourceName] = useState("");
  const [chatIds, setChatIds] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState("Customer controlled approval");
  const [defaultAccount, setDefaultAccount] = useState("");
  const [whatsAppAlerts, setWhatsAppAlerts] = useState(true);
  const selectedDefaultAccount = accounts.some((account) => account.label === defaultAccount)
    ? defaultAccount
    : accounts[0]?.label ?? "";

  return (
    <section className="panel telegram-panel">
      <SectionHeading icon={MessageCircle} eyebrow="Customer Source" title="Telegram bot connection" />
      <div className="connector-layout">
        <form className="connector-form">
          <label>
            <span>Source name</span>
            <input value={sourceName} onChange={(event) => setSourceName(event.target.value)} />
          </label>
          <label>
            <span>Telegram bot token</span>
            <input placeholder="123456789:AA..." type="password" />
          </label>
          <label>
            <span>Allowed chat or channel IDs</span>
            <input value={chatIds} onChange={(event) => setChatIds(event.target.value)} />
          </label>
          <label>
            <span>Webhook secret</span>
            <input placeholder="Create a long private secret" type="password" />
          </label>
          <label>
            <span>Parser template</span>
            <textarea
              placeholder="{{symbol}} {{side}} {{quantity}}"
              rows={4}
            />
          </label>
          <div className="form-row">
            <label>
              <span>Approval policy</span>
              <select value={approvalPolicy} onChange={(event) => setApprovalPolicy(event.target.value)}>
                <option>Customer controlled approval</option>
                <option>Send eligible orders after validation</option>
                <option>Route alerts to review</option>
                <option>Paper-account review only</option>
              </select>
            </label>
            <label>
              <span>Default account</span>
              <select
                value={selectedDefaultAccount}
                onChange={(event) => setDefaultAccount(event.target.value)}
                disabled={accounts.length === 0}
              >
                {accounts.length === 0 && <option>Connect account first</option>}
                {accounts.map((account) => (
                  <option key={account.id}>{account.label}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="check-row">
            <input
              checked={whatsAppAlerts}
              onChange={(event) => setWhatsAppAlerts(event.target.checked)}
              type="checkbox"
            />
            <span>Send WhatsApp notification when an alert creates a pending review</span>
          </label>
          <div className="form-actions">
            <button type="button">
              <Webhook size={18} />
              Save Telegram source
            </button>
          </div>
        </form>
        <aside className="connector-preview" aria-label="Telegram source preview">
          <div className="preview-top">
            <MessageCircle size={22} />
            <div>
              <strong>{sourceName || "New Telegram source"}</strong>
              <span>Customer Source</span>
            </div>
          </div>
          <dl>
            <div>
              <dt>Webhook URL</dt>
              <dd>/api/sources/telegram/webhook</dd>
            </div>
            <div>
              <dt>Allowed chats</dt>
              <dd>{chatIds || "Not set"}</dd>
            </div>
            <div>
              <dt>Policy</dt>
              <dd>{approvalPolicy}</dd>
            </div>
            <div>
              <dt>Default account</dt>
              <dd>{selectedDefaultAccount || "No broker account selected"}</dd>
            </div>
            <div>
              <dt>WhatsApp notices</dt>
              <dd>{whatsAppAlerts ? "Enabled" : "Disabled"}</dd>
            </div>
          </dl>
          <ul className="mini-list">
            <li>
              <BadgeCheck size={16} />
              Store bot token as an encrypted secret
            </li>
            <li>
              <BadgeCheck size={16} />
              Verify webhook secret on every message
            </li>
            <li>
              <BadgeCheck size={16} />
              Log raw message ID, parsed fields, and review outcome
            </li>
            <li>
              <BadgeCheck size={16} />
              Direct order submission is only for validated Customer Source alerts
            </li>
          </ul>
        </aside>
      </div>
    </section>
  );
}

function WhatsAppNotificationsPanel() {
  const [enabled, setEnabled] = useState(true);

  return (
    <article className="panel">
      <SectionHeading icon={MessageCircle} eyebrow="Notifications" title="WhatsApp pending review alerts" />
      <label className="check-row">
        <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />
        <span>Notify customer on WhatsApp when an alert needs review</span>
      </label>
      <div className="connector-form compact-form">
        <label>
          <span>Customer WhatsApp number</span>
          <input placeholder="+1 555 010 1200" />
        </label>
        <label>
          <span>Message template</span>
          <input placeholder="WhatsApp template name" />
        </label>
      </div>
      <p className="muted">
        Customer only needs a regular WhatsApp number and opt-in. The platform sends messages through your WhatsApp
        Business Cloud API sender.
      </p>
      <Pill label={enabled ? "Enabled" : "Disabled"} tone={enabled ? "good" : "warn"} />
    </article>
  );
}

function OverviewPage({
  accounts,
  setPage,
  onRemoveAccount,
}: {
  accounts: BrokerAccount[];
  setPage: (page: Page) => void;
  onRemoveAccount: (accountId: string) => void;
}) {
  const realized = accounts.reduce((sum, account) => sum + account.realizedPnl, 0);
  const open = accounts.reduce((sum, account) => sum + account.openPnl, 0);
  const accountDayPnl = accounts.reduce((sum, account) => sum + account.accountDayPnl, 0);
  return (
    <>
      <section className="dashboard-intro">
        <div>
          <Pill label="Self-directed control" tone="good" />
          <h1>Broker connection dashboard</h1>
          <p>Connect customer-owned sources and broker accounts, then review order intent before live execution.</p>
          <div className="hero-actions">
            <button onClick={() => setPage("accounts")}>
              <KeyRound size={18} />
              Connect account
            </button>
            <button className="secondary" onClick={() => setPage("connections")}>
              <MessageCircle size={18} />
              Add source
            </button>
          </div>
        </div>
        <div className="simple-checklist" aria-label="Platform safeguards">
          <div>
            <ShieldCheck size={20} />
            <strong>Live guardrails</strong>
          </div>
          <span>Manual review for educational-source live orders</span>
          <span>Encrypted broker credentials</span>
          <span>Disclosure and approval records</span>
        </div>
      </section>
      <Metrics accountDayPnl={accountDayPnl} realized={realized} open={open} total={realized + open} />
      <section className="layout-grid">
        <div className="panel wide">
          <SectionHeading icon={WalletCards} eyebrow="Accounts" title="Broker accounts" />
          <AccountTable accounts={accounts} onRemove={onRemoveAccount} />
        </div>
        <div className="panel">
          <SectionHeading icon={SlidersHorizontal} eyebrow="Controls" title="Customer trade settings" />
          <ul className="checklist compact-checklist">
            <li>
              <BadgeCheck size={18} />
              Choose minimum grade and entry order type
            </li>
            <li>
              <BadgeCheck size={18} />
              Set bracket, target-only, stop-only, or entry-only exits
            </li>
            <li>
              <BadgeCheck size={18} />
              Limit position size, daily trades, and daily dollars
            </li>
          </ul>
          <button onClick={() => setPage("controls")}>Edit controls</button>
        </div>
      </section>
    </>
  );
}

function KalkiSourcePanel({ accounts }: { accounts: BrokerAccount[] }) {
  const [enabled, setEnabled] = useState(true);
  const [defaultAccount, setDefaultAccount] = useState(accounts[0]?.id || "");
  const selectedDefaultAccount = accounts.some((account) => account.id === defaultAccount)
    ? defaultAccount
    : accounts[0]?.id || "";

  useEffect(() => {
    if (!defaultAccount && accounts[0]?.id) setDefaultAccount(accounts[0].id);
  }, [accounts, defaultAccount]);

  return (
    <article className="source-option">
      <div className="source-option-top">
        <span className="icon-frame">
          <BookOpen size={18} />
        </span>
        <div>
          <h3>Kalki Educational Source</h3>
          <p>Use Kalki alerts as educational order intent. Live accounts remain customer controlled.</p>
        </div>
        <label className="switch-row">
          <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />
          <span>{enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>
      <div className="source-setting-grid">
        <label>
          <span>Default broker account</span>
          <select
            value={selectedDefaultAccount}
            onChange={(event) => setDefaultAccount(event.target.value)}
            disabled={accounts.length === 0}
          >
            {accounts.length === 0 && <option>Connect an account first</option>}
            {accounts.map((account) => (
              <option value={account.id} key={account.id}>
                {account.label} · {account.broker} {account.accountType}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span>Live policy</span>
          <strong>Manual review before live order</strong>
        </div>
      </div>
      <p className="muted">
        This source should be positioned as educational information. The customer chooses whether to review, approve,
        decline, or disconnect it.
      </p>
    </article>
  );
}

function ConnectionsPage({ accounts }: { accounts: BrokerAccount[] }) {
  return (
    <>
      <PageHeader
        eyebrow="Sources"
        title="Choose where alerts come from."
        description="Use Kalki Educational Source, add a customer Telegram source, or use both. Broker accounts are managed separately in Accounts."
      />
      <section className="source-choice-grid">
        <KalkiSourcePanel accounts={accounts} />
        <article className="source-option">
          <div className="source-option-top">
            <span className="icon-frame">
              <MessageCircle size={18} />
            </span>
            <div>
              <h3>Customer Telegram Source</h3>
              <p>Let the customer connect their own Telegram bot or channel and choose how those alerts are handled.</p>
            </div>
            <Pill label="Customer controlled" tone="good" />
          </div>
          <ul className="mini-list">
            <li>
              <BadgeCheck size={16} />
              Customer supplies bot token and allowed chat IDs
            </li>
            <li>
              <BadgeCheck size={16} />
              Parser turns messages into reviewable order intent
            </li>
            <li>
              <BadgeCheck size={16} />
              Account controls decide grade, order type, sizing, and limits
            </li>
          </ul>
        </article>
      </section>
      <TelegramSourceConnector accounts={accounts} />
    </>
  );
}

function AccountsPage({
  accounts,
  onAddAccount,
  onRestore,
  onRefresh,
  onRemoveAccount,
  loading,
  notice,
}: {
  accounts: BrokerAccount[];
  onAddAccount: (broker: Broker) => void;
  onRestore: (accessCode: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRemoveAccount: (accountId: string) => void;
  loading: boolean;
  notice: string;
}) {
  const [accessCode, setAccessCode] = useState("");
  const realized = accounts.reduce((sum, account) => sum + account.realizedPnl, 0);
  const open = accounts.reduce((sum, account) => sum + account.openPnl, 0);
  const accountDayPnl = accounts.reduce((sum, account) => sum + account.accountDayPnl, 0);
  const restore = async () => {
    const code = accessCode.trim();
    if (!code) return;
    await onRestore(code);
    setAccessCode("");
  };
  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="View broker accounts and P&L separately."
        description="Track multiple Alpaca and Tradier accounts with separate realized, open, and total P&L so the account holder can inspect each account clearly."
      />
      <Metrics accountDayPnl={accountDayPnl} realized={realized} open={open} total={realized + open} />
      <section className="panel restore-panel">
        <SectionHeading icon={KeyRound} eyebrow="Live data" title="Restore existing autotrader account" />
        <div className="restore-form">
          <input
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            placeholder="KALKI-XXXX-XXXX-XXXX"
          />
          <button type="button" onClick={restore} disabled={loading || !accessCode.trim()}>
            Restore
          </button>
          <button className="secondary" type="button" onClick={onRefresh} disabled={loading}>
            Refresh live data
          </button>
        </div>
        <p className="muted">
          Use the access code from the live auto-trader dashboard. This platform then reads real account balance and P/L
          from the secure autotrader backend.
        </p>
        {notice && <p className="status-note">{notice}</p>}
      </section>
      <section className="panel">
        <SectionHeading icon={WalletCards} eyebrow="Multi-account" title="Broker accounts" />
        <div className="table-actions">
          <button onClick={() => onAddAccount("Alpaca")}>
            <Plus size={18} />
            Add Alpaca
          </button>
          <button className="secondary" onClick={() => onAddAccount("Tradier")}>
            <Plus size={18} />
            Add Tradier
          </button>
        </div>
        <AccountTable accounts={accounts} onRemove={onRemoveAccount} />
      </section>
    </>
  );
}

function TradeControlsPage({
  accounts,
  loading,
  notice,
  onSave,
}: {
  accounts: BrokerAccount[];
  loading: boolean;
  notice: string;
  onSave: (accountId: string, controls: TradeControls) => Promise<void>;
}) {
  const [selectedAccountId, setSelectedAccountId] = useState(accounts[0]?.id || "");
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) || accounts[0];
  const [draft, setDraft] = useState<TradeControls>(selectedAccount?.controls || defaultTradeControls);
  const [saving, setSaving] = useState(false);
  const [localNotice, setLocalNotice] = useState("");

  useEffect(() => {
    if (!selectedAccountId && accounts[0]?.id) setSelectedAccountId(accounts[0].id);
  }, [accounts, selectedAccountId]);

  useEffect(() => {
    if (selectedAccount) setDraft(selectedAccount.controls);
  }, [selectedAccount?.id]);

  const updateDraft = (key: keyof TradeControls, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    if (!selectedAccount) return;
    setSaving(true);
    setLocalNotice("Saving controls...");
    try {
      await onSave(selectedAccount.id, draft);
      setLocalNotice("Controls saved for this broker account.");
    } catch (error) {
      setLocalNotice(error instanceof Error ? error.message : "Could not save controls.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Controls"
        title="Let the customer define what trades are allowed."
        description="These settings keep trade decisions in the account holder's hands: source, grade, entry order type, exit style, position sizing, and daily limits."
      />
      <section className="layout-grid">
        <div className="panel wide">
          <SectionHeading icon={SlidersHorizontal} eyebrow="Trade Controls" title="Account trading rules" />
          {accounts.length === 0 ? (
            <EmptyState
              icon={WalletCards}
              title="Connect a broker account first"
              description="Controls are saved per broker account so each account can have its own risk and order rules."
            />
          ) : (
            <div className="controls-form">
              <label>
                <span>Broker account</span>
                <select value={selectedAccount?.id || ""} onChange={(event) => setSelectedAccountId(event.target.value)}>
                  {accounts.map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.label} · {account.broker} {account.accountType}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-row">
                <label>
                  <span>Minimum grade</span>
                  <select value={draft.minGrade} onChange={(event) => updateDraft("minGrade", event.target.value)}>
                    <option value="A+">A+</option>
                    <option value="A">A</option>
                    <option value="B+">B+</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                  </select>
                </label>
                <label>
                  <span>Entry order type</span>
                  <select value={draft.orderType} onChange={(event) => updateDraft("orderType", event.target.value)}>
                    <option value="market">Market</option>
                    <option value="limit">Limit at alert entry</option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  <span>Exit strategy</span>
                  <select value={draft.exitStrategy} onChange={(event) => updateDraft("exitStrategy", event.target.value)}>
                    <option value="bracket">Bracket: stop + take profit (recommended)</option>
                    <option value="take_profit">Buy then sell limit target</option>
                    <option value="stop_loss">Buy then stop loss only</option>
                    <option value="none">Entry only, customer exits manually</option>
                  </select>
                </label>
                <label>
                  <span>Order duration</span>
                  <select value={draft.timeInForce} onChange={(event) => updateDraft("timeInForce", event.target.value)}>
                    <option value="gtc">GTC - keep open</option>
                    <option value="day">Day only</option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  <span>Sizing mode</span>
                  <select value={draft.sizingMode} onChange={(event) => updateDraft("sizingMode", event.target.value)}>
                    <option value="fixed">Fixed dollars per trade (recommended)</option>
                    <option value="risk">Risk % of portfolio</option>
                  </select>
                </label>
                <label>
                  <span>Position size ($)</span>
                  <input value={draft.positionSize} onChange={(event) => updateDraft("positionSize", event.target.value)} inputMode="decimal" />
                </label>
              </div>
              <div className="form-row">
                <label>
                  <span>Portfolio size ($)</span>
                  <input value={draft.portfolioSize} onChange={(event) => updateDraft("portfolioSize", event.target.value)} inputMode="decimal" placeholder="Used for risk % sizing" />
                </label>
                <label>
                  <span>Risk per trade (%)</span>
                  <input value={draft.riskPercent} onChange={(event) => updateDraft("riskPercent", event.target.value)} inputMode="decimal" placeholder="Example: 1" />
                </label>
              </div>
              <div className="form-row">
                <label>
                  <span>Max trades per day</span>
                  <input value={draft.maxTradesPerDay} onChange={(event) => updateDraft("maxTradesPerDay", event.target.value)} inputMode="numeric" />
                </label>
                <label>
                  <span>Max dollars per day</span>
                  <input value={draft.maxDollarsPerDay} onChange={(event) => updateDraft("maxDollarsPerDay", event.target.value)} inputMode="decimal" />
                </label>
              </div>
              <p className="muted">
                Fixed dollars buys the same dollar amount each trade. Risk % uses portfolio size, entry, and stop price
                to calculate shares. Daily limits are still checked before an order is sent.
              </p>
              <div className="form-actions">
                <button type="button" onClick={save} disabled={saving || loading}>
                  {saving ? "Saving..." : "Save controls"}
                </button>
              </div>
              {(localNotice || notice) && <p className="status-note">{localNotice || notice}</p>}
            </div>
          )}
        </div>
        <div className="panel">
          <SectionHeading icon={ShieldCheck} eyebrow="Recommended" title="Safer defaults" />
          <ul className="checklist compact-checklist">
            <li>
              <BadgeCheck size={18} />
              Start with fixed dollars until the customer understands risk sizing
            </li>
            <li>
              <BadgeCheck size={18} />
              Use bracket exits when the alert includes both stop and target
            </li>
            <li>
              <BadgeCheck size={18} />
              Keep max trades and max dollars per day set for live accounts
            </li>
            <li>
              <BadgeCheck size={18} />
              Use minimum grade B or higher only if you want fewer alerts
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}

function ManualOrderPage({
  accounts,
  loading,
  notice,
  onPreview,
  onPlace,
  onSendWhatsApp,
}: {
  accounts: BrokerAccount[];
  loading: boolean;
  notice: string;
  onPreview: (text: string) => Promise<ClientResponse>;
  onPlace: (accountId: string, text: string, liveConfirmation: string) => Promise<ClientResponse>;
  onSendWhatsApp: (accountId: string, to: string, text: string, ticker?: string) => Promise<ClientResponse>;
}) {
  const defaultAlert = "⚡ OKLO\n📊 Grade: B | Score: 6/8\n📈 Entry: $75.27\n🛑 Stop: $70\n🎯 T1: $77";
  const [selectedAccountId, setSelectedAccountId] = useState(accounts[0]?.id || "");
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) || accounts[0];
  const [alertText, setAlertText] = useState(defaultAlert);
  const [preview, setPreview] = useState<ClientResponse | null>(null);
  const [localNotice, setLocalNotice] = useState("");
  const [whatsAppNotice, setWhatsAppNotice] = useState("");
  const [whatsAppNoticeTone, setWhatsAppNoticeTone] = useState<"good" | "error">("good");
  const [busy, setBusy] = useState(false);
  const [whatsAppNumber, setWhatsAppNumber] = useState("");
  const [approvalState, setApprovalState] = useState<"none" | "pending" | "approved" | "declined">("none");

  useEffect(() => {
    if (!selectedAccountId && accounts[0]?.id) setSelectedAccountId(accounts[0].id);
  }, [accounts, selectedAccountId]);

  const approvalMessage = () => {
    const alert = preview?.alert;
    const accountLabel = selectedAccount ? `${selectedAccount.label} · ${selectedAccount.accountType}` : "selected account";
    return [
      `Kalki review needed: ${alert?.ticker || "alert"}`,
      `Account: ${accountLabel}`,
      `Grade: ${alert?.grade || "--"}`,
      `Entry: ${formatBalance(alert?.entryPrice)} Stop: ${formatBalance(alert?.stopPrice)} T1: ${formatBalance(alert?.t1)}`,
      "Open the dashboard to approve or decline:",
      window.location.href,
    ].join("\n");
  };

  const previewAlert = async () => {
    if (!alertText.trim()) return;
    setBusy(true);
    setLocalNotice("Previewing alert...");
    try {
      const data = await onPreview(alertText);
      setPreview(data);
      setApprovalState("none");
      setLocalNotice(data.alert?.ticker ? `Preview ready for ${data.alert.ticker}.` : "Preview ready.");
    } catch (error) {
      setPreview(null);
      setLocalNotice(error instanceof Error ? error.message : "Could not preview alert.");
    } finally {
      setBusy(false);
    }
  };

  const createApproval = () => {
    if (!preview?.alert) {
      setLocalNotice("Preview the alert before creating a WhatsApp approval test.");
      return;
    }
    setApprovalState("pending");
    setLocalNotice("WhatsApp approval test created. Send the notice, then approve or decline in the dashboard.");
  };

  const sendWhatsApp = async () => {
    if (!preview?.alert) {
      setWhatsAppNoticeTone("error");
      setWhatsAppNotice("Preview the alert before sending a WhatsApp test.");
      return;
    }
    if (!selectedAccount) {
      setWhatsAppNoticeTone("error");
      setWhatsAppNotice("Select a broker account before sending a WhatsApp approval.");
      return;
    }
    const cleanNumber = whatsAppNumber.replace(/[^\d]/g, "");
    if (!cleanNumber) {
      setWhatsAppNoticeTone("error");
      setWhatsAppNotice("Enter the customer WhatsApp number with country code.");
      return;
    }
    setBusy(true);
    setWhatsAppNoticeTone("good");
    setWhatsAppNotice("Sending WhatsApp approval notification...");
    try {
      const data = await onSendWhatsApp(selectedAccount.id, cleanNumber, approvalMessage(), preview.alert.ticker);
      const messageId = data.whatsapp?.messages?.[0]?.id;
      setApprovalState("pending");
      setWhatsAppNotice(`Sent to Meta${messageId ? `: ${messageId}` : "."} If it does not arrive, check recipient/test-number access and template approval in Meta.`);
      setWhatsAppNoticeTone("good");
    } catch (error) {
      setWhatsAppNoticeTone("error");
      setWhatsAppNotice(error instanceof Error ? error.message : "Could not send WhatsApp message.");
    } finally {
      setBusy(false);
    }
  };

  const openWhatsAppFallback = () => {
    const cleanNumber = whatsAppNumber.replace(/[^\d]/g, "");
    const url = cleanNumber
      ? `https://wa.me/${cleanNumber}?text=${encodeURIComponent(approvalMessage())}`
      : `https://wa.me/?text=${encodeURIComponent(approvalMessage())}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const placeOrder = async () => {
    if (!selectedAccount || !alertText.trim()) return;
    let liveConfirmation = "";
    if (selectedAccount.accountType === "Live") {
      const typed = window.prompt("This will place a real-money order. Type LIVE to continue:");
      if (typed !== "LIVE") {
        setLocalNotice("Live order cancelled. Type LIVE exactly to place a live order.");
        return;
      }
      liveConfirmation = typed;
    }
    setBusy(true);
    setLocalNotice("Submitting manual order...");
    try {
      const data = await onPlace(selectedAccount.id, alertText, liveConfirmation);
      setPreview(data.result ? { ...data, alert: data.result.alert, decision: data.result.decision } : data);
      setApprovalState("approved");
      setLocalNotice(data.result?.message || data.result?.reason || "Manual order submitted.");
    } catch (error) {
      setLocalNotice(error instanceof Error ? error.message : "Could not place manual order.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Order"
        title="Place a customer-approved manual order."
        description="Paste a Kalki-style alert, preview the parsed trade, then submit it to the selected broker account only after the customer confirms."
      />
      <section className="manual-order-grid">
        <div className="panel wide">
          <SectionHeading icon={ClipboardCheck} eyebrow="Manual Order" title="Paste alert message" />
          <div className="manual-order-form">
            <label>
              <span>Broker account</span>
              <select
                value={selectedAccount?.id || ""}
                onChange={(event) => setSelectedAccountId(event.target.value)}
                disabled={accounts.length === 0}
              >
                {accounts.length === 0 && <option>Connect an account first</option>}
                {accounts.map((account) => (
                  <option value={account.id} key={account.id}>
                    {account.label} · {account.broker} {account.accountType}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Kalki alert text</span>
              <textarea value={alertText} onChange={(event) => setAlertText(event.target.value)} rows={7} />
            </label>
            <div className="form-actions">
              <button className="secondary" type="button" onClick={previewAlert} disabled={busy || !alertText.trim()}>
                Preview
              </button>
              <button type="button" onClick={placeOrder} disabled={busy || loading || !selectedAccount || !alertText.trim()}>
                {selectedAccount?.accountType === "Live" ? "Place Live Order" : "Place Paper Order"}
              </button>
            </div>
            {(localNotice || notice) && <p className="status-note">{localNotice || notice}</p>}
          </div>
        </div>
        <aside className="panel">
          <SectionHeading icon={Activity} eyebrow="Preview" title="Parsed trade" />
          {preview?.alert ? (
            <div className="manual-preview">
              <strong>{preview.alert.ticker || "--"}</strong>
              <dl>
                <div>
                  <dt>Grade</dt>
                  <dd>{preview.alert.grade || "--"}</dd>
                </div>
                <div>
                  <dt>Entry</dt>
                  <dd>{formatBalance(preview.alert.entryPrice)}</dd>
                </div>
                <div>
                  <dt>Stop</dt>
                  <dd>{formatBalance(preview.alert.stopPrice)}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{formatBalance(preview.alert.t1)}</dd>
                </div>
                <div>
                  <dt>Shares</dt>
                  <dd>{preview.decision?.shares || "--"}</dd>
                </div>
                <div>
                  <dt>Notional</dt>
                  <dd>{formatBalance(preview.decision?.notional)}</dd>
                </div>
              </dl>
              {preview.decision?.reason && <p className="muted">{preview.decision.reason}</p>}
            </div>
          ) : (
            <EmptyState
              icon={ClipboardCheck}
              title="Preview before placing"
              description="The parsed ticker, grade, entry, stop, target, and share estimate will appear here."
            />
          )}
          <RiskBanner />
        </aside>
      </section>
      <section className="panel whatsapp-test-panel">
        <div className="log-toolbar">
          <SectionHeading icon={MessageCircle} eyebrow="WhatsApp Test" title="Approval notification test" />
          <Pill
            label={approvalState === "none" ? "Not created" : approvalState}
            tone={approvalState === "approved" ? "good" : approvalState === "declined" ? "danger" : approvalState === "pending" ? "warn" : "neutral"}
          />
        </div>
        <div className="whatsapp-test-grid">
          <div className="manual-order-form">
            <label>
              <span>Customer WhatsApp number</span>
              <input
                value={whatsAppNumber}
                onChange={(event) => setWhatsAppNumber(event.target.value)}
                placeholder="+1 555 010 1200"
                inputMode="tel"
              />
            </label>
            <label>
              <span>Test message</span>
              <textarea value={approvalMessage()} readOnly rows={6} />
            </label>
            <div className="form-actions">
              <button type="button" onClick={sendWhatsApp} disabled={!preview?.alert || busy || loading}>
                {busy ? "Sending..." : "Send WhatsApp"}
              </button>
              <button className="secondary" type="button" onClick={openWhatsAppFallback}>
                Open WhatsApp Manually
              </button>
            </div>
            {whatsAppNotice && (
              <p className={`status-note${whatsAppNoticeTone === "error" ? " error" : ""}`}>{whatsAppNotice}</p>
            )}
          </div>
          <div className="approval-card">
            <strong>{preview?.alert?.ticker || "No alert previewed"}</strong>
            <p>
              This simulates the customer receiving a WhatsApp notice. The actual approval or decline is recorded here
              in the dashboard.
            </p>
            <div className="form-actions">
              <button type="button" onClick={placeOrder} disabled={approvalState !== "pending" || busy || loading || !selectedAccount}>
                Approve & Place Order
              </button>
              <button className="danger" type="button" onClick={() => setApprovalState("declined")} disabled={approvalState !== "pending"}>
                Decline
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function AddAccountDialog({
  broker,
  onClose,
  onConnected,
}: {
  broker: Broker | null;
  onClose: () => void;
  onConnected: (data: ClientResponse, session: StoredSession) => void;
}) {
  const [label, setLabel] = useState("");
  const [accountType, setAccountType] = useState<BrokerAccount["accountType"]>("Paper");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [maxTradesPerDay, setMaxTradesPerDay] = useState("");
  const [maxDollarsPerDay, setMaxDollarsPerDay] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!broker) {
    return null;
  }

  const saveAccount = async () => {
    const cleanLabel = label.trim() || `${broker} ${accountType.toLowerCase()} account`;
    const environment = accountType === "Live" ? "live" : "paper";
    const endpoint =
      broker === "Alpaca"
        ? environment === "live"
          ? "https://api.alpaca.markets"
          : "https://paper-api.alpaca.markets"
        : environment === "live"
          ? "https://api.tradier.com"
          : "https://sandbox.tradier.com";
    setSaving(true);
    setError("");
    try {
      const data = await autotraderPost("/api/client/register", {
        name: cleanLabel,
        broker: broker.toLowerCase(),
        environment,
        endpoint,
        key,
        secret,
        positionSize: 100,
        maxTradesPerDay,
        maxDollarsPerDay,
        customerAcknowledgement: accepted,
        createNewAccount: true,
      });
      if (!data.client?.id || !data.token) throw new Error("Autotrader did not return a client session");
      onConnected(data, { clientId: data.client.id, clientToken: data.token, label: cleanLabel });
      setLabel("");
      setKey("");
      setSecret("");
      setMaxTradesPerDay("");
      setMaxDollarsPerDay("");
      setAccepted(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not connect broker account");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-label={`Add ${broker} account`}>
        <SectionHeading icon={WalletCards} eyebrow="Broker account" title={`Add ${broker} account`} />
        <div className="connector-form">
          <label>
            <span>Account label</span>
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Primary paper account" />
          </label>
          <div className="form-row">
            <label>
              <span>Account type</span>
              <select value={accountType} onChange={(event) => setAccountType(event.target.value as BrokerAccount["accountType"])}>
                <option>Paper</option>
                <option>Live</option>
              </select>
            </label>
          </div>
          {broker === "Alpaca" && (
            <div className="credential-box">
              <SectionHeading icon={KeyRound} eyebrow="Alpaca credentials" title="API connection" />
              <div className="form-row">
                <label>
                  <span>API key ID</span>
                  <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="PK..." />
                </label>
                <label>
                  <span>API secret key</span>
                  <input value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Paste secret key" type="password" />
                </label>
              </div>
              <label>
                <span>Base URL</span>
                <input value={accountType === "Live" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets"} readOnly />
              </label>
            </div>
          )}
          {broker === "Tradier" && (
            <div className="credential-box">
              <SectionHeading icon={KeyRound} eyebrow="Tradier credentials" title="API connection" />
              <div className="form-row">
                <label>
                  <span>Access token</span>
                  <input value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Paste Tradier token" type="password" />
                </label>
                <label>
                  <span>Account ID</span>
                  <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="Tradier account ID" />
                </label>
              </div>
              <label>
                <span>Base URL</span>
                <input value={accountType === "Live" ? "https://api.tradier.com" : "https://sandbox.tradier.com"} readOnly />
              </label>
            </div>
          )}
          <div className="form-row">
            <label>
              <span>Max trades per day</span>
              <input value={maxTradesPerDay} onChange={(event) => setMaxTradesPerDay(event.target.value)} inputMode="numeric" />
            </label>
            <label>
              <span>Max dollars per day</span>
              <input value={maxDollarsPerDay} onChange={(event) => setMaxDollarsPerDay(event.target.value)} inputMode="decimal" />
            </label>
          </div>
          <label className="check-row">
            <input checked={accepted} onChange={(event) => setAccepted(event.target.checked)} type="checkbox" />
            <span>
              I understand this is a self-directed educational tool. I am responsible for broker credentials, settings,
              orders, and risk.
            </span>
          </label>
          <p className="muted">
            Credentials should be sent only to the secure backend, encrypted, verified with the broker, and logged before
            the account is marked ready.
          </p>
          {accountType === "Live" && (
            <p className="status-note">
              Live accounts require daily trade and dollar limits. New live accounts start restricted until enabled in
              the execution dashboard.
            </p>
          )}
          {error && <p className="status-note error">{error}</p>}
          <div className="form-actions">
            <button type="button" onClick={saveAccount} disabled={saving || !key.trim() || !secret.trim() || !accepted}>
              {saving ? "Connecting..." : "Connect live data"}
            </button>
            <button className="secondary" type="button" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ReviewPage({
  items,
  loading,
  notice,
  onRefresh,
  onApprove,
  onDecline,
}: {
  items: ReviewItem[];
  loading: boolean;
  notice: string;
  onRefresh: () => void;
  onApprove: (accountId: string, approvalId: string) => void;
  onDecline: (accountId: string, approvalId: string) => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Review pending order intent before sending."
        description="Live-account items from Kalki Educational Source start in manual approval. The account holder can approve or decline after reviewing risk context."
      />
      <RiskBanner />
      <section className="layout-grid">
        <div className="panel wide">
          <div className="log-toolbar">
            <SectionHeading icon={UserCheck} eyebrow="Order review" title="Pending approvals" />
            <button className="secondary" type="button" onClick={onRefresh} disabled={loading}>
              Refresh
            </button>
          </div>
          {notice && <p className="status-note">{notice}</p>}
          <ReviewList items={items} onApprove={onApprove} onDecline={onDecline} busy={loading} />
        </div>
        <div className="panel">
          <SectionHeading icon={FileCheck2} eyebrow="Approval record" title="What gets logged" />
          <ul className="checklist">
            <li>
              <BadgeCheck size={18} />
              Account holder identity
            </li>
            <li>
              <BadgeCheck size={18} />
              Source, account, broker, symbol, quantity, and side
            </li>
            <li>
              <BadgeCheck size={18} />
              Disclosure version and timestamp
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}

function DisclosuresPage() {
  return (
    <>
      <PageHeader
        eyebrow="Disclosures"
        title="Keep responsibility and risk language front and center."
        description="Every live-account workflow should present clear acknowledgments before the account holder approves an order."
      />
      <section className="layout-grid">
        <div className="panel wide">
          <SectionHeading icon={BookOpen} eyebrow="Required" title="Acknowledgments" />
          <DisclosureList />
        </div>
        <div className="panel">
          <SectionHeading icon={ShieldCheck} eyebrow="Default" title="Educational source policy" />
          <p className="muted">
            Kalki Educational Source is educational only. Live-account order intent from that source is routed to manual
            review unless the platform owner changes the policy after legal and broker review.
          </p>
        </div>
      </section>
    </>
  );
}

function AuditPage() {
  return (
    <>
      <PageHeader
        eyebrow="Audit"
        title="Track every alert, review, and account event."
        description="Maintain durable records for alert intake, broker connections, disclosure acknowledgments, approvals, declines, and order status changes."
      />
      <section className="panel">
        <SectionHeading icon={Clock3} eyebrow="Audit log" title="Recent platform events" />
        <AuditTimeline />
      </section>
    </>
  );
}

function SettingsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Set platform policies before account activity."
        description="Configure approval defaults, account limits, disclosure versions, and broker credential controls."
      />
      <section className="settings-grid">
        <article className="panel">
          <SectionHeading icon={Settings} eyebrow="Approval" title="Live account policy" />
          <div className="setting-row">
            <span>Kalki Educational Source</span>
            <Pill label="Manual approval required" tone="good" />
          </div>
          <div className="setting-row">
            <span>Customer Source</span>
            <Pill label="Customer controlled approval" />
          </div>
        </article>
        <article className="panel">
          <SectionHeading icon={Lock} eyebrow="Security" title="Credential storage" />
          <div className="setting-row">
            <span>Broker tokens</span>
            <Pill label="Encrypted" tone="good" />
          </div>
          <div className="setting-row">
            <span>Audit retention</span>
            <Pill label="Required" tone="good" />
          </div>
        </article>
        <WhatsAppNotificationsPanel />
      </section>
    </>
  );
}

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [accounts, setAccounts] = useState<BrokerAccount[]>(initialAccounts);
  const [sessions, setSessions] = useState<StoredSession[]>(() => readStoredSessions());
  const [addBroker, setAddBroker] = useState<Broker | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [accountNotice, setAccountNotice] = useState("");
  const [tradeLogs, setTradeLogs] = useState<TradeLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logNotice, setLogNotice] = useState("");
  const reviewItems = useMemo(() => pendingReviewItems(tradeLogs), [tradeLogs]);
  const activeTitle = useMemo(() => navItems.find((item) => item.id === page)?.label ?? "Overview", [page]);

  const refreshAccounts = async (sourceSessions = sessions) => {
    setLoadingAccounts(true);
    setAccountNotice(sourceSessions.length ? "Refreshing live account data..." : "Restore or connect an account to load live data.");
    const loaded: BrokerAccount[] = [];
    const validSessions: StoredSession[] = [];
    for (const session of sourceSessions) {
      try {
        const data = await autotraderPost("/api/client/me", {}, session);
        loaded.push(accountFromClient(data, session));
        validSessions.push({
          ...session,
          label: data.client?.name || data.client?.brokerLabel || session.label,
        });
      } catch (error) {
        setAccountNotice(error instanceof Error ? error.message : "Could not refresh one of the saved accounts.");
      }
    }
    setAccounts(loaded);
    setSessions(validSessions);
    writeStoredSessions(validSessions);
    if (validSessions.length) {
      setAccountNotice(`Loaded ${validSessions.length} live account${validSessions.length === 1 ? "" : "s"}.`);
    } else if (sourceSessions.length) {
      setAccountNotice("No saved accounts could be refreshed. Restore the account with a fresh access code.");
    }
    setLoadingAccounts(false);
  };

  useEffect(() => {
    const storedSessions = readStoredSessions();
    setSessions(storedSessions);
    void refreshAccounts(storedSessions);
  }, []);

  const restoreAccount = async (accessCode: string) => {
    setLoadingAccounts(true);
    setAccountNotice("Restoring account...");
    try {
      const data = await autotraderPost("/api/client/restore", { accessCode });
      if (!data.client?.id || !data.token) throw new Error("Restore did not return a client session");
      const nextSessions = upsertStoredSession({
        clientId: data.client.id,
        clientToken: data.token,
        label: data.client.name || data.client.brokerLabel,
      });
      setSessions(nextSessions);
      setAccounts((current) => {
        const account = accountFromClient(data, nextSessions[0]);
        return [account, ...current.filter((item) => item.id !== account.id)];
      });
      setAccountNotice("Restored live account data.");
    } catch (error) {
      setAccountNotice(error instanceof Error ? error.message : "Could not restore account.");
    } finally {
      setLoadingAccounts(false);
    }
  };

  const handleConnectedAccount = (data: ClientResponse, session: StoredSession) => {
    const nextSessions = upsertStoredSession(session);
    setSessions(nextSessions);
    const account = accountFromClient(data, session);
    setAccounts((current) => [account, ...current.filter((item) => item.id !== account.id)]);
    setAddBroker(null);
    setPage("accounts");
    setAccountNotice("Connected real broker account data.");
  };

  const loadTradeLogs = async (sourceSessions = sessions) => {
    setLoadingLogs(true);
    setLogNotice(sourceSessions.length ? "Loading trade logs..." : "Restore or connect an account to view logs.");
    const loaded: TradeLogEntry[] = [];
    for (const session of sourceSessions) {
      try {
        const data = await autotraderPost("/api/client/logs", {}, session);
        const accountLabel =
          accounts.find((account) => account.id === session.clientId)?.label || session.label || "Broker account";
        (data.logs || []).forEach((log, index) => {
          loaded.push({
            ...log,
            id: `${session.clientId}-${log.logged_at || log.created_at || index}-${index}`,
            accountLabel,
          });
        });
      } catch (error) {
        setLogNotice(error instanceof Error ? error.message : "Could not load one of the account logs.");
      }
    }
    loaded.sort((left, right) =>
      String(right.logged_at || right.created_at || "").localeCompare(String(left.logged_at || left.created_at || ""))
    );
    setTradeLogs(loaded);
    setLogNotice(loaded.length ? `Loaded ${loaded.length} log row${loaded.length === 1 ? "" : "s"}.` : "No trade logs yet.");
    setLoadingLogs(false);
  };

  const refreshPnlAndLogs = async () => {
    setLoadingLogs(true);
    setLogNotice(sessions.length ? "Refreshing realized P/L..." : "Restore or connect an account first.");
    for (const session of sessions) {
      try {
        await autotraderPost("/api/client/refresh-pnl", {}, session);
      } catch (error) {
        setLogNotice(error instanceof Error ? error.message : "Could not refresh P/L for one account.");
      }
    }
    await refreshAccounts();
    await loadTradeLogs();
    setLoadingLogs(false);
  };

  const saveTradeControls = async (accountId: string, controls: TradeControls) => {
    const session = sessions.find((item) => item.clientId === accountId);
    if (!session) throw new Error("Restore this account again before saving controls.");
    setLoadingAccounts(true);
    setAccountNotice("Saving account controls...");
    try {
      await autotraderPost(
        "/api/client/settings",
        {
          minGrade: controls.minGrade,
          orderType: controls.orderType,
          exitStrategy: controls.exitStrategy,
          timeInForce: controls.timeInForce,
          sizingMode: controls.sizingMode,
          positionSize: controls.positionSize,
          portfolioSize: controls.portfolioSize,
          riskPercent: controls.riskPercent,
          maxTradesPerDay: controls.maxTradesPerDay,
          maxDollarsPerDay: controls.maxDollarsPerDay,
          customerAcknowledgement: true,
        },
        session
      );
      await refreshAccounts();
      setAccountNotice("Account controls saved.");
    } finally {
      setLoadingAccounts(false);
    }
  };

  const previewManualOrder = async (text: string) => {
    return await autotraderPost("/api/test", { text });
  };

  const placeManualOrder = async (accountId: string, text: string, liveConfirmation: string) => {
    const session = sessions.find((item) => item.clientId === accountId);
    if (!session) throw new Error("Restore this account again before placing a manual order.");
    const response = await fetch(`${AUTOTRADER_API}/api/client/manual-trade`, {
      method: "POST",
      headers: clientHeaders(session),
      body: JSON.stringify({ text, liveConfirmation }),
    });
    const data = (await response.json().catch(() => ({}))) as ClientResponse;
    if (!response.ok) throw new Error(data.error || `Manual order request failed with HTTP ${response.status}`);
    if (!data.result && !data.ok) throw new Error(data.error || "Manual order was not submitted.");
    await refreshAccounts();
    await loadTradeLogs();
    return data;
  };

  const sendWhatsAppApproval = async (accountId: string, to: string, text: string, ticker?: string) => {
    const session = sessions.find((item) => item.clientId === accountId);
    if (!session) throw new Error("Restore this account again before sending WhatsApp approvals.");
    return await autotraderPost("/api/client/whatsapp-approval", { to, text, ticker }, session);
  };

  const decidePendingApproval = async (accountId: string, approvalId: string, action: "approve" | "decline") => {
    const session = sessions.find((item) => item.clientId === accountId);
    if (!session) {
      setLogNotice("Restore this account again before approving this order.");
      return;
    }
    if (action === "approve") {
      const confirmed = window.confirm("Approve this pending live order and send it to the broker?");
      if (!confirmed) return;
    }
    setLoadingLogs(true);
    setLogNotice(action === "approve" ? "Approving and submitting order..." : "Declining pending order...");
    try {
      await autotraderPost("/api/client/approval", { approvalId, action }, session);
      await refreshAccounts();
      await loadTradeLogs();
      setLogNotice(action === "approve" ? "Approval submitted." : "Order declined.");
    } catch (error) {
      setLogNotice(error instanceof Error ? error.message : "Could not update pending approval.");
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    if (page === "logs" || page === "pnl" || page === "review") void loadTradeLogs();
  }, [page]);

  const removeAccount = (accountId: string) => {
    const account = accounts.find((item) => item.id === accountId);
    const confirmed = window.confirm(
      `Remove ${account?.label || "this account"} from this dashboard? This only forgets it in this browser and does not delete the autotrader profile.`
    );
    if (!confirmed) return;
    const nextSessions = sessions.filter((session) => session.clientId !== accountId);
    setSessions(nextSessions);
    writeStoredSessions(nextSessions);
    setAccounts((current) => current.filter((item) => item.id !== accountId));
    setAccountNotice("Account removed from this dashboard. Restore it again with its access code when needed.");
  };

  return (
    <main>
      <header className="topbar">
        <button className="brand-button" onClick={() => setPage("overview")} aria-label="Open overview">
          <span className="brand-mark">K</span>
          <span>
            <strong>Kalki Directed Investing</strong>
            <small>Self-directed alert review and broker connection platform</small>
          </span>
        </button>
        <nav aria-label="Primary">
          {navItems.map((item) => (
            <button
              className={item.id === page ? "active" : ""}
              key={item.id}
              onClick={() => setPage(item.id)}
              aria-current={item.id === page ? "page" : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <p className="screen-label">{activeTitle}</p>
      {page === "overview" && <OverviewPage accounts={accounts} setPage={setPage} onRemoveAccount={removeAccount} />}
      {page === "connections" && <ConnectionsPage accounts={accounts} />}
      {page === "accounts" && (
        <AccountsPage
          accounts={accounts}
          onAddAccount={setAddBroker}
          onRestore={restoreAccount}
          onRefresh={() => refreshAccounts()}
          onRemoveAccount={removeAccount}
          loading={loadingAccounts}
          notice={accountNotice}
        />
      )}
      {page === "pnl" && (
        <PnlPage
          logs={tradeLogs}
          loading={loadingLogs}
          notice={logNotice}
          onRefresh={() => loadTradeLogs()}
          onRefreshPnl={refreshPnlAndLogs}
        />
      )}
      {page === "controls" && (
        <TradeControlsPage
          accounts={accounts}
          loading={loadingAccounts}
          notice={accountNotice}
          onSave={saveTradeControls}
        />
      )}
      {page === "order" && (
        <ManualOrderPage
          accounts={accounts}
          loading={loadingAccounts}
          notice={accountNotice}
          onPreview={previewManualOrder}
          onPlace={placeManualOrder}
          onSendWhatsApp={sendWhatsAppApproval}
        />
      )}
      {page === "logs" && (
        <LogsPage
          logs={tradeLogs}
          loading={loadingLogs}
          notice={logNotice}
          onRefresh={() => loadTradeLogs()}
          onRefreshPnl={refreshPnlAndLogs}
        />
      )}
      {page === "review" && (
        <ReviewPage
          items={reviewItems}
          loading={loadingLogs}
          notice={logNotice}
          onRefresh={() => loadTradeLogs()}
          onApprove={(accountId, approvalId) => decidePendingApproval(accountId, approvalId, "approve")}
          onDecline={(accountId, approvalId) => decidePendingApproval(accountId, approvalId, "decline")}
        />
      )}
      {page === "disclosures" && <DisclosuresPage />}
      {page === "audit" && <AuditPage />}
      {page === "settings" && <SettingsPage />}
      <AddAccountDialog
        broker={addBroker}
        onClose={() => setAddBroker(null)}
        onConnected={handleConnectedAccount}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
