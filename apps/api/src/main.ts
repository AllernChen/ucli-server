import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module.js'
import { JsonSafeInterceptor } from '../../../packages/http/src/json.interceptor.js'
import { AuditInterceptor } from '../../../packages/http/src/audit.interceptor.js'
import { httpMetricsMiddleware } from '../../../packages/monitoring/src/http-metrics.js'
import { PrismaExceptionFilter } from '../../../packages/http/src/prisma-exception.filter.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true })
  app.use(httpMetricsMiddleware)
  app.useGlobalFilters(new PrismaExceptionFilter())
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  app.useGlobalInterceptors(app.get(AuditInterceptor), new JsonSafeInterceptor())
  const origins = process.env.ADMIN_ORIGIN?.split(',').map(value => value.trim()).filter(Boolean)
  app.enableCors({ origin: origins?.length ? origins : false, credentials: true })
  const config = new DocumentBuilder().setTitle('UCLI Server Control API').setVersion('0.1.0')
    .addBearerAuth().build()
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config))
  await app.listen(Number(process.env.API_PORT || 3000), '0.0.0.0')
}
void bootstrap()
