# whaletape-mcp-server

MCP server for [WhaleTape](https://whaletape.xyz): pay-per-call Hyperliquid whale,
funding, open-interest and liquidation intelligence over **x402** (USDC on Base,
Solana or Algorand). No account, no API key: consult first (free), then pay per call.

Agent one-liner: `set up https://whaletape.xyz/skill.md`

## Install

```bash
claude mcp add whaletape \
  -e WHALETAPE_EVM_PRIVATE_KEY=0x... \
  -- npx -y whaletape-mcp-server@latest
```

Configure one or more wallets (the first network you can sign for pays):

| env | network | key format |
|---|---|---|
| `WHALETAPE_EVM_PRIVATE_KEY` | Base (`eip155:8453`) | `0x` hex |
| `WHALETAPE_SVM_PRIVATE_KEY` | Solana | base58 (Phantom export) |
| `WHALETAPE_AVM_PRIVATE_KEY` | Algorand | base64, 64 bytes |

Optional: `WHALETAPE_PREFER_NETWORK=solana|eip155|algorand`,
`WHALETAPE_MAX_USDC_PER_CALL=1.00` (SDK spend control, default $1).

## Tools

- `whaletape_consult(intent)` — **free**, never bills. Returns which route to call and its price.
- `whaletape_catalog()` — free. All routes, prices, networks.
- `whaletape_free(path)` — free routes: `/preview/whales`, `/preview/signals`, `/preview/squeeze` (real samples of paid data), `/markets/preview`, `/public/stats`, `/track-record`, `/metrics`, `/health`.
- `whaletape_fetch(path, method?, body?)` — **paid**. Pays the 402 quote automatically and returns data + on-chain receipt. A 4xx/5xx answer is never billed.

## Without MCP

Any x402 client works — the routes speak plain HTTP 402. Two pages are generated
from the live catalog, so their prices are always the ones the 402 charges:

- `https://whaletape.xyz/skill.md` — for agents with a shell or MCP
- `https://whaletape.xyz/skill-automaton.md` — for autonomous agents that pay on Base

Machine-readable catalog: `https://whaletape.xyz/.well-known/x402`

## Free routes, no wallet needed

`/preview/whales`, `/preview/signals`, `/preview/squeeze` are real samples of the
paid data. `/track-record` publishes the measured hit rate of our own squeeze
radar, bands and sample sizes included — read it before trusting a score.

Contact: hello@whaletape.xyz · Catalog: https://whaletape.xyz/.well-known/x402
