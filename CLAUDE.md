# CLAUDE.md

Repository guidance for agents working on Helix.

## Project Overview

Helix is an AI trading terminal with:

- `dashboard`: frontend trading dashboard
- `skills/helix-account`: exchange account reads
- `skills/helix-trading`: CEX execution
- `skills/helix-freqtrade`: Freqtrade strategy, backtest, deploy, and daemon control

## Boundaries

Skill code is only responsible for:

- Exchange account state
- Order execution and position protection
- Freqtrade lifecycle and daemon state

Do not add speculative abstractions or broad rewrites. Keep changes targeted to the requested module.

Dashboard servers bind to loopback by default. Remote deployments must configure a `HELIX_CONTROL_TOKEN` of at least 24 characters and preserve the control-session guard on every mutating API route.

## Strategy Ownership

`HelixSignalStrategy` is a thin Freqtrade adapter. It may validate and map immutable Helix Signal Artifacts but must not reproduce Scalp Hunter V1 or Swing Hunter V1 semantics in Python.

New strategy manifests, semantic documentation, parameters, policies, tests, and proposals live only in the sibling `helix-strategies` repository. Helix owns deterministic Engine semantics, state machines, journal, replay, risk, execution, and read-only strategy-repository integration. Never deploy a `proposal` manifest to production.

## Freqtrade

In CoinClaw containers, Freqtrade is a supervisord-managed daemon on `127.0.0.1:8888`. Do not start another Freqtrade process.

For local development, Freqtrade runs from `docker/freqtrade/compose.yaml`, with persistent data in `~/.freqtrade/user_data`. Install or repair it with `pnpm freqtrade:install`; `ft-deploy.mjs` automatically uses Docker for backtests and daemon lifecycle when `HELIX_FREQTRADE_RUNTIME=docker` is set by the installer.

Use:

- `skills/helix-freqtrade/scripts/ft.mjs` for REST state and pair-list actions
- `skills/helix-freqtrade/scripts/ft-deploy.mjs` for strategy creation, backtesting, deployment, and daemon restart
- `skills/helix-freqtrade/scripts/ft-dev.mjs` for debug endpoints and analyzed candles

When users ask about PnL, call `ft.mjs profit` and report both `profit_closed_coin` and `profit_all_coin`.

Strategy deployment, strategy switching, and dry-run / live switching must use `ft-deploy.mjs deploy`. The exact current strategy code must have matching backtest evidence with at least one trade and positive total profit; editing the strategy invalidates older evidence.

## Trading

Use `skills/helix-trading/scripts/exchange.mjs`.

Rules:

- Preview first, execute only after explicit confirmation.
- Use `close_position` for closing.
- Verify after close / stop operations.
- Never print secrets.

## Verification

```bash
node --check skills/helix-account/scripts/exchange.mjs
node --check skills/helix-trading/scripts/exchange.mjs
node --check skills/helix-trading/scripts/verify-order-matrix.mjs
node --check skills/helix-freqtrade/scripts/ft.mjs
node --check skills/helix-freqtrade/scripts/ft-deploy.mjs
```
