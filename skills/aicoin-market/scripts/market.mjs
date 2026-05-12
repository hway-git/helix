#!/usr/bin/env node
// AiCoin Market Data CLI
import { apiGet, apiPost, cli } from '../lib/aicoin-api.mjs';

// Kline symbol alias: short names → AiCoin kline format
const KLINE_ALIASES = {
  'btc': 'btcusdt:okex', 'bitcoin': 'btcusdt:okex',
  'eth': 'ethusdt:okex', 'ethereum': 'ethusdt:okex',
  'sol': 'solusdt:okex', 'solana': 'solusdt:okex',
  'doge': 'dogeusdt:okex', 'dogecoin': 'dogeusdt:okex',
  'xrp': 'xrpusdt:okex',
  'bnb': 'bnbusdt:binance',
  'ada': 'adausdt:okex',
  'avax': 'avaxusdt:okex',
  'dot': 'dotusdt:okex',
  'link': 'linkusdt:okex',
  'matic': 'maticusdt:okex', 'pol': 'maticusdt:okex',
};

function resolveKlineSymbol(symbol) {
  if (!symbol) return symbol;
  if (symbol.includes(':')) return symbol;
  const key = symbol.toLowerCase().replace(/[\s/]/g, '');
  return KLINE_ALIASES[key] || symbol;
}

cli({
  // market_info
  exchanges: () => apiGet('/api/v2/market'),
  ticker: ({ market_list }) => apiGet('/api/v2/market/ticker', { market_list }),
  hot_coins: async ({ key, currency }) => {
    const p = { key };
    if (currency) p.currency = currency;
    const json = await apiGet('/api/v2/market/hotTabCoins', p);
    // 实测: 后端字典 key 限定 (`defi` 通, `meme`/`new` 返 data.list=[])。
    // 真实返回结构 {data:{list:[...]}}, 不是 {data:[...]}。返空时加 _note。
    const list = json?.data?.list;
    if (Array.isArray(list) && list.length === 0) {
      json._note = `hot_coins '${key}' 返空。后端 key 字典有限 (实测仅 'defi' 通, 'meme'/'new' 返空)。想查 meme 热门币改用 coin.mjs search '{"search":"meme","trade_type":"spot"}', 这不是接口故障。`;
    }
    return json;
  },
  futures_interest: ({ language, lan, page, page_size, pageSize, currency } = {}) => {
    const p = {};
    const lg = language || lan;
    if (lg) p.lan = lg;
    if (page) p.page = page;
    const ps = page_size || pageSize;
    if (ps) p.pageSize = ps;
    if (currency) p.currency = currency;
    return apiGet('/api/v2/futures/interest', p);
  },
  // kline
  kline: async ({ symbol, period, size = '100', since, open_time } = {}) => {
    if (!symbol) return { error: 'symbol is required. Example: "btcusdt:okex" or short name "btc"' };
    if (!period) return { error: 'period is required. Values: "60"(1m), "300"(5m), "900"(15m), "1800"(30m), "3600"(1h), "14400"(4h), "86400"(1d), "604800"(1w)' };
    const p = { symbol: resolveKlineSymbol(symbol), period, size };
    if (since) p.since = since;
    if (open_time) p.open_time = open_time;
    return apiGet('/api/v2/commonKline/dataRecords', p);
  },
  indicator_kline: ({ symbol, indicator_key, period, size = '100', open_time, since }) => {
    const p = { symbol, indicator_key, size };
    if (period) p.period = period;
    if (open_time) p.open_time = open_time; if (since) p.since = since;
    return apiGet('/api/v2/indicatorKline/dataRecords', p);
  },
  indicator_pairs: async ({ coinType, indicator_key } = {}) => {
    if (!coinType || !indicator_key) {
      return {
        success: false, errorCode: 400,
        error: 'indicator_pairs 必填 indicator_key + coinType (例: {"indicator_key":"fundflow","coinType":"USDT"})',
        参数提示: '缺任意一个上游会返 400, 本地拦截以省签名。',
      };
    }
    const p = { coinType, indicator_key };
    const json = await apiGet('/api/v2/indicatorKline/getTradingPair', p);
    // 实测: indicator_key 取值范围未公开, 传 coinType 也可能某些 indicator_key 返空
    const list = json?.data?.list ?? json?.data;
    if (Array.isArray(list) && list.length === 0) {
      json._note = `indicator_pairs '${indicator_key}+${coinType}' 返空 list。可能 indicator_key 名字不对 (后端 spec 未公开完整列表) 或该 coinType 下确实没指标 K 线交易对。换 indicator_key (fundflow/...) 或换 coinType (USDT/USDC/...) 再试。`;
    }
    return json;
  },
  // index_data
  index_price: ({ key, currency }) => {
    const p = { key };
    if (currency) p.currency = currency;
    return apiGet('/api/v2/index/indexPrice', p);
  },
  index_info: ({ key, language, lan }) => {
    const p = { key };
    const lg = language || lan;
    if (lg) p.lan = lg;
    return apiGet('/api/v2/index/indexInfo', p);
  },
  index_list: () => apiGet('/api/v2/index/getIndex'),
  // crypto_stock
  stock_quotes: async ({ tickers } = {}) => {
    const p = {};
    if (tickers) p.tickers = tickers;
    const json = await apiGet('/api/upgrade/v2/crypto_stock/quotes', p);
    // 实测: 该端点是"加密概念股"专用 (MSTR/COIN/TSLA/BULL 等), 通用美股
    // NVDA/AAPL/MSFT 不在名单, data 会返 null 或单条少于请求数。给 agent 明确提示
    // 避免误判为接口故障。
    if (tickers && (json?.data === null || (Array.isArray(json?.data) && json.data.length === 0))) {
      json._note = `stock_quotes 是"加密概念股"专用 (端点 /crypto_stock/quotes), 只覆盖 MSTR/COIN/TSLA/BULL 等约 2-30 家加密相关公司。tickers="${tickers}" 返空通常是因为这些 symbol 不在加密概念股名单。**不是接口故障**。通用美股 (NVDA/AAPL/MSFT 等) 查 Google Finance / 交易软件。`;
    }
    return json;
  },
  stock_top_gainer: ({ us_stock, hk_stock, limit = '30' } = {}) => {
    const p = { limit };
    if (us_stock != null) p.us_stock = us_stock;
    if (hk_stock != null) p.hk_stock = hk_stock;
    return apiGet('/api/upgrade/v2/crypto_stock/top-gainer', p);
  },
  stock_company: async ({ symbol }) => {
    if (!symbol) return { success: false, errorCode: 400, error: 'stock_company 必填 symbol (例: COIN / MSTR / TSLA)' };
    try {
      return await apiGet(`/api/upgrade/v2/crypto_stock/company/${symbol}`);
    } catch (e) {
      // 实测 COIN/MSTR 都返 500 "Failed to get company info" — 上游故障
      if (/^API 5\d\d/.test(e.message)) {
        return {
          success: false,
          errorCode: 500,
          error: e.message,
          实测结论: 'stock_company 当前后端不稳: 多个 symbol 实测都返 500。请告知用户"该公司详情接口暂时不可用,可用 stock_quotes 看价格/市值汇总,或联系 AiCoin 客服 (service@aicoin.com) 报修"。',
        };
      }
      throw e;
    }
  },
  // coin_treasury
  // 实测: treasury_* 全套只支持 coin=BTC 或 ETH, 传 SOL/其他会 400。
  // 本地拦截以省签名 + 给 agent 明确边界。
  treasury_entities: async (body = {}) => {
    if (body.coin && !/^(BTC|ETH)$/i.test(body.coin)) {
      return { success: false, errorCode: 400, error: `treasury_entities 仅支持 coin=BTC 或 ETH (传入: ${body.coin})。其他币的上市公司持币数据 AiCoin 没覆盖, 可查公开源 bitcointreasuries.net 或 ethtreasuries.com。` };
    }
    const json = await apiPost('/api/upgrade/v2/coin-treasuries/entities', body);
    // 实测 (Q9 v2 subagent): share 字段对 BTC 和 ETH 量级不一致 — BTC 实例
    // 里是小数 (0.012 表示 1.2%), ETH 实例里直接是百分数 (1.2 表示 1.2%)。
    // agent 跨币种横比时容易闹乌龙。提示 agent 注意。
    if (Array.isArray(json?.data) && body.coin) {
      json._note = `⚠️ share 字段口径在 BTC/ETH 之间可能不一致 (BTC 实例: 小数, 如 0.012 = 1.2%; ETH 实例: 百分数, 如 1.2 = 1.2%)。**跨币种比 share 前先用一个已知持有量验证一下口径**, 不要直接拿数字比大小。`;
    }
    return json;
  },
  treasury_history: async (body = {}) => {
    if (body.coin && !/^(BTC|ETH)$/i.test(body.coin)) {
      return { success: false, errorCode: 400, error: `treasury_history 仅支持 coin=BTC 或 ETH (传入: ${body.coin})。` };
    }
    return apiPost('/api/upgrade/v2/coin-treasuries/history', body);
  },
  treasury_accumulated: async (body = {}) => {
    if (body.coin && !/^(BTC|ETH)$/i.test(body.coin)) {
      return { success: false, errorCode: 400, error: `treasury_accumulated 仅支持 coin=BTC 或 ETH (传入: ${body.coin})。` };
    }
    const json = await apiPost('/api/upgrade/v2/coin-treasuries/history/accumulated', body);
    // 实测 (Q9 v2): SKILL 里描述"返 30 天每天一个点", 实际 ETH 数据返了
    // 跨 5 个月的不连续点。窗口口径跟描述对不上。
    if (Array.isArray(json?.data) && json.data.length > 0) {
      json._note = `⚠️ 实测时间窗口口径跟早期文档描述对不上 — 不一定是"30 天每天一点", 后端可能返非等间隔多月历史。**用前先看返回里 timestamp 的实际跨度**, 不要拿描述当 ground truth。`;
    }
    return json;
  },
  treasury_latest_entities: async ({ coin }) => {
    if (coin && !/^(BTC|ETH)$/i.test(coin)) {
      return { success: false, errorCode: 400, error: `treasury_latest_entities 仅支持 coin=BTC 或 ETH (传入: ${coin})。` };
    }
    return apiGet('/api/upgrade/v2/coin-treasuries/latest/entities', { coin });
  },
  treasury_latest_history: async ({ coin }) => {
    if (coin && !/^(BTC|ETH)$/i.test(coin)) {
      return { success: false, errorCode: 400, error: `treasury_latest_history 仅支持 coin=BTC 或 ETH (传入: ${coin})。` };
    }
    return apiGet('/api/upgrade/v2/coin-treasuries/latest/history', { coin });
  },
  treasury_summary: async ({ coin }) => {
    if (coin && !/^(BTC|ETH)$/i.test(coin)) {
      return { success: false, errorCode: 400, error: `treasury_summary 仅支持 coin=BTC 或 ETH (传入: ${coin})。` };
    }
    return apiGet('/api/upgrade/v2/coin-treasuries/summary', { coin });
  },
  // depth
  depth_latest: ({ symbol, dbKey, size }) => {
    const p = { dbKey: symbol || dbKey };
    if (size) p.size = size;
    return apiGet('/api/upgrade/v2/futures/latest-depth', p);
  },
  depth_full: ({ symbol, dbKey }) => apiGet('/api/upgrade/v2/futures/full-depth', { dbKey: symbol || dbKey }),
  depth_grouped: ({ symbol, dbKey, groupSize }) => {
    // 实测: groupSize 必填且必须数字字符串, 不传上游 400。
    // 默认 100 (合理的价格粒度, 主流币 BTC ~0.1%)。
    const gs = groupSize || '100';
    return apiGet('/api/upgrade/v2/futures/full-depth/grouped', { dbKey: symbol || dbKey, groupSize: gs });
  },
});
