'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardList,
  Lock,
  Newspaper,
  PanelRightClose,
  PanelRightOpen,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Message = {
  id: string
  role: 'user' | 'agent'
  content: string
  time: string
}

type Panel = 'agent' | 'risk' | 'execution'

const INITIAL: Message[] = [
  {
    id: 'm1',
    role: 'agent',
    content: '当前为演示控制台。真实模式会先读取行情、策略和风控结果，再生成交易预览。',
    time: '09:41',
  },
  {
    id: 'm2',
    role: 'user',
    content: 'Trend Rider 的 BTC 信号能执行吗？',
    time: '09:42',
  },
  {
    id: 'm3',
    role: 'agent',
    content: '暂不执行。实盘开关锁定，且当前没有后端 preview_id。可以先完成回测验证，再走授权流程。',
    time: '09:42',
  },
]

const panels: Array<{ id: Panel; label: string; icon: React.ElementType }> = [
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'risk', label: '风控', icon: ShieldCheck },
  { id: 'execution', label: '执行', icon: ClipboardList },
]

const suggestions = [
  { icon: TrendingUp, label: '分析当前趋势' },
  { icon: Activity, label: '检查策略信号' },
  { icon: Newspaper, label: '汇总今日事件' },
]

const cannedReply = '已记录为演示请求。生产接入后会以真实行情、回测结果和风控策略为准，当前不会触发下单。'

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'up' | 'warn' | 'down'
}) {
  return (
    <div className="rounded border border-border bg-background/35 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-sm tabular-nums',
          tone === 'up' && 'text-up',
          tone === 'warn' && 'text-[var(--chart-3)]',
          tone === 'down' && 'text-down',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function RiskPanel() {
  const rules = [
    ['单笔风险', '<= 0.50%', '通过'],
    ['日内亏损', '<= 2.00%', '通过'],
    ['最大持仓', '3 / 5', '通过'],
    ['实盘开关', 'Locked', '锁定'],
  ]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Risk Score" value="18 / 100" tone="up" />
        <Metric label="Exposure" value="31.4%" />
        <Metric label="Daily PnL" value="+2.84%" tone="up" />
        <Metric label="Auto Trade" value="OFF" tone="down" />
      </div>

      <div className="mt-3 rounded border border-border bg-background/35">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium leading-none">
          <ShieldCheck className="size-3.5 text-up" />
          Policy Gate
        </div>
        <div className="divide-y divide-border/60">
          {rules.map(([name, value, state]) => (
            <div key={name} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2 text-xs">
              <span>{name}</span>
              <span className="font-mono text-muted-foreground">{value}</span>
              <span className={cn('font-mono text-[11px]', state === '锁定' ? 'text-down' : 'text-up')}>
                {state}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded border border-[var(--chart-3)]/40 bg-[var(--chart-3)]/10 p-3 text-xs text-[var(--chart-3)]">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <p className="leading-relaxed">LIVE 交易需要显式授权、后端确认流水和审计日志；当前界面只保留锁定态。</p>
      </div>
    </div>
  )
}

function ExecutionPanel() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
      <div className="rounded border border-border bg-background/35">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-medium leading-none">
            <ClipboardList className="size-3.5 text-primary" />
            Execution Preview
          </div>
          <span className="inline-flex h-5 items-center rounded border border-down/30 bg-down/10 px-2 font-mono text-[10px] leading-none text-down">
            LOCKED
          </span>
        </div>
        <div className="space-y-2 px-3 py-3 text-xs">
          {[
            ['Strategy', 'Trend Rider 15m'],
            ['Symbol', 'BTC/USDT'],
            ['Intent', 'Long · 0.36R'],
            ['Mode', 'Live locked'],
            ['Preview ID', 'Missing'],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Metric label="Queue" value="0" />
        <Metric label="Latency" value="--" />
        <Metric label="Slippage Guard" value="ON" tone="up" />
        <Metric label="Confirm Flow" value="Required" tone="warn" />
      </div>

      <button
        disabled
        className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded border border-border bg-muted/30 text-xs font-medium leading-none text-muted-foreground"
      >
        <Lock className="size-4" />
        等待后端预览和授权
      </button>
    </div>
  )
}

function AgentPanel({
  messages,
  typing,
  input,
  setInput,
  send,
  scrollRef,
}: {
  messages: Message[]
  typing: boolean
  input: string
  setInput: (value: string) => void
  send: (value: string) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      send(input)
    }
  }

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-thin px-4 py-4">
        {messages.map((m) => (
          <div key={m.id} className={cn('flex flex-col gap-1', m.role === 'user' ? 'items-end' : 'items-start')}>
            <div
              className={cn(
                'max-w-[88%] rounded-md px-3 py-2 text-[13px] leading-relaxed',
                m.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card text-card-foreground',
              )}
            >
              {m.content}
            </div>
            <span className="px-1 font-mono text-[10px] text-muted-foreground">{m.time}</span>
          </div>
        ))}
        {typing && (
          <div className="flex w-fit items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2.5">
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {suggestions.map((s) => (
          <button
            key={s.label}
            onClick={() => send(s.label)}
            className="inline-flex h-6 items-center gap-1.5 rounded border border-border bg-card px-2.5 text-[11px] leading-none text-muted-foreground transition-colors hover:border-ring hover:text-foreground [&_svg]:shrink-0"
          >
            <s.icon className="size-3" />
            {s.label}
          </button>
        ))}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-md border border-border bg-background/60 p-2 focus-within:border-ring">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="向 Agent 提问..."
            className="max-h-28 min-h-[24px] flex-1 resize-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim()}
            aria-label="发送"
            className="flex size-8 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <Send className="size-4" />
          </button>
        </div>
      </div>
    </>
  )
}

export function AgentChat({
  collapsed = false,
  onCollapsedChange,
}: {
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}) {
  const [active, setActive] = useState<Panel>('agent')
  const [messages, setMessages] = useState<Message[]>(INITIAL)
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, typing])

  const send = (text: string) => {
    const value = text.trim()
    if (!value) return
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: value, time: now() }])
    setInput('')
    setTyping(true)
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'agent', content: cannedReply, time: now() },
      ])
      setTyping(false)
    }, 700)
  }

  if (collapsed) {
    return (
      <aside className="flex h-full w-full flex-col items-center overflow-hidden bg-sidebar py-2">
        <button
          type="button"
          aria-label="展开控制台"
          title="展开控制台"
          onClick={() => onCollapsedChange?.(false)}
          className="inline-flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightOpen className="size-4" />
        </button>

        <div className="my-2 h-px w-7 bg-border" />

        <div className="flex flex-col gap-1">
          {panels.map((panel) => {
            const Icon = panel.icon
            const selected = active === panel.id
            return (
              <button
                key={panel.id}
                type="button"
                aria-label={panel.label}
                title={panel.label}
                onClick={() => {
                  setActive(panel.id)
                  onCollapsedChange?.(false)
                }}
                className={cn(
                  'inline-flex size-8 items-center justify-center rounded transition-colors',
                  selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
              </button>
            )
          })}
        </div>

        <div className="mb-1 mt-auto h-1.5 w-1.5 rounded-full bg-up" />
      </aside>
    )
  }

  return (
    <aside className="flex h-full flex-col overflow-hidden bg-sidebar">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <div className="relative flex size-8 items-center justify-center rounded bg-primary/15">
          <Bot className="size-4 text-primary" />
          <CheckCircle2 className="absolute -right-1 -top-1 size-3.5 rounded-full bg-sidebar text-up" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-semibold leading-none">
            交易助手
            <Sparkles className="size-3 text-primary" />
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] leading-none">
            <span className="inline-flex h-5 items-center rounded border border-up/30 bg-up/10 px-1.5 text-up">
              风控在线
            </span>
            <span className="inline-flex h-5 items-center rounded border border-down/30 bg-down/10 px-1.5 text-down">
              实盘锁定
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-label="收起控制台"
          title="收起控制台"
          onClick={() => onCollapsedChange?.(true)}
          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightClose className="size-4" />
        </button>
      </header>

      <div className="grid grid-cols-3 border-b border-border">
        {panels.map((panel) => {
          const Icon = panel.icon
          const selected = active === panel.id
          return (
            <button
              key={panel.id}
              onClick={() => setActive(panel.id)}
              className={cn(
                'inline-flex h-9 items-center justify-center gap-1.5 border-r border-border text-xs leading-none last:border-r-0 [&_svg]:shrink-0',
                selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {panel.label}
            </button>
          )
        })}
      </div>

      {active === 'agent' && (
        <AgentPanel
          messages={messages}
          typing={typing}
          input={input}
          setInput={setInput}
          send={send}
          scrollRef={scrollRef}
        />
      )}
      {active === 'risk' && <RiskPanel />}
      {active === 'execution' && <ExecutionPanel />}
    </aside>
  )
}
