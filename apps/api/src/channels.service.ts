import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { encryptSecret, secretSuffix } from '../../../packages/security/src/envelope-crypto.js'
import { loadMasterKey } from '../../../packages/security/src/master-key.js'
import { decryptSecret } from '../../../packages/security/src/envelope-crypto.js'

@Injectable()
export class ChannelsService {
  constructor(private readonly prisma: PrismaService) {}
  list() { return this.prisma.channel.findMany({ include: { abilities: true, keys: { select: {
    id: true, suffix: true, enabled: true, health: true, priority: true, weight: true, remainingUsd: true, expiresAt: true
  } } }, orderBy: [{ priority: 'desc' }, { name: 'asc' }] }) }
  create(body: any) { return this.prisma.channel.create({ data: {
    name: body.name, provider: body.provider, protocol: body.protocol, baseUrl: body.baseUrl,
    priority: body.priority ?? 0, weight: body.weight ?? 1, timeoutMs: body.timeoutMs ?? 300000,
    maxRetries: body.maxRetries ?? 1, keySelection: body.keySelection ?? 'WEIGHTED_RANDOM'
  } }) }
  async addKey(channelId: string, body: any) {
    if (!await this.prisma.channel.findUnique({ where: { id: channelId } })) throw new NotFoundException('Channel not found')
    const plaintext = String(body.key || '').trim()
    if (!plaintext) throw new BadRequestException('Key is required')
    const encrypted = encryptSecret(plaintext, loadMasterKey())
    return this.prisma.channelKey.create({ data: {
      channelId, ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag,
      suffix: secretSuffix(plaintext), priority: body.priority ?? 0, weight: body.weight ?? 1
    }, select: { id: true, suffix: true, enabled: true, health: true } })
  }
  setEnabled(id: string, enabled: boolean) { return this.prisma.channel.update({ where: { id }, data: { enabled } }) }
  async test(id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id }, include: { keys: true, abilities: true } })
    if (!channel) throw new NotFoundException('Channel not found')
    const key = channel.keys.find(item => item.enabled)
    const ability = channel.abilities.find(item => item.enabled)
    if (!key || !ability) throw new BadRequestException('Channel requires an enabled key and model ability')
    const plaintext = decryptSecret({ algorithm: 'aes-256-gcm', ciphertext: key.ciphertext, iv: key.iv, tag: key.tag }, loadMasterKey())
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(channel.timeoutMs, 30_000))
    try {
      const response = await fetch(new URL('v1/models', channel.baseUrl.endsWith('/') ? channel.baseUrl : `${channel.baseUrl}/`), { headers: channel.protocol === 'ANTHROPIC'
        ? { 'x-api-key': plaintext, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${plaintext}` }, signal: controller.signal })
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
  update(id: string, body: any) {
    return this.prisma.channel.update({ where: { id }, data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
      ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.weight !== undefined ? { weight: body.weight } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.maxRetries !== undefined ? { maxRetries: body.maxRetries } : {}),
      ...(body.keySelection !== undefined ? { keySelection: body.keySelection } : {}),
      ...(body.autoDisable !== undefined ? { autoDisable: body.autoDisable } : {})
    } })
  }
  async updateKey(channelId: string, keyId: string, body: any) {
    if (!await this.prisma.channelKey.findFirst({ where: { id: keyId, channelId } })) throw new NotFoundException('Key not found')
    return this.prisma.channelKey.update({ where: { id: keyId }, data: {
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.weight !== undefined ? { weight: body.weight } : {}),
      ...(body.remainingUsd !== undefined ? { remainingUsd: body.remainingUsd } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {})
    }, select: { id: true, suffix: true, enabled: true, health: true, priority: true, weight: true, remainingUsd: true, expiresAt: true } })
  }
}
