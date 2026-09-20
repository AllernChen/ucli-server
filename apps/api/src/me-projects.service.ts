import { ForbiddenException, Injectable } from '@nestjs/common'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'

@Injectable()
export class MeProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertWebSession(actor: AuthPrincipal) {
    if (actor.deviceId) throw new ForbiddenException('Web login required')
  }

  async list(actor: AuthPrincipal, regionId?: string) {
    this.assertWebSession(actor)
    return this.prisma.project.findMany({
      where: {
        organizationId: actor.organizationId,
        status: 'ACTIVE',
        ...(regionId ? { regionId } : {}),
        region: {
          orgType: { in: ['REGION', 'FUNCTIONAL', 'EXECUTIVE'] },
          enabled: true,
          archivedAt: null,
          organization: { enabled: true }
        },
        OR: [
          { members: { some: { accountId: actor.sub,
            membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } } } },
          { region: { members: { some: { accountId: actor.sub, removedAt: null,
            membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } } } } }
        ]
      },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        status: true,
        category: true,
        region: { select: { id: true, name: true } }
      },
      orderBy: [{ region: { name: 'asc' } }, { name: 'asc' }]
    })
  }
}
