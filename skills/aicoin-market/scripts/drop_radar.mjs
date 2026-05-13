#!/usr/bin/env node
// AiCoin Drop Radar (OpenData) CLI
import { apiGet, cli } from '../lib/aicoin-api.mjs';

// drop_radar 的 itemName / name / oName / entityName / pTitle / siteName 等字段是
// stringified JSON {"tw_value":...,"en_value":...,"cn_value":...,"ja_value":...,"vn_value":...,"ko_value":...}
// 6 国语言. agent 拿到字符串当显示就直接漏底 (用户看到一坨 JSON)。
// 2026-05-13 P0 #3 dogfood: SDK 自动 parse 一层, 默认拍平到中文 (cn_value),
// 原 stringified 保留到 _i18n_<key> 字段方便 agent 取其他语言。
function parseI18nFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(parseI18nFields);
  const out = { ...obj };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (typeof v === 'string' && v.length > 8 && v.startsWith('{') && v.includes('cn_value')) {
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object' && 'cn_value' in parsed) {
          out[key] = parsed.cn_value || parsed.en_value || v;
          out[`_i18n_${key}`] = parsed;
          continue;
        }
      } catch {}
    }
    if (v && typeof v === 'object') {
      out[key] = parseI18nFields(v);
    }
  }
  return out;
}

cli({
  // 2026-05-13 P1 #4 dogfood 复测: 整个 list 端点对**任何** sort_by 都 500,
  // 不只 sort_by="hot" (此前 wrapper 只 catch hot 是不全的)。改成任何 sort_by 都给同样提示。
  list: async ({ page, page_size, status, activity_type, reward_type, min_total_raise, max_total_raise, created_at, keyword, board_keys, eco_keys, sort_by, sort_order, lan } = {}) => {
    const p = {};
    if (page) p.page = page;
    if (page_size) p.page_size = page_size;
    if (status) p.status = status;
    if (activity_type) p.activity_type = activity_type;
    if (reward_type) p.reward_type = reward_type;
    if (min_total_raise) p.min_total_raise = min_total_raise;
    if (max_total_raise) p.max_total_raise = max_total_raise;
    if (created_at) p.created_at = created_at;
    if (keyword) p.keyword = keyword;
    if (board_keys) p.board_keys = board_keys;
    if (eco_keys) p.eco_keys = eco_keys;
    if (sort_by) p.sort_by = sort_by;
    if (sort_order) p.sort_order = sort_order;
    if (lan) p.lan = lan;
    try {
      return parseI18nFields(await apiGet('/api/upgrade/v2/content/drop-radar/list', p));
    } catch (e) {
      // 实测: 传任何 sort_by 都触发 500 (不只 "hot"). 不传 sort_by 默认排序正常。
      if (sort_by && /^API 5\d\d/.test(e.message || '')) {
        return {
          success: false,
          errorCode: 500,
          error: e.message,
          实测结论: `drop_radar.list 传 sort_by="${sort_by}" 后端返 500 (2026-05-13 dogfood 复测: 任何 sort_by 值都触发, 不只 "hot")。**不要重试**, 也不要当成参数错。`,
          替代方案: '不传 sort_by 走默认排序 (默认按热度/活跃度排), 已能拿到 1060+ 条数据。如确需特定排序请联系 AiCoin 客服 service@aicoin.com 报修。',
        };
      }
      throw e;
    }
  },
  detail: async ({ airdrop_id, lan } = {}) => {
    if (!airdrop_id) return { error: 'airdrop_id is required. Use "list" action first to find valid IDs.' };
    const p = { airdrop_id };
    if (lan) p.lan = lan;
    const [detail, team, xFollowing] = await Promise.all([
      apiGet('/api/upgrade/v2/content/drop-radar/detail', p).catch(e => ({ error: e.message })),
      apiGet('/api/upgrade/v2/content/drop-radar/team', { airdrop_id }).catch(e => ({ error: e.message })),
      apiGet('/api/upgrade/v2/content/drop-radar/x-following', { airdrop_id }).catch(e => ({ error: e.message })),
    ]);
    if (detail.error) {
      // 实测: 当前 key 档位不够时上游会返 HTTP 403 (而不是 304 业务错误)。
      // 不要把这类失败统一归因为 "airdrop_id 无效", 否则 agent 会让用户改参数。
      const isPaywall = /API 403|forbidden|paid|付费/i.test(detail.error);
      if (isPaywall) {
        return {
          success: false,
          errorCode: 403,
          error: detail.error,
          实测结论: 'drop_radar.detail 端点需要更高档 AiCoin 套餐。当前 key 拿不到该数据。请告知用户"项目详情需要 AiCoin 标准版以上, 当前账号档位不够; 可改用 list (项目列表已含基础信息)"。**不要让用户改 airdrop_id**, 这不是参数问题。',
        };
      }
      return { error: `Project not found or invalid airdrop_id "${airdrop_id}". Use "list" to browse available projects.`, detail: detail.error };
    }
    return parseI18nFields({ ...detail, team: team.data || team, x_following: xFollowing.data || xFollowing });
  },
  widgets: async ({ lan } = {}) => {
    const p = {};
    if (lan) p.lan = lan;
    return parseI18nFields(await apiGet('/api/upgrade/v2/content/drop-radar/widgets', p));
  },
  filters: async ({ lan } = {}) => {
    const p = {};
    if (lan) p.lan = lan;
    return parseI18nFields(await apiGet('/api/upgrade/v2/content/drop-radar/filters', p));
  },
  // 2026-05-13 P0 #3: events / x_following / team 返的 itemName / name / oName 等字段是
  // stringified i18n JSON, SDK 自动 parse 一层, agent 不用再 JSON.parse。
  // 2026-05-13 dogfood v6 P1 #15: 三个端点都必填 airdrop_id, 不传时上游直接 500,
  // agent 误以为后端故障。本地预检, 引导用 list 拿 airdrop_id。
  events: async ({ airdrop_id } = {}) => {
    if (!airdrop_id) {
      return { success: false, errorCode: 400, error: 'events 必填 airdrop_id', _note: 'airdrop_id 来源: drop_radar.list 返回项里的 airdropId 字段。不传上游会返 500, 看起来像接口故障实际是参数错。' };
    }
    return parseI18nFields(await apiGet('/api/upgrade/v2/content/drop-radar/events', { airdrop_id }));
  },
  team: async ({ airdrop_id } = {}) => {
    if (!airdrop_id) {
      return { success: false, errorCode: 400, error: 'team 必填 airdrop_id', _note: 'airdrop_id 来源: drop_radar.list 返回项里的 airdropId 字段。不传上游会返 500, 看起来像接口故障实际是参数错。' };
    }
    return parseI18nFields(await apiGet('/api/upgrade/v2/content/drop-radar/team', { airdrop_id }));
  },
  x_following: async ({ airdrop_id } = {}) => {
    if (!airdrop_id) {
      return { success: false, errorCode: 400, error: 'x_following 必填 airdrop_id', _note: 'airdrop_id 来源: drop_radar.list 返回项里的 airdropId 字段。不传上游会返 500, 看起来像接口故障实际是参数错。' };
    }
    return parseI18nFields(await apiGet('/api/upgrade/v2/content/drop-radar/x-following', { airdrop_id }));
  },
  status_changes: async ({ days, page, page_size, lan } = {}) => {
    const p = {};
    if (days) p.days = days;
    if (page) p.page = page;
    if (page_size) p.page_size = page_size;
    if (lan) p.lan = lan;
    return parseI18nFields(await apiGet('/api/upgrade/v2/content/drop-radar/status-changes', p));
  },
  tweets: async ({ keywords, page_size, last_id, lan } = {}) => {
    // 实测: 不传 keywords 上游会 502 (而不是 400),让 agent 误判为接口故障。
    // 默认填 "airdrop" 拿一份通用推文列表,agent 后续可自定义。
    const p = { keywords: keywords || 'airdrop' };
    if (page_size) p.page_size = page_size;
    if (last_id) p.last_id = last_id;
    if (lan) p.lan = lan;
    return parseI18nFields(await apiGet('/api/upgrade/v2/content/drop-radar/tweets', p));
  },
});
