import { Injectable } from '@nestjs/common'
import { Client } from 'minio'

@Injectable()
export class ObjectStorageService {
  private readonly client = new Client({
    endPoint: process.env.MINIO_ENDPOINT || 'localhost', port: Number(process.env.MINIO_PORT || 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true', accessKey: process.env.MINIO_ACCESS_KEY || 'ucli',
    secretKey: process.env.MINIO_SECRET_KEY || 'ucli-change-me-now'
  })
  readonly bucket = process.env.MINIO_SKILLS_BUCKET || 'ucli-skills'
  async ensureBucket() { if (!await this.client.bucketExists(this.bucket)) await this.client.makeBucket(this.bucket) }
  async put(key: string, value: Buffer) { await this.ensureBucket(); await this.client.putObject(this.bucket, key, value, value.length) }
  async get(key: string) { await this.ensureBucket(); return this.client.getObject(this.bucket, key) }
}
