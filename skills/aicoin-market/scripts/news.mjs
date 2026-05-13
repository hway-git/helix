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

// 2026-05-13 P1 #5 dogfood: 之前的 markAds 只看 is_ad / isAd 字段, 但 flash_list
// 实际广告标识是 flashType 非 0 (27 是常见广告值, 0 才是普通新闻)。补充检测。
// 实测: AiCoin 快讯/资讯接口里掺杂广告位条目 (比如 "言语社区直播" 这类商品推广),
// 跟普通快讯外观一模一样, agent 一不留神会把广告当头条选进来总结回答。
function markAds(json) {
  let list = null;
  if (Array.isArray(json?.data)) list = json.data;
  else if (Array.isArray(json?.data?.list)) list = json.data.list;
  if (!Array.isArray(list)) return json;
  const adIndices = [];
  list.forEach((item, i) => {
    const isAdFlag = item?.is_ad === 1 || item?.is_ad === true || item?.isAd === 1 || item?.isAd === true;
    const isAdFlashType = typeof item?.flashType === 'number' && item.flashType !== 0;
    if (isAdFlag || isAdFlashType) {
      adIndices.push(i);
    }
  });
  if (adIndices.length > 0) {
    json._note = `本次返回 ${list.length} 条快讯中, 第 ${adIndices.join(',')} 条 (0-indexed) 是广告位 (is_ad=1 或 flashType≠0, 常见 flashType=27 是付费推广), 不是真实新闻。**总结今日头条时跳过这些 index**, 不要把广告当头条引用给用户。`;
    json.ad_indices = adIndices;
  }
  return json;
}

// RSS XML 简易解析: 提取 <item> 块的 title / link / description / pubDate / author 字段,
// 处理 CDATA 包裹。2026-05-13 P1 #6 dogfood: 之前 news_rss 返 raw XML 字符串, agent
// 拿到要自己 regex 解析, 容易漏字段。SDK 主动 parse 一层。
function decodeXmlEntities(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // 最后, 避免双重解码
}
function stripCdata(s) {
  if (s == null) return s;
  // entity-decoded 再 strip CDATA, 因为 description 字段常常是被 entity-escape 过的
  const decoded = decodeXmlEntities(s);
  return decoded.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}
function parseRSS(xml) {
  if (typeof xml !== 'string' || !xml.includes('<item')) return [];
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const getField = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? stripCdata(m[1]) : undefined;
  };
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title: getField(block, 'title'),
      link: getField(block, 'link'),
      description: getField(block, 'description'),
      pubDate: getField(block, 'pubDate'),
      author: getField(block, 'author'),
    });
  }
  return items;
}

// 2026-05-13 dogfood v6 P1 #18: AiCoin 后端在 content 里注入 ((xxx)) 双括号
// 当**关键词高亮标记** (常见: 交易所名 / 品牌词), 不是 markdown 链接也不是错误格式。
// 加 _field_doc 解释 + 每条命中项补 _content_clean (剥掉双括号的纯文本)。
function annotateDoubleParens(json) {
  let list = null;
  if (Array.isArray(json?.data)) list = json.data;
  else if (Array.isArray(json?.data?.list)) list = json.data.list;
  if (!Array.isArray(list)) return json;
  let hits = 0;
  for (const item of list) {
    if (item && typeof item.content === 'string' && /\(\([^)]+\)\)/.test(item.content)) {
      hits++;
      item._content_clean = item.content.replace(/\(\(([^)]+)\)\)/g, '$1');
    }
  }
  if (hits > 0) {
    json._field_doc = `content 字段里的 \`((xxx))\` 是 AiCoin 后端注入的**关键词高亮标记** (常见: 交易所名 Gate.io / Binance / Bybit / OKX / 品牌词等), **不是 markdown 链接也不是错误格式**。展示给用户前剥掉双括号即可: \`content.replace(/\\(\\(([^)]+)\\)\\)/g, '$1')\`。SDK 已经在每条命中项里加了 _content_clean 字段 (本次 ${hits} 条命中)。`;
  }
  return json;
}

cli({
  news_list: async ({ page, page_size, pageSize = '20' } = {}) => {
    const p = { pageSize: page_size || pageSize };
    if (page) p.page = page;
    return annotateDoubleParens(markAds(await apiGet('/api/v2/content/news-list', p)));
  },
  news_detail: ({ id }) => apiGet('/api/v2/content/news-detail', { id }),
  // 该端点返 RSS XML, SDK 用 apiGetText 拿原文后自动 parse 一层 <item> 块。
  // 2026-05-13 P1 #6 dogfood: 之前 SDK 只返 raw XML 让 agent 自己 regex 解析,
  // 现在主动 parse 成 parsed: [{title, link, description, pubDate, author}, ...]。
  // 原始 XML 仍在 body 字段保留, 想要原文的可以取。
  news_rss: async ({ page, page_size, pageSize = '20' } = {}) => {
    const p = { pageSize: page_size || pageSize };
    if (page) p.page = page;
    const raw = await apiGetText('/api/v2/content/square/market/news-list', p);
    const parsed = parseRSS(raw?.body);
    return { ...raw, parsed, _note: `已自动 parse RSS XML <item> 块成 parsed 数组 (${parsed.length} 条). 想要原始 XML 取 body 字段。` };
  },
  newsflash: async ({ language } = {}) => {
    const p = {};
    if (language) p.language = language;
    return annotateDoubleParens(markAds(await apiGet('/api/v2/content/newsflash', p)));
  },
  flash_list: async ({ language, createtime } = {}) => {
    const p = {};
    if (language) p.language = language;
    if (createtime) p.createtime = createtime;
    return annotateDoubleParens(markAds(await apiGet('/api/v2/content/flashList', p)));
  },
  // exchange_listing 和 exchange_listing_flash 共享实现 (P2 #1: 显式声明 alias 关系)。
  exchange_listing: async (args) => {
    const json = await exchangeListingImpl(args);
    if (json && typeof json === 'object') {
      json._alias_note = 'exchange_listing 和 exchange_listing_flash 是 alias, 同一接口同一数据。优先用 exchange_listing。';
    }
    return json;
  },
  exchange_listing_flash: async (args) => {
    const json = await exchangeListingImpl(args);
    if (json && typeof json === 'object') {
      json._alias_note = 'exchange_listing_flash 是 exchange_listing 的 alias (同一实现)。下次直接用 exchange_listing 即可。';
    }
    return json;
  },
});
