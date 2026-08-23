import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { Prisma } from '@prisma/client'
import { encryptSecret, secretSuffix } from '../../../packages/security/src/envelope-crypto.js'
import { loadMasterKey } from '../../../packages/security/src/master-key.js'
import { decryptSecret } from '../../../packages/security/src/envelope-crypto.js'
import { validateCostTimezone } from '../../../packages/gateway-core/src/cost-schedule.js'
import { CatalogLifecycle } from './catalog.dto.js'
import { lockCatalogRecord } from './catalog-lock.js'
import { validateModelDiscoveryUrl as validateDiscoveryUrl } from '../../../packages/gateway-core/src/model-discovery-url.js'

export interface ChannelListFilter {
  limit?: number
  offset?: number
  q?: string
  provider?: string
  protocol?: 'OPENAI' | 'ANTHROPIC' | 'GEMINI'
  health?: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'DISABLED'
  enabled?: boolean
  lifecycle?: CatalogLifecycle
}

@Injectable()
export class ChannelsService {
  constructor(private readonly prisma: PrismaService) {}
  async list(filter: ChannelListFilter = {}) {
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50))
    const offset = Math.max(0, filter.offset ?? 0)
    const where: any = {
      ...lifecycleWhere(filter.lifecycle),
      ...(filter.q ? { OR: [{ name: { contains: filter.q, mode: 'insensitive' } }, { provider: { contains: filter.q, mode: 'insensitive' } }] } : {}),
      ...(filter.provider ? { provider: filter.provider } : {}), ...(filter.protocol ? { protocol: filter.protocol } : {}),
      ...(filter.health ? { health: filter.health } : {}), ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {})
    }
    const [channels, total] = await Promise.all([
      this.prisma.channel.findMany({ where, include: {
        channelModels: { where: lifecycleWhere(filter.lifecycle), select: { id: true, health: true, enabled: true } }, keys: { where: lifecycleWhere(filter.lifecycle), select: {
          id: true, suffix: true, enabled: true, health: true, priority: true, weight: true, remainingUsd: true, expiresAt: true
        } }
      }, orderBy: [{ priority: 'desc' }, { name: 'asc' }], skip: offset, take: limit }),
      this.prisma.channel.count({ where })
    ])
    const ids = channels.map(channel => channel.id)
    const aggregates: any[] = ids.length ? await this.prisma.$queryRaw(Prisma.sql`
      SELECT channel_id::text AS channel_id, COUNT(*)::bigint AS requests,
        COUNT(*) FILTER (WHERE status_code < 400)::bigint AS successes,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms
      FROM usage_logs
      WHERE started_at >= ${new Date(Date.now() - 86_400_000)}
        AND channel_id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      GROUP BY channel_id`) : []
    const usageByChannel = new Map(aggregates.map(row => [row.channel_id, row]))
    const items = channels.map(channel => {
      const usage = usageByChannel.get(channel.id)
      const requests = Number(usage?.requests || 0)
      const { keys, channelModels, ...summary } = channel as any
      return {
        ...summary, availableKeys: keys.filter((key: any) => key.enabled && key.health !== 'DISABLED').length,
        healthyModels: channelModels.filter((model: any) => model.enabled && (model.health === 'HEALTHY' || model.health === 'DEGRADED')).length,
        modelCount: channelModels.length,
        usage24h: {
          requests, successRate: requests ? Number(usage.successes) / requests : 0,
          p95LatencyMs: usage?.p95_latency_ms == null ? null : Math.round(Number(usage.p95_latency_ms))
        }
      }
    })
    return { items, total, limit, offset }
  }

  async detail(id: string, lifecycle: CatalogLifecycle = CatalogLifecycle.ACTIVE) {
    const channel = await this.prisma.channel.findUnique({ where: { id }, include: {
      keys: { where: lifecycleWhere(lifecycle), select: { id: true, suffix: true, enabled: true, health: true, priority: true, weight: true, remainingUsd: true,
        expiresAt: true, isolatedUntil: true, lastUsedAt: true, deletedAt: true } },
      channelModels: { where: lifecycleWhere(lifecycle), include: { costRules: { where: {
        ...lifecycleWhere(lifecycle), ...(lifecycle === CatalogLifecycle.ACTIVE ? { enabled: true } : {})
      }, orderBy: [{ priority: 'desc' }, { validFrom: 'desc' }] } } }
    } })
    if (!channel || !matchesLifecycle(channel, lifecycle)) throw new NotFoundException('Channel not found')
    const safeKeys = (channel.keys as any[]).map(({ ciphertext: _ciphertext, iv: _iv, tag: _tag, ...key }) => key)
    return { ...channel, keys: safeKeys }
  }
  async discoverModels(id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id }, include: { keys: true, channelModels: true } })
    if (!channel || channel.deletedAt) throw new NotFoundException('Channel not found')
    const key = channel.keys.find(item => !item.deletedAt && item.enabled && item.health !== 'DISABLED')
    if (!key) throw new BadRequestException('Channel requires an enabled key')
    const plaintext = decryptSecret({ algorithm: 'aes-256-gcm', ciphertext: key.ciphertext, iv: key.iv, tag: key.tag }, loadMasterKey())
    const base = channel.baseUrl.endsWith('/') ? channel.baseUrl : `${channel.baseUrl}/`
    const headers: Record<string, string> = channel.protocol === 'ANTHROPIC'
      ? { 'x-api-key': plaintext, 'anthropic-version': '2023-06-01' }
      : channel.protocol === 'GEMINI' ? { 'x-goog-api-key': plaintext } : { authorization: `Bearer ${plaintext}` }
    const configuredDiscoveryUrl = channel.modelDiscoveryUrl
      ? validateModelDiscoveryUrl(channel.modelDiscoveryUrl, channel.baseUrl)
      : null
    const discoveryUrl = configuredDiscoveryUrl || (channel.protocol === 'GEMINI'
      ? new URL('v1beta/models', base)
      : new URL('v1/models', base))
    const response = await fetch(discoveryUrl, {
      headers, ...(configuredDiscoveryUrl ? { redirect: 'error' as const } : {})
    })
    if (!response.ok) throw new BadRequestException(`Upstream model discovery failed with status ${response.status}`)
    const payload: any = await response.json()
    const ids = channel.protocol === 'GEMINI'
      ? (payload.models || []).map((model: any) => String(model.name || '').replace(/^models\//, ''))
      : (payload.data || []).map((model: any) => String(model.id || ''))
    const mapped = new Set(channel.channelModels.filter(model => !model.deletedAt).map(model => model.upstreamModel))
    return [...new Set(ids.filter(Boolean) as string[])].sort().map(upstreamModel => ({ upstreamModel, alreadyMapped: mapped.has(upstreamModel) }))
  }
  create(body: any) {
    assertCostTimezone(body.costTimezone ?? 'UTC')
    if (body.modelDiscoveryUrl) validateModelDiscoveryUrl(body.modelDiscoveryUrl, body.baseUrl)
    return this.prisma.channel.create({ data: {
    name: body.name, provider: body.provider, protocol: body.protocol, baseUrl: body.baseUrl,
    modelDiscoveryUrl: body.modelDiscoveryUrl ?? null,
    priority: body.priority ?? 0, weight: body.weight ?? 1, timeoutMs: body.timeoutMs ?? 300000,
    maxRetries: body.maxRetries ?? 1, keySelection: body.keySelection ?? 'WEIGHTED_RANDOM', costTimezone: body.costTimezone ?? 'UTC'
    } })
  }
  async addKey(channelId: string, body: any) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } })
    if (!channel || channel.deletedAt) throw new NotFoundException('Channel not found')
    const plaintext = String(body.key || '').trim()
    if (!plaintext) throw new BadRequestException('Key is required')
    const encrypted = encryptSecret(plaintext, loadMasterKey())
    return this.prisma.channelKey.create({ data: {
      channelId, ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag,
      suffix: secretSuffix(plaintext), priority: body.priority ?? 0, weight: body.weight ?? 1
    }, select: { id: true, suffix: true, enabled: true, health: true } })
  }
  async setEnabled(id: string, enabled: boolean) {
    const channel = await this.requireActiveChannel(id)
    return this.prisma.channel.update({ where: { id }, data: {
      enabled, ...(enabled && channel.health === 'DISABLED' ? { health: 'DEGRADED' as const } : {})
    } })
  }
  async test(id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id }, include: { keys: true, channelModels: true } })
    if (!channel || channel.deletedAt) throw new NotFoundException('Channel not found')
    const key = channel.keys.find(item => !item.deletedAt && item.enabled)
    const ability = channel.channelModels.find(item => !item.deletedAt && item.enabled)
    if (!key || !ability) throw new BadRequestException('Channel requires an enabled key and model ability')
    const plaintext = decryptSecret({ algorithm: 'aes-256-gcm', ciphertext: key.ciphertext, iv: key.iv, tag: key.tag }, loadMasterKey())
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(channel.timeoutMs, 30_000))
    try {
      const base = channel.baseUrl.endsWith('/') ? channel.baseUrl : `${channel.baseUrl}/`
      const headers: Record<string, string> = channel.protocol === 'ANTHROPIC'
        ? { 'x-api-key': plaintext, 'anthropic-version': '2023-06-01' }
        : channel.protocol === 'GEMINI' ? { 'x-goog-api-key': plaintext } : { authorization: `Bearer ${plaintext}` }
      const response = await fetch(channel.protocol === 'GEMINI' ? new URL('v1beta/models', base) : new URL('v1/models', base), { headers, signal: controller.signal })
      const health = response.ok ? 'HEALTHY' : response.status === 401 || response.status === 403 ? 'UNHEALTHY' : 'DEGRADED'
      await this.prisma.channel.update({ where: { id }, data: {
        health, lastTestedAt: new Date(), ...(response.ok ? { lastSuccessAt: new Date(), circuitOpenUntil: null } : {})
      } })
      if (health === 'UNHEALTHY' && channel.autoDisable) await this.prisma.channelKey.update({ where: { id: key.id }, data: { health: 'DISABLED' } })
      return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, health }
    } catch (error: any) {
      await this.prisma.channel.update({ where: { id }, data: { health: 'UNHEALTHY', lastTestedAt: new Date(), circuitOpenUntil: new Date(Date.now() + 5 * 60_000) } })
      return { ok: false, status: 0, latencyMs: Date.now() - started, health: 'UNHEALTHY', error: error.name }
    } finally { clearTimeout(timeout) }
  }
  async update(id: string, body: any) {
    const channel = await this.requireActiveChannel(id)
    if (body.costTimezone !== undefined) assertCostTimezone(body.costTimezone)
    const baseUrl = body.baseUrl ?? channel.baseUrl
    const modelDiscoveryUrl = body.modelDiscoveryUrl !== undefined ? body.modelDiscoveryUrl : channel.modelDiscoveryUrl
    if (modelDiscoveryUrl) validateModelDiscoveryUrl(modelDiscoveryUrl, baseUrl)
    return this.prisma.channel.update({ where: { id }, data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
      ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
      ...(body.modelDiscoveryUrl !== undefined ? { modelDiscoveryUrl: body.modelDiscoveryUrl || null } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.weight !== undefined ? { weight: body.weight } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.maxRetries !== undefined ? { maxRetries: body.maxRetries } : {}),
      ...(body.keySelection !== undefined ? { keySelection: body.keySelection } : {}),
      ...(body.autoDisable !== undefined ? { autoDisable: body.autoDisable } : {}),
      ...(body.costTimezone !== undefined ? { costTimezone: body.costTimezone } : {})
    } })
  }
  async updateKey(channelId: string, keyId: string, body: any) {
    await this.requireActiveChannel(channelId)
    const key = await this.prisma.channelKey.findFirst({ where: { id: keyId, channelId } })
    if (!key) throw new NotFoundException('Key not found')
    if (key.deletedAt) throw new ConflictException('Archived key cannot be edited')
    return this.prisma.channelKey.update({ where: { id: keyId }, data: {
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
      ...(body.enabled === true && key.health === 'DISABLED' ? { health: 'DEGRADED' as const } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.weight !== undefined ? { weight: body.weight } : {}),
      ...(body.remainingUsd !== undefined ? { remainingUsd: body.remainingUsd } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {})
    }, select: { id: true, suffix: true, enabled: true, health: true, priority: true, weight: true, remainingUsd: true, expiresAt: true, deletedAt: true } })
  }

  async archive(id: string) {
    return this.prisma.$transaction(async transaction => {
      await lockCatalogRecord(transaction, `channel:${id}`)
      const channel = await transaction.channel.findUnique({ where: { id }, select: { id: true, deletedAt: true } })
      if (!channel) throw new NotFoundException('Channel not found')
      if (channel.deletedAt) return { id, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt: channel.deletedAt }
      const deletedAt = new Date()
      const modelIds = (await transaction.channelModel.findMany({ where: { channelId: id }, select: { id: true } })).map(item => item.id)
      await transaction.channelModelCostRule.updateMany({
        where: { channelModelId: { in: modelIds } }, data: { deletedAt, enabled: false }
      })
      await transaction.channelModel.updateMany({
        where: { channelId: id }, data: { deletedAt, enabled: false, probeEnabled: false, health: 'DISABLED' }
      })
      await transaction.channelKey.updateMany({
        where: { channelId: id }, data: { deletedAt, enabled: false, health: 'DISABLED', isolatedUntil: null }
      })
      await transaction.channel.update({
        where: { id }, data: { deletedAt, enabled: false, health: 'DISABLED', circuitOpenUntil: null }
      })
      return { id, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt }
    })
  }

  async restore(id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id }, select: { id: true, deletedAt: true } })
    if (!channel) throw new NotFoundException('Channel not found')
    if (!channel.deletedAt) return { id, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
    await this.prisma.channel.update({
      where: { id }, data: { deletedAt: null, enabled: false, health: 'DISABLED', circuitOpenUntil: null }
    })
    return { id, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
  }

  async archiveKey(channelId: string, keyId: string) {
    await this.requireActiveChannel(channelId)
    const key = await this.prisma.channelKey.findFirst({ where: { id: keyId, channelId } })
    if (!key) throw new NotFoundException('Key not found')
    if (key.deletedAt) return { id: keyId, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt: key.deletedAt }
    const deletedAt = new Date()
    await this.prisma.channelKey.update({
      where: { id: keyId }, data: { deletedAt, enabled: false, health: 'DISABLED', isolatedUntil: null }
    })
    return { id: keyId, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt }
  }

  async restoreKey(channelId: string, keyId: string) {
    await this.requireActiveChannel(channelId)
    const key = await this.prisma.channelKey.findFirst({ where: { id: keyId, channelId } })
    if (!key) throw new NotFoundException('Key not found')
    if (!key.deletedAt) return { id: keyId, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
    await this.prisma.channelKey.update({
      where: { id: keyId }, data: { deletedAt: null, enabled: false, health: 'DISABLED', isolatedUntil: null }
    })
    return { id: keyId, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
  }

  private async requireActiveChannel(id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id } })
    if (!channel || channel.deletedAt) throw new NotFoundException('Channel not found')
    return channel
  }
}

function lifecycleWhere(lifecycle: CatalogLifecycle = CatalogLifecycle.ACTIVE): Record<string, unknown> {
  if (lifecycle === CatalogLifecycle.ALL) return {}
  return lifecycle === CatalogLifecycle.ARCHIVED ? { deletedAt: { not: null } } : { deletedAt: null }
}

function matchesLifecycle(item: { deletedAt?: Date | null }, lifecycle: CatalogLifecycle): boolean {
  if (lifecycle === CatalogLifecycle.ALL) return true
  return lifecycle === CatalogLifecycle.ARCHIVED ? Boolean(item.deletedAt) : !item.deletedAt
}

function assertCostTimezone(timezone: string): void {
  try { validateCostTimezone(timezone) } catch {
    throw new BadRequestException('Cost timezone must be a valid IANA timezone')
  }
}

function validateModelDiscoveryUrl(value: string, baseUrl: string): URL {
  try {
    return validateDiscoveryUrl(value, baseUrl)
  } catch (error: any) {
    throw new BadRequestException(error?.message || 'Model discovery URL is invalid')
  }
}
