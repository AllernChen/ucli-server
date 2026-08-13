import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { catchError, Observable, tap, throwError } from 'rxjs'
import { PrismaService } from '../../database/src/prisma.service.js'

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest()
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) || !request.path.startsWith('/api/v1/')) return next.handle()
    const record = (outcome: string) => this.prisma.auditLog.create({ data: {
      actorAccountId: request.principal?.sub || null, organizationId: request.principal?.organizationId || null,
      action: `${request.method} ${request.route?.path || request.path}`, resourceType: request.path.split('/').filter(Boolean)[2] || 'unknown',
      resourceId: request.params?.id || null, metadata: { outcome }
    } }).catch(error => console.error('audit-write-failed', { error: error.message }))
    return next.handle().pipe(tap(() => void record('success')), catchError(error => {
      void record('failure')
      return throwError(() => error)
    }))
  }
}
