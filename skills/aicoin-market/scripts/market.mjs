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

// Period 自然名 → AiCoin 后端期望的秒数字符串。
// 2026-05-13 dogfood: subagent 传 "1day" 后端 400, 实际后端只认 "86400"。SDK
// 应该自己转换, 别让 agent 试错。
const PERIOD_ALIASES = {
  '1m': '60', '1min': '60', 'm1': '60',
  '3m': '180', '3min': '180',
  '5m': '300', '5min': '300', 'm5': '300',
  '15m': '900', '15min': '900', 'm15': '900',
  '30m': '1800', '30min': '1800', 'm30': '1800',
  '1h': '3600', '1hour': '3600', 'hour': '3600', 'h1': '3600',
  '2h': '7200', '2hour': '7200',
  '4h': '14400', '4hour': '14400', 'h4': '14400',
  '6h': '21600', '6hour': '21600',
  '12h': '43200', '12hour': '43200',
  '1d': '86400', '1day': '86400', 'day': '86400', 'daily': '86400', 'd': '86400', 'd1': '86400',
  '3d': '259200', '3day': '259200',
  '1w': '604800', '1week': '604800', 'week': '604800', 'weekly': '604800', 'w': '604800', 'w1': '604800',
  '1mon': '2592000', '1month': '2592000', 'month': '2592000', 'monthly': '2592000',
};

function resolveKlinePeriod(period) {
  if (period == null) return period;
  const s = String(period).trim().toLowerCase();
  if (/^\d+$/.test(s)) return s; // 已经是秒数字符串
  return PERIOD_ALIASES[s] || s;
}

// treasury_* 系列只覆盖 BTC / ETH 上市公司持币数据, 其他币 AiCoin 没数据源。
// 2026-05-13 dogfood: 6 个 treasury_* action 拦截文案要一致, 不能光给 error
// 还得给 _note 引导外部数据源, 否则 agent 拿到 400 后只会让用户改 coin 重试。
function treasuryUnsupportedCoin(action, coin) {
  return {
    success: false,
    errorCode: 400,
    error: `${action} 仅支持 coin=BTC 或 ETH (传入: ${coin})。`,
    _note: `treasury_* 系列 AiCoin 只覆盖 BTC / ETH 上市公司持币数据。其他币 (SOL/DOGE/XRP/...) AiCoin 没数据源, 建议查公开源: BTC 全市场储备见 bitcointreasuries.net, ETH 全市场储备见 ethtreasuries.com, 或查公司财报 10-K / 10-Q。**这是数据覆盖范围问题, 不是参数错, 不要让用户改 coin 重试**。`,
  };
}

// AiCoin 指数 key 内部命名 (i:fgi:alternative 这种), 跟常识 key (fearGreedy / vix) 完全
// 对不上。 2026-05-13 P0 #1 dogfood: agent 传 fearGreedy 100% 触发 304 invalid_key,
// 又不知道真实 key 是啥, 卡死。SDK 维护常识 → 内部 key map, 一次解决。
// 真实 key 来源: market.index_list 拉的 list。
// Map keys 全 lowercase (含下划线版本), resolveIndexKey 做 case-insensitive lookup
const INDEX_KEY_ALIAS = {
  // 恐惧 & 贪婪指数
  feargreedy: 'i:fgi:alternative',
  fearandgreed: 'i:fgi:alternative',
  fear_greedy: 'i:fgi:alternative',
  fear_and_greed: 'i:fgi:alternative',
  fear_greed: 'i:fgi:alternative',
  feargreed: 'i:fgi:alternative',
  fgi: 'i:fgi:alternative',
  crypto_fear_greed: 'i:fgi:alternative',
  cryptofeargreed: 'i:fgi:alternative',
  // VIX 恐慌指数
  vix: 'i:vix:cboe',
  fear_index: 'i:vix:cboe',
  panic_index: 'i:vix:cboe',
  // 比特币流动性指数
  blx: 'i:blx:bnc',
  bitcoin_liquid: 'i:blx:bnc',
  bitcoinliquid: 'i:blx:bnc',
  // 国内股指
  shcomp: 'i:sh000001:sse',
  shanghai_composite: 'i:sh000001:sse',
  shanghaicomposite: 'i:sh000001:sse',
  sse: 'i:sh000001:sse',
  szcomp: 'i:sz399001:szse',
  shenzhen_composite: 'i:sz399001:szse',
  shenzhencomposite: 'i:sz399001:szse',
  // 汇率
  usdcny: 't:usdcny:sina',
  usd_cny: 't:usdcny:sina',
  usdcnh: 't:usdcnh:sina',
  usd_cnh: 't:usdcnh:sina',
};

function resolveIndexKey(key) {
  if (!key) return key;
  if (typeof key !== 'string') return key;
  if (key.includes(':')) return key; // 已经是后端格式
  // 尝试 3 种 normalize: lowercase / lowercase+下划线 / 原 lowercase
  const lcDashes = key.toLowerCase().replace(/[\s-]/g, '_');
  const lcNoDashes = key.toLowerCase().replace(/[\s_-]/g, '');
  return INDEX_KEY_ALIAS[lcDashes] || INDEX_KEY_ALIAS[lcNoDashes] || INDEX_KEY_ALIAS[key.toLowerCase()] || key;
}

// 加密概念股白名单 — stock_quotes 端点只覆盖 ~30 家加密相关上市公司。
// 2026-05-13 P0 #2 dogfood: 之前 _note 误导 agent ("不在名单") 即使 ticker 是白名单内
// 上游真的返 null。现在区分 "白名单内但上游空窗" vs "白名单外没数据源" 给不同提示。
const CRYPTO_STOCK_WHITELIST = new Set([
  // BTC mining
  'MARA', 'RIOT', 'CLSK', 'HUT', 'BITF', 'CIFR', 'BTBT', 'HIVE', 'IREN', 'CORZ', 'WULF', 'BTCM', 'EQNR',
  // BTC treasury
  'MSTR', 'METAPLANET', 'BTCS', 'CLBT',
  // Exchanges / brokers
  'COIN', 'GLXY', 'BULL', 'BITX', 'BITS',
  // Big tech with BTC exposure
  'TSLA', 'SQ', 'BLOCK', 'PYPL',
  // Others tracked
  'DGHI', 'GREE', 'SOS', 'NCTY',
]);

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
  // 2026-05-13 P0 #5: 接受 interval / cycle 当 period alias (agent 跨 script 切换易混)
  kline: async ({ symbol, period, interval, cycle, size = '100', since, open_time } = {}) => {
    const _period = period || interval || cycle;
    if (!symbol) return { error: 'symbol is required. Example: "btcusdt:okex" or short name "btc"' };
    if (!_period) return { error: 'period (or interval/cycle alias) is required. 自然名 "1m / 5m / 15m / 30m / 1h / 4h / 1d / 1w" 或秒数字符串 "60 / 300 / 900 / 1800 / 3600 / 14400 / 86400 / 604800" 都可。' };
    const p = { symbol: resolveKlineSymbol(symbol), period: resolveKlinePeriod(_period), size };
    if (since) p.since = since;
    if (open_time) p.open_time = open_time;
    return apiGet('/api/v2/commonKline/dataRecords', p);
  },
  indicator_kline: async ({ symbol, indicator_key, period, interval, cycle, size = '100', open_time, since } = {}) => {
    const _period = period || interval || cycle;
    // 2026-05-13 P1 #5 dogfood: indicator_kline 400 时 SDK 不告知是 symbol 错还是 indicator_key 错。
    // 本地预校验必填字段, 减少 agent 试错。
    if (!symbol) return { success: false, errorCode: 400, error: 'symbol is required (例: "btcusdt:okex" 或别名 "btc")', _note: 'indicator_kline 需要完整 market pair 符号, 不接受裸 "btc"。' };
    if (!indicator_key) return { success: false, errorCode: 400, error: 'indicator_key is required (例: "fundflow" 等)', _note: 'indicator_key 真实可用值需查 indicator_pairs 端点, 后端未公开完整列表。' };
    const p = { symbol, indicator_key, size };
    if (_period) p.period = resolveKlinePeriod(_period);
    if (open_time) p.open_time = open_time; if (since) p.since = since;
    const json = await apiGet('/api/v2/indicatorKline/dataRecords', p);
    if (json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = `indicator_kline 返空。可能原因: (1) indicator_key "${indicator_key}" 不存在 (用 indicator_pairs 查正确名) (2) symbol "${symbol}" 不存在该指标的 K 线 (3) 时间窗超出后端覆盖。**不是接口故障**, 别让用户重试同参数。`;
    }
    return json;
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
  // 2026-05-13 P0 #1 dogfood: 后端 key 是 "i:fgi:alternative" 这种内部命名, 不是 "fearGreedy"。
  // agent 用常识名 100% 触发 invalid_key 304。SDK resolveIndexKey 做常识 → 内部 map。
  index_price: async ({ key, currency } = {}) => {
    const _key = resolveIndexKey(key);
    const p = { key: _key };
    if (currency) p.currency = currency;
    const json = await apiGet('/api/v2/index/indexPrice', p);
    if (_key !== key && json && json.success !== false && json.errorCode !== 304) {
      json._note = `key "${key}" 已自动纠正为后端格式 "${_key}"。下次直接传纠正后的名字省一步。AiCoin index key 命名跟常识不一致 (后端用 "i:fgi:alternative" 这种内部 ID), 完整 key 列表用 index_list 拉。`;
    }
    return json;
  },
  index_info: async ({ key, language, lan } = {}) => {
    const _key = resolveIndexKey(key);
    const p = { key: _key };
    const lg = language || lan;
    if (lg) p.lan = lg;
    const json = await apiGet('/api/v2/index/indexInfo', p);
    if (_key !== key && json && json.success !== false && json.errorCode !== 304) {
      json._note = `key "${key}" 已自动纠正为后端格式 "${_key}"。`;
    }
    return json;
  },
  index_list: () => apiGet('/api/v2/index/getIndex'),
  // crypto_stock
  // 2026-05-13 P0 #2 dogfood: 之前 _note 误导 — MSTR/COIN/TSLA 明明在名单内, 返空时 _note
  // 却说"不在名单", 让 agent 让用户换 symbol。现在区分 "白名单内但上游空窗" vs "真不在名单"。
  stock_quotes: async ({ tickers } = {}) => {
    const p = {};
    if (tickers) p.tickers = tickers;
    const json = await apiGet('/api/upgrade/v2/crypto_stock/quotes', p);
    if (tickers && (json?.data === null || (Array.isArray(json?.data) && json.data.length === 0))) {
      const requested = String(tickers).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const inList = requested.filter(t => CRYPTO_STOCK_WHITELIST.has(t));
      const notInList = requested.filter(t => !CRYPTO_STOCK_WHITELIST.has(t));
      if (inList.length > 0 && notInList.length === 0) {
        json._note = `stock_quotes 全部 ticker (${inList.join(',')}) 都是已知加密概念股, 但上游 (Hibox) 返空。常见原因: 抓取间歇 / 缓存空窗 / 该批次未刷新。**不是不在名单, 也不是接口故障**。建议 30 秒后重试; 持续返空可联系 service@aicoin.com 报修。`;
      } else if (notInList.length > 0 && inList.length === 0) {
        json._note = `stock_quotes 是"加密概念股"专用端点, 只覆盖 ~30 家加密相关公司 (MSTR / COIN / TSLA / MARA / RIOT / CLSK / BULL 等)。tickers="${tickers}" 都不在名单。**通用美股 (NVDA / AAPL / MSFT 等) 请查 Google Finance / Yahoo Finance / 交易软件**, 这边没数据源。`;
      } else {
        json._note = `stock_quotes 部分 ticker 在加密概念股名单 (${inList.join(',')}), 部分不在 (${notInList.join(',')})。返空可能是: (1) 不在名单的本来就没数据 (2) 在名单的上游 (Hibox) 当前空窗。先用 tickers="${inList.join(',')}" 单独再试看是不是空窗问题。`;
      }
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
  // 2026-05-13 dogfood: 拦截一致带 _note 引导外部数据源, 别只甩 error 一句话。
  treasury_entities: async (body = {}) => {
    if (body.coin && !/^(BTC|ETH)$/i.test(body.coin)) return treasuryUnsupportedCoin('treasury_entities', body.coin);
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
    if (body.coin && !/^(BTC|ETH)$/i.test(body.coin)) return treasuryUnsupportedCoin('treasury_history', body.coin);
    return apiPost('/api/upgrade/v2/coin-treasuries/history', body);
  },
  treasury_accumulated: async (body = {}) => {
    if (body.coin && !/^(BTC|ETH)$/i.test(body.coin)) return treasuryUnsupportedCoin('treasury_accumulated', body.coin);
    const json = await apiPost('/api/upgrade/v2/coin-treasuries/history/accumulated', body);
    // 实测 (Q9 v2): SKILL 里描述"返 30 天每天一个点", 实际 ETH 数据返了
    // 跨 5 个月的不连续点。窗口口径跟描述对不上。
    if (Array.isArray(json?.data) && json.data.length > 0) {
      json._note = `⚠️ 实测时间窗口口径跟早期文档描述对不上 — 不一定是"30 天每天一点", 后端可能返非等间隔多月历史。**用前先看返回里 timestamp 的实际跨度**, 不要拿描述当 ground truth。`;
    }
    return json;
  },
  treasury_latest_entities: async ({ coin }) => {
    if (coin && !/^(BTC|ETH)$/i.test(coin)) return treasuryUnsupportedCoin('treasury_latest_entities', coin);
    return apiGet('/api/upgrade/v2/coin-treasuries/latest/entities', { coin });
  },
  treasury_latest_history: async ({ coin }) => {
    if (coin && !/^(BTC|ETH)$/i.test(coin)) return treasuryUnsupportedCoin('treasury_latest_history', coin);
    return apiGet('/api/upgrade/v2/coin-treasuries/latest/history', { coin });
  },
  treasury_summary: async ({ coin }) => {
    if (coin && !/^(BTC|ETH)$/i.test(coin)) return treasuryUnsupportedCoin('treasury_summary', coin);
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
