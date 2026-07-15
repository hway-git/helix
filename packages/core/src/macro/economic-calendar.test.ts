import assert from 'node:assert/strict'
import test from 'node:test'
import { parseForexFactoryCalendar, translateEconomicEventTitle } from './economic-calendar'

test('parses scheduled economic events and omits holidays or invalid rows', () => {
  const events = parseForexFactoryCalendar([
    {
      title: 'Core CPI m/m',
      country: 'USD',
      date: '2026-07-14T08:30:00-04:00',
      impact: 'High',
      forecast: '0.2%',
      previous: '0.2%',
    },
    {
      title: 'Bank Holiday',
      country: 'EUR',
      date: '2026-07-14T02:01:00-04:00',
      impact: 'Holiday',
    },
    {
      title: 'Broken event',
      country: 'GBP',
      date: 'not-a-date',
      impact: 'Medium',
    },
  ])

  assert.equal(events.length, 1)
  assert.equal(events[0]?.title, 'Core CPI m/m')
  assert.equal(events[0]?.titleZh, '核心 CPI 月率')
  assert.equal(events[0]?.currency, 'USD')
  assert.equal(events[0]?.impact, 'high')
  assert.equal(events[0]?.forecast, '0.2%')
  assert.equal(events[0]?.previous, '0.2%')
  assert.equal(events[0]?.scheduledAt, Date.parse('2026-07-14T08:30:00-04:00'))
})

test('translates common central-bank speakers and leaves unknown events untouched', () => {
  assert.equal(translateEconomicEventTitle('Fed Chairman Warsh Testifies'), '美联储主席 Warsh 作证')
  assert.equal(translateEconomicEventTitle('FOMC Member Bowman Speaks'), '美联储官员 Bowman 讲话')
  assert.equal(translateEconomicEventTitle('Unknown Regional Survey'), undefined)
})

test('rejects a non-array calendar response', () => {
  assert.throws(() => parseForexFactoryCalendar({ error: 'unavailable' }), /返回格式无效/)
})
