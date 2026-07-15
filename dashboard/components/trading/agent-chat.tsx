'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import {
  AGENT_RECENT_MESSAGE_LIMIT,
  AGENT_VISIBLE_MESSAGE_LIMIT,
  DEFAULT_AGENT_CONVERSATION_ID,
  type AgentConversationResponse,
  type AgentStoryResponse,
  type AgentMarketChartResult,
  type MarketStory,
} from '@helix/contracts/agent'
import { DefaultChatTransport, type UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import {
  Activity,
  Bot,
  Newspaper,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentMarketChart } from './agent-market-chart'

const suggestions = [
  { icon: TrendingUp, label: '分析当前趋势' },
  { icon: Activity, label: '检查策略信号' },
  { icon: Newspaper, label: '汇总今日事件' },
]

const daemonOrigin = (
  process.env.NEXT_PUBLIC_HELIX_DAEMON_URL?.trim() || 'http://127.0.0.1:8787'
).replace(/\/$/, '')

function messageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

type MarketChartToolPart = {
  toolCallId: string
  state: string
  output?: unknown
  errorText?: string
}

function marketChartParts(message: UIMessage): MarketChartToolPart[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'tool-renderMarketChart') return []
    return [part as unknown as MarketChartToolPart]
  })
}

function isMarketChartResult(value: unknown): value is AgentMarketChartResult {
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.symbol === 'string'
    && typeof record.timeframe === 'string'
    && Array.isArray(record.candles)
    && Array.isArray(record.annotations)
    && record.source != null
    && typeof record.source === 'object'
}

function MarketChartToolView({ part }: { part: MarketChartToolPart }) {
  if (part.state === 'output-available' && isMarketChartResult(part.output)) {
    return <AgentMarketChart chart={part.output} />
  }
  if (part.state === 'output-error') {
    return <div className="rounded border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">{part.errorText || '图表生成失败'}</div>
  }
  return <div className="h-24 animate-pulse rounded border border-border bg-muted/20" aria-label="正在生成市场图表" />
}

function HelixMessageAvatar({ active = false }: { active?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative mt-0.5 size-7 shrink-0 overflow-hidden rounded-md border border-border bg-primary/10',
        active && 'border-primary/40',
      )}
    >
      <img src="/helix-ai-avatar.png" alt="" className="size-full object-cover" />
      {active && <span className="absolute inset-x-1 bottom-0.5 h-px animate-pulse bg-primary/80" />}
    </div>
  )
}

function AgentPanel({
  messages,
  typing,
  story,
  error,
  input,
  setInput,
  send,
  disabled,
  scrollRef,
}: {
  messages: UIMessage[]
  typing: boolean
  story: MarketStory | null
  error: string | null
  input: string
  setInput: (value: string) => void
  send: (value: string) => void
  disabled: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const lastMessage = messages.at(-1)
  const waitingForFirstToken = typing && (
    lastMessage?.role !== 'assistant' || messageText(lastMessage).length === 0
  )

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
        {story && (
          <div className="border-l-2 border-primary/60 pl-3">
            <div className="flex items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground">
              <span>{story.symbol} · {story.timeframe}</span>
              <span>REV {story.revision}</span>
            </div>
            <div className="mt-1.5 text-xs leading-relaxed text-foreground">{story.summary}</div>
            <div className="mt-2 flex items-center gap-2 font-mono text-[10px]">
              <span className="uppercase text-primary">{story.scenarios.find((scenario) => scenario.role === 'primary')?.state}</span>
              <span className="truncate text-muted-foreground">
                {story.scenarios.find((scenario) => scenario.role === 'primary')?.waitingFor}
              </span>
            </div>
          </div>
        )}
        {messages.length === 0 && !story && (
          <div className="py-6 text-center text-xs text-muted-foreground">当前作用域还没有 Market Story</div>
        )}
        {messages.map((m, index) => {
          const content = messageText(m)
          const charts = marketChartParts(m)
          if (!content && charts.length === 0) return null
          const streaming = typing && m.role === 'assistant' && index === messages.length - 1

          if (m.role === 'user') {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[84%] whitespace-pre-wrap rounded-md rounded-tr-sm bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground">
                  {content}
                </div>
              </div>
            )
          }

          return (
            <div key={m.id} className="flex min-w-0 items-start gap-2">
              <HelixMessageAvatar active={streaming} />
              <div className="min-w-0 max-w-[calc(100%_-_2.25rem)] space-y-2">
                {charts.map((part) => <MarketChartToolView key={part.toolCallId} part={part} />)}
                {(content || streaming) && (
                  <div className="break-words whitespace-pre-wrap rounded-md rounded-tl-sm border border-border bg-card px-3 py-2 text-[13px] leading-relaxed text-card-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_p:not(:last-child)]:mb-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-4">
                    {content && <ReactMarkdown>{content}</ReactMarkdown>}
                    {streaming && (
                      <span className="ml-0.5 inline-block h-[1em] w-px translate-y-[2px] animate-pulse bg-primary" />
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {waitingForFirstToken && (
          <div className="flex items-start gap-2">
            <HelixMessageAvatar active />
            <div className="flex h-9 items-center gap-1.5 rounded-md rounded-tl-sm border border-border bg-card px-3">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </div>
          </div>
        )}
        {error && (
          <div className="rounded border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">{error}</div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {suggestions.map((s) => (
          <button
            key={s.label}
            onClick={() => send(s.label)}
            disabled={disabled}
            className="inline-flex h-6 items-center gap-1.5 rounded border border-border bg-card px-2.5 text-[11px] leading-none text-muted-foreground transition-colors hover:border-ring hover:text-foreground disabled:opacity-40 [&_svg]:shrink-0"
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
            disabled={disabled}
            rows={1}
            placeholder="向 Helix 助手提问..."
            className="max-h-28 min-h-[24px] flex-1 resize-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || typing || disabled}
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
  symbol,
  timeframe,
  collapsed = false,
  onCollapsedChange,
}: {
  symbol: string
  timeframe: string
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}) {
  const [input, setInput] = useState('')
  const [story, setStory] = useState<MarketStory | null>(null)
  const [storyError, setStoryError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [conversationLoading, setConversationLoading] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadStory = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({ symbol, timeframe })
    const response = await fetch(`/api/agent/story?${params.toString()}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error(`Agent Story HTTP ${response.status}`)
    const payload = await response.json() as AgentStoryResponse
    setStory(payload.story)
    setStoryError(null)
  }, [symbol, timeframe])

  const transport = useMemo(() => new DefaultChatTransport({
    api: `${daemonOrigin}/api/agent/chat`,
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        messages: messages.slice(-AGENT_RECENT_MESSAGE_LIMIT),
        symbol,
        timeframe,
      },
    }),
  }), [symbol, timeframe])

  const { messages, status, sendMessage, setMessages, error } = useChat({
    id: `helix:${DEFAULT_AGENT_CONVERSATION_ID}`,
    transport,
    onFinish: () => void loadStory(),
  })
  const typing = status === 'submitted' || status === 'streaming'
  const visibleMessages = messages.slice(-AGENT_VISIBLE_MESSAGE_LIMIT)

  const loadConversation = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/agent/conversation', {
      cache: 'no-store',
      signal,
    })
    if (!response.ok) throw new Error(`Agent Conversation HTTP ${response.status}`)
    const payload = await response.json() as AgentConversationResponse
    setMessages(payload.messages as UIMessage[])
    setConversationError(null)
  }, [setMessages])

  useEffect(() => {
    const controller = new AbortController()
    setStory(null)
    setStoryError(null)
    void loadStory(controller.signal).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setStoryError(reason instanceof Error ? reason.message : 'Agent Story 不可用')
    })
    return () => controller.abort()
  }, [loadStory])

  useEffect(() => {
    const controller = new AbortController()
    setConversationLoading(true)
    setConversationError(null)
    setMessages([])
    void loadConversation(controller.signal)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setConversationError(reason instanceof Error ? reason.message : 'Agent 对话不可用')
      })
      .finally(() => {
        if (!controller.signal.aborted) setConversationLoading(false)
      })
    return () => controller.abort()
  }, [loadConversation, setMessages])

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: typing ? 'auto' : 'smooth',
    })
  }, [messages, typing])

  const send = (text: string) => {
    const value = text.trim()
    if (!value || typing || conversationLoading) return
    setInput('')
    void sendMessage({ text: value })
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

        <button
          type="button"
          aria-label="Helix 助手"
          title="Helix 助手"
          onClick={() => onCollapsedChange?.(false)}
          className="inline-flex size-8 items-center justify-center rounded bg-background text-foreground"
        >
          <Bot className="size-4" />
        </button>

        <div className="mb-1 mt-auto h-1.5 w-1.5 rounded-full bg-muted-foreground" />
      </aside>
    )
  }

  return (
    <aside className="flex h-full flex-col overflow-hidden bg-sidebar">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <div className="relative flex size-8 items-center justify-center overflow-hidden rounded bg-primary/15 ring-1 ring-primary/20">
          <img src="/helix-ai-avatar.png" alt="" className="size-8 object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-semibold leading-none">
            Helix 助手
            <Sparkles className="size-3 text-primary" />
          </div>
          <div className="mt-1.5 truncate font-mono text-[10px] leading-none text-muted-foreground">
            {symbol} · {timeframe}
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

      <AgentPanel
        messages={visibleMessages}
        typing={typing}
        story={story}
        error={error?.message ?? conversationError ?? storyError}
        input={input}
        setInput={setInput}
        send={send}
        disabled={conversationLoading || typing}
        scrollRef={scrollRef}
      />
    </aside>
  )
}
