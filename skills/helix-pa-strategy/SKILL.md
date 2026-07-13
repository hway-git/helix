---
name: helix-pa-strategy
description: "Define, review, and translate deterministic, school-neutral Price Action (PA) setups with the Helix PA Strategy Spec. Use when formalizing candle or market-structure logic; describing swings, HH/HL/LH/LL, ranges, levels, zones, breaks, retests, rejections, or sweeps; checking PA rules for lookahead, repainting, or OHLC ambiguity; or turning a PA idea into a backtest-ready declarative specification. This skill describes setup detection only; use helix-freqtrade for implementation, backtesting, and deployment, and helix-trading for direct order execution."
---

# Helix PA Strategy

Describe Price Action as deterministic facts over closed OHLCV bars. Produce a specification that another agent or engine can evaluate without discretionary interpretation.

## Workflow

1. Read [philosophy.md](references/philosophy.md) before defining or changing the language boundary.
2. Read [vocabulary.md](references/vocabulary.md) before translating trading language into PA terms.
3. Read [schema.md](references/schema.md) before writing or reviewing a PA strategy specification.
4. Read [execution-semantics.md](references/execution-semantics.md) whenever timing, confirmation, equality, tolerance, or event ordering matters.
5. Read [constraints.md](references/constraints.md) and reject any rule that needs future bars, an open candle, inferred intrabar order, or undefined qualitative language.
6. Read [examples.md](references/examples.md) when creating fixtures, counterexamples, or a new setup pattern.

## Output Contract

For a new PA idea:

1. State only assumptions that materially affect evaluation.
2. Translate the idea into one canonical `helix-pa/v1` YAML document.
3. Identify the exact bar on which each fact becomes knowable.
4. Include at least one positive example and one near-miss counterexample.
5. Report unsupported or ambiguous requirements instead of silently inventing semantics.

Keep these layers separate:

- **Market facts:** closed bars supplied by the data provider.
- **PA facts:** confirmed swings, structure relations, levels, zones, and events derived from those bars.
- **Setup decisions:** declarative conditions that emit a setup observation.

Do not add entry prices, order types, stops, targets, leverage, stake sizing, or exchange actions to this specification.

## Non-Negotiable Rules

- Evaluate on closed bars only.
- Preserve both `event_time` and `known_at` for delayed facts such as swings.
- Use only data available at `known_at`; never backdate a setup to `event_time`.
- Treat OHLC bars as unordered summaries. Never infer whether the high or low occurred first.
- Resolve comparisons with the declared instrument tick size and tolerance.
- Reject vague terms such as `near`, `strong`, or `clean` unless converted to numeric rules.
- Keep the core vocabulary school-neutral. Do not introduce ICT or SMC concepts or aliases.
- Emit observations, not trade instructions.

## Handoff

After the PA document and fixtures are accepted, use `helix-freqtrade` to implement the same semantics in a strategy and backtest the exact code. Use `helix-trading` only for explicitly requested direct execution under its confirmation rules.
