import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import jwt from 'jsonwebtoken'
import { PrismaService } from '../../database/src/prisma.service.js'

export interface AuthPrincipal {
  sub: string
  organizationId: string
  deviceId?: string
  role: 'PLATFORM_ADMIN' | 'ORG_ADMIN' | 'MEMBER'
  tokenVersion: number
}

export const ROLES_KEY = 'ucli.roles'
export const Roles = (...roles: AuthPrincipal['role'][]) => SetMetadata(ROLES_KEY, roles)

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
    const value = String(request.headers.authorization || '')
    if (!value.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token required')
    try {
      request.principal = jwt.verify(value.slice(7), process.env.JWT_SECRET!, {
        issuer: 'ucli-server', audience: 'ucli'
      }) as AuthPrincipal
    } catch { throw new UnauthorizedException('Invalid access token') }
    const principal = request.principal as AuthPrincipal
    const account = await this.prisma.account.findFirst({ where: {
      id: principal.sub, status: 'ACTIVE', tokenVersion: principal.tokenVersion,
      memberships: { some: { organizationId: principal.organizationId, role: principal.role, organization: { enabled: true } } }
    } })
    if (!account) throw new UnauthorizedException('Account or membership is inactive')
    if (principal.deviceId) {
      const device = await this.prisma.device.findFirst({ where: {
        id: principal.deviceId, accountId: principal.sub, organizationId: principal.organizationId, revokedAt: null
      } })
      if (!device) throw new UnauthorizedException('Device is revoked')
      await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
    }
    const roles = this.reflector.getAllAndOverride<AuthPrincipal['role'][]>(ROLES_KEY, [
      context.getHandler(), context.getClass()
    ])
    if (roles?.length && !roles.includes(request.principal.role)) throw new UnauthorizedException('Role not permitted')
    return true
  }
}
