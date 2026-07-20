export function okxInstrumentId(symbol) {
  const match = /^([A-Z0-9]+)\/([A-Z0-9]+):\2$/.exec(String(symbol || '').toUpperCase());
  if (!match) throw new Error(`Forward Signal deployment requires an OKX perpetual symbol, received ${symbol}`);
  return `${match[1]}-${match[2]}-SWAP`;
}

export function okxForwardSource(symbol) {
  return {
    provider: 'okx',
    market: 'futures',
    instrumentId: okxInstrumentId(symbol),
    symbol,
  };
}

export function assertOkxForwardSource(source, symbol, name = 'forward source') {
  const target = okxForwardSource(symbol);
  for (const field of ['provider', 'market', 'instrumentId']) {
    if (source?.[field] !== target[field]) {
      throw new Error(`${name} ${field} does not match the OKX forward target`);
    }
  }
  return target;
}
