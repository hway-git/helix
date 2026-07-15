import assert from 'node:assert/strict';
import test from 'node:test';
import {
  freqtradeOhlcvFile,
  marketDatasetHash,
  verifyMarketDataset,
} from '../lib/market-dataset.mjs';

function fixture(symbol = 'BTC/USDT:USDT') {
  const minute = 60_000;
  const payload = {
    schemaVersion: 'helix.market-dataset/v1',
    source: {
      provider: 'okx',
      market: 'futures',
      instrumentId: 'BTC-USDT-SWAP',
      symbol,
    },
    capturedThrough: 2 * minute,
    timeframes: {
      '1m': [
        { time: 0, open: 100, high: 102, low: 99, close: 101, volume: 10 },
        { time: minute, open: 101, high: 103, low: 100, close: 102, volume: 11 },
      ],
    },
  };
  return { ...payload, datasetHash: marketDatasetHash(payload) };
}

test('verifies canonical Helix datasets and rejects candle tampering', () => {
  const dataset = fixture();
  assert.match(dataset.datasetHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(verifyMarketDataset(structuredClone(dataset)), dataset);

  const tampered = structuredClone(dataset);
  tampered.timeframes['1m'][0].volume += 1;
  assert.throws(() => verifyMarketDataset(tampered), /historical dataset hash mismatch/);
});

test('renders the exact Freqtrade futures JSON filename and OHLCV column order', () => {
  const rendered = freqtradeOhlcvFile(fixture(), '1m');
  assert.equal(rendered.relativePath, 'futures/BTC_USDT_USDT-1m-futures.json');
  assert.equal(
    rendered.content,
    '[[0,100,102,99,101,10],[60000,101,103,100,102,11]]\n',
  );
  assert.match(rendered.dataHash, /^sha256:[a-f0-9]{64}$/);
});

test('matches Freqtrade 2026.6 pair filename character replacement', () => {
  const rendered = freqtradeOhlcvFile(fixture('BTC-USDT /USDT:USD.T@X$Y+Z'), '1m');
  assert.equal(rendered.relativePath, 'futures/BTC-USDT__USDT_USD_T_X_Y_Z-1m-futures.json');
});
