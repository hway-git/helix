#!/usr/bin/env node
// AiCoin News & Flash CLI
import { apiGet, apiGetText, cli } from '../lib/aicoin-api.mjs';

function exchangeListingImpl({ language, memberIds, page_size, pageSize } = {}) {
  const p = {};
  if (language) p.language = language;
  if (memberIds) p.memberIds = memberIds;
  const ps = page_size || pageSize;
  if (ps) p.pageSize = ps;
  return apiGet('/api/v2/content/exchange-listing-flash', p);
}

// 实测: AiCoin 快讯/资讯接口里掺杂 is_ad=1 的广告位条目 (比如 "言语社区直播"
// 这类商品推广), 跟普通快讯外观一模一样, agent 一不留神会把广告当头条选进来
// 总结回答。这里检测 is_ad=1 的条目, 不剥离 (保留原数据) 但加 _note 让 agent
// 明确知道哪些是广告。
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
    json._note = `本次返回 ${list.length} 条快讯中, 第 ${adIndices.join(',')} 条 (0-indexed) 是 is_ad=1 的广告位 (常见: "言语社区直播" 等推广), 不是真实新闻。**总结今日头条时跳过这些 index**, 不要把广告当头条引用给用户。`;
    json.ad_indices = adIndices;
  }
  return json;
}

cli({
  news_list: async ({ page, page_size, pageSize = '20' } = {}) => {
    const p = { pageSize: page_size || pageSize };
    if (page) p.page = page;
    return markAds(await apiGet('/api/v2/content/news-list', p));
  },
  news_detail: ({ id }) => apiGet('/api/v2/content/news-detail', { id }),
  // 该端点返 RSS XML 不是 JSON, 必须用 apiGetText 拿原文。
  // 返回 { contentType: "application/xml...", body: "<?xml..." }。
  // agent 拿到后自己解析 XML 或转告用户原文 (不要试图 JSON.parse)。
  news_rss: ({ page, page_size, pageSize = '20' } = {}) => {
    const p = { pageSize: page_size || pageSize };
    if (page) p.page = page;
    return apiGetText('/api/v2/content/square/market/news-list', p);
  },
  newsflash: async ({ language } = {}) => {
    const p = {};
    if (language) p.language = language;
    return markAds(await apiGet('/api/v2/content/newsflash', p));
  },
  flash_list: async ({ language, createtime } = {}) => {
    const p = {};
    if (language) p.language = language;
    if (createtime) p.createtime = createtime;
    return markAds(await apiGet('/api/v2/content/flashList', p));
  },
  exchange_listing: exchangeListingImpl,
  // alias: SKILL.md 早期用 exchange_listing_flash, 实际 action 是 exchange_listing
  exchange_listing_flash: exchangeListingImpl,
});
