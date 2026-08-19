export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    // Non-plain objects (e.g. Decimal.js / Prisma Decimal) serialize via toJSON to their string form.
    if (Object.getPrototypeOf(value) !== Object.prototype && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      return jsonSafe((value as { toJSON: () => unknown }).toJSON())
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]))
  }
  return value
}
