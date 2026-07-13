# Constraints

## Required Invariants

A valid V1 document must:

- use `version: helix-pa/v1`;
- consume one symbol and one timeframe at a time;
- evaluate closed bars only;
- declare tick-based tolerance;
- use confirmed swings only;
- preserve `event_time` and `known_at`;
- reference only previously defined identifiers of compatible types;
- keep event dependencies acyclic;
- produce setup observations without execution fields;
- include deterministic positive and negative fixtures before strategy implementation.

## Causality Rules

- Do not read `b[t+1]` or any later bar while evaluating bar `t`.
- Do not expose a swing before its right-side bars close.
- Do not recompute old setup output after newer bars arrive.
- Do not use centered rolling calculations unless their confirmation delay is represented exactly like a swing.
- Do not use the current open candle in live evaluation.

## Ambiguity Rules

Reject or quantify:

- `near a level`;
- `strong candle`;
- `clean break`;
- `significant swing`;
- `obvious support`;
- `fast retest`;
- `large wick`.

For example, replace `fast retest` with `within_bars: 3`. Do not choose a threshold on the user's behalf when it materially changes the setup.

## OHLC Rules

- Do not infer whether high or low occurred first.
- Do not model a break and later retest inside the same bar.
- Do not claim a stop or target would have executed first from a bar that touched both.
- Do not treat a wick through a level as a close-confirmed break.
- Do not silently replace missing bars or provider gaps.

## Scope Rules

The following are outside V1 and must not be smuggled into custom fields:

- ICT or SMC concepts and aliases;
- indicator conditions such as EMA, RSI, or MACD;
- multiple timeframes or cross-symbol conditions;
- sessions and calendar-derived levels;
- order entry, exit, stops, targets, leverage, or sizing;
- portfolio state, balances, positions, or exchange API behavior;
- probabilistic or LLM-scored chart interpretation.

When a requested setup needs one of these, separate it into another strategy-layer rule or report that the PA V1 document cannot express it.

## Review Checklist

Before accepting a document, verify:

1. Can every executable word be mapped to a schema field?
2. Are all units bars, prices, ticks, or fixed enum values?
3. Is every dynamic level based on a confirmed fact?
4. Is every event's first possible `known_at` unambiguous?
5. Would live and backtest evaluation see the same data on that bar?
6. Does a wick-only near miss stay false for a close-confirmed break?
7. Does a candidate swing stay unavailable until right-side confirmation?
8. Can any single OHLC bar force an assumed intrabar order?
9. Are setup outputs free of execution and risk fields?
10. Do the positive and counterexample fixtures differ only in the intended boundary condition?
