import { describe, expect, it } from 'vitest'
import type { Direction, Weight } from './schema.ts'
import { calculatePosition, footingOf, isAcross, summarize, type Read, type ReviewOf } from './standing.ts'

const now = new Date('2026-11-12T00:00:00Z')
const said = (occurred_on: string) => ({ occurred_on, onRecord: false })
const bound = (occurred_on: string) => ({ occurred_on, onRecord: true })

describe('footingOf', () => {
  it('is unknown with nothing on file', () => {
    expect(footingOf([], now)).toBe('unknown')
  })

  it('treats an act that binds as standing, however old and however alone', () => {
    expect(footingOf([bound('2019-01-01')], now)).toBe('on_record')
    expect(footingOf([said('2026-11-01'), bound('2021-06-01')], now)).toBe('on_record')
  })

  it('calls a single statement sparse even when it is recent', () => {
    expect(footingOf([said('2026-11-01')], now)).toBe('sparse')
  })

  it('calls it stale once the newest statement is over two years old', () => {
    expect(footingOf([said('2023-04-12')], now)).toBe('stale')
    expect(footingOf([said('2023-04-12'), said('2022-01-01')], now)).toBe('stale')
  })

  it('separates fresh from established by the newest statement', () => {
    expect(footingOf([said('2025-01-22'), said('2026-10-02')], now)).toBe('fresh')
    expect(footingOf([said('2025-01-22'), said('2025-07-30')], now)).toBe('established')
  })
})

const read = (weight: Weight, position: Direction, occurred_on: string, inForce = true): Read => ({ position, weight, occurred_on, inForce })

describe('calculatePosition', () => {
  it('is null with nothing on the record', () => {
    expect(calculatePosition([])).toBeNull()
  })

  it('does not count a commitment that was taken back', () => {
    expect(calculatePosition([read('concrete', 'support', '2026-01-01', false)])).toBeNull()
    expect(calculatePosition([read('concrete', 'support', '2026-01-01', false), read('clear', 'oppose', '2025-06-01')])).toBe('oppose')
  })

  it('takes a concrete act as where they stand, however old', () => {
    expect(calculatePosition([read('concrete', 'oppose', '2015-03-01')])).toBe('oppose')
    expect(calculatePosition([read('concrete', 'lean_support', '2015-03-01')])).toBe('lean_support')
  })

  it('lets the most recent concrete act decide, so a later one supersedes an earlier one', () => {
    expect(calculatePosition([read('concrete', 'support', '2020-01-01'), read('concrete', 'oppose', '2026-01-01')])).toBe('oppose')
    expect(calculatePosition([read('concrete', 'oppose', '2020-01-01'), read('concrete', 'support', '2026-01-01')])).toBe('support')
    expect(calculatePosition([read('concrete', 'support', '2020-01-01'), read('concrete', 'lean_support', '2026-01-01')])).toBe('lean_support')
  })

  it('is mixed for concrete acts on both sides on the same day', () => {
    expect(calculatePosition([read('concrete', 'support', '2026-01-01'), read('concrete', 'oppose', '2026-01-01')])).toBe('mixed')
  })

  it('moves one step toward the middle for a clear statement on another side after the last concrete act', () => {
    expect(calculatePosition([read('concrete', 'support', '2026-01-01'), read('clear', 'oppose', '2026-02-01')])).toBe('lean_support')
    expect(calculatePosition([read('concrete', 'oppose', '2026-01-01'), read('clear', 'support', '2026-02-01')])).toBe('lean_oppose')
    expect(calculatePosition([read('concrete', 'lean_support', '2026-01-01'), read('clear', 'oppose', '2026-02-01')])).toBe('mixed')
    expect(calculatePosition([read('concrete', 'support', '2026-01-01'), read('clear', 'mixed', '2026-02-01')])).toBe('lean_support')
  })

  it('leaves a concrete act where it is for a clear statement made before it, on the same day or on the same side', () => {
    expect(calculatePosition([read('concrete', 'support', '2026-01-01'), read('clear', 'oppose', '2025-12-01')])).toBe('support')
    expect(calculatePosition([read('concrete', 'support', '2026-01-01'), read('clear', 'oppose', '2026-01-01')])).toBe('support')
    expect(calculatePosition([read('concrete', 'support', '2026-01-01'), read('clear', 'lean_support', '2026-02-01')])).toBe('support')
  })

  it('measures a clear statement against the last concrete act, not the first', () => {
    const reads = [read('concrete', 'support', '2024-01-01'), read('clear', 'oppose', '2025-01-01'), read('concrete', 'support', '2026-01-01')]
    expect(calculatePosition(reads)).toBe('support')
  })

  it('goes by the most recent clear statement after a concrete act, not an earlier one', () => {
    const reads = [read('concrete', 'support', '2026-01-01'), read('clear', 'oppose', '2026-02-01'), read('clear', 'support', '2026-03-01')]
    expect(calculatePosition(reads)).toBe('support')
  })

  it('takes the most recent clear statement when there is no concrete act', () => {
    expect(calculatePosition([read('clear', 'support', '2025-01-01'), read('clear', 'oppose', '2026-01-01')])).toBe('oppose')
    expect(calculatePosition([read('clear', 'oppose', '2026-01-01'), read('clear', 'lean_support', '2025-01-01')])).toBe('oppose')
  })

  it('is mixed when clear statements made on the same day point both ways', () => {
    expect(calculatePosition([read('clear', 'support', '2026-01-01'), read('clear', 'oppose', '2026-01-01')])).toBe('mixed')
  })

  it('ignores passing remarks once there is a clear statement or a concrete act', () => {
    expect(calculatePosition([read('clear', 'support', '2025-01-01'), read('passing', 'oppose', '2026-01-01')])).toBe('support')
    expect(calculatePosition([read('concrete', 'support', '2025-01-01'), read('passing', 'oppose', '2026-01-01')])).toBe('support')
  })

  it('gives only a lean when all there is are passing remarks, going by the most recent', () => {
    expect(calculatePosition([read('passing', 'support', '2026-01-01')])).toBe('lean_support')
    expect(calculatePosition([read('passing', 'oppose', '2026-01-01')])).toBe('lean_oppose')
    expect(calculatePosition([read('passing', 'lean_support', '2026-01-01')])).toBe('lean_support')
    expect(calculatePosition([read('passing', 'mixed', '2026-01-01')])).toBe('mixed')
    expect(calculatePosition([read('passing', 'support', '2025-01-01'), read('passing', 'oppose', '2026-01-01')])).toBe('lean_oppose')
  })
})

describe('calculatePosition with what others say of someone', () => {
  it('gives a lean when a presumed reading is all there is', () => {
    expect(calculatePosition([read('presumed', 'oppose', '2026-01-01')])).toBe('lean_oppose')
    expect(calculatePosition([read('presumed', 'support', '2026-01-01')])).toBe('lean_support')
  })

  it('does not count a presumed reading once there is anything of their own, however slight or old', () => {
    expect(calculatePosition([read('presumed', 'oppose', '2026-06-01'), read('passing', 'support', '2020-01-01')])).toBe('lean_support')
    expect(calculatePosition([read('presumed', 'oppose', '2026-06-01'), read('clear', 'support', '2020-01-01')])).toBe('support')
  })
})

describe('isAcross', () => {
  it('is true for a reading on the other side of a position, lean or not', () => {
    expect(isAcross('support', 'oppose')).toBe(true)
    expect(isAcross('lean_oppose', 'lean_support')).toBe(true)
    expect(isAcross('oppose', 'support')).toBe(true)
  })

  it('is false on the same side, and whenever either one is mixed', () => {
    expect(isAcross('support', 'lean_support')).toBe(false)
    expect(isAcross('lean_oppose', 'oppose')).toBe(false)
    expect(isAcross('mixed', 'oppose')).toBe(false)
    expect(isAcross('support', 'mixed')).toBe(false)
  })
})

const review = (reviewer_id: string, tier: ReviewOf['tier'], position: Direction, weight: Weight = 'clear', updated_at = '2026-11-01T00:00:00Z'): ReviewOf => ({ reviewer_id, tier, position, weight, updated_at })

describe('summarize', () => {
  it('is null with no reviews', () => {
    expect(summarize([])).toBeNull()
  })

  it('takes an editor review over any number of people who disagree', () => {
    const reviews = [review('a', 'person', 'support'), review('b', 'person', 'support'), review('editors', 'editor', 'oppose', 'passing')]
    expect(summarize(reviews)).toEqual({ position: 'oppose', weight: 'passing', tier: 'editor', count: 1 })
  })

  it('takes people over an agent, and an agent when it is all there is', () => {
    expect(summarize([review('reader', 'agent', 'oppose'), review('a', 'person', 'support')])).toMatchObject({ position: 'support', tier: 'person' })
    expect(summarize([review('reader', 'agent', 'oppose', 'concrete')])).toEqual({ position: 'oppose', weight: 'concrete', tier: 'agent', count: 1 })
  })

  it('averages a yes and a no to mixed', () => {
    expect(summarize([review('a', 'person', 'support'), review('b', 'person', 'oppose')])?.position).toBe('mixed')
  })

  it('averages a mixed and a no to probably no', () => {
    expect(summarize([review('a', 'person', 'mixed'), review('b', 'person', 'oppose')])?.position).toBe('lean_oppose')
  })

  it('rounds halves toward mixed', () => {
    expect(summarize([review('a', 'person', 'support'), review('b', 'person', 'lean_support')])?.position).toBe('lean_support')
    expect(summarize([review('a', 'person', 'lean_support'), review('b', 'person', 'mixed')])?.position).toBe('mixed')
    expect(summarize([review('a', 'person', 'support'), review('b', 'person', 'support'), review('c', 'person', 'lean_support')])?.position).toBe('support')
  })

  it('rounds the weight down', () => {
    expect(summarize([review('a', 'person', 'support', 'concrete'), review('b', 'person', 'support', 'clear')])?.weight).toBe('clear')
    expect(summarize([review('a', 'person', 'support', 'clear'), review('b', 'person', 'support', 'presumed')])?.weight).toBe('passing')
  })

  it('counts one reviewer once, by their latest review', () => {
    const reviews = [review('a', 'person', 'support', 'clear', '2026-01-01'), review('a', 'person', 'oppose', 'clear', '2026-02-01'), review('b', 'person', 'oppose')]
    expect(summarize(reviews)).toMatchObject({ position: 'oppose', count: 2 })
  })

  it('counts a copy of another review as one more review that agrees', () => {
    expect(summarize([review('a', 'person', 'support'), review('b', 'person', 'support'), review('c', 'person', 'oppose')])?.position).toBe('lean_support')
  })
})

describe('calculatePosition over summaries', () => {
  it('moves off what the model guessed once a person reviews the act', () => {
    const guess = summarize([review('reader', 'agent', 'support', 'concrete')])!
    const reviewed = summarize([review('reader', 'agent', 'support', 'concrete'), review('a', 'person', 'oppose', 'clear')])!
    expect(calculatePosition([{ ...guess, occurred_on: '2026-01-01', inForce: true }])).toBe('support')
    expect(calculatePosition([{ ...reviewed, occurred_on: '2026-01-01', inForce: true }])).toBe('oppose')
  })

  it('treats a summary of probably no on a concrete act as where they stand', () => {
    const summary = summarize([review('a', 'person', 'mixed', 'concrete'), review('b', 'person', 'oppose', 'concrete')])!
    expect(calculatePosition([{ ...summary, occurred_on: '2026-01-01', inForce: true }])).toBe('lean_oppose')
  })
})
