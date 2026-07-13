# Examples And Counterexamples

## Example: Close Above Latest Swing High

```yaml
version: helix-pa/v1
name: latest-swing-high-break
description: Emit a long-biased setup on a close-confirmed break of the latest confirmed swing high.

market:
  timeframe: 1h
  timezone: UTC
  tick_size: instrument

evaluation:
  on: bar_close
  tolerance_ticks: 1
  missing_bars: invalidate

definitions:
  pivots:
    type: swings
    left_bars: 2
    right_bars: 2
  resistance:
    type: level
    source:
      type: swing
      swings: pivots
      side: high
      select: latest_confirmed

events:
  resistance-break:
    type: break
    target: resistance
    direction: above
    confirm: close

setups:
  - id: breakout-long
    side: long
    when:
      event: resistance-break
    emit:
      type: setup
      label: breakout-long
      tags: [price-action, breakout]
```

## Example: Retest After Break

Add a dependent event and emit on the retest bar:

```yaml
events:
  resistance-break:
    type: break
    target: resistance
    direction: above
    confirm: close
  resistance-retest:
    type: retest
    after: resistance-break
    within_bars: 6

setups:
  - id: breakout-retest-long
    side: long
    when:
      event: resistance-retest
    emit:
      type: setup
      label: breakout-retest-long
      tags: [price-action, retest]
```

The break event snapshots the resistance price. A later swing cannot move the retest target.

## Example: Structure Filter

Add this definition:

```yaml
definitions:
  structure:
    type: structure
    swings: pivots
```

Then require the latest confirmed low to be higher than the preceding confirmed low:

```yaml
when:
  all:
    - event: resistance-break
    - structure:
        ref: structure
        swing: low
        relation: higher
```

The structure condition becomes available only when the latest swing low is confirmed.

## Golden Fixture: Confirmation And Break Timing

Use `tick_size: 0.1`, `tolerance_ticks: 1`, `left_bars: 2`, and `right_bars: 2`.

| Index | End time UTC | Open | High | Low | Close |
|---:|---|---:|---:|---:|---:|
| 0 | 2026-01-05T01:00:00Z | 96 | 100 | 95 | 98 |
| 1 | 2026-01-05T02:00:00Z | 98 | 103 | 97 | 101 |
| 2 | 2026-01-05T03:00:00Z | 101 | 110 | 100 | 106 |
| 3 | 2026-01-05T04:00:00Z | 106 | 108 | 102 | 104 |
| 4 | 2026-01-05T05:00:00Z | 104 | 107 | 101 | 103 |
| 5 | 2026-01-05T06:00:00Z | 103 | 109 | 102 | 108 |
| 6 | 2026-01-05T07:00:00Z | 108 | 112 | 107 | 111 |

Expected facts:

```yaml
- type: swing-high
  price: 110.0
  event_time: 2026-01-05T03:00:00Z
  known_at: 2026-01-05T05:00:00Z
- type: break
  event: resistance-break
  target_price: 110.0
  event_time: 2026-01-05T07:00:00Z
  known_at: 2026-01-05T07:00:00Z
- type: setup
  setup: breakout-long
  known_at: 2026-01-05T07:00:00Z
```

No setup may emit at index 2 or 4. Index 2 is only the swing's plotted bar; index 4 confirms it; index 6 closes beyond `110.0 + 0.1`.

## Counterexample: Wick Is Not A Close Break

Change only index 6 to:

```yaml
open: 108
high: 112
low: 107
close: 109.8
```

`confirm: close` must emit no break because `109.8` is not greater than `110.1`. A `confirm: wick` event would be a different rule.

## Counterexample: Unconfirmed Swing

At index 2, the candidate high at `110` has no right-side evidence. It must not become a level until index 4 closes. Using it at index 2 or 3 is lookahead.

## Counterexample: Same-Bar Break Then Retest

A bar with `high: 112`, `low: 109`, and `close: 111` can prove that both sides of `110` traded and that the close finished above. It cannot prove that price broke first and retested later. A retest candidate begins on the next bar.

## Counterexample: Undefined Qualitative Rule

This is invalid:

```yaml
events:
  strong-break:
    type: strong-break
    target: resistance
```

`strong-break` is not a primitive and `strong` has no measurable meaning. Keep `type: break`, then place any non-PA numeric filter in the later strategy layer.
