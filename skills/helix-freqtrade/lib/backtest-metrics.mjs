import { reconcileSignalBacktest } from './backtest-reconciliation.mjs';
import { verifyHistoricalRiskTrace } from './historical-risk.mjs';
import { marketTimeframeMilliseconds, verifyMarketDataset } from './market-dataset.mjs';
import { verifySignalArtifact } from './signal-artifact.mjs';

export const RISK_BUDGET_TOLERANCE_RATIO = 0.025;

function firstField(summary, fields, name) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(summary, field)) continue;
    const value = summary[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite JSON number`);
    }
    return value;
  }
  return null;
}

function count(summary, fields, name) {
  const value = firstField(summary, fields, name);
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegative(value, name) {
  if (value !== null && value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function ratioFromPercent(summary, fields, name) {
  const percent = firstField(summary, fields, name);
  return percent === null ? null : percent / 100;
}

function unavailableRisk(reason = 'INITIAL_RISK_TRACE_UNAVAILABLE') {
  return {
    available: false,
    reason,
    expectancyR: null,
    maxDrawdownR: null,
    mfeR: null,
    maeR: null,
  };
}

function requiredFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function riskSegments(risk) {
  if (risk.family === 'scalp') {
    return {
      'scalp.event_type': risk.scalp.eventType,
      'scalp.grade': risk.scalp.grade,
      'scalp.regime.type': risk.scalp.regime.type,
    };
  }
  if (risk.family === 'swing') {
    return {
      'swing.stage': risk.swing.stage,
      'swing.context.state': risk.swing.context.state,
      'swing.context.bias': risk.swing.context.bias,
    };
  }
  throw new Error(`historical risk entry ${risk.entrySignalId} has unsupported family`);
}

function riskNormalizedMetrics(summary, context) {
  if (context == null) return unavailableRisk();
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('risk metric context must be an object');
  }
  const artifact = verifySignalArtifact(context.signalArtifact);
  const riskTrace = verifyHistoricalRiskTrace(context.riskTrace, artifact);
  const dataset = verifyMarketDataset(context.marketDataset);
  if (dataset.datasetHash !== artifact.identity.marketDataSnapshotId) {
    throw new Error('risk metric dataset does not match the signal artifact marketDataSnapshotId');
  }
  if (dataset.source.symbol !== artifact.symbol) {
    throw new Error('risk metric dataset symbol does not match the signal artifact');
  }
  const candles = dataset.timeframes[artifact.baseTimeframe];
  if (!candles) throw new Error(`risk metric dataset is missing base timeframe ${artifact.baseTimeframe}`);
  const duration = marketTimeframeMilliseconds(artifact.baseTimeframe);
  reconcileSignalBacktest(summary, artifact);
  if (summary.trades.length === 0) return unavailableRisk('NO_COMPLETED_TRADES');
  const riskUnitRatio = requiredFinite(context.riskUnitRatio, 'risk metric riskUnitRatio');
  if (riskUnitRatio <= 0 || riskUnitRatio > 1) throw new Error('risk metric riskUnitRatio must be in (0, 1]');
  let accountEquity = requiredFinite(context.accountEquity, 'risk metric accountEquity');
  if (accountEquity <= 0) throw new Error('risk metric accountEquity must be positive');

  const signalsById = new Map(artifact.signals.map((signal) => [signal.signalId, signal]));
  const candlesByTime = new Map(candles.map((candle) => [candle.time, candle]));
  const risksByEntryId = new Map(riskTrace.entries.map((entry) => [entry.entrySignalId, entry]));
  const orderedTrades = [...summary.trades].sort((left, right) => (
    left.open_timestamp - right.open_timestamp || String(left.enter_tag).localeCompare(String(right.enter_tag))
  ));
  const observations = orderedTrades.map((trade, index) => {
    const name = `Freqtrade trades[${index}]`;
    const risk = risksByEntryId.get(trade.enter_tag);
    if (!risk) throw new Error(`${name}.enter_tag has no historical risk entry`);
    const signal = signalsById.get(risk.entrySignalId);
    const sourceCandle = candlesByTime.get(signal.sourceCandleOpenTime);
    if (!sourceCandle || sourceCandle.close !== risk.entryPrice.price) {
      throw new Error(`${name} historical entry price does not match the exact decision candle close`);
    }
    const profitRatio = requiredFinite(trade.profit_ratio, `${name}.profit_ratio`);
    const openRate = requiredFinite(trade.open_rate, `${name}.open_rate`);
    if (openRate <= 0) throw new Error(`${name}.open_rate must be positive`);
    const closeRate = requiredFinite(trade.close_rate, `${name}.close_rate`);
    if (closeRate <= 0) throw new Error(`${name}.close_rate must be positive`);
    const leverage = requiredFinite(trade.leverage, `${name}.leverage`);
    if (leverage < 1) {
      throw new Error(`${name}.leverage must be at least 1 for Helix risk-normalized metrics`);
    }
    const { open_timestamp: openTime, close_timestamp: closeTime } = trade;
    if (openTime % duration || closeTime % duration || closeTime <= openTime) {
      throw new Error(`${name} exposure window must be a non-empty aligned base-timeframe interval`);
    }
    if (candlesByTime.get(openTime)?.open !== openRate) {
      throw new Error(`${name}.open_rate does not match the exact entry candle open`);
    }
    if (candlesByTime.get(closeTime)?.open !== closeRate) {
      throw new Error(`${name}.close_rate does not match the exact exit candle open`);
    }
    const exposure = candles.filter(({ time }) => time >= openTime && time < closeTime);
    const expectedCandles = (closeTime - openTime) / duration;
    if (exposure.length !== expectedCandles
      || exposure[0]?.time !== openTime
      || exposure.at(-1)?.time !== closeTime - duration) {
      throw new Error(`${name} exposure window is not fully covered by the exact market dataset`);
    }
    if (risk.side === 'LONG' && !(risk.initialStop < openRate && openRate < risk.initialTarget)) {
      throw new Error(`${name} LONG fill must remain between its initial stop and target`);
    }
    if (risk.side === 'SHORT' && !(risk.initialTarget < openRate && openRate < risk.initialStop)) {
      throw new Error(`${name} SHORT fill must remain between its initial target and stop`);
    }
    const executionRiskDistance = Math.abs(openRate - risk.initialStop);
    const stakeAmount = requiredFinite(trade.stake_amount, `${name}.stake_amount`);
    if (stakeAmount <= 0) throw new Error(`${name}.stake_amount must be positive`);
    const expectedRiskBudget = accountEquity * riskUnitRatio * risk.riskR;
    const expectedStakeAmount = expectedRiskBudget / ((executionRiskDistance / openRate) * leverage);
    const actualRiskBudget = stakeAmount * leverage * (executionRiskDistance / openRate);
    const tolerance = Math.max(1e-8, expectedRiskBudget * RISK_BUDGET_TOLERANCE_RATIO);
    if (actualRiskBudget > expectedRiskBudget + 1e-8
      || actualRiskBudget < expectedRiskBudget - tolerance) {
      throw new Error(`${name}.stake_amount does not match its account-equity risk budget within execution precision`);
    }
    const profitAbs = requiredFinite(trade.profit_abs, `${name}.profit_abs`);
    const accountRiskUnit = accountEquity * riskUnitRatio;
    const high = Math.max(...exposure.map((candle) => candle.high));
    const low = Math.min(...exposure.map((candle) => candle.low));
    const favorableDistance = risk.side === 'LONG' ? high - openRate : openRate - low;
    const adverseDistance = risk.side === 'LONG' ? openRate - low : high - openRate;
    const observation = {
      entrySignalId: risk.entrySignalId,
      openTime,
      closeTime,
      // One R is the policy-defined fraction of account equity. riskR only
      // scales this trade's budget inside that account-level unit.
      realizedR: profitAbs / accountRiskUnit,
      mfeR: Math.max(0, (stakeAmount * leverage * favorableDistance / openRate) / accountRiskUnit),
      maeR: Math.max(0, (stakeAmount * leverage * adverseDistance / openRate) / accountRiskUnit),
      riskUnitRatio,
      riskR: risk.riskR,
      leverage,
      accountEquity,
      expectedRiskBudget,
      actualRiskBudget,
      expectedStakeAmount,
      stakeAmount,
      segments: riskSegments(risk),
    };
    accountEquity += profitAbs;
    if (!Number.isFinite(accountEquity) || accountEquity <= 0) {
      throw new Error(`${name}.profit_abs leaves invalid account equity`);
    }
    return observation;
  }).sort((left, right) => left.openTime - right.openTime
    || left.entrySignalId.localeCompare(right.entrySignalId));

  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const observation of observations) {
    cumulativeR += observation.realizedR;
    peakR = Math.max(peakR, cumulativeR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);
  }
  const average = (field) => observations.reduce((total, item) => total + item[field], 0)
    / observations.length;
  return {
    available: true,
    reason: 'NET_ACCOUNT_R_EXECUTION',
    expectancyR: average('realizedR'),
    maxDrawdownR,
    mfeR: average('mfeR'),
    maeR: average('maeR'),
    observations,
  };
}

export function backtestMetrics(summary, riskContext = null) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return {};

  const trades = count(summary, ['total_trades', 'trade_count'], 'trades');
  const wins = count(summary, ['wins', 'winning_trades', 'win_trades'], 'wins');
  const draws = count(summary, ['draws', 'draw_trades'], 'draws');
  const losses = count(summary, ['losses', 'losing_trades', 'loss_trades'], 'losses');
  const counts = [wins, draws, losses];
  if (counts.some((value) => value !== null) && counts.some((value) => value === null)) {
    throw new Error('wins, draws, and losses must be reported together');
  }
  const countTotal = wins !== null && draws !== null && losses !== null ? wins + draws + losses : null;
  if (trades !== null && countTotal !== null && countTotal !== trades) {
    throw new Error('wins, draws, and losses must sum to trades');
  }
  const resolvedTrades = trades ?? countTotal;
  const reportedWinRate = firstField(summary, ['winrate', 'win_rate'], 'winRate');
  if (reportedWinRate !== null && (reportedWinRate < 0 || reportedWinRate > 1)) {
    throw new Error('winRate must be between 0 and 1');
  }
  const derivedWinRate = wins !== null && resolvedTrades ? wins / resolvedTrades : null;
  if (reportedWinRate !== null && derivedWinRate !== null
    && Math.abs(reportedWinRate - derivedWinRate) > 1e-9) {
    throw new Error('winRate does not match wins / trades');
  }
  const winRate = reportedWinRate ?? derivedWinRate;
  const reportedProfitFactor = nonNegative(firstField(summary, ['profit_factor'], 'profitFactor'), 'profitFactor');
  const profitFactorStatus = losses === 0 && wins !== null && wins > 0
    ? 'NO_LOSSES'
    : losses === 0 && wins === 0
      ? 'UNAVAILABLE'
      : reportedProfitFactor === null ? 'UNAVAILABLE' : 'AVAILABLE';
  const noTrades = resolvedTrades === 0;
  const expectancyRatio = firstField(summary, ['expectancy_ratio'], 'expectancyRatio');
  const holdingSeconds = nonNegative(firstField(summary, ['holding_avg_s'], 'holdingSeconds'), 'holdingSeconds');

  return {
    trades: resolvedTrades,
    wins,
    draws,
    losses,
    profitRatio: noTrades ? null : firstField(
      summary,
      ['profit_total', 'profit_total_ratio', 'total_profit_ratio'],
      'profitRatio',
    ) ?? ratioFromPercent(
      summary,
      ['profit_total_pct', 'profit_total_percent', 'total_profit_pct'],
      'profitPercent',
    ),
    profitAbs: noTrades ? null : firstField(
      summary,
      ['profit_total_abs', 'total_profit_abs', 'profit_abs'],
      'profitAbs',
    ),
    winRate,
    maxDrawdownRatio: noTrades ? null : nonNegative(firstField(
      summary,
      ['max_drawdown_account', 'max_drawdown_ratio'],
      'maxDrawdownRatio',
    ) ?? ratioFromPercent(
      summary,
      ['max_drawdown_pct', 'max_drawdown_percent'],
      'maxDrawdownPercent',
    ), 'maxDrawdownRatio'),
    maxDrawdownAbs: noTrades ? null : nonNegative(
      firstField(summary, ['max_drawdown_abs'], 'maxDrawdownAbs'),
      'maxDrawdownAbs',
    ),
    expectancyAbs: noTrades ? null : firstField(summary, ['expectancy'], 'expectancyAbs'),
    expectancyRatio: noTrades || losses === 0 ? null : expectancyRatio,
    profitFactor: noTrades || profitFactorStatus !== 'AVAILABLE' ? null : reportedProfitFactor,
    profitFactorStatus: noTrades ? 'UNAVAILABLE' : profitFactorStatus,
    holdingSeconds: noTrades ? null : holdingSeconds,
    riskNormalized: riskNormalizedMetrics(summary, riskContext),
  };
}

export function backtestFeeObservations(summary, requestedFee) {
  if (!summary || typeof summary !== 'object' || !Array.isArray(summary.trades)) {
    throw new Error('Freqtrade result does not contain a trades array for fee verification');
  }
  if (typeof requestedFee !== 'number' || !Number.isFinite(requestedFee) || requestedFee < 0) {
    throw new Error('requested fee must be a non-negative finite number');
  }
  const openRates = [];
  const closeRates = [];
  for (const [index, trade] of summary.trades.entries()) {
    if (!trade || typeof trade !== 'object' || Array.isArray(trade)) {
      throw new Error(`Freqtrade trades[${index}] must be an object for fee verification`);
    }
    for (const [field, target] of [['fee_open', openRates], ['fee_close', closeRates]]) {
      const value = trade[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`Freqtrade trades[${index}].${field} must be a non-negative finite number`);
      }
      target.push(value);
    }
  }
  const unique = (values) => [...new Set(values)].sort((left, right) => left - right);
  const observedOpenRates = unique(openRates);
  const observedCloseRates = unique(closeRates);
  return {
    status: summary.trades.length ? 'OBSERVED' : 'NO_TRADES',
    trades: summary.trades.length,
    requestedFee,
    openRates: observedOpenRates,
    closeRates: observedCloseRates,
    matchesRequested: summary.trades.length > 0
      && [...observedOpenRates, ...observedCloseRates]
        .every((rate) => Math.abs(rate - requestedFee) <= 1e-12),
  };
}
