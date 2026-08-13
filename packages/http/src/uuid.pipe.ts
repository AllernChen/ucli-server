import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common'
import { isUUID } from 'class-validator'

@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isUUID(value)) throw new NotFoundException('Resource not found')
    return value
  }
}
