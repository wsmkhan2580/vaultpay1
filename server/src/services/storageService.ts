import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import S3 from 'aws-sdk/clients/s3';
import { env } from '../config/env';

/**
 * Receipt archive storage.
 *
 * NOTE: receipts are rendered on demand from database records (see
 * receiptService.renderReceiptPdf), so a stored copy is an OPTIONAL archive,
 * never a dependency of the download flow. Every caller must treat failures in
 * this file as non-fatal.
 *
 * - S3 when AWS credentials + bucket are configured.
 * - Local disk (server/storage) otherwise. Fine for development; on hosts with
 *   ephemeral disks (e.g. Render free tier) it is wiped on every deploy/restart,
 *   which is exactly why downloads never rely on it.
 */

export type StorageProvider = 'S3' | 'LOCAL';

export interface UploadResult {
  storageKey: string;
  provider: StorageProvider;
}

// Resolves to <server>/storage in both ts-node (src/services) and compiled (dist/services) layouts.
const LOCAL_STORAGE_DIR = path.resolve(__dirname, '../../storage');

const s3 =
  env.awsAccessKeyId && env.awsSecretAccessKey && env.awsS3Bucket
    ? new S3({
        accessKeyId: env.awsAccessKeyId,
        secretAccessKey: env.awsSecretAccessKey,
        region: env.awsRegion,
        signatureVersion: 'v4',
        // Fail fast: a misconfigured bucket must not stall request handling.
        maxRetries: 1,
        httpOptions: { connectTimeout: 4000, timeout: 8000 },
      })
    : null;

function resolveLocalPath(storageKey: string): string {
  const base = path.resolve(LOCAL_STORAGE_DIR);
  const resolved = path.resolve(base, storageKey);
  // Path-traversal defence. Compare with a trailing separator so a sibling
  // directory such as "storage-evil" can't pass a plain startsWith() check.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Invalid storage key');
  }
  return resolved;
}

export async function uploadReceiptPdf(buffer: Buffer, storageKey: string): Promise<UploadResult> {
  if (s3) {
    await s3
      .putObject({
        Bucket: env.awsS3Bucket,
        Key: storageKey,
        Body: buffer,
        ContentType: 'application/pdf',
        ServerSideEncryption: 'AES256',
        // No explicit ACL: new buckets have ACLs disabled and reject the parameter;
        // objects are private by default.
      })
      .promise();
    return { storageKey, provider: 'S3' };
  }

  const filePath = resolveLocalPath(storageKey);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  return { storageKey, provider: 'LOCAL' };
}

/**
 * Generates a short-lived, scoped download URL/token for a stored receipt.
 * For S3, this is a native pre-signed URL. For local storage, it's a
 * signed, expiring token that the receipt controller verifies before
 * streaming the file — never a stable public path.
 */
export function getSignedDownloadUrl(
  storageKey: string,
  provider: 'S3' | 'LOCAL',
  expiresInSeconds = 300,
  baseUrl: string = env.serverUrl
): string {
  if (provider === 'S3') {
    if (!s3) throw new Error('S3 is not configured');
    return s3.getSignedUrl('getObject', {
      Bucket: env.awsS3Bucket,
      Key: storageKey,
      Expires: expiresInSeconds,
    });
  }

  // Local: HMAC over key + expiry that the download route verifies. This avoids
  // ever exposing an unrestricted static file path.
  const expires = Date.now() + expiresInSeconds * 1000;
  const signature = crypto.createHmac('sha256', env.jwtSecret).update(`${storageKey}:${expires}`).digest('hex');
  return `${baseUrl}/api/receipts/download-local?key=${encodeURIComponent(storageKey)}&expires=${expires}&sig=${signature}`;
}

export function verifyLocalDownloadToken(storageKey: string, expires: number, signature: string): boolean {
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  const expected = crypto.createHmac('sha256', env.jwtSecret).update(`${storageKey}:${expires}`).digest('hex');
  const provided = Buffer.from(signature || '');
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws if lengths differ, so check first.
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, provided);
}

export function readLocalFile(storageKey: string): Buffer {
  return fs.readFileSync(resolveLocalPath(storageKey));
}
