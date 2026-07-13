#!/usr/bin/env node
// Freqtrade Bot Control CLI.
//
// 在 CoinClaw 三引擎容器里, freqtrade 是 supervisord 管的常驻 daemon —
// 不要自己起进程, 用本脚本通过 :8888 REST 控制. 策略和模式变更统一走
// ft-deploy.mjs deploy, 由它执行回测指纹门禁并重启 daemon.
import {
  readFileSync, writeFileSync, copyFileSync, renameSync, chmodSync,
} from 'node:fs';
import { ftGet, ftPost, ftDelete, ftCli } from '../lib/freqtrade-api.mjs';
import { managedFreqtradeEnv } from '../lib/coinclaw-env.mjs';

// ── 帮助函数: 读 / 改 daemon 的 config.json ───────────────────────────
// 三引擎下 config 路径不同, 通过 coinclaw-env 解析.
function configPath() {
  const env = managedFreqtradeEnv();
  if (!env) throw new Error('config 操作仅在托管 daemon 环境可用 (host 模式请用 ft-deploy.mjs deploy)');
  return env.configPath;
}

function readConfig() {
  return JSON.parse(readFileSync(configPath(), 'utf-8'));
}

function writeConfigAtomic(cfg) {
  const path = configPath();
  // 简单备份 — 改坏了 daemon autorestart 会一直 FATAL, 留一个 .bak 让 user 能 rollback.
  // .bak 含明文交易所 key/secret, 必须 0600 收紧权限, 别让同机其它进程读到.
  const bak = `${path}.bak`;
  copyFileSync(path, bak);
  chmodSync(bak, 0o600);
  // 简单 atomic: 写到 tmp 再原地 rename (同目录 POSIX 原子, 不跨 fs 无 EXDEV).
  // tmp 同样含明文 key/secret, 先 0600 再 rename.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 4) + '\n');
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  // rename 保留 tmp 的 mode, 但最终 config 显式再收紧一次以防万一.
  chmodSync(path, 0o600);
}

ftCli({
  // ── 健康检查 / 信息查询 (REST GET) ──────────────────────────
  ping: () => ftGet('ping'),
  version: () => ftGet('version'),
  sysinfo: () => ftGet('sysinfo'),
  health: () => ftGet('health'),
  config: () => ftGet('show_config'),

  // ── daemon 综合信息 (一次拿状态 / 策略 / 模式 / 交易对) ───
  // 给 agent 在用户问 "freqtrade 现在跑什么?" 时单次调用就能答全.
  daemon_info: async () => {
    const cfg = await ftGet('show_config');
    const [status, version] = await Promise.all([
      ftGet('status').catch(() => []),
      ftGet('version').catch(() => ({})),
    ]);
    return {
      online: true,
      version: version.version,
      strategy: cfg.strategy,
      timeframe: cfg.timeframe,
      exchange: cfg.exchange,
      trading_mode: cfg.trading_mode,
      dry_run: cfg.dry_run,
      max_open_trades: cfg.max_open_trades,
      stake_currency: cfg.stake_currency,
      stake_amount: cfg.stake_amount,
      pair_whitelist: cfg.whitelist || cfg.pair_whitelist,
      bot_name: cfg.bot_name,
      open_trades_count: Array.isArray(status) ? status.length : 0,
    };
  },

  // ── daemon 状态控制 ────────────────────────────────────────
  start: () => ftPost('start'),
  stop: () => ftPost('stop'),
  reload: () => ftPost('reload_config'),

  // ── 配置变更 (改 config.json + reload) ────────────────────
  // 切交易对白名单. pair_whitelist 改了之后调 /reload_config 即可,
  // 不需要重启 daemon. freqtrade 会在下一根 candle close 时应用.
  set_pairs: async ({ pairs, reload = true }) => {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new Error('pairs 必填且非空, 例: {"pairs":["BTC/USDT:USDT","ETH/USDT:USDT"]}');
    }
    const cfg = readConfig();
    if (!cfg.exchange) cfg.exchange = {};
    const before = cfg.exchange.pair_whitelist;
    cfg.exchange.pair_whitelist = pairs;
    writeConfigAtomic(cfg);
    let reloaded = null;
    if (reload) {
      try { reloaded = await ftPost('reload_config'); } catch (e) { reloaded = { error: e.message }; }
    }
    return { from: before, to: pairs, reloaded };
  },

  // ── 状态 / 持仓 / 交易历史 (REST GET) ───────────────────────
  balance: () => ftGet('balance'),
  // /status 返回 open trades 数组, 命名 trades_open 比 status 直观 — agent
  // 看到 "trades_open" 不会误以为是 daemon 状态.
  trades_open: () => ftGet('status'),
  trades_count: () => ftGet('count'),
  trade_by_id: ({ trade_id }) => ftGet(`trade/${trade_id}`),
  trades_history: ({ limit, offset } = {}) => ftGet('trades', { limit, offset }),
  // 仓位 force-enter / force-exit, 注意 freqtrade REST 这两个端点是
  // 'forcebuy' / 'forcesell' (历史名) 不是 force_enter/force_exit.
  force_enter: (p) => ftPost('forcebuy', p),
  force_exit: (p) => ftPost('forcesell', p),
  cancel_order: ({ trade_id }) => ftDelete(`trades/${trade_id}/open-order`),
  delete_trade: ({ trade_id }) => ftDelete(`trades/${trade_id}`),

  // ── 盈亏 / 绩效 ────────────────────────────────────────────
  // /profit 是回答 "现在赚多少 / 盈亏多少" 类问题的权威接口:
  //   - profit_closed_coin: 已平仓累计盈亏 (USDT) — dashboard 顶栏的累计盈亏 = 这个
  //   - profit_all_coin:    已平仓 + 浮动 (含未平仓) 总盈亏 (USDT)
  //   - 浮动盈亏 = profit_all_coin - profit_closed_coin
  //   - closed_trade_count: 已平仓交易数
  // 反例: 只调 /status 拿 open trades 浮动盈亏会漏掉已平仓部分,
  // 跟 dashboard 数字不一致.
  profit: () => ftGet('profit'),
  profit_per_pair: () => ftGet('performance'),
  daily: ({ count } = {}) => ftGet('daily', { timescale: count }),
  weekly: ({ count } = {}) => ftGet('weekly', { timescale: count }),
  monthly: ({ count } = {}) => ftGet('monthly', { timescale: count }),
  stats: () => ftGet('stats'),

  // ── 日志 (受 freqtrade api 自带 limit 限制) ────────────────
  logs: ({ limit } = {}) => ftGet('logs', { limit }),
});
