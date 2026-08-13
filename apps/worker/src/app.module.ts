import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { WorkerService } from './worker.service.js'

@Module({ imports: [ScheduleModule.forRoot()], providers: [PrismaService, WorkerService] })
export class WorkerModule {}
