# Vocabulary

## Notation

For closed bar `b[t]`:

- `O[t]`, `H[t]`, `L[t]`, `C[t]`, `V[t]` are open, high, low, close, and volume.
- `tick_size` is positive instrument metadata.
- `epsilon = tick_size * tolerance_ticks`.
- Bar indexes increase with event time. All comparisons use only bars available at evaluation time.

## Bar Terms

### Bar

One closed OHLCV interval with a unique start time, end time, and timeframe.

### Body

The interval between `O[t]` and `C[t]`.

- `body_high = max(O[t], C[t])`
- `body_low = min(O[t], C[t])`
- `body_size = abs(C[t] - O[t])`

### Wick

- `upper_wick = H[t] - body_high`
- `lower_wick = body_low - L[t]`

### Bar range

`H[t] - L[t]`. A zero-range bar is valid, but ratios with bar range as denominator are undefined and must not be evaluated.

## Structural Terms

### Swing high

With `left_bars = l` and `right_bars = r`, bar `i` is a swing high when:

```text
H[i] > H[j] for every j in [i-l, i-1] and [i+1, i+r]
```

It has `event_time = end_time(i)` and `known_at = end_time(i+r)`.

### Swing low

Bar `i` is a swing low when:

```text
L[i] < L[j] for every j in [i-l, i-1] and [i+1, i+r]
```

It has the same confirmation delay as a swing high. Equal neighboring extremes do not form a swing in V1.

### Leg

The movement between two confirmed, opposite-side swings. A leg is descriptive output, not a separate V1 schema primitive.

### Structure relation

Compare the newest confirmed swing with the previous confirmed swing of the same side:

| Swing side | Relation | Rule |
|---|---|---|
| high | `higher` | new price `> old price + epsilon` |
| high | `lower` | new price `< old price - epsilon` |
| high | `equal` | neither higher nor lower |
| low | `higher` | new price `> old price + epsilon` |
| low | `lower` | new price `< old price - epsilon` |
| low | `equal` | neither higher nor lower |

Common display labels are HH, LH, EH, HL, LL, and EL. Executable documents use `side` plus `relation`, not the abbreviations.

### Range

A declared price interval with `lower <= upper`. V1 does not infer that the market is ranging; it only evaluates the supplied boundaries.

## Price References

### Level

A scalar price anchored to a fixed value or a confirmed swing. A dynamic swing level is resolved from confirmed data only.

### Zone

A closed interval `[lower, upper]`. Both boundaries must be explicit and `lower <= upper` after resolution.

### Target boundary

For an upward event, the relevant boundary is a target's upper edge. For a downward event, it is the lower edge. A level has the same lower and upper edge.

## Events

### Break

A transition from the original side of a target boundary to beyond it. Confirmation is explicitly either `close` or `wick`; `close` is the default and preferred mode.

### Retest

The first later bar, within a declared number of bars after a break, that touches the snapshotted broken boundary and closes on the breakout side.

### Rejection

A bar that intersects a level or zone and closes back on the declared approach side. Touching is enough; exceeding the far boundary is not required.

### Sweep

A bar that trades strictly beyond a target boundary by more than `epsilon` and closes back at or behind that boundary. OHLC cannot prove what happened inside the bar beyond these facts.

### Setup

A named observation emitted when its condition tree is true on a closed bar. `long`, `short`, and `neutral` describe bias only; they are not orders.
