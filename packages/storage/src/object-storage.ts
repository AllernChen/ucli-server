import { Injectable, type OnModuleDestroy } from '@nestjs/common'
import { CreateBucketCommand, GetBucketLocationCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

@Injectable()
export class ObjectStorageService implements OnModuleDestroy {
  private region?: string
  private readonly client = new S3Client({
    endpoint: `${process.env.MINIO_USE_SSL === 'true' ? 'https' : 'http'}://${process.env.MINIO_ENDPOINT || 'localhost'}:${Number(process.env.MINIO_PORT || 9000)}`,
    region: async () => this.region || 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY || 'ucli', secretAccessKey: process.env.MINIO_SECRET_KEY || 'ucli-change-me-now' },
    // Keep older MinIO uploads compatible; explicit Content-MD5 still validates the full payload.
    requestChecksumCalculation: 'WHEN_REQUIRED'
  })
  readonly bucket = process.env.MINIO_SKILLS_BUCKET || 'ucli-skills'
  async ensureBucket() {
    try {
      if (!this.region) {
        const location = await this.client.send(new GetBucketLocationCommand({ Bucket: this.bucket }))
        this.region = location.LocationConstraint || 'us-east-1'
      }
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch (error) {
      if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404) throw error
      try { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })) } catch (creationError) {
        if (!(creationError instanceof S3ServiceException) || creationError.name !== 'BucketAlreadyOwnedByYou') throw creationError
      }
    }
  }
  async put(key: string, value: Buffer) {
    await this.ensureBucket()
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: value, ContentLength: value.length,
      ContentType: 'application/octet-stream', ContentMD5: createHash('md5').update(value).digest('base64') }))
  }
  async get(key: string) {
    await this.ensureBucket()
    const { Body } = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    if (!(Body instanceof Readable)) throw new TypeError('Object storage returned no readable body')
    return Body
  }
  onModuleDestroy() { this.client.destroy() }
}
