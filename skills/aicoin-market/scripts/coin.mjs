#!/usr/bin/env node
// AiCoin Coin Data CLI
import { apiGet, apiPost, cli, validateKey } from '../lib/aicoin-api.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Symbol alias mapping: fuzzy input → AiCoin internal format
// Covers funding_rate, liquidation, depth, etc.
const SYMBOL_ALIASES = {
  // BTC
  'btc': 'btcswapusdt:binance', 'bitcoin': 'btcswapusdt:binance',
  'btcusdt': 'btcswapusdt:binance', 'btc/usdt': 'btcswapusdt:binance',
  'btcswapusdt': 'btcswapusdt:binance',
  // ETH
  'eth': 'ethswapusdt:binance', 'ethereum': 'ethswapusdt:binance',
  'ethusdt': 'ethswapusdt:binance', 'eth/usdt': 'ethswapusdt:binance',
  'ethswapusdt': 'ethswapusdt:binance',
  // SOL
  'sol': 'solswapusdt:binance', 'solana': 'solswapusdt:binance',
  'solusdt': 'solswapusdt:binance', 'sol/usdt': 'solswapusdt:binance',
  // DOGE
  'doge': 'dogeswapusdt:binance', 'dogecoin': 'dogeswapusdt:binance',
  'dogeusdt': 'dogeswapusdt:binance',
  // XRP
  'xrp': 'xrpswapusdt:binance', 'xrpusdt': 'xrpswapusdt:binance',
};

// AiCoin 内部各家平台的 perp/spot 命名不统一。已知 platform 坑:
//  - OKX 永续是 `okcoinfutures` 不是 `okex` (后者是 OKX 现货)
//  - Bitget 永续是 `btcumcblusdt:bitget` 不是 `btcswapusdt:bitget`
// 用户/模型常传错的形式自动纠正,避免 304 "无效的交易对"。
function fixPlatformAlias(s) {
  if (!s || !s.includes(':')) return s;
  // OKX 永续路径修正: 凡是 "*swap*:okex" 自动改成 ":okcoinfutures"
  if (/swap.*:okex$/i.test(s)) {
    return s.replace(/:okex$/i, ':okcoinfutures');
  }
  // Bitget 永续 symbol 修正: btcswapusdt:bitget → btcumcblusdt:bitget,
  // ethswapusdt:bitget → ethumcblusdt:bitget 等
  if (/swapusdt:bitget$/i.test(s)) {
    return s.replace(/swapusdt:bitget$/i, 'umcblusdt:bitget');
  }
  return s;
}

function resolveSymbol(symbol) {
  if (!symbol) return symbol;
  // Already in correct format (contains colon) — but still fix known platform aliases
  if (symbol.includes(':')) return fixPlatformAlias(symbol);
  const key = symbol.toLowerCase().replace(/[\s/]/g, '');
  return fixPlatformAlias(SYMBOL_ALIASES[key] || symbol);
}

// dbkey alias (same format as symbol for most cases)
function resolveDbkey(dbkey) {
  return resolveSymbol(dbkey);
}

async function aiAnalysisImpl({ coin_keys, language }) {
  let keys = coin_keys;
  if (typeof keys === 'string') {
    try { keys = JSON.parse(keys); } catch { keys = [keys]; }
  }
  if (!Array.isArray(keys)) keys = [keys];
  const body = { coinKeys: keys };
  if (language) body.language = language;
  const json = await apiPost('/api/v2/content/ai-coins', body);
  // 实测: 端点返回 success:true 但 data.list 经常为空(后端内容池滞后)。
  // 给 agent 明确提示, 避免误判为"接口故障"或"参数错"。
  if (json && json.success !== false && Array.isArray(json.data?.list) && json.data.list.length === 0) {
    json._note = 'AI 解读内容当前为空。这是 AiCoin 后端内容池尚未产出该币种解读,不是接口故障也不是参数错。请告知用户"AI 解读暂未生成,可稍后重试或换其他币种"。';
  }
  return json;
}

cli({
  // coin search — discover dbKeys for any coin/exchange/market type
  search: ({ search, page, page_size, market, trade_type }) => {
    if (!search) return Promise.resolve({ error: 'search is required', usage: 'node coin.mjs search \'{"search":"BTC"}\'' });
    const p = { search };
    if (page) p.page = page;
    if (page_size) p.page_size = page_size;
    if (market) p.market = market;
    if (trade_type) p.trade_type = trade_type;
    return apiGet('/api/upgrade/v2/coin/search', p);
  },
  // coin_info
  coin_list: () => apiGet('/api/v2/coin'),
  coin_ticker: async ({ coin_list }) => {
    const json = await apiGet('/api/v2/coin/ticker', { coin_list });
    // 实测: 后端对 coin_list CSV 里不认识的 key 静默丢弃, agent 拿到 partial
    // data 当全数据用就是 silent wrong。这里本地对比, 把缺失 key 列出来。
    // AiCoin coin_key 命名无规律 (例: RNDRToken 驼峰 / fet1 数字后缀 /
    // virtualprotocol 连写), 用 CoinGecko 或 CMC 风格名字几乎必踩。
    if (coin_list && Array.isArray(json?.data)) {
      const requested = String(coin_list).split(',').map(s => s.trim()).filter(Boolean);
      const returned = new Set(json.data.map(d => d.coin_key));
      const missing = requested.filter(k => !returned.has(k));
      if (missing.length > 0) {
        json._note = `coin_ticker: 传了 ${requested.length} 个 key, 后端只识别 ${returned.size} 个, 未识别: ${missing.join(',')}。AiCoin coin_key 命名无规律 (例: RNDRToken 驼峰 / fet1 数字后缀 / virtualprotocol 连写, 跟 CoinGecko / CMC 完全不一致)。**拿不准的 key 先用 coin.mjs search 查准确的 coin_key**, 不要把后端返的部分数据当全数据用。`;
        json.unrecognized_keys = missing;
      }
    }
    return json;
  },
  coin_config: async ({ coin_list }) => {
    const json = await apiGet('/api/v2/coin/config', { coin_list });
    // 同 coin_ticker, 后端对未识别 key 静默丢弃。
    if (coin_list && Array.isArray(json?.data)) {
      const requested = String(coin_list).split(',').map(s => s.trim()).filter(Boolean);
      const returned = new Set(json.data.map(d => d.coin_key || d.coinKey));
      const missing = requested.filter(k => !returned.has(k));
      if (missing.length > 0) {
        json._note = `coin_config: 传了 ${requested.length} 个 key, 后端只识别 ${returned.size} 个, 未识别: ${missing.join(',')}。先用 coin.mjs search 查准确的 coin_key。`;
        json.unrecognized_keys = missing;
      }
    }
    return json;
  },
  ai_analysis: aiAnalysisImpl,
  // alias: SKILL.md 早期用 ai_coins, 实际 action 名是 ai_analysis。保留兼容。
  ai_coins: aiAnalysisImpl,
  // coin_funding_rate (AiCoin API only supports BTC)
  funding_rate: async ({ symbol, interval = '8h', weighted, limit = '100', start_time, end_time }) => {
    const resolved = resolveSymbol(symbol);
    // Check if resolved symbol is BTC-related
    if (resolved && !resolved.toLowerCase().startsWith('btc')) {
      return {
        code: '0', msg: 'success', data: [],
        _note: `AiCoin funding_rate API only supports BTC. For ${symbol} funding rate, use: node scripts/exchange.mjs funding_rate '{"exchange":"binance","symbol":"${symbol}/USDT:USDT"}'`
      };
    }
    const p = { symbol: resolved, interval, limit };
    if (start_time) p.start_time = start_time;
    if (end_time) p.end_time = end_time;
    const isWeighted = weighted === 'true' || weighted === true;
    const path = isWeighted
      ? '/api/upgrade/v2/futures/funding-rate/vol-weight-history'
      : '/api/upgrade/v2/futures/funding-rate/history';
    const json = await apiGet(path, p);
    // 实测: weighted=true 经常返空 list。给 agent 明确提示这是数据问题不是接口故障。
    if (isWeighted && json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = '加权资金费率 (vol-weight-history) 返回为空。这通常是上游窗口数据没填或当前 Pro 档没覆盖该 endpoint, 不是接口故障也不是参数错。可改用 weighted=false 拿普通资金费率历史, 或告知用户后再决定是否继续。';
    }
    return json;
  },
  // coin_liquidation
  liquidation_map: ({ symbol, dbkey, cycle, leverage }) => {
    const p = { dbkey: resolveDbkey(symbol || dbkey), cycle };
    if (leverage) p.leverage = leverage;
    return apiGet('/api/upgrade/v2/futures/liquidation/map', p);
  },
  liquidation_history: ({ symbol, interval, limit = '100', start_time, end_time }) => {
    const p = { symbol: resolveSymbol(symbol), interval, limit };
    if (start_time) p.start_time = start_time;
    if (end_time) p.end_time = end_time;
    return apiGet('/api/upgrade/v2/futures/liquidation/history', p);
  },
  estimated_liquidation: ({ symbol, dbkey, cycle, leverage, limit = '5', start_time, end_time }) => {
    const p = { dbkey: resolveDbkey(symbol || dbkey), cycle, limit };
    if (leverage) p.leverage = leverage;
    if (start_time) p.start_time = start_time; if (end_time) p.end_time = end_time;
    return apiGet('/api/upgrade/v2/futures/estimated-liquidation/history', p);
  },
  // coin_open_interest
  open_interest: async ({ symbol, interval, margin_type = 'stablecoin', limit = '100', start_time, end_time }) => {
    const resolved = resolveSymbol(symbol);
    // 实测 (Q2 v2): AiCoin open_interest 跟 funding_rate 一样, 只覆盖 BTC。
    // 传 SOL/ETH/其他静默返空 list, agent 拿空 list 当"OI 为零"误判方向。
    if (resolved && !resolved.toLowerCase().startsWith('btc')) {
      return {
        success: true, errorCode: 200, data: [],
        _note: `AiCoin open_interest 仅支持 BTC, 传 ${symbol} 后端静默返空 (不是 OI 真的为零)。**改用 exchange skill** 例如 \`node scripts/exchange.mjs open_interest '{"exchange":"binance","symbol":"${symbol}/USDT:USDT"}'\`, 或者从 HL skill 拿 \`hl-market ticker\` 看 HL 上的 OI。`,
      };
    }
    const path = margin_type === 'coin'
      ? '/api/upgrade/v2/futures/open-interest/aggregated-coin-margin-history'
      : '/api/upgrade/v2/futures/open-interest/aggregated-stablecoin-history';
    const p = { symbol: resolved, interval, limit };
    if (start_time) p.start_time = start_time; if (end_time) p.end_time = end_time;
    return apiGet(path, p);
  },
  // coin_futures_data
  historical_depth: ({ symbol, key, limit = '100', start_time, end_time }) => {
    const p = { key: resolveSymbol(symbol || key), limit };
    if (start_time) p.start_time = start_time; if (end_time) p.end_time = end_time;
    return apiGet('/api/upgrade/v2/futures/historical-depth', p);
  },
  super_depth: async ({ symbol, key, amount = '10000', limit = '100', start_time, end_time }) => {
    const p = { key: resolveSymbol(symbol || key), amount, limit };
    if (start_time) p.start_time = start_time; if (end_time) p.end_time = end_time;
    const json = await apiGet('/api/upgrade/v2/futures/super-depth/history', p);
    // 实测: 默认 amount=10000 经常返空 list, 即使调到 100000 也空。
    // 提示 agent 这通常是当前窗口没大单或权限差异, 别误判为接口故障。
    if (json && Array.isArray(json.data) && json.data.length === 0) {
      json._note = `super_depth (大单挂单历史) 返空。该端点观察窗口很短 (~100 秒级), 当前窗口没 ≥${amount} 的大单挂单是常态, 不是接口故障。可调小 amount 或换交易对再试。`;
    }
    return json;
  },
  trade_data: ({ symbol, dbkey, limit = '100', start_time, end_time }) => {
    const p = { dbkey: resolveDbkey(symbol || dbkey), limit };
    if (start_time) p.start_time = start_time; if (end_time) p.end_time = end_time;
    return apiGet('/api/upgrade/v2/futures/trade-data', p);
  },

  // Aliases: actions models often mis-route here from features.mjs
  big_orders: ({ symbol }) => apiGet('/api/v2/order/bigOrder', { symbol: resolveSymbol(symbol) }),
  whale_orders: ({ symbol }) => apiGet('/api/v2/order/bigOrder', { symbol: resolveSymbol(symbol) }),
  ls_ratio: () => apiGet('/api/v2/mix/ls-ratio'),
  long_short_ratio: () => apiGet('/api/v2/mix/ls-ratio'),

  // API Key status check — run this when user asks about AiCoin API key config/safety
  api_key_info: async ({ probe } = {}) => {
    const envPaths = [
      resolve(process.cwd(), '.env'),
      resolve(process.env.HOME || '', '.openclaw', 'workspace', '.env'),
      resolve(process.env.HOME || '', '.openclaw', '.env'),
    ];
    let keyInfo = { configured: false };
    for (const file of envPaths) {
      if (!existsSync(file)) continue;
      try {
        const lines = readFileSync(file, 'utf-8').split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('AICOIN_ACCESS_KEY_ID=')) {
            const val = line.trim().split('=')[1]?.trim().replace(/^["']|["']$/g, '');
            if (val) keyInfo = { configured: true, key_preview: val.slice(0, 8) + '...', env_file: file };
          }
        }
      } catch {}
    }
    const out = {
      aicoin_key_status: keyInfo.configured
        ? keyInfo
        : { configured: false, setup: '访问 https://www.aicoin.com/opendata 注册 → 创建API Key → 添加到 .env: AICOIN_ACCESS_KEY_ID=xxx / AICOIN_ACCESS_SECRET=xxx' },
      security_notice: '⚠️ AiCoin API Key 与交易所 API Key 是完全独立的两套密钥：(1) AiCoin API Key 仅用于获取市场数据（行情、K线、资金费率等），无法进行任何交易操作，也无法读取你在交易所的任何信息。(2) 如需在交易所下单交易，需要单独到各交易所后台申请交易 API Key。(3) 所有密钥仅保存在你的本地设备 .env 文件中，不会上传到任何服务器。',
    };
    // 实测 (v3 9 并行测试): 配置文件里写着 vip_type=professional 不代表 key 实际权限有效,
    // 过期后部分接口会退权限但 .env 里还看不出来。probe=true 时实跑 4 个分档接口看真档位。
    // **串行** 避免触发限流误判。
    if (probe && keyInfo.configured) {
      const probes = [
        { tier: '免费版', name: 'coin_ticker', path: '/api/v2/coin/ticker', params: { coin_list: 'bitcoin' } },
        { tier: '基础版', name: 'funding_rate', path: '/api/upgrade/v2/futures/funding-rate/history', params: { symbol: 'btcswapusdt:binance', interval: '8h', limit: '1' } },
        { tier: '标准版', name: 'big_orders', path: '/api/v2/order/bigOrder', params: { symbol: 'btcswapusdt:binance' } },
        { tier: '专业版', name: 'treasury_summary', path: '/api/upgrade/v2/coin-treasuries/summary', params: { coin: 'BTC' } },
      ];
      const results = [];
      for (const p of probes) {
        try {
          const r = await apiGet(p.path, p.params);
          const ok = r.success !== false && r.code !== '403';
          results.push({ tier: p.tier, action: p.name, status: ok ? 'OK' : (r.errorCode === 304 ? '304/未授权' : 'unknown'), error: ok ? null : (r.error || r.msg || '').slice(0, 80) });
        } catch (e) {
          const m = (e.message || '').match(/^API (\d+):/);
          const code = m ? m[1] : 'ERR';
          results.push({ tier: p.tier, action: p.name, status: `HTTP ${code}`, error: (e.message || '').slice(0, 80) });
        }
        // 串行间隔, 避 burst 限流
        await new Promise(r => setTimeout(r, 300));
      }
      out.tier_probe = results;
      const okTiers = results.filter(r => r.status === 'OK').map(r => r.tier);
      out.tier_probe_summary = okTiers.length === 0
        ? 'key 完全不工作 (可能彻底失效)'
        : `实际通的档位: ${okTiers.join(' / ')}。**这是真档位, 不是 .env 里声明的档位**。`;
    }
    return out;
  },

  // Update AiCoin API key — validates before writing to .env
  update_key: async ({ key_id, secret }) => {
    if (!key_id || !secret) return { error: '需要同时提供 key_id 和 secret', usage: 'node coin.mjs update_key \'{"key_id":"xxx","secret":"xxx"}\'' };
    const check = await validateKey(key_id, secret);
    if (!check.valid) return { error: `Key 验证失败: ${check.error}`, hint: '请检查 key_id 和 secret 是否正确' };
    const envPaths = [
      resolve(process.cwd(), '.env'),
      resolve(process.env.HOME || '', '.openclaw', 'workspace', '.env'),
      resolve(process.env.HOME || '', '.openclaw', '.env'),
    ];
    let envFile = envPaths.find(f => existsSync(f)) || envPaths[1];
    let content = existsSync(envFile) ? readFileSync(envFile, 'utf-8') : '';
    const replaceOrAppend = (content, k, v) => content.match(new RegExp(`^${k}=`, 'm'))
      ? content.replace(new RegExp(`^${k}=.*`, 'm'), `${k}=${v}`) : content + `\n${k}=${v}`;
    content = replaceOrAppend(content, 'AICOIN_ACCESS_KEY_ID', key_id);
    content = replaceOrAppend(content, 'AICOIN_ACCESS_SECRET', secret);
    writeFileSync(envFile, content, 'utf-8');
    return { success: true, message: '✅ Key 已验证有效并更新', key_preview: key_id.slice(0, 8) + '...', env_file: envFile };
  },
});
