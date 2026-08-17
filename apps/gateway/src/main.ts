import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import express from 'express'
import { GatewayModule } from './app.module.js'
import { JsonSafeInterceptor } from '../../../packages/http/src/json.interceptor.js'
import { httpMetricsMiddleware } from '../../../packages/monitoring/src/http-metrics.js'

async function bootstrap() {
  // 桌面客户端（Codex 等）的系统提示词可超过 Express 默认 100KB body 限制
  const app = await NestFactory.create(GatewayModule, { bodyParser: false })
  app.use(express.json({ limit: '10mb' }))
  app.use(httpMetricsMiddleware)
  app.useGlobalInterceptors(new JsonSafeInterceptor())
  const config = new DocumentBuilder().setTitle('UCLI Model Gateway').setVersion('0.1.0').addBearerAuth().build()
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config))
  await app.listen(Number(process.env.GATEWAY_PORT || 3001), '0.0.0.0')
}
void bootstrap()
