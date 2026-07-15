import type {
  EconomicCalendarEvent,
  EconomicCalendarSnapshot,
  EconomicEventImpact,
} from '@helix/contracts/market'

type ForexFactoryEvent = {
  title?: unknown
  country?: unknown
  date?: unknown
  impact?: unknown
  actual?: unknown
  forecast?: unknown
  previous?: unknown
}

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const REQUEST_TIMEOUT_MS = 10_000
const SOURCE_NAME = 'Forex Factory'
const TITLE_TRANSLATIONS: Record<string, string> = {
  'ADP Non-Farm Employment Change': 'ADP 非农就业人数变化',
  'ADP Weekly Employment Change': 'ADP 每周就业人数变化',
  'Advance GDP q/q': '国内生产总值初值季率',
  'Average Hourly Earnings m/m': '平均时薪月率',
  'BOC Monetary Policy Report': '加拿大央行货币政策报告',
  'BOC Press Conference': '加拿大央行新闻发布会',
  'BOC Rate Statement': '加拿大央行利率声明',
  'Building Permits': '营建许可总数',
  'Core CPI m/m': '核心 CPI 月率',
  'Core CPI y/y': '核心 CPI 年率',
  'Core Durable Goods Orders m/m': '核心耐用品订单月率',
  'Core PCE Price Index m/m': '核心 PCE 物价指数月率',
  'Core PCE Price Index y/y': '核心 PCE 物价指数年率',
  'Core PPI m/m': '核心 PPI 月率',
  'Core PPI y/y': '核心 PPI 年率',
  'Core Retail Sales m/m': '核心零售销售月率',
  'CPI m/m': 'CPI 月率',
  'CPI q/q': 'CPI 季率',
  'CPI y/y': 'CPI 年率',
  'Crude Oil Inventories': '原油库存',
  'Durable Goods Orders m/m': '耐用品订单月率',
  'ECB Main Refinancing Rate': '欧洲央行主要再融资利率',
  'ECB Monetary Policy Statement': '欧洲央行货币政策声明',
  'ECB Press Conference': '欧洲央行新闻发布会',
  'Employment Change': '就业人数变化',
  'Existing Home Sales': '成屋销售总数',
  'Federal Funds Rate': '美联储联邦基金利率',
  'FOMC Economic Projections': '美联储经济预测',
  'FOMC Meeting Minutes': '美联储会议纪要',
  'FOMC Press Conference': '美联储新闻发布会',
  'FOMC Statement': '美联储利率声明',
  'GDP m/m': '国内生产总值月率',
  'GDP q/q': '国内生产总值季率',
  'GDP q/y': '国内生产总值年率',
  'GDP y/y': '国内生产总值年率',
  'Housing Starts': '新屋开工总数',
  'ISM Manufacturing PMI': 'ISM 制造业 PMI',
  'ISM Services PMI': 'ISM 服务业 PMI',
  'JOLTS Job Openings': 'JOLTS 职位空缺',
  'Monetary Policy Report': '货币政策报告',
  'New Home Sales': '新屋销售总数',
  'Non-Farm Employment Change': '非农就业人数变化',
  'Overnight Rate': '加拿大隔夜利率',
  'PCE Price Index m/m': 'PCE 物价指数月率',
  'PCE Price Index y/y': 'PCE 物价指数年率',
  'Pending Home Sales m/m': '成屋签约销售指数月率',
  'Philly Fed Manufacturing Index': '费城联储制造业指数',
  'Policy Rate': '政策利率',
  'PPI m/m': 'PPI 月率',
  'PPI y/y': 'PPI 年率',
  'Prelim UoM Consumer Sentiment': '密歇根大学消费者信心指数初值',
  'Prelim UoM Inflation Expectations': '密歇根大学通胀预期初值',
  'Retail Sales m/m': '零售销售月率',
  'Retail Sales y/y': '零售销售年率',
  'Trade Balance': '贸易帐',
  'Unemployment Claims': '初请失业金人数',
  'Unemployment Rate': '失业率',
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseImpact(value: unknown): EconomicEventImpact | null {
  if (typeof value !== 'string') return null

  switch (value.toLowerCase()) {
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    case 'low':
      return 'low'
    default:
      return null
  }
}

export function translateEconomicEventTitle(title: string) {
  const exact = TITLE_TRANSLATIONS[title]
  if (exact) return exact

  const speakerPatterns: Array<[RegExp, (name: string) => string]> = [
    [/^FOMC Member (.+) Speaks$/, (name) => `美联储官员 ${name} 讲话`],
    [/^Fed Chairman (.+) Speaks$/, (name) => `美联储主席 ${name} 讲话`],
    [/^Fed Chairman (.+) Testifies$/, (name) => `美联储主席 ${name} 作证`],
    [/^BOE Gov (.+) Speaks$/, (name) => `英国央行行长 ${name} 讲话`],
    [/^MPC Member (.+) Speaks$/, (name) => `英国央行货币政策委员 ${name} 讲话`],
    [/^ECB President (.+) Speaks$/, (name) => `欧洲央行行长 ${name} 讲话`],
    [/^BOC Gov (.+) Speaks$/, (name) => `加拿大央行行长 ${name} 讲话`],
    [/^RBA Gov (.+) Speaks$/, (name) => `澳洲联储主席 ${name} 讲话`],
    [/^RBNZ Gov (.+) Speaks$/, (name) => `新西兰联储主席 ${name} 讲话`],
    [/^BOJ Gov (.+) Speaks$/, (name) => `日本央行行长 ${name} 讲话`],
    [/^German Buba President (.+) Speaks$/, (name) => `德国央行行长 ${name} 讲话`],
    [/^President (.+) Speaks$/, (name) => `美国总统 ${name} 讲话`],
  ]

  for (const [pattern, translate] of speakerPatterns) {
    const match = title.match(pattern)
    if (match?.[1]) return translate(match[1])
  }

  return undefined
}

export function getCurrentWeekRange(now = Date.now()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const day = start.getDay()
  start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day))

  const end = new Date(start)
  end.setDate(end.getDate() + 7)

  return { weekStart: start.getTime(), weekEnd: end.getTime() }
}

export function parseForexFactoryCalendar(payload: unknown): EconomicCalendarEvent[] {
  if (!Array.isArray(payload)) throw new Error('经济日历返回格式无效')

  return payload.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return []

    const event = raw as ForexFactoryEvent
    const title = optionalText(event.title)
    const currency = optionalText(event.country)
    const date = optionalText(event.date)
    const impact = parseImpact(event.impact)
    const scheduledAt = date ? Date.parse(date) : Number.NaN

    if (!title || !currency || !impact || !Number.isFinite(scheduledAt)) return []

    const parsed: EconomicCalendarEvent = {
      id: `${currency}:${scheduledAt}:${title}:${index}`,
      title,
      currency,
      scheduledAt,
      impact,
      source: SOURCE_NAME,
    }
    const titleZh = translateEconomicEventTitle(title)
    const actual = optionalText(event.actual)
    const forecast = optionalText(event.forecast)
    const previous = optionalText(event.previous)
    if (titleZh) parsed.titleZh = titleZh
    if (actual) parsed.actual = actual
    if (forecast) parsed.forecast = forecast
    if (previous) parsed.previous = previous

    return [parsed]
  })
}

export async function getEconomicCalendarSnapshot(now = Date.now()): Promise<EconomicCalendarSnapshot> {
  const { weekStart, weekEnd } = getCurrentWeekRange(now)

  try {
    const response = await fetch(CALENDAR_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`经济日历 HTTP ${response.status}`)

    const events = parseForexFactoryCalendar(await response.json())
      .filter((event) => event.scheduledAt >= weekStart && event.scheduledAt < weekEnd)
      .sort((left, right) => left.scheduledAt - right.scheduledAt)

    return {
      ok: true,
      weekStart,
      weekEnd,
      events,
      source: {
        name: SOURCE_NAME,
        status: 'live',
        fetchedAt: Date.now(),
        errors: [],
      },
    }
  } catch (error) {
    return {
      ok: false,
      weekStart,
      weekEnd,
      events: [],
      source: {
        name: SOURCE_NAME,
        status: 'offline',
        fetchedAt: Date.now(),
        errors: [error instanceof Error ? error.message : '经济日历请求失败'],
      },
    }
  }
}
