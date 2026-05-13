#!/usr/bin/env node
// AiCoin Newsflash (OpenData) CLI
import { apiGet, cli } from '../lib/aicoin-api.mjs';

// 标记广告位条目, 避免 agent 把广告当头条 (跟 news.mjs 同款逻辑, 这两个文件没共享 lib helper)。
// 2026-05-13 P1 #5 dogfood: 除 is_ad / isAd 还要看 flashType (非 0 通常是广告/推广位)。
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
    json._note = `本次返回 ${list.length} 条快讯中, 第 ${adIndices.join(',')} 条 (0-indexed) 是广告位 (is_ad=1 或 flashType≠0), 不是真实新闻。**总结今日头条时跳过这些 index**, 不要把广告当头条引用给用户。`;
    json.ad_indices = adIndices;
  }
  return json;
}

// 2026-05-13 dogfood v6 P1 #18: newsflash content 里看到大量 ((Gate.io)) / ((Binance)) 双括号
// 包裹的品牌/交易所名字 — 这是 AiCoin 后端注入的"关键词高亮标记", agent 当 markdown 或链接
// 语法误读。在返 list/search 时统一 _field_doc 说明 + 把双括号剥成纯文本备份到 _content_clean。
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
  // P2 #3: 接受 page_size / pagesize / size 互相 alias (newsflash 跟 news 字段名不统一, 兼容)
  search: async ({ keyword, word, page, page_size, pagesize, size } = {}) => {
    const p = { word: keyword || word };
    if (page) p.page = page;
    const ps = page_size || pagesize || size;
    if (ps) p.size = ps;
    return annotateDoubleParens(markAds(await apiGet('/api/upgrade/v2/content/newsflash/search', p)));
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
    return annotateDoubleParens(markAds(await apiGet('/api/upgrade/v2/content/newsflash/list', p)));
  },
  // 2026-05-13 dogfood v6 P1 #17: 接受 id / flashId 当 flash_id 别名 (list 里返的字段叫 id, 不叫 flash_id,
  // agent 跨字段命名很容易传错)。 返 null 时加 _note 引导。
  detail: async ({ flash_id, id, flashId } = {}) => {
    const _id = flash_id || id || flashId;
    if (!_id) {
      return { success: false, errorCode: 400, error: 'detail 必填 flash_id (也接受 id / flashId 别名)', _note: 'id 来源: newsflash.list / newsflash.search 返回项里的 id 字段。' };
    }
    const json = await apiGet('/api/upgrade/v2/content/newsflash/detail', { flash_id: _id });
    if (json && (json.data === null || json.data === undefined)) {
      json._note = `newsflash.detail 对 flash_id="${_id}" 返 data=null。可能原因: (1) 该快讯被后端下架/隐藏 (2) flash_id 是过期/无效 ID (3) 该快讯无详情正文 (有些短快讯 list 已含全部内容, 不再有 detail)。**list 项里 content 字段通常已是完整正文**, 改用 list 数据即可, 不必再调 detail。`;
    }
    return json;
  },
});
