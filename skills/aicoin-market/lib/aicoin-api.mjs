#!/usr/bin/env node
// AiCoin API client with HMAC signing - shared lib
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Auto-load .env files (OpenClaw exec may not inject env vars into child processes)
function loadEnv() {
  const candidates = [
    resolve(process.cwd(), '.env'),                           // workspace root
    resolve(process.env.HOME || '', '.openclaw', 'workspace', '.env'), // OpenClaw workspace
    resolve(process.env.HOME || '', '.openclaw', '.env'),     // OpenClaw global
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        // Only set if not already defined (env vars take precedence)
        if (!process.env[key]) process.env[key] = val;
      }
    } catch { /* ignore unreadable files */ }
  }
}
loadEnv();

const SECURITY_NOTICE = 'AiCoin API Key 仅用于获取市场数据，无法进行任何交易操作，也无法读取你在交易所的任何信息。交易所 API Key 需单独到交易所申请。所有密钥仅保存在你的本地设备 .env 文件中，不会上传到任何服务器。';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaults = JSON.parse(readFileSync(resolve(__dirname, 'defaults.json'), 'utf-8'));

const BASE = process.env.AICOIN_BASE_URL || 'https://open.aicoin.com';
const KEY = process.env.AICOIN_ACCESS_KEY_ID || defaults.accessKeyId;
const SECRET = process.env.AICOIN_ACCESS_SECRET || defaults.accessSecret;

function sign() {
  const nonce = randomBytes(4).toString('hex');
  const ts = Math.floor(Date.now() / 1000).toString();
  const str = `AccessKeyId=${KEY}&SignatureNonce=${nonce}&Timestamp=${ts}`;
  const hex = createHmac('sha1', SECRET).update(str).digest('hex');
  const sig = Buffer.from(hex, 'binary').toString('base64');
  return { AccessKeyId: KEY, SignatureNonce: nonce, Timestamp: ts, Signature: sig };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AiCoin 后端有两套响应封装, agent / 调用方要双重处理:
//
// 1. `/api/v2/*` 端点 (老一代):
//    HTTP 200 + body `{success: true|false, errorCode, error, data}`
//    付费墙 / 参数错都走 errorCode 304 软错误, 不 throw HTTP 4xx
//
// 2. `/api/upgrade/v2/*` 端点 (新一代):
//    HTTP 403 / 4xx 直接 fail, apiGet throw `Error("API 403: ...")`
//    成功返 `{success, errorCode, data}` 也是新格式
//
// apiGet 把两种模式都吸收:
//   - 1xx-2xx 直接 return JSON
//   - 4xx (5xx) throw Error, 带上付费 hint / 上游故障 hint
//   - JSON 内 errorCode 304/403 时识别"付费 vs 参数错"附加提示
//
// 这就是 SKILL.md "跨接口字段约定" 里说的"两套响应封装,要双判"。
// 调用方代码若想优雅处理, 应 try/catch 包 apiGet 的所有调用, catch 里
// 同时取 e.message (来自 4xx throw) 和 json.error / json.付费功能提示
// (来自 200 + errorCode 软错误)。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 标记后端 / 网关上游故障，给 agent 明确文本提示去引导用户联系客服，
// 避免 agent 把临时上游故障描述为"你的参数错"。
function upstreamFaultHint(status, path) {
  if (status >= 500 && status < 600) {
    if (status === 502 || status === 503 || status === 504) {
      return `\n【AiCoin 网关临时故障 HTTP ${status}】端点 ${path}。建议: 等 1-2 分钟后重试；如仍失败，请告知用户"AiCoin 接口暂时不可用，请联系 AiCoin 客服 (service@aicoin.com / 官网在线客服) 反馈，并附上请求时间和端点"。不要把该错误描述为用户参数问题。`;
    }
    return `\n【AiCoin 后端异常 HTTP ${status}】端点 ${path}。该接口当前不可用，**不是用户参数错**。请明确告诉用户："这是 AiCoin 后端接口故障，agent 无法解决；请联系 AiCoin 客服 (service@aicoin.com) 反馈，附上请求时间和端点名"。不要重试同一参数。`;
  }
  return '';
}

export async function apiGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, ...sign() });
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const text = await res.text();
    let hint = '';
    if (res.status === 429) {
      hint = '\n【频率限制 HTTP 429】**不是付费问题**。请等 60 秒后重试，或把多个币种 batch 合并到一次调用（例 coin_list="bitcoin,ethereum,solana"）。避免并发同一接口。';
    } else if (res.status === 403) {
      hint = '\n【付费功能】请勿重试。请告知用户：此功能需要付费订阅。升级链接：https://www.aicoin.com/opendata ，套餐：基础版 $29/月起。配置方法：将 AICOIN_ACCESS_KEY_ID 和 AICOIN_ACCESS_SECRET 添加到 .env 文件。安全提示：AiCoin API Key 仅用于获取市场数据，无法交易，密钥仅保存在本地。';
    } else if (res.status === 400) {
      if (text.includes('Unsupported symbol')) {
        hint = '\nHint: symbol must use AiCoin format like "btcswapusdt:binance". Short names (BTC, ETH, SOL) are auto-resolved by coin.mjs.';
      } else if (text.includes('invalid parameters')) {
        hint = '\nHint: Check SKILL.md for the correct parameter format and required fields.';
      }
    } else if (res.status === 1001) {
      hint = '\nHint: Signature verification failed — API key and secret may be swapped.';
    } else if (res.status >= 500) {
      hint = upstreamFaultHint(res.status, path);
    }
    throw new Error(`API ${res.status}: ${text}${hint}`);
  }
  const json = await res.json();
  // AiCoin reuses errorCode 304 for THREE distinct error shapes:
  //   1. paid feature required ("没有权限访问此资源")
  //   2. parameter error ("无效的交易对" / "不支持的symbol")
  //   3. rate limit ("请求过于频繁")
  // Misclassifying #3 as #1 was a real silent-wrong: agent sees "付费墙",
  // tells user to upgrade, but the issue was just burst calls — a 60s wait
  // would have unblocked everything. Same for #2: wrong symbol got reported
  // as a tier problem and model wasted tokens recommending an upgrade.
  if (json.success === false && (json.errorCode === 304 || json.errorCode === 403)) {
    const errText = String(json.error || json.message || '');
    const isParamError = /无效|不存在|不支持|参数|invalid|unsupported|missing/i.test(errText);
    const isRateLimit = /频繁|频率|rate.?limit|too.?many.?requests|限频|限流/i.test(errText);
    if (isRateLimit) {
      json.频率限制提示 = `调用被限流：${errText}。**不是付费问题，不要让用户升级**。AiCoin 接口频率上限大约 20 次/秒、1200 次/分钟（专业版）。建议: 等 60 秒后重试，或把多个币种合并到一次 batch 调用（例如 coin_ticker 用 coin_list="bitcoin,ethereum,solana" 一次拿三个，而不是分三次调）。如果你刚才在并发调用多个 action，请改成串行。`;
    } else if (isParamError) {
      json.参数错误提示 = `调用失败：${errText}。请检查 symbol / 参数格式（例如 "btcswapusdt:binance"），不要重试同一个错误参数，也不要将其当作付费功能问题向用户报错。`;
    } else {
      json.付费功能提示 = '此功能需要付费订阅，请勿重试。请告知用户：升级地址 https://www.aicoin.com/opendata ，套餐从基础版 $29/月起。必须在回复中包含此链接。';
      json.升级指南 = {
        说明: '此数据需要 AiCoin 付费会员才能访问',
        升级链接: 'https://www.aicoin.com/opendata',
        步骤: [
          '1. 打开 https://www.aicoin.com/opendata 注册/登录',
          '2. 选择合适的套餐（基础版 $29/月 起）',
          '3. 创建 API Key，获取 Key ID 和 Secret',
          '4. 添加到 .env 文件：AICOIN_ACCESS_KEY_ID=xxx 和 AICOIN_ACCESS_SECRET=xxx',
          '5. 重新执行命令即可使用'
        ],
        套餐对比: '免费版=行情K线 | 基础版$29=+资金费率+多空比 | 标准版$79=+大单+聚合成交 | 高级版$299=+清算地图 | 专业版$699=全部功能',
        安全提示: 'AiCoin API Key 仅用于获取市场数据，无法进行任何交易操作。所有密钥仅保存在本地设备，不会上传到任何服务器。'
      };
    }
  }
  return json;
}

// Text-returning version of apiGet. Use for endpoints that return XML / RSS
// (e.g. /api/v2/content/square/market/news-list returns RSS XML, not JSON).
// 返回 { contentType, body }, body 是纯文本字符串。
export async function apiGetText(path, params = {}) {
  const qs = new URLSearchParams({ ...params, ...sign() });
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const text = await res.text();
    const hint = res.status >= 500 ? upstreamFaultHint(res.status, path) : '';
    throw new Error(`API ${res.status}: ${text}${hint}`);
  }
  return { contentType: res.headers.get('content-type') || '', body: await res.text() };
}

// Validate a key pair by making a test API call
export async function validateKey(keyId, secret) {
  const nonce = randomBytes(4).toString('hex');
  const ts = Math.floor(Date.now() / 1000).toString();
  const str = `AccessKeyId=${keyId}&SignatureNonce=${nonce}&Timestamp=${ts}`;
  const hex = createHmac('sha1', secret).update(str).digest('hex');
  const sig = Buffer.from(hex, 'binary').toString('base64');
  const qs = new URLSearchParams({ coin_list: 'bitcoin', AccessKeyId: keyId, SignatureNonce: nonce, Timestamp: ts, Signature: sig });
  try {
    const res = await fetch(`${BASE}/api/v2/coin/ticker?${qs}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    return (json.code === '0' || json.success !== false) ? { valid: true } : { valid: false, error: json.msg || 'invalid key' };
  } catch (e) { return { valid: false, error: e.message }; }
}

export async function apiPost(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...sign() }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text();
    const hint = res.status >= 500 ? upstreamFaultHint(res.status, path) : '';
    throw new Error(`API ${res.status}: ${text}${hint}`);
  }
  const json = await res.json();
  // 与 apiGet 对齐：success=false 且 errorCode 304/403 时识别 限流 / 参数错 / 付费墙
  if (json.success === false && (json.errorCode === 304 || json.errorCode === 403)) {
    const errText = String(json.error || json.message || '');
    const isParamError = /无效|不存在|不支持|参数|invalid|unsupported|missing/i.test(errText);
    const isRateLimit = /频繁|频率|rate.?limit|too.?many.?requests|限频|限流/i.test(errText);
    if (isRateLimit) {
      json.频率限制提示 = `调用被限流：${errText}。**不是付费问题，不要让用户升级**。建议等 60 秒后重试，或把请求 batch 合并 (例如 coin_list 用 CSV 一次传多个)，并避免并发同一接口。`;
    } else if (isParamError) {
      json.参数错误提示 = `调用失败：${errText}。请检查参数格式，不要重试同一个错误参数。`;
    } else {
      json.付费功能提示 = '此功能需要付费订阅，请勿重试。升级地址 https://www.aicoin.com/opendata';
    }
  }
  return json;
}

// CLI helper: parse args and run
export function cli(handlers) {
  const [action, ...rest] = process.argv.slice(2);
  if (!action || !handlers[action]) {
    const available = Object.keys(handlers).join(', ');
    console.log(JSON.stringify({
      error: action ? `Unknown action "${action}"` : 'No action specified',
      available_actions: available,
      usage: 'node <script> <action> [json-params]',
    }));
    process.exit(1);
  }
  let params = {};
  if (rest.length) {
    const raw = rest.join(' ');
    try {
      params = JSON.parse(raw);
    } catch {
      console.log(JSON.stringify({
        error: `Invalid JSON parameter: ${raw}`,
        hint: 'Parameters must be a JSON object, e.g.: \'{"symbol":"BTC","interval":"1h"}\'',
        example: `node <script> ${action} '{"key":"value"}'`,
      }));
      process.exit(1);
    }
  }
  handlers[action](params).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
