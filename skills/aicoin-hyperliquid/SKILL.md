---
name: aicoin-hyperliquid
description: "Hyperliquid is a real on-chain perpetuals DEX, so this skill is the **primary source for on-chain whale / smart money / large-fund movement data** — not just HL-specific queries. Use this skill when user asks about: Hyperliquid whale positions, HL liquidations, HL open interest, HL trader analytics, HL taker data, smart money on Hyperliquid, **HL funding rate / 资金费率** (via Info API, see types below), AND ALSO **generic '链上大资金动向 / 链上鲸鱼 / 聪明钱在做什么 / 大户最近开仓 / on-chain whale activity'** — because HL is the deepest on-chain perp venue and AiCoin's HL endpoints expose real on-chain whale positions / events / liquidations without needing OKX Web3 API key. Use when user says: '链上大资金动向', '链上鲸鱼', '聪明钱', '大户在干嘛', 'on-chain whale', 'smart money signal', 'Hyperliquid whales', 'HL whale positions', 'HL liquidations', 'HL open interest', 'HL trader', 'Hyperliquid大户', 'HL鲸鱼', 'HL持仓', 'HL清算', 'HL持仓量', 'HL交易员', 'HL 资金费率', 'HL funding rate', 'HL funding history'. For general crypto prices/news, use aicoin-market. For DEX swap / 钱包 / Uniswap / 链上 token 交易动作, use aicoin-onchain. For CEX trading, use aicoin-trading. For Freqtrade, use aicoin-freqtrade."
metadata: { "openclaw": { "primaryEnv": "AICOIN_ACCESS_KEY_ID", "requires": { "bins": ["node"] }, "homepage": "https://www.aicoin.com/opendata", "source": "https://github.com/aicoincom/coinos-skills", "license": "MIT" } }
---

> **运行脚本**: 从 SKILL.md 所在目录运行 `node scripts/<file>.mjs <action>`. 三引擎(OpenClaw / Hermes / Claude Code)容器自动加载 skill, 直接 `cd` 到 skill 目录即可.

# AiCoin Hyperliquid

Hyperliquid whale tracking and analytics powered by [AiCoin Open API](https://www.aicoin.com/opendata).

**Version:** 1.0.0

## Critical Rules

1. **NEVER fabricate data.** Always run scripts to fetch real-time data.
2. **NEVER use curl, web_fetch, or browser.** Always use these scripts.
3. **NEVER run `env` or `printenv`** — leaks API secrets.
4. **Scripts auto-load `.env`** — never pass credentials inline.
5. **On 304/403 error — STOP, do NOT retry.** Guide user to upgrade (see Paid Feature Guide at bottom).
6. **响应里出现 `实测结论` 字段时把原文转告用户**, 不要重试 — 脚本帮你把上游故障 / 业务错误塞 200 body / API 限制 翻译成了清晰提示, 重试浪费用户时间。

## Known Issues (broken / 临时不稳 / 设计限制)

下面这些端点 agent **不要重试**, 不是用户参数错。脚本已经做了本地拦截或上游故障 catch, 调用时会拿到 `实测结论` 字段, 把它原文转告用户即可。

- **`hl-trader.completed_pos_history` / `completed_pnl` / `completed_executions`** — 后端按 **positionId** 取数, 不接受 `address+coin` 组合 (任何真实地址都返"position not found")。HL 后端把这种业务错误塞到 HTTP 200 body `{code:"400",msg:"position not found"}` 里 (不是 HTTP 4xx), 脚本已 wrap。**替代**: `completed_trades` (按地址列已平仓) / `fills` (按地址列所有成交) / `pnls` (整地址 PnL 曲线)
- **`hl-trader.accounts`** — 后端偶发 500。**替代**: `statistics` + `batch_clearinghouse_state` 拿同样的字段
- **上游 5xx 通用响应** — 任何端点拿到 HTTP 502/503/504 是 AiCoin 网关临时故障(可重试 1-2 分钟), 拿到 500/501/505+ 是后端异常(引导用户联系 service@aicoin.com)

## HL 市场命名 (HIP-3 Deployer Prefix — 必读)

`tickers` 返回 ~686 个市场, 调任何按 `coin` 过滤的接口 (`ticker` / `whale_positions` / `oi_history` 等) 前必须知道这个分类:

| 类型 | 数量 | 命名 | 例子 |
|---|---|---|---|
| 常规 crypto perp | 184 | 裸大写名 | `BTC` / `ETH` / `SOL` / `DOGE` / `BNB` |
| Spot index | 280 | `@N` | `@244` |
| HIP-3 美股合成 | 74 | `cash:` / `xyz:` | `cash:TSLA` / `xyz:AMZN` / `cash:NVDA` |
| HIP-3 贵金属/指数/商品 | 15 | `flx:` | `flx:GOLD` / `flx:USA500` / `flx:OIL` |
| HIP-3 主题指数 | 13 | `vntl:` | `vntl:DEFENSE` / `vntl:OPENAI` / `vntl:SEMIS` |
| HIP-3 中概股/原油 | 22 | `km:` | `km:TENCENT` / `km:XIAOMI` / `km:USOIL` |
| HIP-3 第三方加密 | 22 | `hyna:` | `hyna:BNB` / `hyna:DOGE` |
| HIP-3 市场宽度 | 3 | `para:` | `para:BTCD` / `para:TOTAL2` |
| 1000x 系列 | 6 | `k*` | `kPEPE` / `kSHIB` |
| HL dexs 子市场 | 67 | `#N` (纯数字) | `#71` / `#110` / `#321` (其它 deployer 子市场 ID) |

**调用规则**:
- 主流 crypto 直接传裸名 (`BTC` / `ETH` / `SOL` / `XRP` / `DOGE` / `BNB`)
- 美股 / 商品 / 指数 **必须带 prefix** (`coin: "cash:TSLA"` 而不是 `coin: "TSLA"`)
- 同名资产可能有多个 deployer 版本 (`xyz:NVDA` vs `flx:NVDA`), 流动性 / 价格略差 0.1%。 用户没指定时优先 `cash:` (主流 deployer)
- 不确定 prefix 时先 `tickers` 拿全表筛一遍, 别瞎猜

## Setup

**Hyperliquid Registration (AiCoin Referral):** If user needs to register on Hyperliquid, use AiCoin referral link: https://app.hyperliquid.xyz/join/AICOIN88 (邀请码: AICOIN88, 返4%手续费).

Scripts work out of the box with a built-in free key (tickers + info only). For whale/trader/OI data, add your API key to `.env`:

```
AICOIN_ACCESS_KEY_ID=your-key-id
AICOIN_ACCESS_SECRET=your-secret
```

Get at https://www.aicoin.com/opendata. See [Paid Feature Guide](#paid-feature-guide) for tier details.

**安全说明：** AiCoin API Key 仅用于获取 Hyperliquid 链上分析数据，无法进行任何交易操作。如需在 Hyperliquid 上交易，需单独配置钱包私钥（见 aicoin-trading skill）。所有密钥仅保存在本地设备 `.env` 文件中，不会上传到任何服务器。

**`.env` 加载位置**: CoinClaw 容器自动从 `/workspace/.env` (Hermes/CC) 或 `/home/node/.openclaw/workspace/.env` (OpenClaw) 加载; 本地 host 模式从 cwd → `~/.openclaw/workspace/.env` → `~/.openclaw/.env` 加载.

## Quick Reference

| Task | Command | Min Tier |
|------|---------|----------|
| All tickers | `node scripts/hl-market.mjs tickers` | 免费版 |
| BTC ticker | `node scripts/hl-market.mjs ticker '{"coin":"BTC"}'` | 免费版 |
| Whale positions | `node scripts/hl-market.mjs whale_positions '{"coin":"BTC"}'` | 标准版 |
| Whale events | `node scripts/hl-market.mjs whale_events '{"coin":"BTC"}'` | 标准版 |
| Liquidation history | `node scripts/hl-market.mjs liq_history '{"coin":"BTC"}'` | 标准版 |
| OI summary | `node scripts/hl-market.mjs oi_summary` | 高级版 |
| Trader stats | `node scripts/hl-trader.mjs trader_stats '{"address":"0x...","period":"30"}'` | 标准版 |
| Smart money | `node scripts/hl-trader.mjs smart_find` | 标准版 |
| Top open orders | `node scripts/hl-trader.mjs top_open '{"coin":"BTC"}'` | 基础版 |

## Scripts

### scripts/hl-market.mjs — Market Data

#### Tickers
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `tickers` | All tickers | 免费版 | None |
| `ticker` | Single coin | 免费版 | `{"coin":"BTC"}` |

#### Whales
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `whale_positions` | Whale positions | 标准版 | `{"coin":"BTC","dir":"long","topBy":"position-value","take":"10"}` dir: long/short; topBy: position-value/margin-balance/create-time/profit/loss; take: max 200. Optional: `npnlSide` (profit/loss), `frSide` (profit/loss) |
| `whale_events` | Whale events. **上游 coin 过滤不严**, 脚本本地按 coin 严格剔除非请求币种 (返回会带 `_note` 说明剔除几条)。 | 标准版 | `{"coin":"BTC","limit":"10"}` limit: max 100 |
| `whale_directions` | Long/short direction | 标准版 | `{"coin":"BTC"}` |
| `whale_history_ratio` | Historical long ratio. **全市场聚合**, 不接 coin 参数 (脚本签名也没暴露)。要看单币历史多空比目前 Open API 没暴露。 | 标准版 | `{"interval":"1h","limit":"50"}` interval: 10m/1h/4h/1d; limit: max 200 |

#### Liquidations
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `liq_history` | Liquidation history. **字段命名陷阱**: `longFilled` / `shortFilled` 是**总成交量** (taker), `longLiquidations` / `shortLiquidations` 才是**真强平**。最近窗口没强平时后两个全 0 但 Filled 仍大数 — 不要混淆。 | 标准版 | `{"coin":"BTC","interval":"15m","limit":"20"}` interval: 1m~60d; limit: max 100 |
| `liq_stats` | Liquidation stats | 标准版 | `{"coin":"BTC","interval":"15m"}` interval: 1s~60d |
| `liq_stats_by_coin` | Stats by coin. **只返回最近窗口实际发生过强平的币**, 没强平的币不出现。15m 窗口可能只 1-3 个币, 1d 窗口才覆盖更多。返回少不是 bug。 | 标准版 | `{"interval":"15m"}` interval: 1s~60d |
| `liq_top_positions` | Large liquidations | 标准版 | `{"coin":"BTC","interval":"1d"}` |

#### Open Interest & Orderbook
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `oi_summary` | OI overview | 高级版 | None |
| `oi_top_coins` | OI ranking | 高级版 | `{"limit":"10","interval":"3d"}` interval: 15m~180d |
| `oi_history` | OI history. **后端默认只返 ~4 条**, 没传 limit 会非常少。脚本暂未暴露 limit, 想要更多历史点目前查不到 (后端 spec 未公开)。 | 专业版 | `{"coin":"BTC","interval":"4h"}` |
| `orderbook_history` | Orderbook history summaries | 高级版 | `{"coin":"BTC","interval":"1d"}` interval: 1h~180d |

#### Taker
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `taker_delta` | Taker delta | 高级版 | `{"coin":"BTC"}` |
| `taker_klines` | Taker K-lines | 标准版 | `{"coin":"BTC","interval":"4h"}` Optional: `startTime`, `endTime` (ms), `limit` (max 2000) |

### scripts/hl-trader.mjs — Trader Analytics

#### Trader Stats
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `trader_stats` | Trader statistics | 标准版 | `{"address":"0x...","period":"30"}` |
| `best_trades` | Best trades | 标准版 | `{"address":"0x...","period":"30"}` |
| `performance` | Performance by coin | 标准版 | `{"address":"0x...","period":"30"}` |
| `completed_trades` | Completed trades | 标准版 | `{"address":"0x...","coin":"BTC"}` |
| `accounts` | Batch accounts — 见 [Known Issues](#known-issues-broken--临时不稳--设计限制) 偶发 500, 用 `statistics`+`batch_clearinghouse_state` 替代。**字段陷阱**: `currentPosition` (该接口) ≠ `smart_find.positions` (那是累计交易笔数) ≠ `trader_stats.closePosCount` (30天已平仓数), 三个数字差几个数量级, 别串字段。 | 标准版 | `{"addresses":"[\"0x...\"]"}` |
| `statistics` | Batch statistics | 标准版 | `{"addresses":"[\"0x...\"]"}` |

#### Fills
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `fills` | Address fills. **`oid` 字段会重复** (一个 order 可能产生多个 fill), 想做去重要用 `tid` (trade id, 唯一)。 | 标准版 | `{"address":"0x..."}` |
| `fills_by_oid` | By order ID | 标准版 | `{"oid":"xxx"}` |
| `fills_by_twapid` | By TWAP ID | 标准版 | `{"twapid":"xxx"}` |
| `fills_by_builder` | Builder fills | 标准版 | `{"builder":"0x..."}` Optional: `coin`, `limit` (max 2000), `minVal` |
| `top_trades` | Large trades | 基础版 | `{"coin":"BTC","interval":"1d"}` |

#### Orders
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `orders_latest` | Latest orders. **返**嵌套结构 `[{order: {oid, side, ...}, status, statusTimestamp}]`, 不是扁平。要 `oid` 走 `row.order.oid` 不是 `row.oid`。 | 标准版 | `{"address":"0x..."}` |
| `order_by_oid` | By order ID | 标准版 | `{"oid":"xxx"}` |
| `filled_orders` | Filled orders. 同 `orders_latest` 嵌套结构。**注意**: 高频地址的 `filled_orders` vs `orders_latest` 可能完全不重叠 (filled 是已成, orders_latest 含 open + cancelled)。 | 标准版 | `{"address":"0x..."}` |
| `filled_by_oid` | Filled by ID | 标准版 | `{"oid":"xxx"}` |
| `top_open` | Large open orders | 基础版 | `{"coin":"BTC","minVal":"100000"}` |
| `active_stats` | Active stats | 基础版 | `{"coin":"BTC","whaleThreshold":"500000"}` |
| `twap_states` | TWAP states | 标准版 | `{"address":"0x..."}` Optional: `coin`, `limit` (max 100) |

#### Positions
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `current_pos_history` | Current position history | 标准版 | `{"address":"0x...","coin":"BTC"}` |
| `completed_pos_history` | 见 [Known Issues](#known-issues-broken--临时不稳--设计限制) — 按 positionId 取数 | 标准版 | — |
| `completed_trades_by_time` | Completed trades by time | 标准版 | `{"address":"0x...","Coin":"BTC","endTimeFrom":1771891200000,"endTimeTo":1772064000000}` Optional: `pageNum`, `pageSize` |
| `current_pnl` | Current PnL | 标准版 | `{"address":"0x...","coin":"BTC","interval":"1h"}` Optional: `limit` (max 1000) |
| `completed_pnl` | 见 [Known Issues](#known-issues-broken--临时不稳--设计限制) — 按 positionId 取数 | 标准版 | — |
| `current_executions` | Current executions | 标准版 | `{"address":"0x...","coin":"BTC","interval":"1h"}` Optional: `limit` (max 1000) |
| `completed_executions` | 见 [Known Issues](#known-issues-broken--临时不稳--设计限制) — 按 positionId 取数 | 标准版 | — |

#### Portfolio
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `portfolio` | Account curve. `window` **仅接受** `day` / `week` / `month` / `allTime` (其他值脚本本地拦截)。 | 标准版 | `{"address":"0x...","window":"week"}` |
| `pnls` | PnL curve. **返**累计序列 (`{ts, v}` 数组, 起点 v=0), 不是日增量。要日增量自己算相邻 `v` 差值。 | 标准版 | `{"address":"0x...","period":"30"}` |
| `max_drawdown` | Max drawdown | 标准版 | `{"address":"0x...","days":"30"}` |
| `net_flow` | Net flow | 标准版 | `{"address":"0x...","days":"30"}` |

#### Batch Endpoints
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `batch_pnls` | Batch PNL curves. 同 `pnls` 累计序列起点 v=0, 多个地址版。 | 标准版 | `{"addresses":"[\"0x...\"]","period":7}` Optional: `scope` (all/perp) |
| `batch_addr_stat` | Batch address stats | 标准版 | `{"addresses":"[\"0x...\"]","period":7}` |
| `batch_clearinghouse_state` | Batch clearinghouse state | 标准版 | `{"addresses":"[\"0x...\"]"}` Optional: `dex` |
| `batch_spot_clearinghouse_state` | Batch spot state | 标准版 | `{"addresses":"[\"0x...\"]"}` |
| `batch_max_drawdown` | Batch max drawdown. **返**同时含 Pascal (`Address/MaxDrawdown/High/NetIn`) 和 camelCase (`address/maxDrawdown/high/netIn`) 两套字段, 数据相同。用 **camelCase** 跟单地址版 `max_drawdown` 字段对齐永远安全。 | 标准版 | `{"addresses":"[\"0x...\"]","days":7}` Optional: `scope` |
| `batch_net_flow` | Batch net flow | 标准版 | `{"addresses":"[\"0x...\"]","days":7}` |

#### Advanced
| Action | Description | Min Tier | Params |
|--------|-------------|----------|--------|
| `info` | HL Info API 统一端点 (POST /api/upgrade/v2/hl/info) — 用 type 切不同子接口,见下方完整 types 表 | 免费版 | `{"type":"<type>","user":"<addr 可选>","extra_params":{<其它参数>}}` |
| `smart_find` | Smart money discovery. **`positions` / `profitPositions` 是累计交易笔数, 不是当前持仓数** (Top1 `positions=602107` 意思是历史交易 60 万笔)。`winRate = profitPositions / positions` 累计胜率。`avgHoldingSec` 平均持仓秒数, 小值=高频量化, 跟单意义不大, 当**市场情绪信号**用。`perpValue` / `spotValue` / `totalValue` 是**历史最大账户价值聚合**, 不是当前账户净值 — 要当前净值用 `batch_clearinghouse_state` 的 `accountValue`。想看地址当前真实持仓用 `whale_positions` 按 user 过滤或 `performance`。 | 标准版 | `{}` |
| `discover` | Trader discovery. **字段命名不一致警告**: 跟 `smart_find` 不同 — discover 用 `snapPerpValue` / `snapTotalValue` / `positionCount`, smart_find 用 `perpValue` / `totalValue` / `positions`。跨这两个接口套字段会拿不到, 用前先看 raw 字段名。 | 高级版 | `{}` |
| `discover_history` | Historical discovery | 高级版 | `{"pageNum":1,"pageSize":20,"period":7}` Optional: `startTime`, `time`, `sort`, `coins`, `selects`, `filters` |

#### `info` action 全部支持的 type (按 AiCoin 文档对齐, https://docs.aicoin.com/apis/hyperliquid#post-hl-info)

| type | 说明 | 必填 |
|---|---|---|
| `meta` | 永续 universe 元数据 (asset list / 杠杆梯度) | — |
| `spotMeta` | 现货元数据 | — |
| `clearinghouseState` | 永续账户状态 (含 `cumFunding.allTime/sinceOpen/sinceChange` 累计资金费) | `user` |
| `spotClearinghouseState` | 现货账户状态 | `user` |
| `openOrders` | 用户挂单 | `user` |
| `frontendOpenOrders` | 用户挂单 (前端格式) | `user` |
| `userFees` | 用户手续费 | `user` |
| `userFills` | 用户成交记录 | `user` |
| `userFillsByTime` | 用户指定时间段成交 | `user` + `extra_params.startTime` |
| `userFunding` | **用户资金费历史** (每 8h 一笔 funding 收支) | `user` + `extra_params.startTime` |
| `userNonFundingLedgerUpdates` | 用户非资金费账本 | `user` + `extra_params.startTime` |
| `historicalOrders` | 历史订单 | `user` |
| `orderStatus` | 订单状态 | `user` + `extra_params.oid` |
| `candleSnapshot` | K 线 | `extra_params.req={coin,interval,startTime,endTime}` |
| `perpDexs` | 永续 DEX 列表 | — |
| `allMids` | 所有 mid price (~517 个市场)。**数量比 `hl-market.tickers` 少** (tickers 全表 ~686 个), allMids 不含部分 spot index `@N` 和无活跃报价的 deployer 市场。要全市场用 tickers, 这个仅看活跃 mid。 | — |
| `l2Book` | L2 订单簿 | `extra_params.coin` |
| `portfolio` | 账户曲线 | `user` |
| `webData2` | 综合用户数据 (资产、订单、成交聚合) | `user` |
| `userTwapSliceFills` | TWAP 切片成交 | `user` |
| `activeAssetData` | 单 asset 当前可用余额 / markPx / leverage | `user` + `extra_params.coin` |

#### 关于 "BTC 资金费率" 这种问题

AiCoin HL wrapper **没有公开全局"当前 funding rate per asset"endpoint**(如 HL 官方 `metaAndAssetCtxs` / `predictedFundings` AiCoin 都未透出). 能拿到的 funding 数据是:

1. **per-user 历史** — `info {type:"userFunding", user:"0x...", extra_params:{startTime: <ms>}}` 拿用户每 8h 的 funding 收支记录
2. **per-user 累计** — `info {type:"clearinghouseState", user:"0x..."}` 看 `cumFunding.allTime` 字段
3. **不支持** — 当前刻的 BTC 永续 funding rate(每 8h 周期内的预测/实际值). 如果用户问"BTC 现在 funding rate", 直接告诉他: "AiCoin HL 接口没有全局当前 funding rate, 建议直接看 https://app.hyperliquid.xyz/trade/BTC 顶部 funding 显示, 或调用 HL 官方 https://api.hyperliquid.xyz/info type=metaAndAssetCtxs"

**不要**: 看到没数据就说"AiCoin 不支持 HL", 也不要编一个数字. 必须明说哪条路能拿哪条路不能.

## Cross-Skill References

| Need | Use |
|------|-----|
| Prices, K-lines, news | **aicoin-market** |
| Exchange trading (buy/sell), including Hyperliquid orders | **aicoin-trading** |
| Freqtrade strategies/backtest | **aicoin-freqtrade** |

## Common Errors

- `errorCode 304 / HTTP 403` — Paid feature. See Paid Feature Guide below.
- `Invalid coin` — Use uppercase: `BTC`, `ETH`, `SOL`
- `Address format` — Must be full `0x...` Ethereum address
- `Rate limit exceeded` — Wait 1-2s between requests

## Paid Feature Guide

When a script returns 304 or 403: **Do NOT retry.** Tell the user:

1. This feature needs a paid AiCoin API subscription.
2. Get API key at https://www.aicoin.com/opendata

| Tier | Price | HL Features |
|------|-------|-------------|
| 免费版 | $0 | Tickers, info only |
| 基础版 | $29/mo | + Top trades, top open orders, active stats |
| 标准版 | $79/mo | + Whales, liquidations, trader analytics, taker K-lines |
| 高级版 | $299/mo | + OI summary/top, taker delta, trader discover |
| 专业版 | $699/mo | + OI history |

3. CoinClaw 用户在 web UI EnvSection 添加 `AICOIN_ACCESS_KEY_ID` / `AICOIN_ACCESS_SECRET`; 本地用户写到 `.env`.
4. **MUST tell the user**: AiCoin API Key 仅用于获取 Hyperliquid 链上分析数据，无法进行任何交易操作。如需在 Hyperliquid 上交易，需要单独配置钱包私钥（见 aicoin-trading skill）。所有密钥仅保存在你的本地设备 `.env` 文件中，不会上传到任何服务器。
