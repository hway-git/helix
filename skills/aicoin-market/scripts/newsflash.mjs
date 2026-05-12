#!/usr/bin/env node
// AiCoin Newsflash (OpenData) CLI
import { apiGet, cli } from '../lib/aicoin-api.mjs';

// 标记 is_ad=1 的广告位条目, 避免 agent 把广告当头条 (跟 news.mjs 同款逻辑,
// 但因为这两个文件没共享 lib helper, 这里复制一份)。
function markAds(json) {
  let list = null;
  if (Array.isArray(json?.data)) list = json.data;
  else if (Array.isArray(json?.data?.list)) list = json.data.list;
  if (!Array.isArray(list)) return json;
  const adIndices = [];
  list.forEach((item, i) => {
    if (item?.is_ad === 1 || item?.is_ad === true || item?.isAd === 1 || item?.isAd === true) {
      adIndices.push(i);
    }
  });
  if (adIndices.length > 0) {
    json._note = `本次返回 ${list.length} 条快讯中, 第 ${adIndices.join(',')} 条 (0-indexed) 是 is_ad=1 的广告位, 不是真实新闻。**总结今日头条时跳过这些 index**, 不要把广告当头条引用给用户。`;
    json.ad_indices = adIndices;
  }
  return json;
}

cli({
  search: async ({ keyword, word, page, page_size, size } = {}) => {
    const p = { word: keyword || word };
    if (page) p.page = page;
    const ps = page_size || size;
    if (ps) p.size = ps;
    return markAds(await apiGet('/api/upgrade/v2/content/newsflash/search', p));
  },
  list: async ({ last_id, page_size, pagesize, tab, only_important, language, lan, platform_show, date_mode, jump_to_date, start_date, end_date } = {}) => {
    const p = {};
    if (last_id) p.last_id = last_id;
    const ps = page_size || pagesize;
    if (ps) p.pagesize = ps;
    if (tab) p.tab = tab;
    if (only_important) p.only_important = only_important;
    const lg = language || lan;
    if (lg) p.lan = lg;
    if (platform_show) p.platform_show = platform_show;
    if (date_mode) p.date_mode = date_mode;
    if (jump_to_date) p.jump_to_date = jump_to_date;
    if (start_date) p.start_date = start_date;
    if (end_date) p.end_date = end_date;
    return markAds(await apiGet('/api/upgrade/v2/content/newsflash/list', p));
  },
  detail: ({ flash_id } = {}) => {
    return apiGet('/api/upgrade/v2/content/newsflash/detail', { flash_id });
  },
});
