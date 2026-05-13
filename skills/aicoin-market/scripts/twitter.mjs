#!/usr/bin/env node
// AiCoin Twitter/X CLI
import { apiGet, apiPost, cli } from '../lib/aicoin-api.mjs';

cli({
  latest: ({ language, last_time, page_size } = {}) => {
    const p = {};
    if (language) p.language = language;
    if (last_time) p.last_time = last_time;
    if (page_size) p.page_size = page_size;
    return apiGet('/api/upgrade/v2/content/twitter/latest', p);
  },
  search: ({ keyword, language, last_time, page_size } = {}) => {
    const p = { keyword };
    if (language) p.language = language;
    if (last_time) p.last_time = last_time;
    if (page_size) p.page_size = page_size;
    return apiGet('/api/upgrade/v2/content/twitter/search', p);
  },
  // 2026-05-13 dogfood v6 P1 #20: 不传 keyword/word 时上游静默返空 list (lastId=1),
  // agent 看到空数据困惑。本地预检 + _note 引导。
  members: async ({ keyword, word, type, page, page_size, size } = {}) => {
    const _kw = keyword || word;
    if (!_kw) {
      return {
        success: false, errorCode: 400,
        error: 'members 必填 keyword (也接受 word 别名)',
        _note: 'twitter.members 是按关键字搜推特 KOL/账号。例: keyword="vitalik" 查 Vitalik / keyword="cz" 查 CZ。**不传时上游静默返空, 不是接口故障**。想看最新推文用 latest, 想搜内容用 search。',
      };
    }
    const p = { word: _kw };
    if (type) p.type = type;
    if (page) p.page = page;
    const ps = page_size || size;
    if (ps) p.size = ps;
    const json = await apiGet('/api/upgrade/v2/content/twitter/members', p);
    const list = json?.data?.list;
    if (Array.isArray(list) && list.length === 0) {
      json._note = `twitter.members keyword="${_kw}" 返空。可能该关键字没匹配的 KOL / 账号, 换更通用的关键字试试 (例 "btc" / "eth" / 项目名)。`;
    }
    return json;
  },
  // 2026-05-13 P1 #3 dogfood: 加空数据 _note + 必填校验, 不让 agent 拿空当 "无数据" 误判
  interaction_stats: async ({ flash_ids } = {}) => {
    if (!flash_ids) {
      return {
        success: false, errorCode: 400,
        error: 'flash_ids 必填 (CSV 字符串, 例 "12345,67890")',
        _note: 'flash_ids 来源: news.flash_list / newsflash.list 返回项里的 id 字段。',
      };
    }
    const ids = typeof flash_ids === 'string'
      ? flash_ids.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n))
      : flash_ids;
    const json = await apiPost('/api/upgrade/v2/content/twitter/interaction-stats', { flash_ids: ids });
    const list = Array.isArray(json?.data) ? json.data : (json?.data?.list);
    if (Array.isArray(list) && list.length === 0) {
      json._note = `interaction_stats 对 flash_ids "${ids.slice(0, 5).join(',')}${ids.length > 5 ? '...' : ''}" 返空 list。常见原因: (1) flash_ids 都不存在 (拿当前 id 用 news.flash_list) (2) 这批快讯还没产生推特互动数据 (新闻发布后通常几小时内才有推特反应)。**不是接口故障**。`;
    }
    return json;
  },
});
