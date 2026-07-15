---
name: helix-freqtrade
description: "Freqtrade automation for Helix. Use for strategy creation, backtesting, hyperopt, deployment, switching strategy / pairs / dry-run / live mode, and querying daemon status, balance, open positions, and PnL. Trigger words: strategy, create strategy, backtest, hyperopt, deploy, switch live, open positions, PnL, 写策略, 回测, 部署策略, 切策略, 切实盘, 盈亏, 当前持仓."
metadata: { "openclaw": { "primaryEnv": "OKX_API_KEY", "requires": { "bins": ["node"] } } }
---

# Helix Freqtrade

Freqtrade strategy generation, backtesting, deployment, and daemon control.

## Core Rules

- In CoinClaw containers, Freqtrade is already managed by supervisord on `127.0.0.1:8888`. Do not start another process.
- In local Docker mode, use `docker/freqtrade/compose.yaml` through `ft-deploy.mjs`; do not install or start a second host daemon.
- Use `ft.mjs` and `ft-deploy.mjs`; do not manually edit daemon state without reloading or restarting through scripts.
- `create_strategy` is only for independent indicator prototypes. New Scalp Hunter V1 and Swing Hunter V1 strategy changes belong only in the sibling `helix-strategies` repository. Their Engine decisions reach Freqtrade only through `HelixSignalStrategy` and a verified Signal Artifact.
- Deploy only through `ft-deploy.mjs deploy`. It requires backtest evidence for the exact current strategy code with at least one trade and positive total profit; editing the strategy invalidates older evidence.
- LIVE mode requires all of: current backtest evidence, `HELIX_LIVE_TRADING_ENABLED=true`, valid exchange credentials, `max_open_trades <= 2`, and a fresh Dashboard live authorization session. Never ask the user to paste the live token in chat.
- Do not use direct agent auto-entry. Strategy-driven entries must come from the Freqtrade daemon.
- Use `emergency_stop` for the safety path. It force-exits all open trades before stopping the daemon and does not require a live session.
- Answer PnL questions from `ft.mjs profit`, not from open trades alone.

## Strategy Ownership

- Treat `HelixSignalStrategy` as an execution adapter only. Never add indicators, detectors, state machines, or Scalp/Swing rules to it.
- Read Scalp Hunter V1 and Swing Hunter V1 semantics from the exact pinned `helix-strategies` commit; do not reproduce or override those semantics here.
- Evaluate closed candles only. Confirmed events become available at their confirmation bar; never backdate them or infer intrabar event order from OHLC.
- Every adapter edit invalidates prior backtest evidence. Helix deployment also requires matching artifact identity, positive non-empty backtest evidence, and a deployable lifecycle (`shadow+` for dry-run, `canary+` for live).
- Backtest a Signal Artifact only with its exact `helix.market-dataset/v1` file. The dataset hash, symbol, market window, provider, and base-timeframe OHLCV must match; never download or substitute exchange data for this path.

## Dashboard Alignment

| User asks | Command |
|---|---|
| Total PnL / today made how much | `node scripts/ft.mjs profit` |
| Open positions | `node scripts/ft.mjs trades_open` |
| Balance | `node scripts/ft.mjs balance` |
| Current strategy / mode | `node scripts/ft.mjs daemon_info` |
| Closed trades | `node scripts/ft.mjs trades_history` |

When reporting PnL, include:

- `profit_closed_coin`: closed cumulative PnL
- `profit_all_coin`: closed + floating PnL

## Quick Reference

```bash
node scripts/ft.mjs daemon_info
node scripts/ft.mjs profit
node scripts/ft.mjs trades_open
node scripts/ft.mjs balance
node scripts/ft.mjs locks
node scripts/ft.mjs set_pairs '{"pairs":["BTC/USDT:USDT","ETH/USDT:USDT"]}'

node scripts/ft-deploy.mjs strategy_list
node scripts/ft-deploy.mjs create_strategy '{"name":"RSIStrategy","timeframe":"15m","indicators":["rsi","macd"],"direction":"long"}'
node scripts/ft-deploy.mjs backtest '{"strategy":"RSIStrategy","timeframe":"15m","timerange":"20250101-20260301"}'
node scripts/ft-deploy.mjs hyperopt '{"strategy":"RSIStrategy","timeframe":"1h","epochs":100}'
node scripts/ft-deploy.mjs deploy '{"strategy":"RSIStrategy","dry_run":true}'
node scripts/ft-deploy.mjs backtest '{"signal_artifact":"/path/to/artifact.json","market_dataset":"/path/to/dataset.json"}'
node scripts/ft-deploy.mjs deploy '{"signal_artifact":"/path/to/artifact.json","dry_run":true}'
node scripts/ft-deploy.mjs logs '{"lines":100}'
```

## Strategy Generation

Use `create_strategy` for simple technical-indicator strategies.

Supported indicators:

`rsi`, `bb`, `bollinger`, `ema`, `sma`, `macd`, `stochastic`, `kdj`, `atr`, `adx`, `cci`, `williams_r`, `willr`, `vwap`, `ichimoku`, `volume_sma`, `volume`, `obv`.

Direction:

- `long`: long only
- `short`: short only
- `both`: long and short

For independent prototypes, write a Python strategy file directly into the daemon strategy directory, backtest that exact code, then deploy it. Do not use this path for Scalp Hunter or Swing Hunter:

```bash
node scripts/ft-deploy.mjs backtest '{"strategy":"MyStrategy","timeframe":"15m"}'
node scripts/ft-deploy.mjs deploy '{"strategy":"MyStrategy"}'
```

## Config Changes

| Operation | Command | Restart |
|---|---|---|
| Switch strategy | `ft-deploy.mjs deploy {"strategy":"X","dry_run":true}` | yes |
| Switch pairs | `ft.mjs set_pairs {"pairs":[...]}` | reload only |
| Switch live | Dashboard live authorization + live deploy only | yes |
| Return to dry-run | `ft-deploy.mjs deploy {"strategy":"X","dry_run":true}` | yes |
| Reload config | `ft.mjs reload` | no |

## Manual Force Actions

Do not use `force_enter` for unattended live execution. Use `emergency_stop` for urgent liquidation and use the Dashboard reconciliation action to compare LIVE bot state with exchange positions and active orders.

The Freqtrade daemon's own strategy-driven entries/exits do not require per-trade confirmation after the user has intentionally deployed the strategy and mode.

## Pitfalls

- Do not answer PnL from `/status` only.
- Do not start `freqtrade trade` manually.
- Do not use random or synthetic data as real backtest input.
- Do not pass `timerange` for Signal Artifact backtests; their immutable dataset defines the complete window.
- Do not print `.env` or `.ft_api_pass`.
