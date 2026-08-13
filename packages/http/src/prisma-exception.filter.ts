import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Response } from 'express'

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    switch (exception.code) {
      case 'P2025':
        response.status(404).json({ statusCode: 404, message: 'Resource not found' })
        return
      case 'P2002':
        response.status(409).json({ statusCode: 409, message: 'Resource already exists' })
        return
      case 'P2003':
        response.status(400).json({ statusCode: 400, message: 'Referenced resource does not exist' })
        return
      case 'P2023':
        response.status(400).json({ statusCode: 400, message: 'Invalid identifier' })
        return
      default:
        console.error('unhandled-prisma-error', { code: exception.code, message: exception.message })
        response.status(500).json({ statusCode: 500, message: 'Internal server error' })
    }
  }
}
