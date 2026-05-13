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

// 2026-05-13 P0 #4 dogfood: batch_pnls / batch_addr_stat / batch_max_drawdown / batch_net_flow
// / completed_trades_by_time 全 400 "请求体无效", 根因是上游期望 period/days/pageSize 是
// 数字类型, agent 传字符串 "7" / "30" 就 400。SDK 这边接受任意类型, 内部转 Number。
function toNum(v) {
  if (v == null) return v;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

// 2026-05-13 P0 #5 dogfood: 时间字段 alias — hl-trader 内部叫 period/days, 但 agent
// 跨 script 切换易混淆 (hl-market 用 interval, coin 用 cycle/interval)。
// pickPeriod / pickDays 接受 interval / cycle / period / days 互相 alias。
// 2026-05-13 dogfood v6: HL 后端 stats/排行/batch 接口 period 只认纯数字 (天数),
// agent 传 "7d" / "1d" / "30day" 等自然名 → 400 "查询参数无效"。SDK 自动剥后缀。
function normalizePeriod(v) {
  if (v == null) return v;
  const s = String(v).trim().toLowerCase();
  // "7d" / "1d" / "30day" / "7days" → "7" / "1" / "30" / "7"
  const m = s.match(/^(\d+)\s*(d|day|days)?$/);
  if (m) return m[1];
  return v; // 不是常见格式留给上游报错
}
function pickPeriod(args, defaultValue) {
  return normalizePeriod(args.period ?? args.interval ?? args.cycle ?? args.timeframe ?? defaultValue);
}
function pickDays(args, defaultValue) {
  return normalizePeriod(args.days ?? args.day ?? args.period ?? args.interval ?? defaultValue);
}

// 2026-05-13 dogfood v6 P0 #3: batch_* 接口接受 addresses 参数,
// agent 容易传 CSV 字符串 (跟其他接口对齐). 原 fallback 把整个 CSV
// 当一个 address, 上游静默返空或拼接错乱。统一 split.
function normalizeAddresses(addrs) {
  if (Array.isArray(addrs)) return addrs;
  if (typeof addrs !== 'string') return addrs;
  const trimmed = addrs.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr : [arr];
    } catch { /* fallthrough */ }
  }
  if (trimmed.includes(',')) {
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return trimmed ? [trimmed] : [];
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

// hl-trader 高级查询 (smart_find / discover / discover_history) 是标准版以上才有的
// endpoint, 当前 key 拿不到。 2026-05-13 dogfood: 之前直接 raw apiPost, agent
// 拿到的就是 raw 403 没引导。这里包一层, 业务码 / HTTP 4xx 都附加替代方案。
// HL 上游 paywall 用 {code:"403", msg:"..."} 格式 (不是 success:false), 两种都要识别。
async function hlAdvancedPaywall(path, params, name, fallback) {
  try {
    const json = await apiPost(path, params || {});
    const isPaywall = json && (
      (json.success === false && (json.errorCode === 403 || json.errorCode === 304))
      || json.code === '403' || json.code === '304'
    );
    if (isPaywall) {
      json.替代方案 = fallback;
      json.实测结论 = `${name} 是 hl-trader 付费档功能 (标准版以上), 当前 key 不支持。**不要重试, 不要让用户改参数**。`;
    }
    return json;
  } catch (e) {
    if (/^API 40[34]/.test(e.message || '')) {
      return {
        success: false,
        errorCode: 403,
        error: e.message,
        替代方案: fallback,
        实测结论: `${name} 是 hl-trader 付费档功能 (标准版以上), 当前 key 不支持。**不要重试, 不要让用户改参数**。`,
      };
    }
    throw e;
  }
}

cli({
  // hl_trader — period 实测必填且没默认, 不传 400。这里给 "30" (30 天) 兜底。
  // P0 #5 alias: 接受 interval / cycle / timeframe 当 period alias。
  trader_stats: (args = {}) => {
    const { address } = args;
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = { period: pickPeriod(args, '30') };
    return apiGet(`/api/upgrade/v2/hl/traders/${address}/addr-stat`, p);
  },
  best_trades: (args = {}) => {
    const { address, limit } = args;
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = { period: pickPeriod(args, '30') }; if (limit) p.limit = limit;
    return apiGet(`/api/upgrade/v2/hl/traders/${address}/best-trades`, p);
  },
  performance: (args = {}) => {
    const { address, limit } = args;
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = { period: pickPeriod(args, '30') }; if (limit) p.limit = limit;
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
    addrs = normalizeAddresses(addrs);
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
  // P1 #22 dogfood v6: 跟 accounts 一样要 addresses 数组, 不传时上游 400 "请求体无效"。
  // 本地预检 + 接受 CSV/JSON 别名。
  statistics: ({ addresses, address }) => {
    const addrs = normalizeAddresses(addresses || address);
    if (!Array.isArray(addrs) || addrs.length === 0) {
      return Promise.resolve({
        success: false, errorCode: 400,
        error: 'statistics 必填 addresses (HL 钱包地址数组或 CSV string)',
        _note: '例: {"addresses":["0x...","0x..."]} 或 {"addresses":"0x...,0x..."}。先用 smart_find 拿聪明钱列表, 或让用户提供。不传时上游返 400 "请求体无效"。',
      });
    }
    return apiPost('/api/upgrade/v2/hl/traders/statistics', { addresses: addrs });
  },
  // hl_fills — P1 #3: 空数据 _note 引导
  fills: async ({ address, coin, limit } = {}) => {
    const err = requireAddress(address); if (err) return err;
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    const json = await apiGet(`/api/upgrade/v2/hl/fills/${address}`, p);
    if (json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = `fills 该地址${coin ? ` ${coin}` : ''} 近期无成交。可能: (1) 地址不活跃 (用 statistics / accounts 看是否有任何 HL 历史) (2) 该 coin 无成交但其他 coin 有 (不传 coin 看全部)。**不是接口故障**。`;
    }
    return json;
  },
  // P0 #5 dogfood v6: 4 个 by_oid 接口缺参时上游返 "invalid oid", agent 困惑。
  // 本地预检 + _note 引导 oid 来源。
  fills_by_oid: ({ oid }) => {
    if (oid == null || oid === '') {
      return Promise.resolve({ success: false, errorCode: 400, error: 'fills_by_oid 必填 oid (订单 ID, 数字)', _note: 'oid 来源: fills / orders_latest / filled_orders 返回项里的 oid 字段。' });
    }
    return apiGet(`/api/upgrade/v2/hl/fills/oid/${oid}`);
  },
  fills_by_twapid: ({ twapid }) => {
    if (twapid == null || twapid === '') {
      return Promise.resolve({ success: false, errorCode: 400, error: 'fills_by_twapid 必填 twapid (TWAP 任务 ID, 数字)', _note: 'twapid 来源: twap_states 返回项里的 twapId 字段。' });
    }
    return apiGet(`/api/upgrade/v2/hl/fills/twapid/${twapid}`);
  },
  top_trades: ({ coin, interval, period, cycle, limit } = {}) => {
    // 实测: interval 必填, 默认 1h. P0 #5 alias: 接受 period/cycle.
    const _interval = interval || period || cycle || '1h';
    const p = { coin, interval: _interval }; if (limit) p.limit = limit;
    return apiGet('/api/upgrade/v2/hl/fills/top-trades', p);
  },
  // hl_orders — P1 #3: 空数据 _note 引导
  orders_latest: async ({ address, coin, limit } = {}) => {
    const err = requireAddress(address); if (err) return err;
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    const json = await apiGet(`/api/upgrade/v2/hl/orders/${address}/latest`, p);
    if (json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = `orders_latest 该地址${coin ? ` ${coin}` : ''} 当前无活跃挂单。常态 — 大部分地址不持续挂限价单。想看历史成交用 fills / filled_orders, 想看活跃账户状态用 statistics。**不是接口故障**。`;
    }
    return json;
  },
  order_by_oid: ({ oid }) => {
    if (oid == null || oid === '') {
      return Promise.resolve({ success: false, errorCode: 400, error: 'order_by_oid 必填 oid (订单 ID, 数字)', _note: 'oid 来源: orders_latest / filled_orders 返回项里的 oid 字段。' });
    }
    return apiGet(`/api/upgrade/v2/hl/orders/oid/${oid}`);
  },
  filled_orders: ({ address, coin, limit } = {}) => {
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    return apiGet(`/api/upgrade/v2/hl/filled-orders/${address}/latest`, p);
  },
  filled_by_oid: ({ oid }) => {
    if (oid == null || oid === '') {
      return Promise.resolve({ success: false, errorCode: 400, error: 'filled_by_oid 必填 oid (订单 ID, 数字)', _note: 'oid 来源: filled_orders 返回项里的 oid 字段。' });
    }
    return apiGet(`/api/upgrade/v2/hl/filled-orders/oid/${oid}`);
  },
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
  // P0 #5 alias: 接受 period / interval / cycle / timeframe 互相 alias
  pnls: (args = {}) => {
    const { address } = args;
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    const p = { period: pickPeriod(args, '30') };
    return apiGet(`/api/upgrade/v2/hl/pnls/${address}`, p);
  },
  // max_drawdown / net_flow — days 实测必填, 默认 30. P0 #5: 接受 interval/period alias.
  max_drawdown: (args = {}) => {
    const { address, scope = 'perp' } = args;
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    return apiGet(`/api/upgrade/v2/hl/max-drawdown/${address}`, { days: pickDays(args, '30'), scope });
  },
  net_flow: (args = {}) => {
    const { address } = args;
    const err = requireAddress(address); if (err) return Promise.resolve(err);
    return apiGet(`/api/upgrade/v2/hl/ledger-updates/net-flow/${address}`, { days: pickDays(args, '30') });
  },
  // hl_advanced
  // 2026-05-13 dogfood: info 当前是 raw apiPost, 传错 type ("userState") 后端 400 没列枚举。
  // 加合法 type 列表 + 别名修正 + 错误时引导。
  // P0 #4 dogfood v6: hl-trader 其他接口都用 address, 唯独 info 用 user (HL 后端字段名)。
  // 接受 address 当 user 别名, 跟同模块对齐。
  info: async ({ type, user, address, extra_params } = {}) => {
    const _user = user || address;
    const COMMON_TYPES = [
      'clearinghouseState', 'spotClearinghouseState', 'portfolio',
      'meta', 'spotMeta', 'allMids', 'l2Book', 'candleSnapshot',
      'fundingHistory', 'predictedFundings',
      'userFees', 'userFunding', 'userNonFundingLedgerUpdates',
      'subAccounts', 'vaultDetails', 'twapHistory', 'referral',
    ];
    // 用户常传错的 type 名,自动纠正避免 silent 400
    const ALIASES = {
      userState: 'clearinghouseState',
      spotState: 'spotClearinghouseState',
      accountState: 'clearinghouseState',
    };
    if (!type) {
      return {
        success: false, errorCode: 400,
        error: 'info 必填 type 参数。',
        常用_type: COMMON_TYPES,
        _note: 'info 是 HL /info 原生 passthrough。常用: clearinghouseState (账户状态/持仓), spotClearinghouseState (现货账户), meta (永续 universe meta), allMids (全币现价), candleSnapshot (K 线 snapshot)。完整 type 见 HL 官方 docs https://hyperliquid.gitbook.io/。',
      };
    }
    const resolvedType = ALIASES[type] || type;
    const aliasUsed = resolvedType !== type;
    const body = { type: resolvedType };
    if (_user) body.user = _user;
    if (extra_params) {
      try { Object.assign(body, typeof extra_params === 'string' ? JSON.parse(extra_params) : extra_params); } catch {}
    }
    try {
      const json = await apiPost('/api/upgrade/v2/hl/info', body);
      // HL 上游对未知 type 返 HTTP 200 + body {code:"400", msg:"未知的type类型..."},
      // 不走 throw 分支。这里也要识别。
      const code = String(json?.code ?? '');
      const msg = String(json?.msg ?? '');
      if ((code === '400' || /未知的type/i.test(msg))) {
        return {
          success: false, errorCode: 400,
          error: msg || `info type "${type}" 后端不认`,
          常用_type: COMMON_TYPES,
          _note: `info type "${type}" 后端不认。常用 type 见上, 完整列表见 https://hyperliquid.gitbook.io/。注意 "userState" 已弃用, 现在叫 "clearinghouseState"。**这是 type 名问题, 不是付费问题**。`,
          _raw: json,
        };
      }
      if (aliasUsed) {
        json._note = `type "${type}" 已自动纠正为 "${resolvedType}" (HL 官方接口名)。下次直接传纠正后的名字省一步。`;
      }
      return json;
    } catch (e) {
      // 上游 HTTP 400 throw 分支
      if (/^API 400|未知的type/.test(e.message || '')) {
        return {
          success: false, errorCode: 400,
          error: e.message,
          常用_type: COMMON_TYPES,
          _note: `info type "${type}" 后端不认。常用 type 见上, 完整列表见 https://hyperliquid.gitbook.io/。注意 "userState" 已弃用, 现在叫 "clearinghouseState"。**这是 type 名问题, 不是付费问题**。`,
        };
      }
      throw e;
    }
  },
  smart_find: (params) => hlAdvancedPaywall('/api/upgrade/v2/hl/smart/find', params, 'smart_find',
    '想找鲸鱼/大户头寸: 改用 hl-market.mjs 的 whale_positions (按持仓量排序看头部地址) 或 whale_events (按时间窗看大额事件)。'),
  discover: (params) => hlAdvancedPaywall('/api/upgrade/v2/hl/traders/discover', params, 'discover',
    '想找优秀交易员: 免费档可改用 hl-market.mjs 的 tickers + whale_positions 自己筛, 或升级标准版后再用 discover。'),
  discover_history: (params) => hlAdvancedPaywall('/api/upgrade/v2/hl/traders/discover-history', params, 'discover_history',
    '历史发现接口同 discover, 当前 key 不支持。免费档无对应平替, 改用 whale_events 看大额事件时间线。'),
  // batch endpoints
  fills_by_builder: ({ builder, coin, limit, minVal } = {}) => {
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit; if (minVal) p.minVal = minVal;
    return apiGet(`/api/upgrade/v2/hl/fills/builder/${builder}/latest`, p);
  },
  // 2026-05-13 P0 #4 dogfood: batch_* + completed_trades_by_time 全 400 "请求体无效",
  // 根因是上游期望 period/days/pageNum/pageSize 是**数字**类型, agent 传字符串 "7" 就 400。
  // toNum 把字符串自动转 Number, agent 任传都通。
  batch_pnls: (args = {}) => {
    const { addresses, scope } = args;
    let addrs = addresses;
    addrs = normalizeAddresses(addrs);
    const body = { addresses: addrs };
    const period = pickPeriod(args);
    if (period != null) body.period = toNum(period);
    if (scope) body.scope = scope;
    return apiPost('/api/upgrade/v2/hl/batch-pnls', body);
  },
  batch_addr_stat: (args = {}) => {
    const { addresses } = args;
    let addrs = addresses;
    addrs = normalizeAddresses(addrs);
    const body = { addresses: addrs };
    const period = pickPeriod(args);
    if (period != null) body.period = toNum(period);
    return apiPost('/api/upgrade/v2/hl/traders/batch-addr-stat', body);
  },
  // 注意: 上游 body 字段是大写 Coin (不是 coin)。 agent 容易传小写, 静默拿到全币种杂烩。
  // 这里兼容两种大小写, 不让 silent wrong 发生。
  // P0 #4: pageNum / pageSize / endTimeFrom / endTimeTo 都要数字。
  completed_trades_by_time: async ({ address, pageNum, pageSize, Coin, coin, endTimeFrom, endTimeTo } = {}) => {
    const err = requireAddress(address); if (err) return err;
    const body = {};
    if (pageNum != null) body.pageNum = toNum(pageNum);
    if (pageSize != null) body.pageSize = toNum(pageSize);
    const coinValue = Coin || coin;
    if (coinValue) body.Coin = coinValue;
    if (endTimeFrom != null) body.endTimeFrom = toNum(endTimeFrom);
    if (endTimeTo != null) body.endTimeTo = toNum(endTimeTo);
    const json = await apiPost(`/api/upgrade/v2/hl/traders/${address}/completed-trades/by-time`, body);
    if (json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = `completed_trades_by_time 时间窗 [${endTimeFrom || '?'}, ${endTimeTo || '?'}] 内该地址${coinValue ? ` ${coinValue}` : ''} 无已平仓交易。 扩大时间窗 (ms epoch), 或用 completed_trades 不限时间。`;
    }
    return json;
  },
  batch_clearinghouse_state: ({ addresses, dex }) => {
    let addrs = addresses;
    addrs = normalizeAddresses(addrs);
    const body = { addresses: addrs }; if (dex) body.dex = dex;
    return apiPost('/api/upgrade/v2/hl/traders/clearinghouse-state', body);
  },
  batch_spot_clearinghouse_state: ({ addresses }) => {
    let addrs = addresses;
    addrs = normalizeAddresses(addrs);
    return apiPost('/api/upgrade/v2/hl/traders/spot-clearinghouse-state', { addresses: addrs });
  },
  batch_max_drawdown: (args = {}) => {
    const { addresses, scope } = args;
    let addrs = addresses;
    addrs = normalizeAddresses(addrs);
    const body = { addresses: addrs };
    const days = pickDays(args);
    if (days != null) body.days = toNum(days);
    if (scope) body.scope = scope;
    return apiPost('/api/upgrade/v2/hl/batch-max-drawdown', body);
  },
  batch_net_flow: (args = {}) => {
    const { addresses } = args;
    let addrs = addresses;
    addrs = normalizeAddresses(addrs);
    const body = { addresses: addrs };
    const days = pickDays(args);
    if (days != null) body.days = toNum(days);
    return apiPost('/api/upgrade/v2/hl/ledger-updates/batch-net-flow', body);
  },
});
