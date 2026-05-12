#!/usr/bin/env node
// AiCoin Airdrop (OpenData) CLI
import { apiGet, cli } from '../lib/aicoin-api.mjs';

cli({
  // 综合查询：同时查 airdrop(交易所空投) + airdrop banner(高亮交易所活动) + drop_radar(链上早期项目)
  // 实测 (Q6 v2 subagent): 之前 all 只拿了 airdrop/list 跟 drop-radar/list, "交易所空投" count
  // 经常 0, 真正的 OKX X Launch / Binance HODLer 这些都在 banner 里 — 不拿 banner 就漏。
  // 现在 banner 也并入返回。
  // status 参数只会传给 drop-radar (airdrop/list 接口的 status 取值跟 drop-radar 不一致,
  // 静默忽略), 用 _note 警告。
  all: async ({ page_size, status, keyword, lan } = {}) => {
    const ps = page_size || '20';
    const [airdrop, radar, banner] = await Promise.all([
      apiGet('/api/upgrade/v2/content/airdrop/list', { source: 'all', page_size: ps, ...(lan ? { lan } : {}) }).catch(e => ({ error: e.message, list: [] })),
      apiGet('/api/upgrade/v2/content/drop-radar/list', { page_size: ps, ...(status ? { status } : {}), ...(keyword ? { keyword } : {}), ...(lan ? { lan } : {}) }).catch(e => ({ error: e.message, list: [] })),
      apiGet('/api/upgrade/v2/content/airdrop/banner', { ...(lan ? { lan } : {}) }).catch(e => ({ error: e.message, list: [] })),
    ]);
    const result = {
      交易所空投: { count: airdrop.data?.count || 0, list: airdrop.data?.list || [] },
      交易所高亮活动: { count: banner.data?.count || banner.data?.list?.length || 0, list: banner.data?.list || [] },
      链上早期项目: { count: radar.data?.count || 0, list: radar.data?.list || [] },
    };
    if (status) {
      result._note = `status="${status}" 只过滤了"链上早期项目" (drop-radar/list)。"交易所空投" / "交易所高亮活动" 不支持同名 status 参数 — airdrop 用的是 activity_type (用 \`airdrop.mjs list\` 单独指定), 不要以为 all 的 status 对所有部分都生效。`;
    }
    if (result.交易所空投.count === 0 && result.交易所高亮活动.count > 0) {
      result._tip = `交易所空投 list 为空但 banner 有 ${result.交易所高亮活动.count} 条活动。OKX X Launch / Binance HODLer 等热门活动都常驻在 banner 里, list 是已结束/低优先的归档。给用户推荐时优先看 banner。`;
    }
    return result;
  },
  list: ({ source, status, page, page_size, exchange, activity_type, lan } = {}) => {
    const p = {};
    if (source) p.source = source;
    if (status) p.status = status;
    if (page) p.page = page;
    if (page_size) p.page_size = page_size;
    if (exchange) p.exchange = exchange;
    if (activity_type) p.activity_type = activity_type;
    if (lan) p.lan = lan;
    return apiGet('/api/upgrade/v2/content/airdrop/list', p);
  },
  detail: async ({ type, token, lan } = {}) => {
    if (!type || !token) {
      return {
        success: false,
        errorCode: 400,
        error: 'airdrop detail 必填 type + token (从 list 返回项里拿)',
      };
    }
    const p = { type, token };
    if (lan) p.lan = lan;
    try {
      return await apiGet('/api/upgrade/v2/content/airdrop/detail', p);
    } catch (e) {
      // 实测: 三种 type+token 组合 (xlaunch+airdropId / launchpad+BTC / airdrop+BTC) 都返 500
      // "Failed to get airdrop detail"。给 agent 明确提示这是上游故障,别让用户改参数。
      if (/^API 5\d\d/.test(e.message)) {
        return {
          success: false,
          errorCode: 500,
          error: e.message,
          实测结论: 'airdrop detail 当前后端不稳: 多种参数组合实测都返 500。请告知用户"该详情接口暂时不可用,可改用 list/banner/calendar 看简要信息,或联系 AiCoin 客服 (service@aicoin.com) 报修"。',
        };
      }
      throw e;
    }
  },
  banner: ({ limit, lan } = {}) => {
    const p = {};
    if (limit) p.limit = limit;
    if (lan) p.lan = lan;
    return apiGet('/api/upgrade/v2/content/airdrop/banner', p);
  },
  exchanges: ({ lan } = {}) => {
    const p = {};
    if (lan) p.lan = lan;
    return apiGet('/api/upgrade/v2/content/airdrop/exchanges', p);
  },
  calendar: ({ year, month, lan } = {}) => {
    // 实测: year+month 必填,不传上游 400。默认填当前月,免去 agent 算月份。
    const now = new Date();
    const y = year || String(now.getFullYear());
    const m = month || String(now.getMonth() + 1);
    const p = { year: y, month: m };
    if (lan) p.lan = lan;
    return apiGet('/api/upgrade/v2/content/airdrop/calendar', p);
  },
});
