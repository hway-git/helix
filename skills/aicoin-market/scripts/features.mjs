#!/usr/bin/env node
// AiCoin Features & Signals CLI
import { apiGet, cli } from '../lib/aicoin-api.mjs';

// AiCoin 平台命名坑修正(big_orders/agg_trades 必用,否则 304 "无效的交易对"):
//  - OKX 永续是 "okcoinfutures" 不是 "okex" (okex 是现货)
//  - Bitget 永续 symbol 是 "btcumcblusdt:bitget" 不是 "btcswapusdt:bitget"
function fixPlatformAlias(s) {
  if (!s || !s.includes(':')) return s;
  if (/swap.*:okex$/i.test(s)) return s.replace(/:okex$/i, ':okcoinfutures');
  if (/swapusdt:bitget$/i.test(s)) return s.replace(/swapusdt:bitget$/i, 'umcblusdt:bitget');
  return s;
}

// big_orders/agg_trades 已知不支持的交易所(实测): huobi/huobifutures/kraken/
// deribit/mexc/kucoin/bithumb/bitfinex/binancespot 等。遇到这些 platform 直接
// 返回一个清晰的错误说明,不去调上游浪费一次签名。
const BIG_ORDERS_UNSUPPORTED = new Set([
  'huobi', 'huobipro', 'huobifutures', 'huobiproswap', 'kraken', 'deribit', 'mexc',
  'kucoin', 'bithumb', 'bitfinex', 'binancespot', 'bybitswap', 'gateswap',
]);
function checkBigOrdersSupport(symbol) {
  if (!symbol || !symbol.includes(':')) return null;
  const platform = symbol.split(':').pop().toLowerCase();
  if (BIG_ORDERS_UNSUPPORTED.has(platform)) {
    return {
      success: false,
      errorCode: 304,
      error: `big_orders/agg_trades 不支持交易所 "${platform}"。当前支持: binance(永续+现货) / okcoinfutures(OKX 永续) / bybit / bitget(symbol 用 btcumcblusdt) / gate / coinbase / upbit`,
      参数错误提示: `不要将该错误描述为付费问题或参数格式问题。请告知用户:"AiCoin 主力大单/大单成交目前只覆盖头部 8 家交易所,${platform} 不在列表里"`,
    };
  }
  return null;
}

cli({
  // market_overview
  nav: ({ language, lan } = {}) => { const p = {}; const lg = language || lan; if (lg) p.lan = lg; return apiGet('/api/v2/mix/nav', p); },
  ls_ratio: () => apiGet('/api/v2/mix/ls-ratio'),
  liquidation: ({ currency, type, coinKey, marketKey } = {}) => {
    const p = {};
    if (currency) p.currency = currency;
    if (type) p.type = type;
    if (coinKey) p.coinKey = coinKey;
    if (marketKey) p.marketKey = marketKey;
    return apiGet('/api/v2/mix/liq', p);
  },
  // alias: 早期 SKILL.md 用 `liq`,实际 action 是 `liquidation`
  liq: function(args) { return this.liquidation(args); },
  grayscale_trust: () => apiGet('/api/v2/mix/grayscale-trust'),
  // gray_scale 接受 coin key 必须小写完整名 (bitcoin/ethereum), 不是 ticker (BTC/ETH)
  gray_scale: async ({ coins }) => {
    const norm = String(coins || '').split(',').map(c => {
      const low = c.trim().toLowerCase();
      if (low === 'btc') return 'bitcoin';
      if (low === 'eth') return 'ethereum';
      return low;
    }).join(',');
    const json = await apiGet('/api/v2/mix/gray-scale', { coins: norm });
    // 实测: 即使 coins 正确转成 bitcoin/ethereum, 上游 detail 也常返空 {} 对象。
    // 加 _note 提示 agent 这是数据不可用 (灰度持仓窗口未填充或权限差异), 不是接口故障。
    const detail = json?.data?.detail;
    const isEmpty = detail && typeof detail === 'object' && !Array.isArray(detail) && Object.keys(detail).length === 0;
    if (isEmpty) {
      json._note = `gray_scale 上游 detail 返空 {}。这通常是当前 Pro 档没覆盖该 endpoint 的历史窗口或数据未填充, 不是接口故障。想看灰度持仓概览改用 grayscale_trust (列出 GBTC/ETHE 总览)。`;
    }
    return json;
  },
  stock_market: () => apiGet('/api/v2/mix/stock-market'),
  // order_flow — 必须经 fixPlatformAlias + 支持列表校验
  big_orders: ({ symbol }) => {
    const fixed = fixPlatformAlias(symbol);
    const blocked = checkBigOrdersSupport(fixed);
    if (blocked) return Promise.resolve(blocked);
    return apiGet('/api/v2/order/bigOrder', { symbol: fixed });
  },
  agg_trades: async ({ symbol }) => {
    const fixed = fixPlatformAlias(symbol);
    const blocked = checkBigOrdersSupport(fixed);
    if (blocked) return blocked;
    const json = await apiGet('/api/v2/order/aggTrade', { symbol: fixed });
    // 实测: bybit U 永续上 agg_trades 后端经常返 success=true 但 data.list=[] 空,
    // 不是接口故障也不是参数错。给 agent 明确 _note 避免误判。
    const list = json?.data?.list;
    if (Array.isArray(list) && list.length === 0) {
      json._note = `agg_trades '${fixed}' 返空 list (success=true 但 data.list=[])。不是接口故障 — bybit U 永续等部分交易所后端经常空, 或者当前窗口确实没大单成交。换交易所 (binance/okcoinfutures) 或稍后重试。`;
    }
    return json;
  },
  // trading_pair
  pair_ticker: ({ key_list }) => apiGet('/api/v2/trading-pair/ticker', { key_list }),
  pair_by_market: ({ market }) => apiGet('/api/v2/trading-pair/getTradingPair', { market }),
  pair_list: ({ market, currency, show }) => {
    if (!market) {
      return Promise.resolve({
        success: false,
        errorCode: 400,
        error: 'pair_list 必填 market 参数 (例: binance/okex/bybit)',
        参数错误提示: '请告知用户先指定交易所',
      });
    }
    const p = { market };
    if (currency) p.currency = currency;
    if (show) p.show = show;
    return apiGet('/api/v2/trading-pair', p);
  },
  // signal_data — strategy_signal 后端 broken: 公开的 signal_key 格式 (depth_win_one /
  // ma:1440:single_ma:7 / macd:5:fork:12,26,9 / 各种 indicator + period 组合) 实测全 400。
  // **无条件**返实测结论,不去打上游浪费签名,避免 agent 瞎猜参数反复试错。
  // 等后端修好或拿到正确 signal_key spec 再恢复实际调用。
  strategy_signal: ({ coin_type, signal_key, latest_time } = {}) => {
    return Promise.resolve({
      success: false,
      errorCode: 400,
      error: 'strategy_signal 后端 broken: 公开 signal_key 格式 (depth_win_one / ma:1440:single_ma:7 / macd:5:fork:12,26,9) 实测全 400',
      实测结论: '请告知用户"AiCoin 策略胜率信号接口暂不可用,需联系 AiCoin 客服 (service@aicoin.com) 获取正确 signal_key 格式或等待修复"。**不要瞎猜参数重试**, 后端 spec 没公开就是没,试什么都 400。',
      替代方案: '想看技术指标信号: change_signal (异动信号) / signal_alert (用户配置的预警)',
      请求参数_仅供记录: { coin_type, signal_key, latest_time },
    });
  },
  signal_alert: () => apiGet('/api/v2/signal/signalAlert'),
  signal_config: ({ language, lan } = {}) => { const p = {}; const lg = language || lan; if (lg) p.lan = lg; return apiGet('/api/v2/signal/signalAlertConf', p); },
  signal_alert_list: () => apiGet('/api/v2/signal/getSignalAlertSetList'),
  change_signal: ({ type, currency } = {}) => {
    const p = {};
    if (type) p.type = type;
    if (currency) p.currency = currency;
    return apiGet('/api/v2/signal/changeSignal', p);
  },
  delete_signal: ({ id }) => apiGet('/api/v2/signal/delSignalAlert', { id }),
  add_signal: ({ subType, symbol, remark }) => {
    const p = { subType, symbol };
    if (remark) p.remark = remark;
    return apiGet('/api/v2/signal/addSignalAlert', p);
  },
});
