# aicoin-hyperliquid CHANGELOG

修复历史 (给开发者看, 非 agent 必读 — agent 操作指南看 SKILL.md)。

## 2026-05 — 实测踩坑批量修复

跑了 58 个 endpoint 实测, 找到一批 SKILL.md 未说明的必填参数 / 业务错误塞 200 body / 单地址端点缺校验等问题。

### 脚本透明处理 (agent 无感知, 直接用就行)

- **默认参数兜底** (减少 agent 必填参数缺失的 400):
  - `hl-market.liq_top_positions / taker_delta` 默认 `interval: "1h"`
  - `hl-trader.top_trades / current_pnl / current_executions / completed_pnl / completed_executions` 默认 `interval: "1h"`
  - `hl-trader.trader_stats / best_trades / performance / pnls` 默认 `period: "30"`
  - `hl-trader.max_drawdown / net_flow` 默认 `days: "30"`
  - `hl-trader.portfolio` 默认 `window: "day"`
- **本地参数校验**:
  - 所有单地址端点缺 address 时本地拦截, 不再产生 `traders/undefined/...` 错误 URL (`requireAddress` helper)
  - `portfolio` window 非法值本地拦截 (上游对 `perpAllTime` 等返 400)
- **业务错误 wrap** (`wrapPositionNotFound` helper):
  - HL 后端把 "position not found" 这类业务错误塞到 HTTP 200 body `{code:"400",msg:"..."}` 里 (不是 HTTP 4xx)
  - `completed_pos_history / completed_pnl / completed_executions` 三个端点统一 wrap 这种 body, 返 `实测结论` 字段引导改用替代接口

### 错误处理增强 (agent 必读, 见 SKILL.md Known Issues)

- `lib/aicoin-api.mjs` `apiGet/apiPost` 加 `upstreamFaultHint`: 5xx 时附"网关临时故障/后端异常"提示, 引导用户联系客服
- `hl-trader.accounts` 偶发 500 时 catch 返实测结论, 提示改用 `statistics + batch_clearinghouse_state`

### 字段语义/设计限制 (SKILL.md 已写入对应 action 备注)

- `smart_find.positions / profitPositions` 是累计交易笔数, 不是当前持仓 (Top1 `602107` = 历史 60 万笔交易)
- `smart_find.winRate` = `profitPositions / positions` (累计胜率)
- `smart_find.avgHoldingSec` 小值 = 高频量化风格, 跟单意义不大
- `portfolio.window` 仅接受 `day / week / month / allTime`
- `completed_*` 端点都还要 `startTime` 或 `endTime` 之一 (ms epoch)

### HIP-3 Deployer Prefix (SKILL.md 单独一节)

HL 上 686 个市场里有 ~150 个是第三方 deployer prefix 资产 (美股 / 商品 / 指数 / 主题), 调按 `coin` 过滤的接口必须用正确 prefix。具体分类见 SKILL.md。

## 2026-05 收尾 polish — audit agent 找到的 P1/P2 漏修

第一轮 (9a4762c/e50f36c) 后 audit agent 指出还有几条漏修。本轮 (6bddd69/<本 commit>) 补:

### 脚本层一致性 (commit 6bddd69)
- `current_pnl / current_executions` 缺 coin 校验 (之前只给 `current_pos_history` 加了 — 一致性破缺)
- 三个 current_* 端点 + data:null 时加空数据 _note 引导改用 fills / performance

### SKILL.md (本 commit)
- `smart_find.perpValue/spotValue/totalValue` 是**历史最大账户价值聚合**, 不是当前账户净值; 要当前净值用 batch_clearinghouse_state.accountValue (G9-3 漏修补)

## 2026-05 收尾 — 9 并行 agent 测试 (G6-G9) 发现的坑

### 脚本层 silent wrong 修复 (commit 9a4762c)

- `whale_events` 上游 coin 过滤不严, 本地剔除非请求币种 + _note 提示
- `completed_trades_by_time` Coin 大写字段, 小写 coin 兼容自动转
- `current_pos_history` 缺 coin 拼 /undefined → 本地校验
- `fills / completed_trades / orders_latest / filled_orders / twap_states` 缺 address → 统一加 requireAddress

### SKILL.md 字段陷阱补全

- HIP-3 表加 67 个 `#N` (HL dexs 子市场, 之前未分类)
- `whale_events`: 本地过滤行为说明
- `whale_history_ratio`: 全市场聚合, 不接 coin 参数
- `liq_history`: longFilled (taker 成交) vs longLiquidations (真强平) 区分
- `liq_stats_by_coin`: 只返有强平的币 (不是 bug)
- `oi_history`: 后端默认只 4 条
- `fills.oid` 会重复, 去重用 `tid`
- `orders_latest / filled_orders` 返嵌套 `{order:{oid,..},status,..}` 不是扁平
- `pnls / batch_pnls` 累计序列起点 v=0, 不是日增量
- `batch_max_drawdown` 同时返 Pascal + camelCase 两套字段, 用 camelCase 跟单地址版对齐
- `discover` vs `smart_find` 字段命名不统一 (snapPerpValue vs perpValue 等)
- `accounts.currentPosition` ≠ `smart_find.positions` ≠ `trader_stats.closePosCount`, 字段语义差异警告

## 提交时间线

- `5caa59b` (2026-05): 第 1 轮 — 默认参数兜底 + requireAddress + completed_* try/catch
- `2287691` (2026-05): 第 2 轮 — wrapPositionNotFound (业务错误塞 200 body 的统一 catch)
- `7ec7237` (2026-05): demo 阶段挖到 HIP-3 deployer prefix 提示
- `b846512` (2026-05): demo 阶段挖到 smart_find.positions 累计语义陷阱
