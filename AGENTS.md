# Helix Skills — Agent Instructions

Helix skill 层当前只包含 3 个能力:

- `helix-account`: 交易所账户查询、持仓、订单历史、API key 引导、注册开户链接
- `helix-trading`: CEX 现货 / 永续下单、平仓、止盈止损、杠杆与保证金设置
- `helix-freqtrade`: Freqtrade 策略生成、回测、部署、切策略 / 交易对 / 实盘、查询 daemon 盈亏

## 路由规则

| 用户意图 | 使用 |
|---|---|
| 查余额、持仓、订单、账户历史、API key 配置、注册开户 | `helix-account` |
| 直接下单、平仓、挂止盈止损、改杠杆 / 保证金模式 | `helix-trading` |
| 写策略、回测、hyperopt、部署 bot、切策略、切交易对、查 freqtrade 盈亏 / 持仓 | `helix-freqtrade` |

## 数据准确性铁则

- 不要用本地心算或临时代码计算用户可见的交易指标; 策略指标以 Freqtrade daemon 分析结果为准。
- 下单数量、合约张数、保证金、爆仓价以 `helix-trading` 脚本和交易所返回值为准, 不要自己推算。
- 回测只能使用真实历史数据和策略内技术指标, 不要用随机数或 mock CSV 冒充真实输入。
- 用户纠错时默认用户对, 先重新读取交易所 / Freqtrade 返回值, 连错两次就停手向用户确认。
- 涉及价格、盈亏、开仓价、策略建议时, 不要凭记忆 hardcode 价格; 先通过项目内真实数据源读取当前价。
- PA 规则只在闭合 K 线上求值，必须保留事件发生时间和确认时间；禁止未来函数、重绘和从 OHLC 推断柱内先后顺序。

## Freqtrade Dashboard 对齐

| 用户问 | agent 必须先调 |
|---|---|
| 现在赚了多少 / 总盈亏 / 今天涨多少 | `helix-freqtrade/scripts/ft.mjs profit` |
| 持仓 / 现在开了哪些 | `helix-freqtrade/scripts/ft.mjs trades_open` |
| 余额 | `helix-freqtrade/scripts/ft.mjs balance` |
| 跑什么策略 / 当前模式 | `helix-freqtrade/scripts/ft.mjs daemon_info` |

报告盈亏时同时报:

- `profit_closed_coin`: 已平仓累计盈亏
- `profit_all_coin`: 已平仓 + 当前持仓浮动后的总盈亏

## 交易与实盘安全规则

- 所有直接下单必须走 `helix-trading/scripts/exchange.mjs create_order`, 禁止 agent 自己写 CCXT / fetch 下单代码。
- `create_order` / `close_position` / `set_stop` 第一次调用只展示预览; 用户明确回复"确认"或 "yes" 后, 才能第二次加 `confirmed=true` 执行。
- 平仓必须用 `close_position`, 禁止用 `create_order` 构建反向单。
- 改杠杆、保证金模式、切实盘前必须明确说明影响并等待用户确认。
- Freqtrade daemon 自己根据策略自动开平仓是 daemon 本职; 用户切实盘那一刻视为授权, 不需要 agent 对每笔策略信号再确认。
- 策略部署、切策略和切 dry-run / live 统一走 `helix-freqtrade/scripts/ft-deploy.mjs deploy`; 当前策略代码必须先有匹配的回测指纹，且回测至少有一笔交易并为正收益；修改策略后必须重新回测。
- `HelixSignalStrategy` 只能校验并消费 Helix Signal Artifact，不得在 Python 中复制 Scalp Hunter V1 或 Swing Hunter V1 规则。新策略的 manifest、语义文档、参数、policy、测试和 proposal 只允许维护在 sibling `helix-strategies` 仓库；`proposal` 不得部署。

## 安全规则

- 永远不要 `cat` 任何 `.env` / `.ft_api_pass`。
- 永远不要 `printenv` / `env` dump 环境变量。
- 永远不要在 chat 里 echo 用户提供的 API secret、钱包私钥、助记词。
- dashboard 默认只监听 loopback；远程开放时必须配置至少 24 字符的 `HELIX_CONTROL_TOKEN`，所有写 API 必须经过控制会话门禁。
- 用户在 chat 里提供交易所 key 时, 本地 host / Docker 模式用 `helix-trading` 的 `save_key` 写入 `~/.helix/.env`; CoinClaw 容器内引导用户去 web UI EnvSection 配置。

## Skill Discovery

Skills 在 `skills/` 目录, 当前只应有:

- `skills/helix-account`
- `skills/helix-trading`
- `skills/helix-freqtrade`
