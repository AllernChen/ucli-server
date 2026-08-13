export interface ChannelCandidate {
  id: string
  priority: number
  weight: number
  healthy: boolean
}

export interface KeyCandidate {
  id: string
  enabled: boolean
  healthy: boolean
  remainingUsd: number | null
  weight: number
  priority?: number
  expiresAt?: Date | null
  isolatedUntil?: Date | null
}

function weighted<T extends { weight: number }>(items: T[], random: () => number): T | null {
  if (!items.length) return null
  const total = items.reduce((sum, item) => sum + Math.max(1, item.weight), 0)
  let cursor = Math.min(0.999999999, Math.max(0, random())) * total
  for (const item of items) {
    cursor -= Math.max(1, item.weight)
    if (cursor < 0) return item
  }
  return items.at(-1) ?? null
}

export function selectChannel<T extends ChannelCandidate>(
  channels: T[], random: () => number = Math.random
): T | null {
  const healthy = channels.filter(channel => channel.healthy)
  if (!healthy.length) return null
  const highestPriority = Math.max(...healthy.map(channel => channel.priority))
  return weighted(healthy.filter(channel => channel.priority === highestPriority), random)
}

export function selectKey<T extends KeyCandidate>(
  keys: T[], random: () => number = Math.random, now = new Date()
): T | null {
  const available = keys.filter(key =>
    key.enabled && key.healthy && (key.remainingUsd === null || key.remainingUsd > 0) &&
    (!key.expiresAt || key.expiresAt > now) && (!key.isolatedUntil || key.isolatedUntil <= now)
  )
  if (!available.length) return null
  const priority = Math.max(...available.map(key => key.priority ?? 0))
  return weighted(available.filter(key => (key.priority ?? 0) === priority), random)
}

export function selectKeyRoundRobin<T extends KeyCandidate>(keys: T[], cursor: number, now = new Date()): T | null {
  const available = keys.filter(key => key.enabled && key.healthy && (key.remainingUsd === null || key.remainingUsd > 0) &&
    (!key.expiresAt || key.expiresAt > now) && (!key.isolatedUntil || key.isolatedUntil <= now))
  if (!available.length) return null
  const priority = Math.max(...available.map(key => key.priority ?? 0))
  const eligible = available.filter(key => (key.priority ?? 0) === priority).sort((left, right) => left.id.localeCompare(right.id))
  return eligible[Math.abs(Math.trunc(cursor)) % eligible.length] ?? null
}
