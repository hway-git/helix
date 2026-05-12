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

## 2026-05 收尾 polish — audit agent 找到的 P1/P2 漏修

第一轮 (9a4762c/95b0f9a/e50f36c) 后 audit agent 指出还有 14 条 P1/P2 漏修。本轮 (6bddd69/<本 commit>) 补齐:

### 脚本层一致性 (commit 6bddd69)
- `features.agg_trades`: bybit 空 list _note (跟 stock_quotes data:null 一致性)
- `hl-trader.current_pnl / current_executions`: 缺 coin 校验 (跟 current_pos_history 一致性)
- 上述 3 个 current_* 端点 + data:null 加空数据 _note 引导

### SKILL.md 跨接口约定 (本 commit)
- 新增 "跨接口字段约定" 段落统一说明 (放在 Quick Reference 之前):
  - 两套响应封装 (`{success,errorCode,data}` vs `{code,msg,data}`)
  - 时间戳单位混杂 (kline 秒 / funding/OI/historical_depth/trade_data 毫秒 / estimated_liquidation time_points 秒)
  - search.dbKeys string 不是 array (复述)
  - search.price 是 CNY (复述)
  - 多端点硬上限 100 条无翻页
  - 数据时新性差异 (historical_depth 可能滞后 30h+)
  - 字段类型 string/number 不统一 (coin_ticker 全 string / ls_ratio 混合 / kline 数组全 number)
  - dbkey vs dbKeys vs key 命名混乱

### treasury 系列 (3 个端点字段语义)
- treasury_summary: 单 object 结构
- treasury_latest_entities / latest_history: GET, `data: list[]` 直接数组
- treasury_entities / history / accumulated: POST, 分页/嵌套结构差异

## 2026-05 收尾 — 9 并行 agent 测试 (145 endpoints) 发现的坑

### 脚本层 silent wrong 修复 (commit 9a4762c)

- `whale_events` 上游 coin 过滤不严, 本地按 coin 严格剔除非请求币种 + _note
- `completed_trades_by_time` Coin (大写) 字段, 小写 coin 兼容自动转
- `current_pos_history` 缺 coin 拼 /undefined silent OK → 本地校验
- `fills / completed_trades / orders_latest / filled_orders / twap_states` 缺 address 静默拿空 → 统一加 requireAddress
- `news_rss` 端点返 XML/RSS, lib 新增 `apiGetText` 函数, news_rss 改用返 { contentType, body 字符串 }
- `huobipro` 加进 big_orders/agg_trades BLACKLIST
- `stock_quotes` 收 data:null 时主动加 _note (告知"加密概念股专用")
- `drop_radar.detail` 区分 403 付费墙 vs 真 airdrop_id 错, 不再统一报"airdrop_id 无效"

### SKILL.md 字段陷阱补全

- `coin.search`: `dbKeys` 单 string (不是 array), `price` 是 CNY (不是 USD, 6.8 倍量级差)
- `features.signal_alert`: 返回字段是 tp_key / sub_type / side / ews_price / ews_time, **没有 winRate**
- `market.indicator_pairs`: `coinType` 必填
- `airdrop.all`: 顶层 key 是中文 (`交易所空投`/`链上早期项目`), 不是标准 `data`
- `drop_radar.list`: 不要瞎传 status+keyword, 用 filters 拿合法选项

### Known Issues 刷新

- `coin.liquidation_history` 加入 (网关偶发 502)
- `airdrop.detail / drop_radar.detail` 实际是 403 付费墙不是 500 后端故障 (改提示文)
- `market.stock_company` 状态不稳, 弱化"必定 broken"措辞

## 2026-05 后续 — sub-agent 互动测试挖到的字段语义陷阱

7 题互动测试 (主线程出题 / sub-agent 用 SKILL.md 答) 发现 2 个 SKILL.md 没说明的字段陷阱:

- **`signal_alert / signal_alert_list`** 返的是**当前账号在 AiCoin 网页端配置过的预警**, 不是全市场实时触发。 sub-agent 实测发现 50 条结果全是 ETH MACD 5min (因为该账号订阅过 ETH 预警), 一条 BTC 都没。Open API 暂未暴露"全市场技术指标实时触发"接口。
- **`stock_quotes / stock_top_gainer / stock_company`** 是**加密概念股专用** (端点路径 `/crypto_stock/`), 只覆盖 AiCoin 整理的有限名单 (MSTR/COIN/TSLA/BULL 等约 2-30 家)。NVDA/AAPL/MSFT 等通用美股返空, **不是接口故障**。 SKILL.md 之前写 "Stock quotes" 容易让 agent 以为是通用美股接口。

附带清理: 表里 `signal_alert_list` 之前有两行重复, 现合并到 signal data 段一行 (带语义说明)。

## 提交时间线

- `5caa59b` (2026-05): 第 1 轮 12 文件 458 行 — 平台 alias / 命名 alias / 上游 5xx hint / 默认参数 / requireAddress (HL skill)
- `2287691` (2026-05): 第 2 轮 5 文件 64 行 — strategy_signal 无条件拦截 / 业务错误 wrapPositionNotFound (HL skill) / 空 list `_note` / 文档补
- `1fd7628` (2026-05): polish 2 文件 19 行 — hot_coins / gray_scale 空 list 加 `_note`
- `b9a99f0..65cc23a` (2026-05): demo 阶段挖到 6 个字段语义陷阱 — degree/ls_ratio/HIP-3/smart_find/newsflash/high_amount
