# Helix

Helix 是一个面向加密交易的 AI 交易终端与自动化交易工作台。项目目标是把实时行情监测、策略研究、回测验证、Freqtrade 执行和人工确认交易串到同一个工作流里，让 agent 能在受控边界内辅助交易决策与执行。

当前仓库包含两层能力:

- `app/dashboard`: 交易大屏前端，用于行情、K 线、指标、新闻 / 宏观数据、持仓、订单和 agent 控制台展示。
- `skills`: agent 可调用的账户查询、交易执行、Price Action 规范和 Freqtrade 自动化能力。

## 当前范围

Helix skill 层当前只保留 4 个能力:

| Skill | 职责 |
|---|---|
| `helix-account` | 查询交易所余额、持仓、订单、成交历史，并引导 API key / 注册配置 |
| `helix-trading` | 执行 CEX 现货 / 永续下单、平仓、止盈止损、杠杆和保证金模式设置 |
| `helix-pa-strategy` | 把 Price Action 思路定义为确定、因果、可回测的策略 setup，并检查未来函数与 OHLC 歧义 |
| `helix-freqtrade` | 创建策略、回测、hyperopt、部署 bot、切策略 / 交易对 / 实盘，查询 daemon 盈亏 |

Skill 层只负责账户、交易执行、PA setup 规范和 Freqtrade 自动化。行情、新闻和宏观数据由 Helix 应用层服务维护。

## 目录结构

```text
helix/
├── app/
│   └── dashboard/              # 交易大屏前端
├── skills/
│   ├── helix-account/          # 账户查询
│   ├── helix-trading/          # 交易执行
│   ├── helix-pa-strategy/      # Price Action 策略规范与示例
│   └── helix-freqtrade/        # 策略、回测、Freqtrade daemon 控制
├── scripts/
│   └── validate-skills.mjs     # skill frontmatter 与共享文件校验
├── AGENTS.md                   # Codex / agent 工作规则
├── CLAUDE.md                   # Claude Code 工作规则
└── README.md
```

## Agent 路由

| 用户意图 | 使用 |
|---|---|
| 查余额、持仓、订单、账户历史、API key 配置、注册开户 | `skills/helix-account` |
| 下单、平仓、挂止盈止损、改杠杆 / 保证金模式 | `skills/helix-trading` |
| 定义 / 审查 PA setup、市场结构、突破、回踩、拒绝、扫单或检查未来函数 | `skills/helix-pa-strategy` |
| 写策略、回测、hyperopt、部署 bot、切交易对、切实盘、查 Freqtrade 盈亏 / 持仓 | `skills/helix-freqtrade` |

## 安全边界

- 所有直接下单必须走 `skills/helix-trading/scripts/exchange.mjs create_order`。
- 平仓必须走 `close_position`，不用反向单模拟平仓。
- `create_order` / `close_position` / `set_stop` 第一次调用只展示预览，用户明确确认后才允许带 `confirmed=true` 执行。
- 改杠杆、改保证金模式、切实盘前必须说明影响并等待确认。
- 策略部署、切策略和切 dry-run / live 统一走 `ft-deploy.mjs deploy`；当前策略代码必须有匹配的回测指纹，修改后必须重新回测。
- PA Strategy 只产生 setup 观察，不包含下单、止损、止盈、杠杆或仓位；规则确认后再交给 Freqtrade 实现与回测。
- 不读取、不打印 `.env`、`.ft_api_pass`、API secret、passphrase、私钥或助记词。
- 不用 mock / random 数据冒充真实行情、真实交易或回测输入。

## Freqtrade 对齐

dashboard 的策略、持仓、盈亏以 Freqtrade daemon 为准。用户询问盈亏时，先读取 daemon:

```bash
cd skills/helix-freqtrade
node scripts/ft.mjs profit
```

回答时同时说明:

- `profit_closed_coin`: 已平仓累计盈亏
- `profit_all_coin`: 已平仓 + 当前持仓浮动后的总盈亏

本机使用官方 Docker 镜像安装，默认是 OKX 永续 dry-run，REST API 仅监听 `127.0.0.1:8888`:

```bash
pnpm freqtrade:install
```

运行配置和凭据保存在 `~/.helix/.env`，Freqtrade 用户数据保存在 `~/.freqtrade/user_data`。安装器可重复执行，不会覆盖已有配置或轮换已有 API 密码。

## 常用命令

```bash
# 校验 skill 配置与共享文件
node scripts/validate-skills.mjs

# 账户查询
cd skills/helix-account
node scripts/exchange.mjs balance '{"exchange":"okx"}'
node scripts/exchange.mjs positions '{"exchange":"okx","market_type":"swap"}'
node scripts/exchange.mjs closed_orders '{"exchange":"okx","symbol":"BTC/USDT","limit":20}'

# 交易预览 / 执行
cd skills/helix-trading
node scripts/exchange.mjs create_order '{"exchange":"okx","symbol":"BTC/USDT:USDT","type":"market","side":"buy","amount":0.01,"market_type":"swap"}'
node scripts/exchange.mjs close_position '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap"}'
node scripts/exchange.mjs set_stop '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap","stop_loss":70000}'

# Freqtrade
cd skills/helix-freqtrade
node scripts/ft-deploy.mjs create_strategy '{"name":"RSIStrategy","timeframe":"15m","indicators":["rsi","macd"],"direction":"long"}'
node scripts/ft-deploy.mjs backtest '{"strategy":"RSIStrategy","timeframe":"15m","timerange":"20250101-20260301"}'
node scripts/ft-deploy.mjs deploy '{"strategy":"RSIStrategy","dry_run":true}'
node scripts/ft.mjs daemon_info
node scripts/ft.mjs profit
```

## 环境配置

交易所 API key 通过项目脚本或容器 Web UI 配置，不要在聊天、日志或 shell 历史中回显 secret。

dashboard 的 `dev` / `start` 默认只监听 `127.0.0.1`。通过局域网或反向代理开放时，必须设置至少 24 字符的 `HELIX_CONTROL_TOKEN`，并显式让 Next.js 监听外部地址。写接口会要求先在 dashboard 解锁控制会话；行情和状态查询保持只读可用。

本机 Freqtrade REST daemon 默认监听 `http://127.0.0.1:8888`，dashboard 和 skill 会使用同一地址。

常用变量:

```bash
OKX_API_KEY="xxx"
OKX_API_SECRET="xxx"
OKX_PASSWORD="xxx"

BINANCE_API_KEY="xxx"
BINANCE_API_SECRET="xxx"

BYBIT_API_KEY="xxx"
BYBIT_API_SECRET="xxx"

PROXY_URL="socks5://127.0.0.1:7890"

HELIX_CONTROL_TOKEN="generate-a-random-value-with-at-least-32-chars"

FREQTRADE_URL="http://127.0.0.1:8888"
```

## 验证

```bash
node scripts/validate-skills.mjs
node --check skills/helix-account/scripts/exchange.mjs
node --check skills/helix-trading/scripts/exchange.mjs
node --check skills/helix-trading/scripts/verify-order-matrix.mjs
node --check skills/helix-freqtrade/scripts/ft.mjs
node --check skills/helix-freqtrade/scripts/ft-deploy.mjs
node --check skills/helix-freqtrade/lib/strategy-builder.mjs
```
