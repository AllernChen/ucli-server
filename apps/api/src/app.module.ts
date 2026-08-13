import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { ChannelsController } from './channels.controller.js'
import { ChannelsService } from './channels.service.js'
import { ClientController } from './client.controller.js'
import { ModelsController } from './models.controller.js'
import { ReportsController } from './reports.controller.js'
import { SkillsController } from './skills.controller.js'
import { UsageController } from './usage.controller.js'
import { GovernanceController } from './governance.controller.js'
import { MonitoringController } from './monitoring.controller.js'
import { ObjectStorageService } from '../../../packages/storage/src/object-storage.js'
import { MetricsController } from '../../../packages/monitoring/src/metrics.controller.js'
import { OrganizationsController } from './organizations.controller.js'
import { AuditInterceptor } from '../../../packages/http/src/audit.interceptor.js'

@Module({
  controllers: [AuthController, ChannelsController, ClientController, ModelsController, UsageController, SkillsController, ReportsController, GovernanceController, MonitoringController, MetricsController, OrganizationsController],
  providers: [PrismaService, AuthService, ChannelsService, AuthGuard, ObjectStorageService, AuditInterceptor]
})
export class AppModule {}
