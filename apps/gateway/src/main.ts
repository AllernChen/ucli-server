import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { GatewayModule } from './app.module.js'
import { JsonSafeInterceptor } from '../../../packages/http/src/json.interceptor.js'
import { httpMetricsMiddleware } from '../../../packages/monitoring/src/http-metrics.js'

async function bootstrap() {
  const app = await NestFactory.create(GatewayModule)
  app.use(httpMetricsMiddleware)
  app.useGlobalInterceptors(new JsonSafeInterceptor())
  const config = new DocumentBuilder().setTitle('UCLI Model Gateway').setVersion('0.1.0').addBearerAuth().build()
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config))
  await app.listen(Number(process.env.GATEWAY_PORT || 3001), '0.0.0.0')
}
void bootstrap()
