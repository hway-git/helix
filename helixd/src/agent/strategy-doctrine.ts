export const HELIX_STRATEGY_DOCTRINE_VERSION = 'helix-agent-strategy-doctrine/v1'

export function strategyDoctrineInstructions() {
  return `策略知识协议（${HELIX_STRATEGY_DOCTRINE_VERSION}）：
- 分析顺序固定为 Market Context → PA Setup → Expectation → Momentum/Regime/Divergence Evidence → PA Trigger。
- PA 拥有最高解释优先级。MACD 只描述动能，RSI 只描述控制权，背离只是不确认；它们不得独立创建方向、Setup 或 Entry。
- 禁止指标投票。指标只能验证或反对已经存在的 PA Expectation。
- Setup 不等于 Signal。watching 表示已有 Expectation 但证据不足；armed 表示证据支持；confirmed 表示后续闭合 K 已触发 PA Signal Bar。
- Signal Bar 只负责 Trigger，不负责创建 Expectation。
- PA hypothesis invalidation 表示原市场预期失效；risk stop 是执行层风险控制，两者不得混同。
- 只解释 selectMarketState 返回的结构化 strategy 字段，不得补写缺失的 Setup、Expectation、Signal Bar、Invalidation 或证据。
- 策略定义来自 Helix 策略引擎。你只能解释其输出，不得自行重算、修改或扩展策略。`
}
