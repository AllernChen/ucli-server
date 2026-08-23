import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { BindChannelModelDto } from './catalog.dto.js'
import { lockCatalogRecord, lockChannelModelRecord } from './catalog-lock.js'
import { normalizeManufacturer } from './model-manufacturer.js'

type PersistTarget = { channelId: string } | { channelModelId: string }

@Injectable()
export class ModelBindingService {
  constructor(private readonly prisma: PrismaService) {}

  bind(channelId: string, input: BindChannelModelDto) {
    return this.inTransaction(transaction => this.persist(transaction, { channelId }, input))
  }

  rebind(channelModelId: string, input: BindChannelModelDto) {
    return this.inTransaction(transaction => this.persist(transaction, { channelModelId }, input))
  }

  private async inTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(operation)
    } catch (error: any) {
      if (error?.code === 'P2002') throw new ConflictException('Channel model mapping already exists')
      throw error
    }
  }

  private async persist(transaction: Prisma.TransactionClient, target: PersistTarget, input: BindChannelModelDto) {
    const initialCurrent = 'channelModelId' in target
      ? await transaction.channelModel.findUnique({ where: { id: target.channelModelId } })
      : null
    if ('channelModelId' in target && !initialCurrent) throw new NotFoundException('Channel model not found')

    const channelId = 'channelId' in target ? target.channelId : initialCurrent!.channelId
    await lockCatalogRecord(transaction, `channel:${channelId}`)
    const channel = await transaction.channel.findUnique({ where: { id: channelId }, select: { id: true, deletedAt: true } })
    if (!channel || channel.deletedAt) throw new NotFoundException('Channel not found')

    const publicModelId = input.publicModelId.trim()
    const upstreamModel = input.upstreamModel.trim()
    if (!publicModelId) throw new BadRequestException('Public model id is required')
    if (!upstreamModel) throw new BadRequestException('Upstream model id is required')

    let current = initialCurrent
    if ('channelModelId' in target) {
      current = await transaction.channelModel.findUnique({ where: { id: target.channelModelId } })
      if (!current) throw new NotFoundException('Channel model not found')
      if (current.channelId !== channelId || current.deletedAt) {
        throw new ConflictException('Archived channel model cannot be edited')
      }
    }

    const publicModelIds = [...new Set([publicModelId, ...(current ? [current.publicModelId] : [])])].sort()
    for (const id of publicModelIds) await lockCatalogRecord(transaction, `public-model:${id}`)
    if (current) {
      await lockChannelModelRecord(transaction, current.id)
      current = await transaction.channelModel.findUnique({ where: { id: current.id } })
      if (!current || current.channelId !== channelId || current.deletedAt) {
        throw new ConflictException('Archived channel model cannot be edited')
      }
    }

    let publicModel = await transaction.publicModel.findUnique({ where: { id: publicModelId } })
    let publicModelCreated = false
    if (publicModel?.deletedAt) throw new ConflictException('Public model is archived; restore it first')
    if (publicModel && input.createPublicModel) throw new ConflictException('Public model already exists; bind it instead')
    if (!publicModel && !input.createPublicModel) throw new NotFoundException('Public model not found')
    if (!publicModel) {
      const { manufacturer, manufacturerKey } = normalizeManufacturer(input.manufacturer || '')
      const displayName = input.publicModelDisplayName?.trim()
      if (!displayName) throw new BadRequestException('Public model display name is required')
      try {
        publicModel = await transaction.publicModel.create({ data: {
          id: publicModelId, displayName, manufacturer, manufacturerKey,
          contextSize: input.contextSize ?? null, enabled: false
        } })
      } catch (error: any) {
        if (error?.code === 'P2002') throw new ConflictException('Public model already exists; bind it instead')
        throw error
      }
      publicModelCreated = true
    }

    const existingMapping = await transaction.channelModel.findFirst({
      where: {
        channelId, publicModelId, protocol: input.protocol,
        ...(current ? { id: { not: current.id } } : {})
      },
      select: { id: true, deletedAt: true }
    })
    if (existingMapping) {
      throw new ConflictException(existingMapping.deletedAt
        ? 'Channel model mapping is archived; restore it instead'
        : 'Channel model mapping already exists')
    }

    let costRulesArchived = 0
    const identityChanged = Boolean(current && (
      current.publicModelId !== publicModelId || current.upstreamModel !== upstreamModel || current.protocol !== input.protocol
    ))
    if (current && identityChanged) {
      const archived = await transaction.channelModelCostRule.updateMany({
        where: { channelModelId: current.id, deletedAt: null },
        data: { deletedAt: new Date(), enabled: false }
      })
      costRulesArchived = archived.count
    }

    const mappingData = {
      publicModelId, upstreamModel, protocol: input.protocol,
      supportsStream: input.supportsStream, supportsTools: input.supportsTools,
      probeEnabled: input.probeEnabled, probeIntervalMinutes: input.probeIntervalMinutes,
      health: 'UNKNOWN' as const, consecutiveFailures: 0,
      lastTestedAt: null, lastSuccessAt: null, lastErrorCode: null
    }
    const channelModel = current
      ? await transaction.channelModel.update({ where: { id: current.id }, data: mappingData })
      : await transaction.channelModel.create({ data: { channelId, ...mappingData } })

    return { publicModelCreated, publicModel, channelModel, costRulesArchived }
  }
}
