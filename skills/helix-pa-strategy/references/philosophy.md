# Philosophy

## Purpose

Helix PA Strategy turns visual Price Action ideas into deterministic, causal setup detection over closed OHLCV bars. A valid specification must produce the same events for the same ordered bars in live evaluation and backtesting.

## Three Layers

Keep these layers independent:

1. **Market facts** are provider-supplied bars and instrument metadata.
2. **PA facts** are derived observations such as confirmed swings, structure relations, levels, breaks, and retests.
3. **Setup decisions** combine PA facts and emit a named observation with a directional bias.

An execution engine may consume a setup later, but execution is not part of the PA language.

## Principles

### Price before narrative

Define every concept from bar fields, timestamps, tick size, and explicit parameters. A familiar label is not a definition.

### Causality before visual neatness

A swing may be plotted on an earlier candle, but it is not known until its right-side confirmation bars close. Decisions use the confirmation time, never the plotted time.

### Closed bars by default

Evaluate only after the requested timeframe closes. Open-candle observations are provisional and outside V1.

### Determinism over discretion

Replace words such as `near`, `strong`, `obvious`, and `clean` with measurable thresholds. If the user cannot specify one, preserve the ambiguity as an unresolved requirement.

### Minimal, school-neutral vocabulary

Use common chart facts: bars, swings, structure, levels, zones, breaks, retests, rejections, and sweeps. Do not encode a trading school, guru vocabulary, or narrative interpretation into core primitives.

### Evidence before implementation

Define positive examples and near-miss counterexamples before translating a setup into strategy code. Those examples become golden vectors for the eventual evaluator and backtest implementation.

## Non-Goals for V1

V1 does not define:

- order entry or exit;
- stop loss, take profit, leverage, or position sizing;
- portfolio or risk management;
- exchange-specific behavior;
- multi-timeframe joins;
- tick-level or intrabar sequencing;
- predictive confidence or discretionary chart scoring;
- automatic discovery of levels or zones beyond declared primitives.

## Definition of Done

A PA setup is specified when:

- every term maps to a vocabulary definition;
- every parameter has a value and unit;
- every event has an unambiguous `known_at` bar;
- no condition reads future or open bars;
- identical inputs yield identical outputs;
- at least one positive and one negative fixture distinguish the intended rule.
