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
6. **On 304/403 error — STOP, do NOT retry.** This is a paid feature. Follow the [Paid Feature Guide](#paid-feature-guide) to help the user upgrade.
7. **更换 API Key 只能用 `update_key` 命令。** 禁止直接编辑 .env、禁止用 gateway/edit 工具改 key。`update_key` 会先验证 key 有效才写入。
8. **上游故障 (HTTP 5xx / `_note` 含"后端"或"实测结论") 不是用户参数错。** 当返回 JSON 含 `实测结论` 字段时,**必须**把该提示原文转告用户,引导联系 AiCoin 客服 (service@aicoin.com),**不要**让用户改参数重试。

## 2026-05 实测踩坑修复 (已自动处理,这里只是知会)

- `big_orders` / `agg_trades` 实测**仅支持 8 家**: binance(永续+现货) / okcoinfutures(OKX 永续) / bybit / bitget(用 btcumcblusdt) / gate / coinbase / upbit。脚本自动把 `:okex` 转 `:okcoinfutures`, `btcswapusdt:bitget` 转 `btcumcblusdt:bitget`. huobi/kraken/mexc/kucoin 等会被脚本本地拒绝并返清晰提示
- `funding_rate` AiCoin 只覆盖 BTC,其他币改用 `aicoin-trading exchange.mjs funding_rate`
- `strategy_signal` 后端 broken: 公开的 signal_key 格式 (`depth_win_one` 等) 实测都返 400。脚本会直接返 `实测结论: AiCoin 接口故障` 提示, **不要重试**
- `stock_company` / `airdrop detail` / `hl/traders/accounts` 后端偶发 500: 脚本会捕获并返清晰提示告诉用户联系客服, **不要让用户改参数**
- `ai_analysis` 返空 list 是后端内容池空, 不是接口故障. 脚本会加 `_note` 提示
- `funding_rate weighted=true` / `super_depth` 返空 list 通常是窗口/数据问题, 脚本加 `_note` 区分
- `liq` 是 `liquidation` 的 alias; `ai_coins` 是 `ai_analysis` 的 alias; `exchange_listing_flash` 是 `exchange_listing` 的 alias — 都可用
- 多个端点的硬上限 100 条 (coin_list / funding_rate / open_interest / historical_depth / trade_data), 没有 pagination, 别问"为啥只有 100 条"
- `search` 支持翻页参数: `{"search":"BTC","page":"2","page_size":"50"}` (默认 page=1 / page_size=20, 全库 ~350 个币要翻几页才全)
- `hot_coins` 的 `key` 实测只 `defi` 通; `meme` / `new` 都返空,可能需要后端更新字典。 用户问 meme 热点币改用 `coin.mjs search '{"search":"meme","trade_type":"spot"}'`
- `market.mjs ticker '{"market_list":"binance"}'` 返的是**平台整体 24h 资金净流入**, 不是单币 OHLC。 单币行情用 `coin.mjs coin_ticker` 或 `features.mjs pair_ticker`
- **`coin_ticker` 返回字段单位陷阱**: 所有数值都是 **string 类型**, 别忘了 `parseFloat`。`degree_24h_usd` / `degree_7day_usd` / `degree_24h_cny` 等"涨跌"字段 **本身就是百分比数值**, 例如 `"-0.61"` 表示 **-0.61%**, **不要再 ×100**。`price_usd` / `price_cny` 是绝对价格,`supply_usd` 是市值(USD),`trade_24h_usd` 是 24h 成交额(USD),`fundNetIn_24h_usd` 是 24h 净流入(USD,负数=流出)。
- **`ls_ratio` 是全局加权汇总, 不分交易所/币种**: 返回 `{detail: {last, last_day, last_week}}` 三个数, 代表全市场多空比快照 (`last`=现在 / `last_day`=24h 前 / `last_week`=一周前)。 `>1` 多头占优, `<1` 空头占优。 **Open API 暂未暴露分交易所/分币种的多空比**, 用户要看 Binance/OKX 单所多空比时, 老实告知"AiCoin Open API 当前只返全局多空比, 分交易所版本暂未开放, 可去 aicoin.com 网页端查看"。 不要瞎猜参数 (传 `symbol` / `marketKey` 都没用, 接口忽略)。
- **`newsflash.mjs list` 字段名陷阱**: 返回结构是 `{data: {isLive, list: [...]}}`, 每条快讯有 40+ 字段(直播 / 投票 / Pro 等冗余字段), 但**最常用的就 4 个**: `timestamp` (秒级 unix, 不是 createtime/publish_time), `title` (标题), `content` (正文), `is_important` / `is_pro` (重要 / Pro 标记)。 想要双语版用 `transTitle` / `transContent`。 别瞎猜 `createtime` / `content_text` / `description` —— 不存在。

## Quick Reference

| Task | Command | Min Tier |
|------|---------|----------|
| **Search coin dbKey** | `node scripts/coin.mjs search '{"search":"BTC"}'` — **不确定 symbol 时先用这个查 dbKey** | 免费版 |
| **空投查询** | `node scripts/airdrop.mjs all` — **查空投必用此命令，自动合并交易所空投+链上早期项目** | 基础版 |
| **项目深度分析** | `node scripts/drop_radar.mjs detail '{"airdrop_id":"xxx"}'` — **自动包含团队+X关注，不要用 web_search** | 基础版 |
| **查币上了哪些交易所** | `node scripts/coin.mjs search '{"search":"OPN"}'` — 返回全部交易所交易对 | 免费版 |
| **API Key Info** | `node scripts/coin.mjs api_key_info` — **When user asks about AiCoin API key (配置/安全/能不能下单), ALWAYS run this first.** | 免费版 |
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

## Free vs Paid Endpoints

**Free (built-in key, no config needed):** `coin_ticker`, `kline`, `hot_coins`, `exchanges`, `pair_ticker`, `news_rss` — only 6 endpoints.

**基础版 ($29/mo) adds:** `coin_list`, `coin_config`, `funding_rate`, `trade_data`, `ticker`, `futures_interest`, `ls_ratio`, `nav`, `pair_by_market`, `pair_list`, `news_list`, `flash_list`, `twitter/latest`, `twitter/search`, `newsflash/search`, `newsflash/list`

**标准版 ($79/mo) adds:** `big_orders`, `agg_trades`, `grayscale_trust`, `gray_scale`, `signal_alert`, `signal_config`, `strategy_signal`, `change_signal`, `depth_latest`, `newsflash`, `news_detail`, `twitter/members`, `twitter/interaction_stats`, `newsflash/detail`

**高级版 ($299/mo) adds:** `liquidation_map`, `liquidation_history`, `liquidation`, `indicator_kline`, `indicator_pairs`, `index_list`, `index_price`, `index_info`, `depth_full`, `depth_grouped`

**专业版 ($699/mo) adds:** `ai_analysis`, `open_interest`, `estimated_liquidation`, `historical_depth`, `super_depth`, `stock_quotes`, `stock_top_gainer`, `stock_company`, `treasury_*`, `stock_market`, `signal_alert_list`, `exchange_listing`

Full tier table: `docs/api-tiers.md`

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
| `search` | **搜索币种，获取 dbKey。** 不确定 symbol 格式时先用这个查。 | 免费版 | `{"search":"BTC"}` Optional: `market`, `trade_type`, `page`, `page_size` |
| `api_key_info` | **AiCoin API Key status + security notice. Run when user asks about key config/safety.** | 免费版 | None |
| `update_key` | **更换 API Key（先验证再写入 .env）。禁止直接编辑 .env 更换 key。** | 免费版 | `{"key_id":"xxx","secret":"xxx"}` |
| `coin_ticker` | Real-time prices | 免费版 | `{"coin_list":"bitcoin,ethereum"}` |
| `coin_list` | List all coins | 基础版 | None |
| `coin_config` | Coin profile | 基础版 | `{"coin_list":"bitcoin"}` |
| `funding_rate` | Funding rate (BTC only, aggregated) | 基础版 | `{"symbol":"BTC","interval":"8h"}` Weighted: add `"weighted":"true"` (基础版). For per-exchange real-time rates, use **aicoin-trading**: `node scripts/exchange.mjs funding_rate '{"exchange":"binance","symbol":"BTC/USDT:USDT"}'` |
| `trade_data` | Trade data | 基础版 | `{"symbol":"btcswapusdt:okcoinfutures"}` |
| `ai_analysis` | AI analysis & prediction | 专业版 | `{"coin_keys":"[\"bitcoin\"]","language":"CN"}` |
| `open_interest` | Open interest | 专业版 | `{"symbol":"BTC","interval":"15m"}` Coin-margined: add `"margin_type":"coin"` |
| `liquidation_map` | Liquidation heatmap | 高级版 | `{"symbol":"btcswapusdt:binance","cycle":"24h"}` |
| `liquidation_history` | Liquidation history | 高级版 | `{"symbol":"btcswapusdt:binance","interval":"1m"}` |
| `estimated_liquidation` | Estimated liquidation | 专业版 | `{"symbol":"btcswapusdt:binance","cycle":"24h"}` |
| `historical_depth` | Historical depth | 专业版 | `{"symbol":"btcswapusdt:okcoinfutures"}` |
| `super_depth` | Large order depth >$10k | 专业版 | `{"symbol":"btcswapusdt:okcoinfutures"}` |

### scripts/market.mjs — Market Data

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `kline` | Standard K-line | 免费版 | `{"symbol":"btcusdt:okex","period":"3600","size":"100"}` period: 900/3600/14400/86400 |
| `hot_coins` | Trending coins | 免费版 | `{"key":"defi"}` key: gamefi/anonymous/market/web/newcoin/stable/defi |
| `exchanges` | Exchange list | 免费版 | None |
| `ticker` | Exchange tickers | 基础版 | `{"market_list":"okex,binance"}` |
| `futures_interest` | Futures OI ranking | 基础版 | `{"language":"cn"}` |
| `depth_latest` | Real-time depth | 标准版 | `{"symbol":"btcswapusdt:binance"}` |
| `indicator_kline` | Indicator K-line | 高级版 | `{"symbol":"btcswapusdt:binance","indicator_key":"fundflow","period":"3600"}` Optional: `open_time`, `since` |
| `indicator_pairs` | Indicator pairs | 高级版 | `{"indicator_key":"fundflow"}` |
| `index_list` | Index list | 高级版 | None |
| `index_price` | Index price | 高级版 | `{"key":"i:diniw:ice"}` |
| `index_info` | Index details | 高级版 | `{"key":"i:diniw:ice"}` |
| `depth_full` | Full order book | 高级版 | `{"symbol":"btcswapusdt:binance"}` |
| `depth_grouped` | Grouped depth | 高级版 | `{"symbol":"btcswapusdt:binance","groupSize":"100"}` |
| `stock_quotes` | Stock quotes | 专业版 | `{"tickers":"i:mstr:nasdaq"}` |
| `stock_top_gainer` | Top gainers | 专业版 | `{"us_stock":"true"}` |
| `stock_company` | Company details | 专业版 | `{"symbol":"i:mstr:nasdaq"}` |
| `treasury_entities` | Holding entities | 专业版 | `{"coin":"BTC"}` |
| `treasury_history` | Transaction history | 专业版 | `{"coin":"BTC"}` |
| `treasury_accumulated` | Accumulated holdings | 专业版 | `{"coin":"BTC"}` |
| `treasury_latest_entities` | Latest entities | 专业版 | `{"coin":"BTC"}` |
| `treasury_latest_history` | Latest history | 专业版 | `{"coin":"BTC"}` |
| `treasury_summary` | Holdings overview | 专业版 | `{"coin":"BTC"}` |

### scripts/features.mjs — Features & Signals

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `pair_ticker` | Pair ticker | 免费版 | `{"key_list":"btcusdt:okex,btcusdt:huobipro"}` |
| `ls_ratio` | Long/short ratio | 基础版 | None |
| `nav` | Market navigation | 基础版 | `{"language":"cn"}` |
| `pair_by_market` | Pairs by exchange | 基础版 | `{"market":"binance"}` |
| `pair_list` | Pair list | 基础版 | `{"market":"binance","currency":"USDT"}` |
| `grayscale_trust` | Grayscale trust | 标准版 | None |
| `gray_scale` | Grayscale holdings (脚本自动把 BTC/ETH 转 bitcoin/ethereum) | 标准版 | `{"coins":"bitcoin,ethereum"}` |
| `signal_alert` | Signal alerts | 标准版 | None |
| `signal_config` | Alert config | 标准版 | `{"language":"cn"}` |
| `strategy_signal` | ⚠️ **后端 broken**: SKILL.md 推荐参数实测全 400, agent 调用会拿到 `实测结论` 提示, 不要重试 | 标准版 | (broken) |
| `change_signal` | Anomaly signal | 标准版 | `{"type":"1"}` |
| `big_orders` | Whale orders. ⚠️ 仅支持 8 家 (binance/okcoinfutures/bybit/bitget/gate/coinbase/upbit). OKX 永续用 `okcoinfutures` 不是 `okex` (脚本自动转), bitget 永续 symbol 也自动转 `btcumcblusdt` | 标准版 | `{"symbol":"btcswapusdt:binance"}` |
| `agg_trades` | 同 big_orders 覆盖范围。**注: bybit agg_trades 当前空数据** | 标准版 | `{"symbol":"btcswapusdt:binance"}` |
| `liquidation` | Liquidation data | 高级版 | `{"type":"1","coinKey":"bitcoin"}` |
| `signal_alert_list` | Alert list | 专业版 | None |
| `stock_market` | Crypto stocks | 专业版 | None |
| `delete_signal` | Delete alert | 专业版 | `{"id":"xxx"}` |
| `add_signal` | Add signal alert | 标准版 | `{"subType":"ma:1440:single_ma:7","symbol":"btcusdt:binance"}` Optional: `remark` |

### scripts/news.mjs — News & Content

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `news_rss` | RSS news feed | 免费版 | `{"page":"1"}` |
| `news_list` | News list | 基础版 | `{"page":"1","page_size":"20"}` |
| `flash_list` | Industry flash news | 基础版 | `{"language":"cn"}` |
| `newsflash` | AiCoin flash news | 标准版 | `{"language":"cn"}` |
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
| `list` | Newsflash list with filters | 基础版 | `{"page_size":"20","language":"cn"}` |
| `detail` | Newsflash full content | 标准版 | `{"flash_id":"123456"}` |

### scripts/airdrop.mjs — Airdrop (OpenData)

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `all` | **综合查询（推荐）** — 同时查交易所空投+链上早期项目，合并返回 | 基础版 | `{"page_size":"20"}` Optional: `status`, `keyword`, `lan` |
| `list` | Airdrop projects list (multi-source) | 基础版 | `{"source":"all","status":"ongoing","page":"1","page_size":"20","exchange":"binance"}` |
| `detail` | Airdrop detail (hodler/xlaunch) | 标准版 | `{"type":"hodler","token":"SIGN"}` |
| `banner` | Hot airdrop banners | 基础版 | `{"limit":"5"}` |
| `exchanges` | Available exchanges and activity types | 基础版 | `{"lan":"cn"}` |
| `calendar` | Airdrop calendar (year+month required) | 标准版 | `{"year":"2026","month":"3"}` |

**Source options for list:** `all`(default), `hodler`, `xlaunch`, `earncoin`, `alpha`, `bitget_launchpool`, `bitget_poolx`

### scripts/drop_radar.mjs — Drop Radar (OpenData)

| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `list` | Project list with filters | 基础版 | `{"page":"1","page_size":"20","status":"CONFIRMED","keyword":"airdrop"}` |
| `detail` | Project detail（自动包含团队+X关注） | 基础版 | `{"airdrop_id":"xxx"}` |
| `widgets` | Statistics overview | 基础版 | `{"lan":"cn"}` |
| `filters` | Available filter options | 基础版 | `{"lan":"cn"}` |
| `events` | Project event calendar | 标准版 | `{"airdrop_id":"xxx"}` |
| `team` | Project team members | 标准版 | `{"airdrop_id":"xxx"}` |
| `x_following` | Project X following list | 标准版 | `{"airdrop_id":"xxx"}` |
| `status_changes` | Recent status changes | 标准版 | `{"days":"7","page":"1","page_size":"20"}` |
| `tweets` | Search project tweets | 标准版 | `{"keywords":"bitcoin,airdrop","page_size":"20"}` |

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
