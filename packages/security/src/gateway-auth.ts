import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import { PrismaService } from '../../database/src/prisma.service.js'
import { AuthGuard, type AuthPrincipal } from './auth.js'
import { assertActiveGroupMember } from './group-access.js'
import { hashOpaqueToken } from './tokens.js'

export type GatewayIdentity = {
  sub: string; organizationId: string; role: AuthPrincipal['role']; groupId: string | null; projectId?: string | null
} & ({ credentialType: 'DEVICE'; deviceId: string; apiKeyId?: never }
  | { credentialType: 'API_KEY'; apiKeyId: string; groupId: string; deviceId?: never })

export function extractGatewayCredential(headers: Record<string, string | string[] | undefined>): string {
  const bearer = headers.authorization
  const apiKey = headers['x-api-key']
  const fail = () => new UnauthorizedException({ code: 'invalid_credential', message: 'A single unambiguous credential is required' })
  if ((bearer !== undefined && typeof bearer !== 'string') || (apiKey !== undefined && typeof apiKey !== 'string')) throw fail()
  const match = bearer === undefined ? undefined : /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(bearer as string)
  if (bearer !== undefined && !match) throw fail()
  if (apiKey !== undefined && !/^[A-Za-z0-9._~-]+$/.test(apiKey as string)) throw fail()
  const token = match?.[1] ?? apiKey
  if (typeof token !== 'string' || token.length > 4096 || (match && apiKey !== undefined && match[1] !== apiKey)) throw fail()
  return token
}

@Injectable()
export class GatewayAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthGuard, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const token = extractGatewayCredential(request.headers)
    let identity: GatewayIdentity
    if (token.startsWith('ucli_sk_')) {
      if (process.env.EMPLOYEE_API_KEYS_ENABLED !== 'true') {
        throw new ForbiddenException({ code: 'employee_api_keys_disabled', message: 'Employee API key access is not enabled' })
      }
      const key = await this.prisma.employeeApiKey.findUnique({
        where: { secretHash: hashOpaqueToken(token) },
        include: {
          membership: true,
          group: { select: { id: true, type: true, orgType: true, enabled: true, archivedAt: true, organization: { select: { enabled: true } } } },
          project: { select: { id: true, regionId: true, status: true, category: true,
            members: { where: { role: { not: 'VIEWER' } }, select: {
              accountId: true, membership: { select: { status: true, account: { select: { status: true } } } }
            } } } }
        }
      })
      const now = new Date()
      const invalid = () => new UnauthorizedException({ code: 'invalid_api_key', message: 'Employee API key is invalid or inactive' })
      if (!key || key.disabledAt || key.deletedAt || key.revokedAt || (key.expiresAt && key.expiresAt <= now)) throw invalid()
      const project = key.project
      if (project) {
        if (project.status !== 'ACTIVE' || !key.group.enabled || key.group.archivedAt || !key.group.organization.enabled) throw invalid()
        const member = project.members.find(item =>
          item.accountId === key.accountId && item.membership.status === 'ACTIVE' && item.membership.account.status === 'ACTIVE')
        if (!member) throw invalid()
      } else {
        if (key.group.type !== 'PROJECT') throw invalid()
        await assertActiveGroupMember(this.prisma, key)
      }
      const used = await this.prisma.employeeApiKey.updateMany({ where: { id: key.id, disabledAt: null, deletedAt: null, revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, data: { lastUsedAt: now } })
      if (!used.count) throw invalid()
      const projectId = project?.id ?? null
      identity = { credentialType: 'API_KEY', apiKeyId: key.id, sub: key.accountId, organizationId: key.organizationId,
        groupId: key.groupId, projectId, role: key.membership.role }
    } else {
      const principal = await this.auth.authenticateToken(token)
      if (!principal.deviceId) throw new UnauthorizedException('A device token or employee API key is required')
      identity = { credentialType: 'DEVICE', deviceId: principal.deviceId, sub: principal.sub,
        organizationId: principal.organizationId, groupId: principal.groupId ?? null,
        projectId: principal.projectId ?? null, role: principal.role }
    }
    request.principal = identity
    return true
  }
}
