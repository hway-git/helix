---
name: aicoin-market
description: "This skill should be used when the user asks about crypto prices, market data, K-line charts, funding rates, open interest, long/short ratios, whale orders, liquidation data, crypto news, newsflash, Twitter crypto tweets, trending coins, airdrops, drop radar, airdrop research, project analysis, exchange listings, stock quotes, treasury holdings, or any crypto market query. Also use when user asks about configuring or checking AiCoin API key. Use when user says: 'BTC price', 'check price', 'show K-line', 'funding rate', 'open interest', 'whale orders', 'long/short ratio', 'crypto news', 'newsflash', 'ETF', '监管', '政策', 'trending coins', 'airdrop', 'drop radar', '查行情', '看价格', '大饼多少钱', 'K线', '资金费率', '多空比', '鲸鱼单', '新闻', '快讯', '新闻快讯', '热门币', '空投', '空投项目', '空投机会', '空投研报', '项目分析', '项目详情', '上了哪些交易所', '推特', 'Twitter', 'liquidation map', '配置AiCoin key', 'AiCoin API key', 'AiCoin key安全吗'. Covers 200+ exchanges with real-time data. MUST run node scripts to fetch real data. NEVER generate fake prices or hallucinate market data. NEVER use web_search/web_fetch for airdrop, project, news, or Twitter data — always use airdrop.mjs, drop_radar.mjs, news.mjs, newsflash.mjs, or twitter.mjs scripts. IMPORTANT — AiCoin API Key: When user asks about AiCoin API key (配置/检查/安全/能不能交易), run `node scripts/coin.mjs api_key_info` FIRST, show the security_notice to user. For exchange trading (buy/sell/balance), use aicoin-trading instead. For Freqtrade strategies/backtest, use aicoin-freqtrade. For Hyperliquid whale analytics, use aicoin-hyperliquid."
metadata: { "openclaw": { "primaryEnv": "AICOIN_ACCESS_KEY_ID", "requires": { "bins": ["node"] }, "homepage": "https://www.aicoin.com/opendata", "source": "https://github.com/aicoincom/coinos-skills", "license": "MIT" } }
---

> **运行脚本**: 从 SKILL.md 所在目录运行 `node scripts/<file>.mjs <action>`. 在 CoinClaw 三引擎(OpenClaw / Hermes / Claude Code)容器里 skill 路径自动注入到 agent workspace, 直接 `cd` 到 skill 目录即可 — 三引擎共用同一份 skill 代码, 不要假设硬编码路径.

# AiCoin Market

Crypto market data toolkit powered by [AiCoin Open API](https://www.aicoin.com/opendata). Prices, K-lines, news, signals, whale orders, and more from 200+ exchanges.

**Version:** 1.0.0

## Critical Rules

1. **NEVER fabricate data.** Always run scripts. If data is empty or errors occur, say so directly — do NOT invent explanations.
2. **NEVER use curl, web_fetch, web_search, or browser** for crypto/airdrop/project data. Always use these scripts.
3. **NEVER run `env` or `printenv`** — leaks API secrets into logs.
4. **Scripts auto-load `.env`** — never pass credentials inline.
5. **Reply in the user's language.** Chinese input = all-Chinese response (titles, headings, analysis).
6. **遇到 304/403 错误**: 先看响应里附带的字段判断, **不要一律当付费墙** (lib 已经帮你区分了三种 304):
   - `频率限制提示` 字段 → 限流。**不是付费问题, 不要让用户升级**。等 60 秒重试, 或把多个币种 batch 合并到一次调用 (例 coin_list 用 CSV `"bitcoin,ethereum,solana"`), 避免并发同一接口。
   - `付费功能提示` / `升级指南` 字段 → 真付费墙。按 [Paid Feature Guide](#paid-feature-guide) 引导升级, 不重试。
   - `参数错误提示` 字段 → 参数错 (symbol 写错 / coin_key 不存在 等), 检查格式不重试, 别让用户以为是付费问题。
7. **更换 API Key 只能用 `update_key` 命令。** 禁止直接编辑 .env、禁止用 gateway/edit 工具改 key。`update_key` 会先验证 key 有效才写入。
8. **响应里出现 `实测结论` / `_note` 字段时把原文转告用户**,不要重试同一参数 — 这些是脚本帮你把上游故障 / 数据空 / API 设计限制翻译成了清晰提示, 重试会浪费用户时间。

## Known Issues (broken / 临时不稳的端点)

下面这些端点 agent **不要重试**, 不是用户参数错, 是 AiCoin 后端的问题。脚本已经做了本地拦截或上游故障 catch, 调用时会拿到 `实测结论` 字段, 把它原文转告用户即可。

- **`features.strategy_signal`** — 后端长期 broken, 公开 signal_key 格式 (`depth_win_one` 等) 实测全 400。脚本本地无条件拦截, 不会真调上游。**替代**: `change_signal` (异动信号) / `signal_alert` (用户配置预警)
- **`coin.liquidation_history`** — AiCoin 网关 stgw 偶发 HTTP 502 (实测重试 3 次都失败的窗口)。脚本会带 upstreamFaultHint 提示重试或联系客服。**替代**: `coin.liquidation_map` (清算地图) / `coin.estimated_liquidation` (预估清算)
- **`market.stock_company`** — 后端偶发 500 / 也可能恢复正常 (状态不稳)。MSTR 实测有时通有时 500。拿到 `实测结论` 字段时按提示转告用户, 否则正常使用。
- **`airdrop.detail`** — 当前 key 档位不够时上游返 **HTTP 403 付费墙** (不是 500 后端故障)。脚本会带"档位不够"提示。**替代**: `airdrop.list / banner / calendar` 拿简要信息
- **`drop_radar.detail`** — 同 airdrop.detail, 当前 key 档位不够时返 403。**替代**: `drop_radar.list` 已含项目基础信息
- **`hl-trader.accounts`** (aicoin-hyperliquid) — 后端偶发 500。**替代**: `statistics + batch_clearinghouse_state`
- **`hl-trader.statistics`** (aicoin-hyperliquid) — 跟 `accounts` 同样接受 `addresses` 数组参数, 不传时上游返 400 "请求体无效" (不是 SDK 报错)。本地未拦截。**正确用法**: `{"addresses":["0x...", "0x..."]}` 或 CSV string。
- **`coin.ai_analysis` / `coin.ai_coins`** — AiCoin 后端 AI 解读内容池**当前整体稀疏** (BTC / ETH / HYPE 等主流币都返 `data.list=[]`)。脚本已加 _note 引导, 但 agent 别误以为单个币种问题, 实测多币种都空。**不是接口故障也不是付费问题**, 是后端内容运营问题, 别浪费签名重试。
- **`coin.historical_depth` / `coin.super_depth`** — 后端长期返 500 "Failed to get (super) depth"。脚本会带后端故障提示。**替代**: `market.depth_latest / depth_full / depth_grouped` (注意是 `dbKey` 而非 `dbkey`, 脚本两种大小写都接受)。
- **`coin.open_interest` / `coin.liquidation_history`** — 即便 BTC 也常返空 (上游数据稀疏)。脚本加了空数据 _note 引导用 hl-market / exchange skill 替代。**不是 OI/清算真为零**。
- **`hl-trader.batch_clearinghouse_state` / `batch_spot_clearinghouse_state`** — 后端偶发 500 "Internal Server Error"。**替代**: 单地址多次调 `info '{"type":"clearinghouseState","address":"0x..."}'` 拼起来。
- **上游 5xx 通用响应** — 任何端点拿到 HTTP 502/503/504 是 AiCoin 网关临时故障(可重试 1-2 分钟), 拿到 500/501/505+ 是后端异常(直接引导用户联系 service@aicoin.com), 不要让用户改参数

## 跨接口字段约定 (agent 必读, 单接口看不出的坑)

整个 skill 跨多个 action 时容易踩的字段 / 类型 / 单位陷阱:

- **两套响应封装**: 同一份 lib 同时接 AiCoin 两种端点格式 — `/api/v2/*` 返 `{success, errorCode, error, data}`, `/api/upgrade/v2/*` 返 `{code, msg, data}`。 agent 判断成功不能只看 `success`, 必须**两套都判** (`success !== false` && `code === '0'`)。
- **时间戳单位混杂**: `kline` 用**秒**级 unix; `funding_rate` / `open_interest` / `historical_depth` / `trade_data` 用**毫秒**级; `estimated_liquidation.time_points` key 又是秒; `newsflash.list.timestamp` 是秒。**跨接口处理时间戳前必须按 action 核对单位**, 别假设统一。
- **search.dbKeys 是 string 不是 array**: 同上述 [search 行](#scriptscoinmjs--coin-data) 已说, 用 `.split(',')` 不要 `JSON.parse`。
- **search.price 是 CNY**, `coin_ticker.price_usd` 才是 USD: 量级差 ~6.8 倍, 别串字段。
- **多个端点硬上限 100 条无翻页**: `coin_list` / `funding_rate` / `open_interest` / `historical_depth` / `trade_data` 都是。 用户问"全量历史"时老实告知 API 限制。
- **数据时新性差异**: `kline` / `coin_ticker` 实时; `historical_depth` 实测窗口短 (近 100 秒) 且**可能滞后 30h+** (后端取样窗口设计); `treasury_*` 每日更新; `news_rss` 24h 摘要。 答用户前看数据 `time` 字段确认是不是用户期望的时点。
- **字段类型 string vs number 不统一**: `coin_ticker` 所有数值字段是 string (要 parseFloat); `ls_ratio` 部分 string 部分 number (`detail.last` 是 number, `last_day` 是 string); `kline.kline_data[]` 数组里数值是 number。 agent **每次新接口都先看 raw 类型**, 别假设统一。
- **币种/dbKey 字段命名混乱**: 同一概念在不同接口字段名都不一样, 跨接口取数前看清字段名:
  - `search` **返回字段** `dbKeys` (string, 逗号分隔, 不是 array) — 这是输出
  - `coin_list` / `coin_config` / `coin_ticker` **输入参数** `coin_list` (string, CSV, 例 `"bitcoin,ethereum"`) — 取的是 coin_key (`bitcoin`, 不是 `btcusdt:okex`)
  - `liquidation_map` / `historical_depth` / `trade_data` 输入参数 `dbkey` (小写单数, 例 `btcswapusdt:binance`)
  - `kline` 输入参数 `symbol` (同 dbkey 格式)
  - `pair_ticker` 输入参数 `key_list` (string, CSV, dbkey 格式)
  - 大单 `big_orders` / `agg_trades` 输入参数 `symbol` (dbkey 格式)
- **funding_rate / open_interest 必须用永续 dbkey, 不是现货**:
  - 现货 `btcusdt:okex` / `btcusdt:binance` → funding_rate 静默返空 (上游不报错)
  - 永续 `btcswapusdt:okcoinfutures` / `btcswapusdt:binance` → 才有数据
  - 弄不清就 `search` 一下, dbkey 里带 `swap` / `perp` / `fut` 的才是合约。
  - 另外 AiCoin funding_rate 和 open_interest **只覆盖 BTC**, 传 SOL/ETH 等会被脚本本地拦截并引导你用 exchange skill 或 HL skill。
- **treasury_\* 全套只支持 coin=BTC / ETH**: 传 SOL / DOGE / 其他, 脚本本地拦截。其他币的上市公司持币 AiCoin 没覆盖, 引导用户去 bitcointreasuries.net / ethtreasuries.com。
- **treasury_entities.share 字段口径在 BTC/ETH 之间不一致**: BTC 实例返小数 (0.012 = 1.2%), ETH 实例返百分数 (1.2 = 1.2%)。**跨币种比 share 前必须用一个已知持有量校准口径**, 不要直接拿数字比大小。脚本会带 `_note` 警告。
- **新闻/快讯接口可能掺 `is_ad=1` 广告位**: `newsflash` / `flash_list` / `news_list` / `newsflash.list / search` 等接口里, 脚本检测到 is_ad=1 条目会加 `ad_indices` 字段。**总结今日头条时跳过这些 index**, 不要把广告 ("言语社区直播" 等推广) 引用成新闻。
- **coin_ticker / coin_config 写错 key 静默丢字段**: 后端对 coin_list CSV 里不认识的 key 不报错, 直接丢弃。脚本会本地对比, 拿到响应里出现 `unrecognized_keys: [...]` 字段就说明传错了, 不要把部分数据当全数据用。先用 `search` 查准确的 coin_key (例: AiCoin coin_key 命名无规律 — `RNDRToken` 驼峰 / `fet1` 数字后缀 / `virtualprotocol` 连写, 跟 CoinGecko / CMC 完全不一致)。

## Quick Reference

| Task | Command | Min Tier |
|------|---------|----------|
| **Search coin dbKey** | `node scripts/coin.mjs search '{"search":"BTC"}'` — **不确定 symbol 时先用这个查 dbKey** | 免费版 |
| **空投查询** | `node scripts/airdrop.mjs all` — **查空投必用此命令，自动合并交易所空投+链上早期项目** | 基础版 |
| **项目深度分析** | `node scripts/drop_radar.mjs detail '{"airdrop_id":"xxx"}'` — **自动包含团队+X关注，不要用 web_search** | 基础版 |
| **查币上了哪些交易所** | `node scripts/coin.mjs search '{"search":"OPN"}'` — 返回全部交易所交易对 | 免费版 |
| **API Key Info** | `node scripts/coin.mjs api_key_info` — **When user asks about AiCoin API key (配置/安全/能不能下单), ALWAYS run this first.** | 免费版 |
| **Key Health Check (在线探档)** | `node scripts/coin.mjs api_key_info '{"probe":true}'` — **怀疑 key 失效 / 重复 403 时调用**, 串行测 4 个分档接口 (免费 / 基础 / 标准 / 专业), 返回真实能通的档位 (不只看 .env 里写的档位)。过期 key 即使 .env 标 professional 实测可能只剩免费档。 | 免费版 |
| **Update API Key** | `node scripts/coin.mjs update_key '{"key_id":"xxx","secret":"xxx"}'` — **更换 key 必须用此命令（自动验证+写入），禁止直接编辑 .env** | 免费版 |
| BTC price | `node scripts/coin.mjs coin_ticker '{"coin_list":"bitcoin"}'` | 免费版 |
| K-line | `node scripts/market.mjs kline '{"symbol":"btcusdt:okex","period":"3600","size":"100"}'` | 免费版 |
| Funding rate | `node scripts/coin.mjs funding_rate '{"symbol":"BTC"}'` | 基础版 |
| Long/short ratio | `node scripts/features.mjs ls_ratio` | 基础版 |
| Whale orders | `node scripts/features.mjs big_orders '{"symbol":"btcswapusdt:binance"}'` | 标准版 |
| News flash | `node scripts/news.mjs flash_list '{"language":"cn"}'` | 基础版 |
| Trending coins | `node scripts/market.mjs hot_coins '{"key":"defi"}'` | 免费版 |
| Open interest | `node scripts/coin.mjs open_interest '{"symbol":"BTC","interval":"15m"}'` | 专业版 |
| Liquidation map | `node scripts/coin.mjs liquidation_map '{"dbkey":"btcswapusdt:binance","cycle":"24h"}'` | 高级版 |

**Symbol Discovery:** dbKey 格式不用猜。先用 `search` 查，再用返回的 dbKey 调其他接口：
```
node scripts/coin.mjs search '{"search":"BTC"}'          # → dbKeys: ["btcswapusdt:binance", "btcusdt:okex", ...]
node scripts/coin.mjs search '{"search":"CL"}'           # → dbKeys: ["clswapusdc:hyperliquid", ...]
node scripts/market.mjs kline '{"symbol":"从search拿到的dbKey","period":"3600"}'
```

**常用币快捷方式：** `BTC`, `ETH`, `SOL`, `DOGE`, `XRP` 在 coin.mjs 里自动解析，无需 search。其他币必须先 search。

**中文俗称：** 大饼=BTC, 姨太=ETH, 狗狗=DOGE, 瑞波=XRP, 索拉纳=SOL.

## 常用工作流

**空投查询：** 用户问空投/airdrop/优质项目 时，**只需一条命令**查全部数据：
`node scripts/airdrop.mjs all` — 自动同时查交易所空投 + 链上早期项目，合并返回。

**项目深度分析：** 用户问某项目详情/研报时，用 `drop_radar.mjs detail`（自动包含团队 + X关注数据）：
`node scripts/drop_radar.mjs detail '{"airdrop_id":"xxx"}'` — 返回项目详情 + 团队 + X关注列表。
如已发代币，再用 `node scripts/coin.mjs search '{"search":"代币名"}'` 查价格和交易对。
**不要用 web_search 替代**，数据都在脚本里。

**查币上了哪些交易所：** `node scripts/coin.mjs search '{"search":"OPN"}'` — 返回全部交易所的交易对（现货+合约），不要用其他接口拼凑。

**推特/Twitter 讨论：** 用户问推特/Twitter热点时，用 `twitter.mjs latest` 或 `twitter.mjs search`，不要用 newsflash 替代。

**怀疑 key 失效 / 短时间内 ≥ 3 个接口 403：** 不要继续盲打。先跑 `node scripts/coin.mjs api_key_info '{"probe":true}'` 串行测 4 个分档接口，看真实档位。结果只有"免费版"通时, 告诉用户 key 已过期/降权, 引导续费或换 key (`update_key`), 而不是让用户为每个 403 单独升级。

## Free vs Paid Endpoints

**Free (built-in key, no config needed):** `coin_ticker`, `kline`, `hot_coins`, `exchanges`, `pair_ticker`, `news_rss` — only 6 endpoints.

**基础版 ($29/mo) adds:** `coin_list`, `coin_config`, `funding_rate`, `trade_data`, `ticker`, `futures_interest`, `ls_ratio`, `nav`, `pair_by_market`, `pair_list`, `news_list`, `flash_list`, `twitter/latest`, `twitter/search`, `newsflash/search`, `newsflash/list`

**标准版 ($79/mo) adds:** `big_orders`, `agg_trades`, `grayscale_trust`, `gray_scale`, `signal_alert`, `signal_config`, `strategy_signal`, `change_signal`, `depth_latest`, `newsflash`, `news_detail`, `twitter/members`, `twitter/interaction_stats`, `newsflash/detail`

**高级版 ($299/mo) adds:** `liquidation_map`, `liquidation_history`, `liquidation`, `indicator_kline`, `indicator_pairs`, `index_list`, `index_price`, `index_info`, `depth_full`, `depth_grouped`

**专业版 ($699/mo) adds:** `ai_analysis`, `open_interest`, `estimated_liquidation`, `historical_depth`, `super_depth`, `stock_quotes`, `stock_top_gainer`, `stock_company`, `treasury_*`, `stock_market`, `signal_alert_list`, `exchange_listing`

Full tier table: `docs/api-tiers.md`

### 免费档 survival kit — 当 health check 探出只剩免费版时怎么干活

key 过期 / 没续费时, 你能用的只有 6 个免费接口 + aicoin-hyperliquid 的 HL 公共 info API (HL 自家免费)。常见问题的免费档解法:

| 用户问 | 免费档怎么答 |
|---|---|
| BTC/ETH 价格、24h 涨跌、净流入 | `coin.mjs coin_ticker '{"coin_list":"bitcoin,ethereum,solana"}'` (CSV 一次拿多个币, 别分多次调) |
| 1h/4h/1d K 线、近期高低点 | `market.mjs kline '{"symbol":"btcusdt:okex","period":"3600","size":"100"}'` |
| 热门赛道币 (defi 等) | `market.mjs hot_coins '{"key":"defi"}'` — 后端 key 字典有限, 仅 `defi` 通, `meme`/`new` 返空 |
| 跨所现货价比较 | `coin.mjs pair_ticker '{"key_list":"btcusdt:binance,btcusdt:okex,btcusdt:bybit"}'` |
| 今日加密新闻 | `news.mjs news_rss` — 返 RSS XML, 自己解析 |
| 资金费率 / OI / 多空比 / 大单 / 鲸鱼 / 清算 | **拿不到** — 明确告诉用户"这需要 AiCoin 付费档 (从 \$29/月起), 升级地址 https://www.aicoin.com/opendata", 并引导跨 skill: HL 数据用 `aicoin-hyperliquid` (HL 自家免费), 交易所原生数据用 `aicoin-trading` |
| 上市公司持币 (treasury_\*) | **拿不到** — 引导公开源 bitcointreasuries.net (BTC) / ethtreasuries.com (ETH) |
| 推特/KOL | **拿不到** — 引导用户直接看 Twitter 或等 RSS 摘要里 KOL 引用 |

**关键**: 免费档下不要假装能给完整分析。诚实说"这些数据当前 key 拿不到", 再用上面的工作流给能给的部分 + 跨 skill / 公开源 fallback。

## Setup

Scripts work out of the box with a built-in free key (6 endpoints). For more endpoints, add your API key to `.env`:

```
AICOIN_ACCESS_KEY_ID=your-key
AICOIN_ACCESS_SECRET=your-secret
```

**安全说明：** AiCoin API Key 仅用于获取市场数据（行情、K线、新闻等），无法进行任何交易操作，也无法读取你在交易所的信息。如需交易功能，需单独到交易所申请交易 API Key（见 aicoin-trading skill）。所有密钥仅保存在本地设备 `.env` 文件中，不会上传到任何服务器。

**`.env` 自动加载位置**:
- CoinClaw Hermes / Claude Code 容器: `/workspace/.env` (写入 web UI EnvSection 的设置)
- CoinClaw OpenClaw 容器: `/home/node/.openclaw/workspace/.env`
- 本地 host 模式: cwd → `~/.openclaw/workspace/.env` → `~/.openclaw/.env`

## Scripts

All scripts: `node scripts/<name>.mjs <action> [json-params]`

### scripts/coin.mjs — Coin Data

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `search` | **搜索币种，获取 dbKey。** 不确定 symbol 格式时先用这个查。默认返 20/页, 全库 ~350 个币要翻几页才全。**返回字段陷阱**: 每条 `dbKeys` 是**单 string** (例 `"btcswapusdt:binance,btcusdt:okex,..."` 逗号分隔), **不是 array** — 别 `JSON.parse` 也别 `.map`。**page 2+ 经常有些条目 `dbKeys=""` 空 string** (该币没活跃交易对), 翻页结果先 `filter(r => r.dbKeys)` 排除空的再用。`price` 字段是 **CNY** 不是 USD (跟 `coin_ticker.price_cny` 量级一致, 写错会贵 ~6.8 倍)。要 USD 转 `coin_ticker '{"coin_list":"<coin_key>"}'`。 | 免费版 | `{"search":"BTC"}` Optional: `market`, `trade_type`, `page`, `page_size` (例: `{"search":"BTC","page":"2","page_size":"50"}`) |
| `api_key_info` | **AiCoin API Key status + security notice. Run when user asks about key config/safety.** | 免费版 | None |
| `update_key` | **更换 API Key（先验证再写入 .env）。禁止直接编辑 .env 更换 key。** | 免费版 | `{"key_id":"xxx","secret":"xxx"}` |
| `coin_ticker` | Real-time prices. **返回字段单位**: 所有数值都是 string (要 `parseFloat`); `degree_24h_usd`/`degree_7day_usd` 等"涨跌"字段**本身就是百分数** (如 `"-0.61"` = -0.61%, 不要 ×100); `price_usd` 绝对价 USD; `supply_usd` 市值 USD; `trade_24h_usd` 24h 成交额 USD; `fundNetIn_24h_usd` 净流入 USD (负数=流出) | 免费版 | `{"coin_list":"bitcoin,ethereum"}` |
| `coin_list` | List all coins. **硬上限 100 条**, 没有分页。要全量列表先用 `search` 翻页。 | 基础版 | None |
| `coin_config` | Coin profile | 基础版 | `{"coin_list":"bitcoin"}` |
| `funding_rate` | Funding rate. ⚠️ **AiCoin 只覆盖 BTC**, 其他币传进去返空; 想查别的币用 `aicoin-trading exchange.mjs funding_rate`。**硬上限 100 条**。 | 基础版 | `{"symbol":"BTC","interval":"8h"}` Weighted (加权): 加 `"weighted":"true"` (走 vol-weight-history, 返空时有 `_note`) |
| `trade_data` | Trade data | 基础版 | `{"symbol":"btcswapusdt:okcoinfutures"}` |
| `ai_analysis` | AI analysis & prediction. 返空 list 是后端内容池滞后 (脚本加 `_note`), 非接口故障。 | 专业版 | `{"coin_keys":"[\"bitcoin\"]","language":"CN"}` |
| `open_interest` | Open interest. **硬上限 100 条**。 | 专业版 | `{"symbol":"BTC","interval":"15m"}` Coin-margined: add `"margin_type":"coin"` |
| `liquidation_map` | Liquidation heatmap. **返**嵌套结构 `data.data_map`: **按杠杆分桶** (key 是 leverage `"10"`/`"25"`/`"50"`/`"100"`), 每桶下 `{long: [...], short: [...]}` 价格区间 + 清算金额。要总清算需自己跨桶求和。 | 高级版 | `{"symbol":"btcswapusdt:binance","cycle":"24h"}` `cycle` 仅 `24h` / `7d` |
| `liquidation_history` | Liquidation history. **硬上限 100 条**。 | 高级版 | `{"symbol":"btcswapusdt:binance","interval":"1m"}` |
| `estimated_liquidation` | Estimated liquidation. **返**结构 `data.time_points` (object, **key 是秒级 unix 时间戳**, value 是该时间点的 `{columns, rows}` 二维表 — columns=["leverage","direction","from_price","to_price","turnover"], rows 多行)。注意 time_points key 是秒不是毫秒, 跟 funding_rate/OI 的毫秒不一样。 | 专业版 | `{"symbol":"btcswapusdt:binance","cycle":"24h"}` |
| `historical_depth` | Historical depth. **硬上限 100 条**, 窗口短 (~100 秒)。 | 专业版 | `{"symbol":"btcswapusdt:okcoinfutures"}` |
| `super_depth` | Large order depth ≥ amount (默认 $10k)。返空时脚本加 `_note` 提示 "窗口短或没大单, 调小 amount 或换交易对"。 | 专业版 | `{"symbol":"btcswapusdt:okcoinfutures","amount":"10000"}` |

### scripts/market.mjs — Market Data

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `kline` | Standard K-line. **时间戳是秒级 unix**, 不是毫秒。 | 免费版 | `{"symbol":"btcusdt:okex","period":"3600","size":"100"}` period: 900/3600/14400/86400 |
| `hot_coins` | Trending coins. **实测只 `defi` 通**, `meme`/`new` 返空 (脚本加 `_note`)。查 meme 走 `coin.search '{"search":"meme"}'`。 | 免费版 | `{"key":"defi"}` (gamefi/anonymous/market/web/newcoin/stable/defi 字典见后端) |
| `exchanges` | Exchange list | 免费版 | None |
| `ticker` | ⚠️ **返的是平台整体 24h 资金净流入** (`fundNetInCny`/`fundNetInUsd`), **不是单币 OHLC**。单币行情用 `coin.coin_ticker` 或 `features.pair_ticker`。 | 基础版 | `{"market_list":"okex,binance"}` |
| `futures_interest` | Futures OI ranking | 基础版 | `{"language":"cn"}` |
| `depth_latest` | Real-time depth. **交易所覆盖有空洞** (实测 Q8 v2): `binance` / `okex` / `bybit` / `huobipro` 通; `gate` / `coinbase` 返 `Invalid dbKey: depth data not found` 即便 pair_ticker 能查到价。pair_ticker 通 ≠ depth_latest 通。默认 50 档 (够 1 万-100 万 USD 模拟), 更大量级要 `depth_full`。 | 标准版 | `{"symbol":"btcswapusdt:binance"}` |
| `indicator_kline` | Indicator K-line. **返**嵌套结构 `data.kline_data` 是 **dict** (不是 array) — `{list: [[ts_str, value_str], ...], mapping: ["timestamp","value"]}`。跟普通 `kline.kline_data[]` 直接数组结构**不同**, agent 别复用解析代码。 | 高级版 | `{"symbol":"btcswapusdt:binance","indicator_key":"fundflow","period":"3600"}` Optional: `open_time`, `since` |
| `indicator_pairs` | Indicator pairs. **`indicator_key` + `coinType` 双必填**, 缺 coinType 上游返 400 (不是脚本本地拦截, 直接报错)。 | 高级版 | `{"indicator_key":"fundflow","coinType":"USDT"}` |
| `index_list` | Index list | 高级版 | None |
| `index_price` | Index price | 高级版 | `{"key":"i:diniw:ice"}` |
| `index_info` | Index details | 高级版 | `{"key":"i:diniw:ice"}` |
| `depth_full` | Full order book | 高级版 | `{"symbol":"btcswapusdt:binance"}` |
| `depth_grouped` | Grouped depth | 高级版 | `{"symbol":"btcswapusdt:binance","groupSize":"100"}` |
| `stock_quotes` | ⚠️ **"加密概念股"专用**, 不是通用美股接口 — 端点路径 `/crypto_stock/quotes`, 只覆盖 AiCoin 整理的加密相关公司 (MSTR/COIN/TSLA/BULL 等约 2-30 家)。**NVDA/AAPL/MSFT 等通用股票返空**, 不是接口故障。用户问通用美股价格直接说"AiCoin 这套接口只覆盖加密概念股, 通用美股查 Google Finance / 交易软件"。 | 专业版 | `{"tickers":"i:mstr:nasdaq"}` 不传 tickers 返默认 2 条 |
| `stock_top_gainer` | 同 `stock_quotes` — 加密概念股范围内的涨幅榜, 不是全美股 | 专业版 | `{"us_stock":"true"}` |
| `stock_company` | Company details — 见 [Known Issues](#known-issues-broken--临时不稳的端点) 后端偶发 500。同范围仅加密概念股 | 专业版 | `{"symbol":"i:mstr:nasdaq"}` |
| `treasury_summary` | Holdings overview (单 object: total_entities / total_hold_amount / total_value_usd / last_update_time) | 专业版 | `{"coin":"BTC"}` |
| `treasury_latest_entities` | 最新国库实体快照 (GET, 返 `data: list[]` 直接数组, 359 实体) | 专业版 | `{"coin":"BTC"}` |
| `treasury_latest_history` | 最新变动流水 (GET, 返 `data: list[]` 直接数组) | 专业版 | `{"coin":"BTC"}` |
| `treasury_entities` | **POST**, **分页版** latest_entities (返 `data: {list, total, page, page_size}` 嵌套, total=359). 想要全量翻页用这个不是 latest_entities | 专业版 | `{"coin":"BTC","page":1,"page_size":20}` |
| `treasury_history` | **POST**, **分页版** latest_history (返 `data: {list, total}` 嵌套, 全量 ~3648 条变动)。每条字段: `type` (Buy/Sell), `balance` (变动后余额), `change` (本次变动量), `total_cost_usd` 是**历史累计成本不是单次成本** (求单次买入额自己算相邻 total_cost_usd 差值), `stock_price` 当时股价。 | 专业版 | `{"coin":"BTC","page":1,"page_size":50}` |
| `treasury_accumulated` | **POST**, 累积曲线 (返 `data: {accumulated_data: [...]}` 嵌套, 30 天每天一点)。每天一个 `{date, total_amount}` 累计点。 | 专业版 | `{"coin":"BTC"}` |

### scripts/features.mjs — Features & Signals

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `pair_ticker` | Pair ticker | 免费版 | `{"key_list":"btcusdt:okex,btcusdt:huobipro"}` |
| `ls_ratio` | Long/short ratio. ⚠️ **全局加权汇总, 不分交易所/币种**。返 `{last, last_day, last_week}` 三个数 (>1 多头占优, <1 空头占优)。Open API 没暴露 marketKey 过滤, 用户要看 Binance/OKX 单所多空比时老实告知"Open API 当前只返全局, 分交易所版去 aicoin.com 网页端"。 | 基础版 | None |
| `nav` | Market navigation | 基础版 | `{"language":"cn"}` |
| `pair_by_market` | Pairs by exchange | 基础版 | `{"market":"binance"}` |
| `pair_list` | Pair list (必填 market) | 基础版 | `{"market":"binance","currency":"USDT"}` |
| `grayscale_trust` | Grayscale trust 总览 (GBTC/ETHE) | 标准版 | None |
| `gray_scale` | Grayscale 单币持仓细分。脚本自动把 BTC/ETH 转 bitcoin/ethereum。返空 detail 时脚本加 `_note`, 引导改用 `grayscale_trust`。 | 标准版 | `{"coins":"bitcoin,ethereum"}` |
| `signal_alert` | ⚠️ **返的是当前账号在 AiCoin 网页端配置过的预警**, 不是全市场实时触发列表。用户没配过任何预警时返空; 配了 ETH 预警就只看到 ETH 触发。**返回字段**: `tp_key` (币:周期) / `sub_type` (信号子类) / `side` (long/short) / `ews_price` / `ews_time`。**没有 `winRate` 字段** (那是 strategy_signal 才有的)。要看全市场技术指标实时触发, AiCoin Open API **暂未暴露**, 用户引导去 aicoin.com 网页端"指标信号"板块。 | 标准版 | None |
| `signal_alert_list` | 同 `signal_alert` — 返当前账号订阅的预警列表 (不是全市场) | 专业版 | None |
| `signal_config` | Alert config — 系统支持的指标 + 周期字典 (MA/MACD/BOLL/TD/RSI/KDJ 等), **不返实时触发**, 只是配置目录 | 标准版 | `{"language":"cn"}` |
| `strategy_signal` | 见 [Known Issues](#known-issues-broken--临时不稳的端点) — 后端 broken 脚本本地拦截 | 标准版 | — |
| `change_signal` | Anomaly signal | 标准版 | `{"type":"1"}` |
| `big_orders` | Whale orders. ⚠️ **仅支持 8 家** (binance 永续+现货 / okcoinfutures(OKX 永续) / bybit / bitget / gate / coinbase / upbit), 其他交易所脚本本地拒绝。**`high_amount` 单位是合约张数不是币数量** (OKX 永续 1 张=0.01 BTC; Binance 永续 1 张=1 BTC), 用户输出**必须用美元金额 `high_turnover`**, 别报"X 张" / "X BTC"。 | 标准版 | `{"symbol":"btcswapusdt:binance"}` (OKX 永续传 `:okcoinfutures`, bitget 永续传 `btcumcblusdt:bitget`; 写错的也会被脚本自动转) |
| `agg_trades` | 同 big_orders。**注: bybit agg_trades 当前后端返空 list** (success=true 但 list 长度 0), 调用方判长度。 | 标准版 | 同 big_orders |
| `liquidation` | Liquidation data | 高级版 | `{"type":"1","coinKey":"bitcoin"}` |
| `stock_market` | Crypto stocks index (4 大盘: 上证 / 纳指 / 道指 / 标普) | 专业版 | None |
| `delete_signal` | Delete alert | 专业版 | `{"id":"xxx"}` |
| `add_signal` | Add signal alert | 标准版 | `{"subType":"ma:1440:single_ma:7","symbol":"btcusdt:binance"}` Optional: `remark` |

### scripts/news.mjs — News & Content

> **news.mjs 和 newsflash.mjs 怎么区分？**
> - `news.mjs` 4 个 action (`news_list` / `flash_list` / `newsflash` / `news_rss`) 是**只读拉取**老一代 `/api/v2/content/*` 端点, 接口固定参数少, 拿到的是按时间倒序的快照。
> - `newsflash.mjs` 3 个 action (`list` / `search` / `detail`) 是 **OpenData** 新一代 `/api/upgrade/v2/content/newsflash/*` 端点, 支持分页 / 关键词搜索 / 多种 tab / 日期跳转, 拿单条 detail 也只能用这个。
> - 想要"今日头条总览" → `news.mjs flash_list` 一条命令; 想要"按 BTC 关键词找历史快讯" → `newsflash.mjs search`; 想要"翻第 2 页 / 看 5 月 1 号当天" → `newsflash.mjs list`。

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `news_rss` | RSS news feed. **返 XML/RSS 不是 JSON** — 脚本用 `apiGetText` 返 `{contentType, body}`, body 是 XML 字符串。agent 收到后**不要 JSON.parse**, 直接转告用户原文或用 XML parser 解析。 | 免费版 | `{"page":"1"}` |
| `news_list` | News list (老接口, 不分页固定参数) | 基础版 | `{"page":"1","page_size":"20"}` |
| `flash_list` | 行业快讯总览 (老接口, 今日头条用这个) | 基础版 | `{"language":"cn"}` |
| `newsflash` | AiCoin flash news (老接口) | 标准版 | `{"language":"cn"}` |
| `news_detail` | News detail | 标准版 | `{"id":"xxx"}` |
| `exchange_listing` | Exchange listing announcements | 专业版 | `{"memberIds":"477,1509"}` |

### scripts/twitter.mjs — Twitter/X Crypto Tweets

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `latest` | Latest crypto tweets | 基础版 | `{"language":"cn","page_size":"20"}` |
| `search` | Search tweets | 基础版 | `{"keyword":"bitcoin","language":"cn","page_size":"20"}` |
| `members` | Search KOL/users | 标准版 | `{"keyword":"elon","page":"1","page_size":"20"}` |
| `interaction_stats` | Tweet engagement stats | 标准版 | `{"flash_ids":"123,456,789"}` |

### scripts/newsflash.mjs — Newsflash (OpenData)

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `search` | Search newsflash | 基础版 | `{"keyword":"bitcoin","page":"1","page_size":"20"}` |
| `list` | Newsflash list. **返回结构** `{data:{isLive, list:[...]}}`, 每条最常用 4 字段: `timestamp` (秒级 unix, **不是 createtime/publish_time**), `title`, `content`, `is_important`/`is_pro`。双语版用 `transTitle`/`transContent`。 | 基础版 | `{"page_size":"20","language":"cn"}` |
| `detail` | Newsflash full content | 标准版 | `{"flash_id":"123456"}` |

### scripts/airdrop.mjs — Airdrop (OpenData)

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `all` | **综合查询（推荐）** — 同时查交易所空投+链上早期项目，合并返回。**返回结构特殊**: 顶层 key 是**中文** (`{交易所空投: {...}, 链上早期项目: {...}}`), 不是标准 `{data:...}`。agent 别按 `data` 取字段。 | 基础版 | `{"page_size":"20"}` Optional: `status`, `keyword`, `lan` |
| `list` | Airdrop projects list (multi-source) | 基础版 | `{"source":"all","status":"ongoing","page":"1","page_size":"20","exchange":"binance"}` |
| `detail` | Airdrop detail — 见 [Known Issues](#known-issues-broken--临时不稳的端点) 后端偶发 500 | 标准版 | `{"type":"hodler","token":"SIGN"}` |
| `banner` | Hot airdrop banners | 基础版 | `{"limit":"5"}` |
| `exchanges` | Available exchanges and activity types | 基础版 | `{"lan":"cn"}` |
| `calendar` | Airdrop calendar. 不传 year/month 时脚本默认当月。 | 标准版 | `{"year":"2026","month":"3"}` |

**Source options for list:** `all`(default), `hodler`, `xlaunch`, `earncoin`, `alpha`, `bitget_launchpool`, `bitget_poolx`

### scripts/drop_radar.mjs — Drop Radar (OpenData)

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `list` | Project list with filters. 用 `filters` action 拿到合法的 status/board/eco 选项再筛, 别瞎传 (例 `status:"CONFIRMED"+keyword:"airdrop"` 组合实测筛 0 条)。 | 基础版 | `{"page":"1","page_size":"20"}` Optional: `status`/`activity_type`/`reward_type`/`keyword`/`board_keys`/`eco_keys`/`sort_by` |
| `detail` | Project detail（自动包含团队+X关注） | 基础版 | `{"airdrop_id":"xxx"}` |
| `widgets` | Statistics overview | 基础版 | `{"lan":"cn"}` |
| `filters` | Available filter options | 基础版 | `{"lan":"cn"}` |
| `events` | Project event calendar | 标准版 | `{"airdrop_id":"xxx"}` |
| `team` | Project team members | 标准版 | `{"airdrop_id":"xxx"}` |
| `x_following` | Project X following list | 标准版 | `{"airdrop_id":"xxx"}` |
| `status_changes` | Recent status changes | 标准版 | `{"days":"7","page":"1","page_size":"20"}` |
| `tweets` | Search project tweets. 不传 keywords 时脚本默认 `"airdrop"`。 | 标准版 | `{"keywords":"bitcoin,airdrop","page_size":"20"}` |

## Cross-Skill References

| Need | Use |
|------|-----|
| Exchange trading (buy/sell/balance) | **aicoin-trading** |
| Freqtrade strategies/backtest/deploy | **aicoin-freqtrade** |
| Hyperliquid whale tracking | **aicoin-hyperliquid** |

## Common Errors

- `errorCode 304 / HTTP 403` — Paid feature. Script output includes upgrade link and instructions. Show them to user. Do NOT retry.
- `Invalid symbol` — Check format: AiCoin uses `btcusdt:okex`, not `BTC/USDT`
- `Rate limit exceeded` — Wait 1-2s between requests; use batch queries
