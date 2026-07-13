# Execution Semantics

## Input Contract

Evaluate a strictly increasing sequence of closed bars for exactly one symbol and timeframe. Each bar must satisfy:

```text
low <= min(open, close) <= max(open, close) <= high
volume >= 0
```

Reject duplicate or out-of-order timestamps. A gap invalidates every feature window that crosses it; do not synthesize or forward-fill bars.

## Evaluation Cycle

At each closed bar `t`, process in this order:

1. Validate and append `b[t]`.
2. Confirm any swing whose right-side window now ends.
3. Update structure and dynamic definitions from newly confirmed facts.
4. Evaluate primitive events for bar `t`.
5. Evaluate dependent retest events.
6. Evaluate setup condition trees and emit zero or more setup observations.

An event emitted in step 4 or 5 is visible to setups in step 6 on the same bar.

## Time Model

Every derived fact contains:

- `event_time`: the close time of the bar where the fact is plotted or occurred;
- `known_at`: the close time when all required evidence is available.

For ordinary break, rejection, sweep, retest, and setup events, `event_time = known_at`. For a swing at bar `i` with `right_bars = r`, `event_time = end_time(i)` and `known_at = end_time(i+r)`.

Never let a condition consume a fact before `known_at`. Never shift a setup back to an earlier `event_time` in a backtest.

## Tolerance

Resolve `tick_size` before evaluation and calculate:

```text
epsilon = tick_size * tolerance_ticks
```

Use the same epsilon for equality, structure relations, target crossing, and return-side tests. Do not mix decimal percentages or floating-point machine epsilon with tick tolerance.

## Dynamic Targets

A level sourced from `latest_confirmed` may change only when a new swing becomes known. When a break emits, snapshot the resolved target interval into that event. A dependent retest uses the snapshot, even if the dynamic level later changes.

For target interval `[lower, upper]`:

- upward events use boundary `p = upper`;
- downward events use boundary `p = lower`.

## Swing Confirmation

A swing is evaluated only when all left and right bars exist and are contiguous. Strict extrema remove tie ambiguity. The first eligible swing can emit after the full warmup window closes.

Structure compares a newly confirmed swing only with the previous confirmed swing of the same side. The relation becomes known on the new swing's `known_at` bar.

## Break

For `confirm: close`:

```text
above at t: C[t-1] <= p + epsilon and C[t] > p + epsilon
below at t: C[t-1] >= p - epsilon and C[t] < p - epsilon
```

For `confirm: wick`:

```text
above at t: H[t-1] <= p + epsilon and H[t] > p + epsilon
below at t: L[t-1] >= p - epsilon and L[t] < p - epsilon
```

This is transition-based, so remaining beyond the boundary on later bars does not repeatedly emit breaks.

## Rejection

A bar intersects `[lower - epsilon, upper + epsilon]` when:

```text
H[t] >= lower - epsilon and L[t] <= upper + epsilon
```

Then:

```text
side below: intersects and C[t] < lower - epsilon
side above: intersects and C[t] > upper + epsilon
```

Rejection does not imply that price crossed the far boundary.

## Sweep

```text
direction above: H[t] > upper + epsilon and C[t] <= upper + epsilon
direction below: L[t] < lower - epsilon and C[t] >= lower - epsilon
```

A sweep says only that the bar traded beyond and closed back. It does not establish whether the beyond-boundary trade happened before or after another same-bar condition.

## Retest

Each break opens one retest candidate beginning with the next bar. A newer break replaces any unconsumed candidate for the same retest event. For an upward break at boundary `p`, a bar retests when:

```text
L[t] <= p + epsilon and C[t] > p + epsilon
```

For a downward break:

```text
H[t] >= p - epsilon and C[t] < p - epsilon
```

The retest must occur from bar `break_index + 1` through `break_index + within_bars`, inclusive. Emit once on the earliest matching bar and then consume that candidate. Expired candidates emit nothing.

## Boolean Conditions

- `event` is true only on the bar where that event emits.
- `occurred.within_bars = N` searches indexes `[t-N+1, t]`.
- `structure` reads the latest relation known by bar `t`.
- Evaluate `all`, `any`, and `not` without side effects; result does not depend on child order.
- Emit each setup at most once per bar.

## OHLC Limitation

OHLC bars do not reveal the path between open and close. When one candle satisfies multiple price facts, report those facts independently. Do not assert their internal order or use a same-bar break followed by retest; retest begins on the next bar by definition.
