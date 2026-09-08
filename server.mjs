#!/usr/bin/env node
// WhaleTape MCP server. Consult first (free), then pay per call over x402.
// Networks: Base (WHALETAPE_EVM_PRIVATE_KEY), Solana (WHALETAPE_SVM_PRIVATE_KEY),
// Algorand (WHALETAPE_AVM_PRIVATE_KEY). Register only what has a key.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";

const BASE_URL = (process.env.WHALETAPE_API_BASE_URL || "https://whaletape.xyz").replace(/\/$/, "");
const MAX_USDC = Number(process.env.WHALETAPE_MAX_USDC_PER_CALL || "1.00");
const PREFER = (process.env.WHALETAPE_PREFER_NETWORK || "").trim(); // e.g. "solana", "eip155", "algorand"
const FREE = ["/preview/whales", "/preview/signals", "/preview/squeeze", "/markets/preview", "/public/stats", "/track-record", "/metrics", "/health"];

// ---------- catalog (free, cached) ----------
let catalogCache = { at: 0, resources: [] };
async function catalog() {
  if (Date.now() - catalogCache.at < 5 * 60_000 && catalogCache.resources.length) return catalogCache.resources;
  const r = await fetch(`${BASE_URL}/.well-known/x402`);
  if (!r.ok) throw new Error(`catalog unavailable: HTTP ${r.status}`);
  const j = await r.json();
  const resources = (j.resources || []).map(x => ({
    method: x.method, path: x.path, price_usdc: Number(x.price), description: x.description,
    networks: [...(x.accepts || []).map(a => a.network), ...((x.alternatives || []).flatMap(a => (a.accepts || []).map(b => b.network)))].filter(Boolean),
  }));
  catalogCache = { at: Date.now(), resources };
  return resources;
}

// ---------- consult (free): intent -> route ----------
const INTENTS = [
  { keys: ["liquidation", "liq level", "get liquidated", "cascade"], path: "/liquidations", tip: "per-market: /liquidations/BTC, /liquidations/ETH, /liquidations/SOL, /liquidations/HYPE" },
  { keys: ["whale position", "largest position", "who is long", "who is short", "biggest whale"], path: "/whales/positions" },
  { keys: ["whale", "smart money", "leaderboard trader", "which side"], path: "/whales" },
  { keys: ["what did whales do", "whale event", "opened", "closed", "flipped"], path: "/whales/events" },
  { keys: ["wallet", "address", "0x"], path: "/whale/[address]", tip: "replace [address] with the 0x wallet" },
  { keys: ["squeeze", "short squeeze", "crowded"], path: "/squeeze" },
  { keys: ["funding", "open interest", "oi jump", "signal", "positioning change"], path: "/signals" },
  { keys: ["flow", "rotation", "money moving", "inflow", "outflow"], path: "/flows", tip: "per asset class: /flows/classes" },
  { keys: ["all markets", "every market", "full market", "mark price"], path: "/markets/full" },
  { keys: ["crypto only", "equities", "commodities", "fx", "asset class", "screen"], path: "/markets/class/[asset_class]", tip: "asset_class: crypto | equities | commodities | fx | indices | rates" },
  { keys: ["history", "backtest", "time series", "series"], path: "/history/[symbol]", tip: "e.g. /history/BTC" },
  { keys: ["what changed", "since last", "delta", "cursor", "poll"], path: "/pulse" },
  { keys: ["recommend", "bias", "long or short", "should i"], path: "/recommendations" },
  { keys: ["brief", "analysis", "written read", "summary of the market", "overview"], path: "/analysis" },
  { keys: ["premium", "everything", "bundle", "one call"], path: "/premium" },
  { keys: ["ask", "question", "why", "explain"], path: "/ask", tip: "GET /ask?q=your question" },
  { keys: ["alert", "webhook", "push", "notify", "stop polling"], path: "/alerts", tip: "POST JSON {webhook_url, symbols?, ttl_hours?}" },
  { keys: ["coverage", "which markets", "what do you track", "range"], path: "/coverage" },
  { keys: ["x402 merchant", "settlement rate", "which endpoints settle", "index"], path: "/index/summary", tip: "ranking: /index/ranking; one merchant: /index/merchant/[id]" },
];
function consult(intent, resources) {
  const q = intent.toLowerCase();
  const hits = INTENTS.filter(i => i.keys.some(k => q.includes(k)));
  const picks = (hits.length ? hits : [INTENTS.find(i => i.path === "/premium")]).slice(0, 3);
  return picks.map(p => {
    const res = resources.find(r => r.path === p.path) || {};
    return { path: p.path, method: res.method || "GET", price_usdc: res.price_usdc ?? null,
             description: res.description || "", networks: res.networks || [], tip: p.tip || null,
             call_with: p.path.startsWith("/alerts") ? "whaletape_fetch (method POST, body)" : "whaletape_fetch" };
  });
}

// ---------- payment client ----------
let payingFetch = null, registered = [];
async function buildClient() {
  const { wrapFetchWithPaymentFromConfig } = await import("@x402/fetch");
  const schemes = [];
  if (process.env.WHALETAPE_EVM_PRIVATE_KEY) {
    const { ExactEvmScheme } = await import("@x402/evm");
    const { privateKeyToAccount } = await import("viem/accounts");
    // MetaMask exports without 0x and with surrounding spaces; viem needs 0x + 64 hex.
    let evmKey = process.env.WHALETAPE_EVM_PRIVATE_KEY.trim().replace(/\s+/g, "");
    if (!evmKey.startsWith("0x")) evmKey = "0x" + evmKey;
    if (!/^0x[0-9a-fA-F]{64}$/.test(evmKey)) throw new Error("WHALETAPE_EVM_PRIVATE_KEY must be 64 hex chars (with or without 0x); got " + evmKey.length + " chars");
    schemes.push({ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(evmKey)) });
    registered.push("eip155");
  }
  if (process.env.WHALETAPE_SVM_PRIVATE_KEY) {
    const { ExactSvmScheme } = await import("@x402/svm");
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const { base58 } = await import("@scure/base");
    const kp = await createKeyPairSignerFromBytes(base58.decode(process.env.WHALETAPE_SVM_PRIVATE_KEY));
    schemes.push({ network: "solana:*", client: new ExactSvmScheme(kp) });
    registered.push("solana");
  }
  if (process.env.WHALETAPE_AVM_PRIVATE_KEY) {
    const { ExactAvmScheme, toClientAvmSigner } = await import("@x402/avm");
    schemes.push({ network: "algorand:*", client: new ExactAvmScheme(toClientAvmSigner(process.env.WHALETAPE_AVM_PRIVATE_KEY)) });
    registered.push("algorand");
  }
  if (!schemes.length) return;
  // Prefer a network when asked; otherwise the first option we can sign.
  // The USD cap is the SDK's own spend control (enforced before selection).
  const selector = (_version, accepts) => {
    let opts = accepts.filter(a => registered.includes(String(a.network).split(":")[0]));
    if (!opts.length) throw new Error(`no configured wallet for any of: ${accepts.map(a => a.network).join(", ")}`);
    if (PREFER) opts = [...opts.filter(a => String(a.network).startsWith(PREFER)), ...opts.filter(a => !String(a.network).startsWith(PREFER))];
    return opts[0];
  };
  payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes,
    spendControls: { maxAmountPerPayment: `$${MAX_USDC.toFixed(2)}` },
    paymentRequirementsSelector: selector,
  });
}

async function paidCall(path, method, body) {
  if (!payingFetch) await buildClient();
  if (!registered.length) throw new Error("no wallet configured: set WHALETAPE_EVM_PRIVATE_KEY, WHALETAPE_SVM_PRIVATE_KEY or WHALETAPE_AVM_PRIVATE_KEY");
  const init = { method, headers: { accept: "application/json", "user-agent": "whaletape-mcp/0.1.1" } };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await payingFetch(`${BASE_URL}${path}`, init);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  let receipt = null;
  const ph = r.headers.get("payment-response") || r.headers.get("x-payment-response");
  if (ph) { try { receipt = decodePaymentResponseHeader(ph); } catch { receipt = ph; } }
  return { status: r.status, data, receipt, billed: r.status < 400 && !!receipt };
}

// ---------- MCP ----------
const server = new McpServer({ name: "whaletape", version: "0.1.1" });
const text = o => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 1) }] });

server.tool("whaletape_consult",
  "FREE, never bills. Call this first with the user's whole intent about Hyperliquid perps, whales, funding, open interest, liquidations or market flows. Returns which WhaleTape route to call, its price in USDC and the networks that accept payment (Base, Solana, Algorand).",
  { intent: z.string().describe("what the user wants, in plain words") },
  async ({ intent }) => text({ suggestions: consult(intent, await catalog()), how_to_pay: "call whaletape_fetch with the path; payment is automatic on the first network you have a key for", max_usdc_per_call: MAX_USDC }));

server.tool("whaletape_catalog", "FREE. Every paid route with price (USDC) and payment networks, plus the free routes.", {},
  async () => text({ paid: await catalog(), free: FREE, base_url: BASE_URL }));

server.tool("whaletape_free", "FREE. Call a free WhaleTape route (no payment). Real samples of paid data: /preview/whales, /preview/signals, /preview/squeeze; also /markets/preview, /public/stats, /track-record, /metrics, /health.",
  { path: z.string().describe("one of the free paths") },
  async ({ path }) => {
    if (!FREE.includes(path)) return text({ error: `not a free route; free: ${FREE.join(", ")}` });
    const r = await fetch(`${BASE_URL}${path}`); const t = await r.text();
    let d; try { d = JSON.parse(t); } catch { d = t; }
    return text({ status: r.status, data: d });
  });

server.tool("whaletape_fetch",
  "PAID over x402 (USDC). Calls a WhaleTape route and pays the quoted price automatically with the configured wallet (Base, Solana or Algorand). Returns the data and the on-chain receipt. Never pays more than WHALETAPE_MAX_USDC_PER_CALL. A 4xx/5xx answer is never billed.",
  { path: z.string().describe("route path, e.g. /premium or /liquidations/BTC or /ask?q=..."),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.record(z.any()).optional().describe("JSON body for POST routes (e.g. /alerts)") },
  async ({ path, method, body }) => {
    try { return text(await paidCall(path, method, body)); }
    catch (e) { return text({ error: String(e?.message || e), paid: false }); }
  });

const transport = new StdioServerTransport();
await server.connect(transport);
