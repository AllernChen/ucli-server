export function loadMasterKey(value = process.env.MASTER_KEY): Buffer {
  if (!value) throw new Error('MASTER_KEY is required')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32) throw new Error('MASTER_KEY must be a base64 encoded 32-byte key')
  return decoded
}
