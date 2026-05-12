#!/usr/bin/env node
// Hyperliquid Trader Analytics CLI
import { apiGet, apiPost, cli } from '../lib/aicoin-api.mjs';

// portfolio window 实测仅支持这 4 个值,其他 (perpAllTime, allTimePerp 等) 一律 400
const PORTFOLIO_WINDOWS = new Set(['day', 'week', 'month', 'allTime']);

// 单地址必填校验, 避免 URL 拼出 `traders/undefined/...` 然后上游 404
function requireAddress(address) {
  if (!address) {
    return {
      success: false,
      errorCode: 400,
      error: 'address 必填 (HL 钱包地址, 例 0x...)。先用 smart_find 拿聪明钱列表, 或让用户提供。',
    };
  }
  return null;
}

// HL 后端的 completed_* 端点对 "未知 positionId" 是塞到 HTTP 200 的 body
// {code:"400", msg:"position not found"} 里返,不走 throw 分支。统一把这种
// 业务错误包成 实测结论 提示, 引导 agent 改用替代端点。
// fallback 是替代调用建议文字。
function wrapPositionNotFound(json, fallback) {
  if (!json || typeof json !== 'object') return json;
  const code = String(json.code || '');
  const msg = String(json.msg || '');
  // code 非 "0" 或非 0 都视为业务错; 同时 msg 含 position not found 才走包装路径
  if (code !== '0' && code !== '' && /position not found/i.test(msg)) {
    return {
      success: false,
      errorCode: 400,
      error: msg,
      实测结论: `该端点按 positionId 取数, 不接受 address+coin 组合。agent 拿不到 positionId 用不了。${fallback}`,
      _raw: json,
    };
  }
  return json;
}

cli({
  // hl_trader — period 实测必填且没默认, 不传 400。这里给 "30" (30 天) 兜底。
  trader_stats: ({ address, period }) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = { period: period || '30' };
    return apiGet(`/api/upgrade/v2/hl/traders/${address}/addr-stat`, p);
  },
  best_trades: ({ address, period, limit }) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = { period: period || '30' }; if (limit) p.limit = limit;
    return apiGet(`/api/upgrade/v2/hl/traders/${address}/best-trades`, p);
  },
  performance: ({ address, period, limit }) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = { period: period || '30' }; if (limit) p.limit = limit;
    return apiGet(`/api/upgrade/v2/hl/traders/${address}/performance-by-coin`, p);
  },
  completed_trades: async ({ address, coin, limit } = {}) => {
    const err = requireAddress(address); if (err) return err;
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    const json = await apiGet(`/api/upgrade/v2/hl/traders/${address}/completed-trades`, p);
    if (json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = `completed_trades 该地址${coin ? ` ${coin}` : ''} 近期无已平仓交易。换 coin 或不传 coin 看全部历史; 想看活跃币种用 performance (per-coin 业绩)。`;
    }
    return json;
  },
  accounts: async ({ addresses }) => {
    let addrs = addresses;
    if (typeof addrs === 'string') { try { addrs = JSON.parse(addrs); } catch { addrs = [addrs]; } }
    try {
      return await apiPost('/api/upgrade/v2/hl/traders/accounts', { addresses: addrs });
    } catch (e) {
      // 实测: 即使 addresses 格式正确, 后端也偶发 500。statistics 同输入正常。
      if (/^API 5\d\d/.test(e.message)) {
        return {
          success: false,
          errorCode: 500,
          error: e.message,
          实测结论: 'hl/traders/accounts 端点后端不稳, 实测 500 但同样的 addresses 调 statistics 正常。请改用 statistics + batch_clearinghouse_state 拿同样数据, 或告知用户"该接口后端故障, 联系 AiCoin 客服 (service@aicoin.com) 报修"。',
        };
      }
      throw e;
    }
  },
  statistics: ({ addresses }) => {
    let addrs = addresses;
    if (typeof addrs === 'string') { try { addrs = JSON.parse(addrs); } catch { addrs = [addrs]; } }
    return apiPost('/api/upgrade/v2/hl/traders/statistics', { addresses: addrs });
  },
  // hl_fills
  fills: ({ address, coin, limit } = {}) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    return apiGet(`/api/upgrade/v2/hl/fills/${address}`, p);
  },
  fills_by_oid: ({ oid }) => apiGet(`/api/upgrade/v2/hl/fills/oid/${oid}`),
  fills_by_twapid: ({ twapid }) => apiGet(`/api/upgrade/v2/hl/fills/twapid/${twapid}`),
  top_trades: ({ coin, interval, limit } = {}) => {
    // 实测: interval 必填, 默认 1h
    const p = { coin, interval: interval || '1h' }; if (limit) p.limit = limit;
    return apiGet('/api/upgrade/v2/hl/fills/top-trades', p);
  },
  // hl_orders
  orders_latest: ({ address, coin, limit } = {}) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    return apiGet(`/api/upgrade/v2/hl/orders/${address}/latest`, p);
  },
  order_by_oid: ({ oid }) => apiGet(`/api/upgrade/v2/hl/orders/oid/${oid}`),
  filled_orders: ({ address, coin, limit } = {}) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    return apiGet(`/api/upgrade/v2/hl/filled-orders/${address}/latest`, p);
  },
  filled_by_oid: ({ oid }) => apiGet(`/api/upgrade/v2/hl/filled-orders/oid/${oid}`),
  top_open: ({ coin, minVal, min_val, limit }) => {
    const p = {}; if (coin) p.coin = coin; if (minVal || min_val) p.minVal = minVal || min_val; if (limit) p.limit = limit;
    return apiGet('/api/upgrade/v2/hl/orders/top-open-orders', p);
  },
  active_stats: ({ coin, whaleThreshold, whale_threshold }) => {
    const p = {}; if (coin) p.coin = coin; if (whaleThreshold || whale_threshold) p.whaleThreshold = whaleThreshold || whale_threshold;
    return apiGet('/api/upgrade/v2/hl/orders/active-stats', p);
  },
  twap_states: async ({ address, coin, limit } = {}) => {
    const err = requireAddress(address); if (err) return err;
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    const json = await apiGet(`/api/upgrade/v2/hl/twap-states/${address}/latest`, p);
    if (json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = `twap_states 该地址当前无 TWAP 委托 (空属正常 — TWAP 是 HL 的时间加权拆单, 大多数地址不用)。常态返空, 不是接口故障。`;
    }
    return json;
  },
  // hl_position
  current_pos_history: async ({ address, coin } = {}) => {
    const err = requireAddress(address); if (err) return err;
    if (!coin) {
      return {
        success: false, errorCode: 400,
        error: 'current_pos_history 必填 coin (例: BTC / ETH / cash:TSLA)',
        参数提示: '缺 coin 会拼出 /undefined URL 上游返 null 误导, 现已本地拦截。',
      };
    }
    const json = await apiGet(`/api/upgrade/v2/hl/traders/${address}/current-position-history/${coin}`);
    if (json && (json.data === null || (Array.isArray(json.data) && json.data.length === 0))) {
      json._note = `current_pos_history 该地址 ${coin} 当前无持仓 (data 空)。先用 fills (按地址列实际活跃币种) 或 performance 确认地址主攻哪些币。`;
    }
    return json;
  },
  completed_pos_history: async ({ address, coin, startTime, endTime } = {}) => {
    const err = requireAddress(address); if (err) return err;
    if (!startTime && !endTime) {
      return {
        success: false, errorCode: 400,
        error: 'completed_pos_history 必填 startTime 或 endTime 之一 (ms epoch)',
        参数提示: '换用 completed_trades (按地址列已平仓交易无需时间窗)。',
      };
    }
    const p = {}; if (startTime) p.startTime = startTime; if (endTime) p.endTime = endTime;
    const json = await apiGet(`/api/upgrade/v2/hl/traders/${address}/completed-position-history/${coin}`, p);
    return wrapPositionNotFound(json, '改用 completed_trades (按地址列已平仓交易) 或 fills (按地址列所有成交) 拿历史。');
  },
  current_pnl: async ({ address, coin, interval, limit } = {}) => {
    const err = requireAddress(address); if (err) return err;
    if (!coin) {
      return {
        success: false, errorCode: 400,
        error: 'current_pnl 必填 coin (例: BTC / ETH / cash:TSLA)',
        参数提示: '缺 coin 会拼出 /undefined URL 上游返 null 误导, 现已本地拦截。',
      };
    }
    // 实测: interval 必填 (返 missing interval), 默认 1h
    const p = { interval: interval || '1h' }; if (limit) p.limit = limit;
    const json = await apiGet(`/api/upgrade/v2/hl/traders/${address}/current-position-pnl/${coin}`, p);
    if (json && (json.data === null || (Array.isArray(json.data) && json.data.length === 0))) {
      json._note = `current_pnl 该地址 ${coin} 当前无持仓 (data 空)。先用 fills (按地址列实际活跃币种) 或 performance (per-coin 业绩) 确认地址主攻哪些币。`;
    }
    return json;
  },
  completed_pnl: async ({ address, coin, interval, startTime, endTime, limit } = {}) => {
    const err = requireAddress(address); if (err) return err;
    // 实测: 除 interval, 还必须传 startTime 或 endTime 之一 (ms epoch). agent 应该自己算时间窗。
    if (!startTime && !endTime) {
      return {
        success: false,
        errorCode: 400,
        error: 'completed_pnl 必填 startTime 或 endTime 之一 (ms epoch)',
        参数提示: '例: startTime=Date.now()-30*86400*1000 取过去 30 天。或换用 pnls (全地址 PnL 曲线无需时间窗)。',
      };
    }
    const p = { interval: interval || '1h' }; if (startTime) p.startTime = startTime; if (endTime) p.endTime = endTime; if (limit) p.limit = limit;
    const json = await apiGet(`/api/upgrade/v2/hl/traders/${address}/completed-position-pnl/${coin}`, p);
    return wrapPositionNotFound(json, '改用 pnls (整地址 PnL 曲线) 或 best_trades (按地址盈利交易)。');
  },
  current_executions: async ({ address, coin, interval, limit } = {}) => {
    const err = requireAddress(address); if (err) return err;
    if (!coin) {
      return {
        success: false, errorCode: 400,
        error: 'current_executions 必填 coin (例: BTC / ETH / cash:TSLA)',
        参数提示: '缺 coin 会拼出 /undefined URL 上游返 null 误导, 现已本地拦截。',
      };
    }
    const p = { interval: interval || '1h' }; if (limit) p.limit = limit;
    const json = await apiGet(`/api/upgrade/v2/hl/traders/${address}/current-position-executions/${coin}`, p);
    if (json && (json.data === null || (Array.isArray(json.data) && json.data.length === 0))) {
      json._note = `current_executions 该地址 ${coin} 当前无持仓 (data 空)。先用 fills (按地址列实际活跃币种) 或 performance 确认地址主攻哪些币。`;
    }
    return json;
  },
  completed_executions: async ({ address, coin, interval, startTime, endTime, limit } = {}) => {
    const err = requireAddress(address); if (err) return err;
    if (!startTime && !endTime) {
      return {
        success: false, errorCode: 400,
        error: 'completed_executions 必填 startTime 或 endTime 之一 (ms epoch)',
        参数提示: '换用 fills (按地址全量成交无需时间窗)。',
      };
    }
    const p = { interval: interval || '1h' }; if (startTime) p.startTime = startTime; if (endTime) p.endTime = endTime; if (limit) p.limit = limit;
    const json = await apiGet(`/api/upgrade/v2/hl/traders/${address}/completed-position-executions/${coin}`, p);
    return wrapPositionNotFound(json, '改用 fills (按地址列所有成交)。');
  },
  // hl_portfolio — window 仅 day/week/month/allTime, 其他值上游 400。校验后再调。
  portfolio: ({ address, window }) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const w = window || 'day';
    if (!PORTFOLIO_WINDOWS.has(w)) {
      return Promise.resolve({
        success: false,
        errorCode: 400,
        error: `portfolio window 仅接受 day / week / month / allTime, 收到 "${w}"`,
        参数错误提示: '请改用合法 window 值, 不要尝试 perpAllTime / allTimePerp 这类组合。',
      });
    }
    return apiGet(`/api/upgrade/v2/hl/portfolio/${address}/${w}`);
  },
  pnls: ({ address, period } = {}) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = { period: period || '30' };
    return apiGet(`/api/upgrade/v2/hl/pnls/${address}`, p);
  },
  // max_drawdown / net_flow — days 实测必填, 默认 30
  max_drawdown: ({ address, days, scope = 'perp' } = {}) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    return apiGet(`/api/upgrade/v2/hl/max-drawdown/${address}`, { days: days || '30', scope });
  },
  net_flow: ({ address, days } = {}) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    return apiGet(`/api/upgrade/v2/hl/ledger-updates/net-flow/${address}`, { days: days || '30' });
  },
  // hl_advanced
  info: ({ type, user, extra_params }) => {
    const body = { type }; if (user) body.user = user;
    if (extra_params) {
      try { Object.assign(body, typeof extra_params === 'string' ? JSON.parse(extra_params) : extra_params); } catch {}
    }
    return apiPost('/api/upgrade/v2/hl/info', body);
  },
  smart_find: (params) => apiPost('/api/upgrade/v2/hl/smart/find', params || {}),
  discover: (params) => apiPost('/api/upgrade/v2/hl/traders/discover', params || {}),
  discover_history: (params) => apiPost('/api/upgrade/v2/hl/traders/discover-history', params || {}),
  // batch endpoints
  fills_by_builder: ({ builder, coin, limit, minVal } = {}) => {
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit; if (minVal) p.minVal = minVal;
    return apiGet(`/api/upgrade/v2/hl/fills/builder/${builder}/latest`, p);
  },
  batch_pnls: ({ addresses, period, scope }) => {
    let addrs = addresses;
    if (typeof addrs === 'string') { try { addrs = JSON.parse(addrs); } catch { addrs = [addrs]; } }
    const body = { addresses: addrs }; if (period != null) body.period = period; if (scope) body.scope = scope;
    return apiPost('/api/upgrade/v2/hl/batch-pnls', body);
  },
  batch_addr_stat: ({ addresses, period }) => {
    let addrs = addresses;
    if (typeof addrs === 'string') { try { addrs = JSON.parse(addrs); } catch { addrs = [addrs]; } }
    const body = { addresses: addrs }; if (period != null) body.period = period;
    return apiPost('/api/upgrade/v2/hl/traders/batch-addr-stat', body);
  },
  // 注意: 上游 body 字段是大写 Coin (不是 coin)。 agent 容易传小写, 静默拿到全币种杂烩。
  // 这里兼容两种大小写, 不让 silent wrong 发生。
  completed_trades_by_time: async ({ address, pageNum, pageSize, Coin, coin, endTimeFrom, endTimeTo } = {}) => {
    const err = requireAddress(address); if (err) return err;
    const body = {};
    if (pageNum) body.pageNum = pageNum; if (pageSize) body.pageSize = pageSize;
    const coinValue = Coin || coin;
    if (coinValue) body.Coin = coinValue;
    if (endTimeFrom) body.endTimeFrom = endTimeFrom; if (endTimeTo) body.endTimeTo = endTimeTo;
    const json = await apiPost(`/api/upgrade/v2/hl/traders/${address}/completed-trades/by-time`, body);
    if (json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = `completed_trades_by_time 时间窗 [${endTimeFrom || '?'}, ${endTimeTo || '?'}] 内该地址${coinValue ? ` ${coinValue}` : ''} 无已平仓交易。 扩大时间窗 (ms epoch), 或用 completed_trades 不限时间。`;
    }
    return json;
  },
  batch_clearinghouse_state: ({ addresses, dex }) => {
    let addrs = addresses;
    if (typeof addrs === 'string') { try { addrs = JSON.parse(addrs); } catch { addrs = [addrs]; } }
    const body = { addresses: addrs }; if (dex) body.dex = dex;
    return apiPost('/api/upgrade/v2/hl/traders/clearinghouse-state', body);
  },
  batch_spot_clearinghouse_state: ({ addresses }) => {
    let addrs = addresses;
    if (typeof addrs === 'string') { try { addrs = JSON.parse(addrs); } catch { addrs = [addrs]; } }
    return apiPost('/api/upgrade/v2/hl/traders/spot-clearinghouse-state', { addresses: addrs });
  },
  batch_max_drawdown: ({ addresses, days, scope }) => {
    let addrs = addresses;
    if (typeof addrs === 'string') { try { addrs = JSON.parse(addrs); } catch { addrs = [addrs]; } }
    const body = { addresses: addrs }; if (days != null) body.days = days; if (scope) body.scope = scope;
    return apiPost('/api/upgrade/v2/hl/batch-max-drawdown', body);
  },
  batch_net_flow: ({ addresses, days }) => {
    let addrs = addresses;
    if (typeof addrs === 'string') { try { addrs = JSON.parse(addrs); } catch { addrs = [addrs]; } }
    const body = { addresses: addrs }; if (days != null) body.days = days;
    return apiPost('/api/upgrade/v2/hl/ledger-updates/batch-net-flow', body);
  },
});
