import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import jwt from 'jsonwebtoken'
import { PrismaService } from '../../database/src/prisma.service.js'
import { deviceGrantFailure } from './device-grants.js'
import { assertActiveGroupMember } from './group-access.js'

export interface AuthPrincipal {
  sub: string
  organizationId: string
  deviceId?: string
  groupId?: string | null
  role: 'PLATFORM_ADMIN' | 'ORG_ADMIN' | 'MEMBER'
  tokenVersion: number
}

export const ROLES_KEY = 'ucli.roles'
export const Roles = (...roles: AuthPrincipal['role'][]) => SetMetadata(ROLES_KEY, roles)

type AuthorizationFailureCode = 'invalid_grant' | 'grant_disabled' | 'grant_expired' | 'grant_deleted' |
  'account_inactive' | 'organization_inactive' | 'invalid_device'

export function clientMessage(code: AuthorizationFailureCode): string {
  return {
    invalid_grant: 'Device grant is invalid',
    grant_disabled: 'Device grant is disabled',
    grant_expired: 'Device grant has expired',
    grant_deleted: 'Device grant has been deleted',
    account_inactive: 'Account or membership is inactive',
    organization_inactive: 'Organization is inactive',
    invalid_device: 'Device is invalid'
  }[code]
}

export function authorizationFailure(code: AuthorizationFailureCode): UnauthorizedException {
  return new UnauthorizedException({ code, message: clientMessage(code) })
}

export function signAccessToken(principal: AuthPrincipal): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is required')
  return jwt.sign(principal, secret, { expiresIn: '15m', issuer: 'ucli-server', audience: 'ucli' })
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const bearer = String(request.headers.authorization || '')
    // 网关 Anthropic 协议客户端（Claude Code）用 x-api-key 而非 Bearer
    const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : String(request.headers['x-api-key'] || '')
    if (!token) throw new UnauthorizedException('Bearer token required')
    request.principal = await this.authenticateToken(token)
    const roles = this.reflector.getAllAndOverride<AuthPrincipal['role'][]>(ROLES_KEY, [
      context.getHandler(), context.getClass()
    ])
    if (roles?.length && !roles.includes(request.principal.role)) throw new UnauthorizedException('Role not permitted')
    return true
  }

  async authenticateToken(token: string): Promise<AuthPrincipal> {
    let principal: AuthPrincipal
    try {
      principal = jwt.verify(token, process.env.JWT_SECRET!, {
        issuer: 'ucli-server', audience: 'ucli'
      }) as AuthPrincipal
    } catch { throw new UnauthorizedException('Invalid access token') }
    // Group ownership is live server state, never a JWT or client-context claim.
    principal.groupId = null
    if (principal.deviceId) {
      const device = await this.prisma.device.findFirst({ where: {
        id: principal.deviceId, accountId: principal.sub, organizationId: principal.organizationId
      }, include: { grant: true } })
      if (!device) throw authorizationFailure('invalid_device')
      if (!device.grant) throw authorizationFailure('invalid_grant')
      const failure = deviceGrantFailure(device.grant)
      if (failure) throw authorizationFailure(failure)
      if (device.revokedAt) throw authorizationFailure('invalid_device')
      const organization = await this.assertActiveMembership(principal, principal.role)
      principal.groupId = device.grant.groupId ?? null
      if (principal.groupId) {
        await assertActiveGroupMember(this.prisma, { organizationId: principal.organizationId, accountId: principal.sub, groupId: principal.groupId })
      } else if (organization.requireDeviceGroup) {
        throw new ForbiddenException({ code: 'group_required', message: 'Device must be assigned to a usage group' })
      }
      await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
    } else {
      await this.assertActiveMembership(principal, principal.role)
    }
    return principal
  }

  private async assertActiveMembership(principal: AuthPrincipal, role: AuthPrincipal['role']) {
    const account = await this.prisma.account.findUnique({
      where: { id: principal.sub },
      include: { memberships: { where: { organizationId: principal.organizationId }, include: { organization: true } } }
    })
    if (!account || account.status !== 'ACTIVE' || account.tokenVersion !== principal.tokenVersion) {
      throw authorizationFailure('account_inactive')
    }
    const membership = account.memberships[0]
    if (!membership || membership.role !== role || membership.status !== 'ACTIVE') {
      throw authorizationFailure('account_inactive')
    }
    if (!membership.organization.enabled) throw authorizationFailure('organization_inactive')
    return membership.organization
  }
}
