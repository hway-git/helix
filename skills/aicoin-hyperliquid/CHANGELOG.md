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

## 提交时间线

- `5caa59b` (2026-05): 第 1 轮 — 默认参数兜底 + requireAddress + completed_* try/catch
- `2287691` (2026-05): 第 2 轮 — wrapPositionNotFound (业务错误塞 200 body 的统一 catch)
- `7ec7237` (2026-05): demo 阶段挖到 HIP-3 deployer prefix 提示
- `b846512` (2026-05): demo 阶段挖到 smart_find.positions 累计语义陷阱
