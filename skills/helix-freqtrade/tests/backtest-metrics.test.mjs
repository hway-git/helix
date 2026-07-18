import assert from 'node:assert/strict';
import test from 'node:test';
import { backtestFeeObservations, backtestMetrics } from '../lib/backtest-metrics.mjs';
import { historicalRiskTraceHash } from '../lib/historical-risk.mjs';
import { marketDatasetHash } from '../lib/market-dataset.mjs';
import { signalArtifactHash } from '../lib/signal-artifact.mjs';

test('parses Freqtrade ratios, absolute metrics, counts, and duration without changing units', () => {
  assert.deepEqual(backtestMetrics({
    total_trades: 8,
    wins: 5,
    draws: 1,
    losses: 2,
    profit_total: 0.0123,
    profit_total_pct: 1.23,
    profit_total_abs: 12.3,
    winrate: 0.625,
    max_drawdown_account: 0.021,
    max_drawdown_abs: 21,
    expectancy: 1.5375,
    expectancy_ratio: 0.19,
    profit_factor: 1.8,
    holding_avg_s: 930,
  }), {
    trades: 8,
    wins: 5,
    draws: 1,
    losses: 2,
    profitRatio: 0.0123,
    profitAbs: 12.3,
    winRate: 0.625,
    maxDrawdownRatio: 0.021,
    maxDrawdownAbs: 21,
    expectancyAbs: 1.5375,
    expectancyRatio: 0.19,
    profitFactor: 1.8,
    profitFactorStatus: 'AVAILABLE',
    holdingSeconds: 930,
    riskNormalized: {
      available: false,
      reason: 'INITIAL_RISK_TRACE_UNAVAILABLE',
      expectancyR: null,
      maxDrawdownR: null,
      mfeR: null,
      maeR: null,
    },
  });
});

test('normalizes percent-point fallbacks to ratios', () => {
  const metrics = backtestMetrics({
    total_trades: 2,
    wins: 1,
    draws: 0,
    losses: 1,
    profit_total_pct: 1.23,
    max_drawdown_pct: 4.5,
  });
  assert.equal(metrics.profitRatio, 0.0123);
  assert.equal(metrics.maxDrawdownRatio, 0.045);
});

test('does not treat Freqtrade zero profit factor as real when there are no losses', () => {
  const metrics = backtestMetrics({
    total_trades: 3,
    wins: 3,
    draws: 0,
    losses: 0,
    profit_factor: 0,
    expectancy_ratio: 100,
  });
  assert.equal(metrics.profitFactor, null);
  assert.equal(metrics.profitFactorStatus, 'NO_LOSSES');
  assert.equal(metrics.expectancyRatio, null);
});

test('derives counts conservatively and keeps unavailable risk metrics explicit', () => {
  const metrics = backtestMetrics({ wins: 2, draws: 1, losses: 1 });
  assert.equal(metrics.trades, 4);
  assert.equal(metrics.winRate, 0.5);
  assert.equal(metrics.profitFactorStatus, 'UNAVAILABLE');
  assert.equal(metrics.riskNormalized.available, false);
});

test('sets advanced metrics to null when there are no trades', () => {
  const metrics = backtestMetrics({
    total_trades: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    profit_total: 0,
    profit_factor: 0,
  });
  assert.equal(metrics.profitRatio, null);
  assert.equal(metrics.expectancyAbs, null);
  assert.equal(metrics.holdingSeconds, null);
});

test('does not label an all-draw segment as a no-loss profit factor', () => {
  const metrics = backtestMetrics({
    total_trades: 2,
    wins: 0,
    draws: 2,
    losses: 0,
    profit_factor: 0,
  });
  assert.equal(metrics.profitFactor, null);
  assert.equal(metrics.profitFactorStatus, 'UNAVAILABLE');
});

test('rejects malformed or internally inconsistent metrics', () => {
  for (const summary of [
    { total_trades: '2' },
    { total_trades: 1.5 },
    { total_trades: 2, wins: 2, draws: 0, losses: 1 },
    { total_trades: 2, wins: 1, draws: 0, losses: 1, winrate: 0.75 },
    { total_trades: 1, holding_avg_s: -1 },
    { total_trades: 1, max_drawdown_account: -0.1 },
  ]) {
    assert.throws(() => backtestMetrics(summary));
  }
});

test('observes the fee actually recorded on every Freqtrade trade', () => {
  assert.deepEqual(backtestFeeObservations({
    trades: [
      { fee_open: 0.001, fee_close: 0.001 },
      { fee_open: 0.001, fee_close: 0.001 },
    ],
  }, 0.001), {
    status: 'OBSERVED',
    trades: 2,
    requestedFee: 0.001,
    openRates: [0.001],
    closeRates: [0.001],
    matchesRequested: true,
  });
  assert.equal(backtestFeeObservations({
    trades: [{ fee_open: 0.001, fee_close: 0.001 }],
  }, 0.002).matchesRequested, false);
  assert.deepEqual(backtestFeeObservations({ trades: [] }, 0.001), {
    status: 'NO_TRADES',
    trades: 0,
    requestedFee: 0.001,
    openRates: [],
    closeRates: [],
    matchesRequested: false,
  });
});

test('matches the Core canonical historical risk trace hash', () => {
  assert.equal(historicalRiskTraceHash({
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: `sha256:${'1'.repeat(64)}`,
    entries: [{
      entrySignalId: 'entry-1', family: 'scalp',
      object: { model: 'PRICE_EVENT', id: 'event-1' }, side: 'LONG',
      entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: 100 },
      initialStop: 95, initialTarget: 110, riskDistance: 5, riskR: 0.35,
      scalp: {
        eventType: 'LIQUIDITY_SWEEP', grade: 'A',
        regime: { id: 'regime-1', type: 'RANGING' },
      },
    }],
  }), 'sha256:c54c881fafae8685cba56cda92ce3b0d4b39f792fa6c8fdc4feb205a792737ee');
});

function riskMetricFixture() {
  const minute = 60_000;
  const candles = [
    [99, 101, 98, 100],
    [102, 106, 98, 105],
    [105, 105, 94, 95],
    [109, 111, 108, 110],
    [108, 112, 105, 106],
    [106, 116, 102, 114],
    [114, 115, 108, 109],
    [109, 110, 107, 108],
  ].map(([open, high, low, close], index) => ({
    time: index * minute, open, high, low, close, volume: 10 + index,
  }));
  const datasetPayload = {
    schemaVersion: 'helix.market-dataset/v1',
    source: {
      provider: 'binance', market: 'futures', instrumentId: 'BTCUSDT', symbol: 'BTC/USDT:USDT',
    },
    capturedThrough: candles.length * minute,
    timeframes: { '1m': candles },
  };
  const marketDataset = { ...datasetPayload, datasetHash: marketDatasetHash(datasetPayload) };
  const signals = [
    {
      sequence: 0, signalId: 'entry-long', decisionId: 'decision-entry-long',
      object: { model: 'PRICE_EVENT', id: 'event-long' }, action: 'ENTER', side: 'LONG',
      sourceCandleOpenTime: 0, decisionTime: minute, reasonCodes: ['EXECUTION_TRIGGERED'],
    },
    {
      sequence: 1, signalId: 'exit-long', decisionId: 'decision-exit-long',
      object: { model: 'PRICE_EVENT', id: 'event-long' }, action: 'EXIT', side: 'LONG',
      sourceCandleOpenTime: 2 * minute, decisionTime: 3 * minute, reasonCodes: ['TIME_STOP'],
    },
    {
      sequence: 2, signalId: 'entry-short', decisionId: 'decision-entry-short',
      object: { model: 'PRICE_EVENT', id: 'event-short' }, action: 'ENTER', side: 'SHORT',
      sourceCandleOpenTime: 3 * minute, decisionTime: 4 * minute, reasonCodes: ['EXECUTION_TRIGGERED'],
    },
    {
      sequence: 3, signalId: 'exit-short', decisionId: 'decision-exit-short',
      object: { model: 'PRICE_EVENT', id: 'event-short' }, action: 'EXIT', side: 'SHORT',
      sourceCandleOpenTime: 6 * minute, decisionTime: 7 * minute, reasonCodes: ['TIME_STOP'],
    },
  ];
  const artifactPayload = {
    schemaVersion: 'helix.signal-artifact/v1',
    identity: {
      strategyId: 'helix_scalp_hunter', strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40), strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40), marketDataSnapshotId: marketDataset.datasetHash,
    },
    strategyLifecycle: 'proposal', objectModel: 'PRICE_EVENT', symbol: marketDataset.source.symbol,
    baseTimeframe: '1m', marketData: { firstCandleOpenTime: 0, lastCandleCloseTime: 8 * minute },
    signals,
  };
  const signalArtifact = { ...artifactPayload, artifactHash: signalArtifactHash(artifactPayload) };
  const riskPayload = {
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: signalArtifact.artifactHash,
    entries: [
      {
        entrySignalId: 'entry-long', family: 'scalp',
        object: { model: 'PRICE_EVENT', id: 'event-long' }, side: 'LONG',
        entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: 100 },
        initialStop: 95, initialTarget: 110, riskDistance: 5, riskR: 0.35,
        scalp: { eventType: 'LIQUIDITY_SWEEP', grade: 'A', regime: { id: 'regime-1', type: 'RANGING' } },
      },
      {
        entrySignalId: 'entry-short', family: 'scalp',
        object: { model: 'PRICE_EVENT', id: 'event-short' }, side: 'SHORT',
        entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: 110 },
        initialStop: 115, initialTarget: 100, riskDistance: 5, riskR: 0.25,
        scalp: { eventType: 'MOMENTUM_BURST', grade: 'B', regime: { id: 'regime-2', type: 'TRENDING' } },
      },
    ],
  };
  const riskTrace = { ...riskPayload, traceHash: historicalRiskTraceHash(riskPayload) };
  const accountEquity = 1000;
  const riskUnitRatio = 0.01;
  const longProfitRatio = 0.8 * (7 / 102);
  const longStake = (accountEquity * riskUnitRatio * 0.35) / (7 / 102);
  const longProfitAbs = longStake * longProfitRatio;
  const shortAccountEquity = accountEquity + longProfitAbs;
  const shortProfitRatio = -0.6 * (7 / 108);
  const shortStake = (shortAccountEquity * riskUnitRatio * 0.25) / (7 / 108);
  const summary = {
    total_trades: 2, wins: 1, draws: 0, losses: 1,
    trades: [
      {
        pair: marketDataset.source.symbol, is_open: false, is_short: false,
        open_timestamp: minute, close_timestamp: 3 * minute,
        enter_tag: 'entry-long', exit_reason: 'exit-long',
        open_rate: 102, close_rate: 109,
        // Freqtrade's net return is 0.8 times the actual fill-to-stop risk return.
        profit_ratio: longProfitRatio, profit_abs: longProfitAbs, stake_amount: longStake, leverage: 1,
      },
      {
        pair: marketDataset.source.symbol, is_open: false, is_short: true,
        open_timestamp: 4 * minute, close_timestamp: 7 * minute,
        enter_tag: 'entry-short', exit_reason: 'exit-short',
        open_rate: 108, close_rate: 109,
        profit_ratio: shortProfitRatio, profit_abs: shortStake * shortProfitRatio,
        stake_amount: shortStake, leverage: 1,
      },
    ],
  };
  return { summary, signalArtifact, riskTrace, marketDataset, accountEquity, riskUnitRatio };
}

test('computes net realized R and exact-dataset MFE/MAE in account-equity risk units', () => {
  const fixture = riskMetricFixture();
  const metrics = backtestMetrics(fixture.summary, fixture);
  assert.equal(metrics.riskNormalized.available, true);
  assert.equal(metrics.riskNormalized.reason, 'NET_ACCOUNT_R_EXECUTION');
  assert.ok(Math.abs(metrics.riskNormalized.expectancyR - 0.065) < 1e-12);
  assert.ok(Math.abs(metrics.riskNormalized.maxDrawdownR - 0.15) < 1e-12);
  assert.ok(Math.abs(metrics.riskNormalized.mfeR - (29 / 140)) < 1e-12);
  assert.ok(Math.abs(metrics.riskNormalized.maeR - (12 / 35)) < 1e-12);
  assert.ok(Math.abs(metrics.riskNormalized.observations[0].realizedR - 0.28) < 1e-12);
  assert.ok(Math.abs(metrics.riskNormalized.observations[1].realizedR + 0.15) < 1e-12);
  assert.ok(Math.abs(metrics.riskNormalized.observations[0].expectedRiskBudget - 3.5) < 1e-12);
  assert.ok(Math.abs(metrics.riskNormalized.observations[0].stakeAmount - 51) < 1e-12);
});

test('requires bounded leverage and exact trace/dataset linkage for risk-normalized metrics', () => {
  const leveraged = riskMetricFixture();
  leveraged.summary.trades[0].leverage = 0.5;
  assert.throws(() => backtestMetrics(leveraged.summary, leveraged), /leverage must be at least 1/);

  const invalidFill = riskMetricFixture();
  invalidFill.summary.trades[0].open_rate = 95;
  assert.throws(() => backtestMetrics(invalidFill.summary, invalidFill), /exact entry candle open/);

  const wrongExitFill = riskMetricFixture();
  wrongExitFill.summary.trades[0].close_rate = 108;
  assert.throws(() => backtestMetrics(wrongExitFill.summary, wrongExitFill), /exact exit candle open/);

  const invalidGeometry = riskMetricFixture();
  invalidGeometry.riskTrace.entries[0].initialTarget = 101;
  invalidGeometry.riskTrace.traceHash = historicalRiskTraceHash({
    schemaVersion: invalidGeometry.riskTrace.schemaVersion,
    signalArtifactHash: invalidGeometry.riskTrace.signalArtifactHash,
    entries: invalidGeometry.riskTrace.entries,
  });
  assert.throws(() => backtestMetrics(invalidGeometry.summary, invalidGeometry), /fill must remain between/);

  const wrongEntry = riskMetricFixture();
  wrongEntry.riskTrace.entries[0].entryPrice.price = 101;
  wrongEntry.riskTrace.entries[0].riskDistance = 6;
  wrongEntry.riskTrace.traceHash = historicalRiskTraceHash({
    schemaVersion: wrongEntry.riskTrace.schemaVersion,
    signalArtifactHash: wrongEntry.riskTrace.signalArtifactHash,
    entries: wrongEntry.riskTrace.entries,
  });
  assert.throws(() => backtestMetrics(wrongEntry.summary, wrongEntry), /exact decision candle close/);

  const wrongStake = riskMetricFixture();
  wrongStake.summary.trades[0].stake_amount *= 2;
  assert.throws(() => backtestMetrics(wrongStake.summary, wrongStake), /account-equity risk budget/);
});
