function requiredText(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requiredTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative millisecond timestamp`);
  }
  return value;
}

function expectedTrades(artifact) {
  const expected = [];
  let entry = null;

  for (const signal of artifact.signals) {
    if (signal.action === 'ENTER') {
      if (entry) throw new Error(`signal artifact has overlapping ENTER ${signal.signalId}`);
      entry = signal;
      continue;
    }
    if (!entry) throw new Error(`signal artifact EXIT ${signal.signalId} has no ENTER`);
    expected.push({ entry, exit: signal });
    entry = null;
  }

  if (entry) throw new Error(`signal artifact ENTER ${entry.signalId} has no EXIT`);
  return expected;
}

export function reconcileSignalBacktest(summary, artifact) {
  if (!summary || typeof summary !== 'object' || !Array.isArray(summary.trades)) {
    throw new Error('Freqtrade result does not contain a trades array');
  }
  if (!artifact || typeof artifact !== 'object' || !Array.isArray(artifact.signals)) {
    throw new Error('signal artifact does not contain a signals array');
  }
  if (!Number.isSafeInteger(summary.total_trades) || summary.total_trades < 0) {
    throw new Error('Freqtrade result total_trades must be a non-negative integer');
  }
  if (summary.total_trades !== summary.trades.length) {
    throw new Error(
      `Freqtrade total_trades does not match trades array: declared ${summary.total_trades}, got ${summary.trades.length}`,
    );
  }

  const expected = expectedTrades(artifact);
  if (summary.trades.length !== expected.length) {
    throw new Error(
      `Freqtrade trade count does not match signal artifact: expected ${expected.length}, got ${summary.trades.length}`,
    );
  }

  const tradesByEntryTag = new Map();
  for (const [index, trade] of summary.trades.entries()) {
    if (!trade || typeof trade !== 'object') throw new Error(`Freqtrade trades[${index}] must be an object`);
    const entryTag = requiredText(trade.enter_tag, `Freqtrade trades[${index}].enter_tag`);
    if (tradesByEntryTag.has(entryTag)) throw new Error(`Freqtrade result contains duplicate enter_tag ${entryTag}`);
    tradesByEntryTag.set(entryTag, { trade, index });
  }

  for (const { entry, exit } of expected) {
    const matched = tradesByEntryTag.get(entry.signalId);
    if (!matched) throw new Error(`Freqtrade result is missing ENTER signal ${entry.signalId}`);
    const { trade, index } = matched;
    const prefix = `Freqtrade trades[${index}]`;
    if (trade.is_open !== false) throw new Error(`${prefix}.is_open must be false`);
    if (trade.pair !== artifact.symbol) {
      throw new Error(`${prefix}.pair does not match signal artifact symbol ${artifact.symbol}`);
    }
    const expectedShort = entry.side === 'SHORT';
    if (typeof trade.is_short !== 'boolean' || trade.is_short !== expectedShort) {
      throw new Error(`${prefix}.is_short does not match ${entry.side} signal ${entry.signalId}`);
    }
    if (requiredTimestamp(trade.open_timestamp, `${prefix}.open_timestamp`) !== entry.decisionTime) {
      throw new Error(`${prefix}.open_timestamp does not match ENTER decisionTime for ${entry.signalId}`);
    }
    if (requiredTimestamp(trade.close_timestamp, `${prefix}.close_timestamp`) !== exit.decisionTime) {
      throw new Error(`${prefix}.close_timestamp does not match EXIT decisionTime for ${exit.signalId}`);
    }
    if (trade.exit_reason !== exit.signalId) {
      throw new Error(`${prefix}.exit_reason does not match EXIT signal ${exit.signalId}`);
    }
    tradesByEntryTag.delete(entry.signalId);
  }

  if (tradesByEntryTag.size) {
    const [unexpected] = tradesByEntryTag.keys();
    throw new Error(`Freqtrade result contains non-artifact ENTER ${unexpected}`);
  }

  return {
    trades: expected.length,
    entries: expected.length,
    exits: expected.length,
    matchedSignals: expected.length * 2,
  };
}
