import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { jsonSafe } from '../../packages/http/src/json.js'

describe('jsonSafe', () => {
  it('converts bigint to string', () => {
    expect(jsonSafe(123n)).toBe('123')
  })
  it('recursively converts nested bigints in arrays and objects', () => {
    expect(jsonSafe({ a: 1n, list: [2n, { b: 3n }], keep: 'x' })).toEqual({ a: '1', list: ['2', { b: '3' }], keep: 'x' })
  })
  it('passes through primitives', () => {
    expect(jsonSafe('s')).toBe('s')
    expect(jsonSafe(42)).toBe(42)
    expect(jsonSafe(null)).toBeNull()
    expect(jsonSafe(true)).toBe(true)
  })
  it('preserves Date objects (so JSON serializes them as ISO strings)', () => {
    const date = new Date('2026-08-13T12:00:00.000Z')
    expect(jsonSafe(date)).toBe(date)
    expect(JSON.stringify(jsonSafe({ at: date }))).toBe('{"at":"2026-08-13T12:00:00.000Z"}')
  })
})
