# Helix

Helix is an AI trading terminal for crypto execution and strategy automation. The repository currently contains:

- `app/dashboard`: trading dashboard frontend
- `skills`: account, execution, Price Action specification, and Freqtrade automation tools for agents

## Skills

Only these 4 skills are part of the skill layer:

| Skill | Purpose |
|---|---|
| `helix-account` | Query exchange balances, positions, orders, trade history, and guide API key setup |
| `helix-trading` | Execute CEX spot / perpetual orders, close positions, set stop loss / take profit, configure leverage and margin mode |
| `helix-pa-strategy` | Define deterministic, causal, backtest-ready Price Action setups and detect lookahead or OHLC ambiguity |
| `helix-freqtrade` | Create strategies, backtest, hyperopt, deploy bots, switch strategy / pairs / live mode, query daemon PnL |

## Agent Routing

| User request | Use |
|---|---|
| "Check my OKX balance" / "current positions" / "order history" | `skills/helix-account` |
| "Buy BTC on OKX" / "close position" / "set stop loss" / "change leverage" | `skills/helix-trading` |
| "Define this PA setup" / "validate swing structure" / "check this breakout rule for lookahead" | `skills/helix-pa-strategy` |
| "Write a strategy" / "backtest" / "deploy dry-run" / "switch live" / "how much did it make" | `skills/helix-freqtrade` |

## Safety Rules

- Direct orders must go through `skills/helix-trading/scripts/exchange.mjs create_order`.
- Close positions with `close_position`, not a reverse order.
- `create_order`, `close_position`, and `set_stop` require preview first, then execution with `confirmed=true` only after explicit user confirmation.
- Explain risk and wait for confirmation before changing leverage, margin mode, or live trading mode.
- Use `ft-deploy.mjs deploy` for deployment, strategy changes, and dry-run / live changes. The exact current strategy code must have matching backtest evidence; edits require a new backtest.
- PA Strategy emits setup observations only. Keep orders, stops, targets, leverage, and sizing in the later implementation or execution layer.
- Never read or print `.env`, `.ft_api_pass`, API secrets, passphrases, private keys, or seed phrases.
- Never use mock or random data as real trading or backtest input.

## Freqtrade Alignment

Dashboard strategy, positions, and PnL should match the Freqtrade daemon. For PnL questions:

```bash
cd skills/helix-freqtrade
node scripts/ft.mjs profit
```

Report both:

- `profit_closed_coin`: closed cumulative PnL
- `profit_all_coin`: closed PnL plus current floating PnL

For local development, install the official Docker image in OKX futures dry-run mode. The REST API binds only to `127.0.0.1:8888`:

```bash
pnpm freqtrade:install
```

Runtime credentials are stored in `~/.helix/.env`, and persistent Freqtrade data is stored in `~/.freqtrade/user_data`. The installer is idempotent and preserves existing configuration and API credentials.

## Common Commands

```bash
# Account
cd skills/helix-account
node scripts/exchange.mjs balance '{"exchange":"okx"}'
node scripts/exchange.mjs positions '{"exchange":"okx","market_type":"swap"}'
node scripts/exchange.mjs closed_orders '{"exchange":"okx","symbol":"BTC/USDT","limit":20}'

# Trading
cd skills/helix-trading
node scripts/exchange.mjs create_order '{"exchange":"okx","symbol":"BTC/USDT:USDT","type":"market","side":"buy","amount":0.01,"market_type":"swap"}'
node scripts/exchange.mjs close_position '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap"}'
node scripts/exchange.mjs set_stop '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap","stop_loss":70000}'

# Freqtrade
cd skills/helix-freqtrade
node scripts/ft-deploy.mjs create_strategy '{"name":"RSIStrategy","timeframe":"15m","indicators":["rsi","macd"],"direction":"long"}'
node scripts/ft-deploy.mjs backtest '{"strategy":"RSIStrategy","timeframe":"15m","timerange":"20250101-20260301"}'
node scripts/ft-deploy.mjs deploy '{"strategy":"RSIStrategy","dry_run":true}'
node scripts/ft.mjs daemon_info
node scripts/ft.mjs profit
```

## Environment

Put exchange API keys in `~/.helix/.env` or the container web UI EnvSection.

Dashboard `dev` / `start` binds to `127.0.0.1` by default. When exposing it through a LAN or reverse proxy, set `HELIX_CONTROL_TOKEN` to a random value of at least 24 characters and explicitly bind Next.js to the external interface. Mutating APIs then require an unlocked dashboard control session; read-only market and status APIs remain available.

The local Freqtrade REST daemon listens on `http://127.0.0.1:8888` by default. Dashboard and skill clients use the same address.

```bash
OKX_API_KEY="xxx"
OKX_API_SECRET="xxx"
OKX_PASSWORD="xxx"

BINANCE_API_KEY="xxx"
BINANCE_API_SECRET="xxx"

BYBIT_API_KEY="xxx"
BYBIT_API_SECRET="xxx"

PROXY_URL="socks5://127.0.0.1:7890"

HELIX_CONTROL_TOKEN="generate-a-random-value-with-at-least-32-chars"

FREQTRADE_URL="http://127.0.0.1:8888"
```

## Structure

```text
helix/
├── app/
│   └── dashboard/
├── skills/
│   ├── helix-account/
│   ├── helix-trading/
│   ├── helix-pa-strategy/
│   └── helix-freqtrade/
├── AGENTS.md
├── CLAUDE.md
├── README.md
└── README-EN.md
```

## Verification

```bash
node --check skills/helix-account/scripts/exchange.mjs
node --check skills/helix-trading/scripts/exchange.mjs
node --check skills/helix-trading/scripts/verify-order-matrix.mjs
node --check skills/helix-freqtrade/scripts/ft.mjs
node --check skills/helix-freqtrade/scripts/ft-deploy.mjs
```
