# aicoin-market CHANGELOG

修复历史 (给开发者看, 非 agent 必读 — agent 操作指南看 SKILL.md)。

## 2026-05 — 实测踩坑批量修复

跑了 100+ endpoint 实测,发现一批命名漂移、参数缺省、上游故障没提示、字段语义不清的问题。
agent 调用时容易把上游故障当用户参数错,误导用户。

### 脚本透明处理 (agent 无感知,直接用就行)

- **平台 symbol 自动修正** (`coin.mjs` fixPlatformAlias + `features.mjs` fixPlatformAlias):
  - OKX 永续 `:okex` 自动转 `:okcoinfutures` (后者是 OKX U 永续真实 platform key)
  - Bitget 永续 `swapusdt:bitget` 自动转 `umcblusdt:bitget`
- **Action alias** (兼容老 SKILL.md 命名):
  - `coin.mjs`: `ai_coins` → `ai_analysis`
  - `features.mjs`: `liq` → `liquidation`
  - `news.mjs`: `exchange_listing_flash` → `exchange_listing`
- **空 list `_note` 注解** (区分"数据空 vs 接口故障"):
  - `coin.funding_rate weighted=true` 返空时加 `_note` 提示上游窗口数据未填或权限差异
  - `coin.super_depth` 返空时加 `_note` 提示观察窗口短或没大单
  - `coin.ai_analysis` 返空 list 时加 `_note` 提示后端内容池滞后
  - `market.hot_coins` 返空时加 `_note` 提示 key 字典限定 + 引导用 `coin.search`
  - `features.gray_scale` 上游 detail 返空 {} 时加 `_note` 引导改用 `grayscale_trust`
- **参数标准化**:
  - `features.gray_scale` 把 BTC/ETH 自动转 bitcoin/ethereum (上游只接受小写完整名)
- **默认值兜底** (减少必填参数缺失的 400):
  - `airdrop.calendar` 默认当月 year/month
  - `drop_radar.tweets` 默认 keywords="airdrop"
  - `market.depth_grouped` 默认 groupSize="100"

### 错误处理增强 (agent 必读, 见 SKILL.md Known Issues)

- `lib/aicoin-api.mjs` `apiGet/apiPost` 加 `upstreamFaultHint`:
  - 502/503/504 → "网关临时故障, 建议重试 1-2 分钟"
  - 500/501/505+ → "后端异常, 联系 service@aicoin.com"
- 在 catch 里返 `实测结论` 字段引导联系客服:
  - `market.stock_company` (实测 COIN/MSTR 都返 500)
  - `airdrop.detail` (实测三种 type+token 组合都 500)
- `features.strategy_signal` 后端 broken (公开 signal_key 全 400): 本地无条件返实测结论, 不调上游
- `features.big_orders/agg_trades` 不支持的交易所 (huobi/kraken/mexc/kucoin/bithumb/bitfinex/binancespot 等) 本地拒绝, 不浪费签名

### 字段单位/语义陷阱 (SKILL.md 已写入 action 详细说明)

- `coin_ticker`: `degree_*` 字段值本身就是百分数(如 -0.61 表示 -0.61%, 不要 ×100); 所有数值都是 string 要 parseFloat
- `big_orders/agg_trades`: `high_amount` 单位是合约张数不是币数量 (OKX 永续 1 张=0.01 BTC; Binance 永续 1 张=1 BTC), 用户输出用 `high_turnover` (美元)
- `ls_ratio`: 全局加权, 不分交易所/币种 (Open API 没暴露 marketKey 参数)
- `market.ticker`: 返的是平台整体 24h 资金净流入, 不是单币 OHLC (单币用 `coin_ticker` / `pair_ticker`)
- `newsflash list`: 时间字段是 `timestamp` (秒级 unix), 不是 `createtime` / `publish_time`

### API 设计限制 (SKILL.md 已写入对应 action description)

- `funding_rate` 只支持 BTC, 其他币走 `aicoin-trading exchange.mjs funding_rate`
- `coin_list / funding_rate / open_interest / historical_depth / trade_data` 硬上限 100 条, 没有分页
- `search` 支持 page/page_size 翻页 (全库 ~350 个币)
- `hot_coins` key 字典只 `defi` 通, `meme/new` 返空 — 用户问 meme 走 `coin.search`

## 提交时间线

- `5caa59b` (2026-05): 第 1 轮 12 文件 458 行 — 平台 alias / 命名 alias / 上游 5xx hint / 默认参数 / requireAddress (HL skill)
- `2287691` (2026-05): 第 2 轮 5 文件 64 行 — strategy_signal 无条件拦截 / 业务错误 wrapPositionNotFound (HL skill) / 空 list `_note` / 文档补
- `1fd7628` (2026-05): polish 2 文件 19 行 — hot_coins / gray_scale 空 list 加 `_note`
- `b9a99f0..65cc23a` (2026-05): demo 阶段挖到 6 个字段语义陷阱 — degree/ls_ratio/HIP-3/smart_find/newsflash/high_amount
