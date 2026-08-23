import { BadRequestException } from '@nestjs/common'

export function normalizeManufacturer(value: string) {
  const manufacturer = value.trim().replace(/\s+/g, ' ')
  if (!manufacturer) throw new BadRequestException('Manufacturer is required')
  return { manufacturer, manufacturerKey: manufacturer.toLocaleLowerCase('en-US') }
}
