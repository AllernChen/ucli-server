import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { WorkerService } from './worker.service.js'
import { ModelTestingService } from '../../api/src/model-testing.service.js'

@Module({ imports: [ScheduleModule.forRoot()], providers: [PrismaService, ModelTestingService, WorkerService] })
export class WorkerModule {}
