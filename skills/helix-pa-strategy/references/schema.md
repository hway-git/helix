# Schema

## Canonical Form

V1 uses YAML as the canonical serialization of a small abstract syntax tree. JSON may be accepted only when it maps exactly to the same tree. Do not create a second, free-form surface syntax.

```yaml
version: helix-pa/v1
name: last-swing-high-break
description: Emit a long-biased setup when price closes above the latest confirmed swing high.

market:
  timeframe: 15m
  timezone: UTC
  tick_size: instrument

evaluation:
  on: bar_close
  tolerance_ticks: 1
  missing_bars: invalidate

definitions: {}
events: {}
setups: []
```

Unknown keys and unsupported enum values are validation errors.

## Root Fields

| Field | Required | Rule |
|---|---|---|
| `version` | yes | Must be `helix-pa/v1` |
| `name` | yes | Stable kebab-case identifier |
| `description` | no | Human-readable intent; never executable |
| `market` | yes | Single-timeframe input contract |
| `evaluation` | yes | Timing, tolerance, and missing-bar policy |
| `definitions` | yes | Named PA fact definitions; may be empty |
| `events` | yes | Named event definitions; may be empty |
| `setups` | yes | One or more emitted setup definitions |

Definition and event identifiers share one reference namespace and must not collide. Setup `id` values are unique within `setups`. Identifiers match `[a-z][a-z0-9-]*`; `emit.label` may intentionally equal its setup `id`.

## Market

```yaml
market:
  timeframe: 15m
  timezone: UTC
  tick_size: instrument
```

- `timeframe` is one positive exchange-style interval such as `1m`, `15m`, `1h`, or `1d`.
- `timezone` must be `UTC` in V1.
- `tick_size` is either `instrument` or a positive number. Use a number in fixtures. `instrument` requires the runtime to bind immutable provider metadata before evaluation.

## Evaluation

```yaml
evaluation:
  on: bar_close
  tolerance_ticks: 1
  missing_bars: invalidate
```

- `on` must be `bar_close`.
- `tolerance_ticks` is an integer `>= 0`.
- `missing_bars` must be `invalidate`; any feature window crossing a missing interval is unavailable until rebuilt from contiguous bars.

## Definitions

Each definition key is an identifier. References use that identifier as a scalar string.

### Swings

```yaml
definitions:
  pivots:
    type: swings
    left_bars: 2
    right_bars: 2
```

Both widths are integers `>= 1`. The definition emits confirmed swing facts using the strict rules in `vocabulary.md`.

### Structure

```yaml
definitions:
  structure:
    type: structure
    swings: pivots
```

`swings` must reference a `swings` definition. The result stores the latest same-side relation for confirmed highs and lows.

### Level

From a confirmed swing:

```yaml
definitions:
  resistance:
    type: level
    source:
      type: swing
      swings: pivots
      side: high
      select: latest_confirmed
```

From a fixed value, mainly for fixtures or externally supplied boundaries:

```yaml
definitions:
  reference-price:
    type: level
    source:
      type: fixed
      price: 110.0
```

`side` is `high` or `low`. `select` must be `latest_confirmed` in V1.

### Zone

```yaml
definitions:
  support-zone:
    type: zone
    lower: support-lower
    upper: support-upper
```

`lower` and `upper` reference level definitions. The resolved lower price must not exceed the upper price.

### Range

```yaml
definitions:
  balance-range:
    type: range
    lower: support
    upper: resistance
```

A range has the same interval shape as a zone. The distinct type preserves the author's intent; V1 does not infer a range automatically.

## Events

Event targets reference a `level`, `zone`, or `range` definition.

### Break

```yaml
events:
  resistance-break:
    type: break
    target: resistance
    direction: above
    confirm: close
```

- `direction`: `above` or `below`
- `confirm`: `close` or `wick`

### Retest

```yaml
events:
  resistance-retest:
    type: retest
    after: resistance-break
    within_bars: 6
```

`after` must reference a `break` event. The retest inherits the break direction and its snapshotted target boundary. `within_bars` is an integer `>= 1`.

### Rejection

```yaml
events:
  resistance-rejection:
    type: rejection
    target: resistance
    side: below
```

`side` is `below` when price approaches resistance from below and `above` when it approaches support from above.

### Sweep

```yaml
events:
  high-sweep:
    type: sweep
    target: resistance
    direction: above
```

`direction` is `above` or `below`.

Event dependencies must form an acyclic graph.

## Setup Conditions

Each setup contains `id`, `side`, `when`, and `emit`.

```yaml
setups:
  - id: breakout-long
    side: long
    when:
      all:
        - event: resistance-break
        - structure:
            ref: structure
            swing: low
            relation: higher
    emit:
      type: setup
      label: breakout-long
      tags: [price-action, breakout]
```

`side` is `long`, `short`, or `neutral`. `emit.type` must be `setup`. `label` is a stable identifier and `tags` is an optional list of stable identifiers.

Condition nodes are recursive and use exactly one operator:

```yaml
# Event emitted on the current bar
event: event-id

# Every child must be true
all: [condition, condition]

# At least one child must be true
any: [condition, condition]

# Negation
not: { event: event-id }

# Event occurred in the current or preceding N-1 bars
occurred:
  event: event-id
  within_bars: 4

# Latest confirmed structure relation
structure:
  ref: structure-id
  swing: high
  relation: lower
```

Empty `all` and `any` lists are invalid. `within_bars` is an integer `>= 1`.

## Prohibited Fields

Reject execution concerns such as `entry`, `order_type`, `stop_loss`, `take_profit`, `leverage`, `stake`, `position_size`, and exchange credentials. A PA setup can be translated into those decisions only in a separate strategy specification.
