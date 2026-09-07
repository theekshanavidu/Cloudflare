// Cloudflare R2 S3-Compatible Direct Storage Uploader (Browser Native WebCrypto)

export const R2_CONFIG = {
  accountId: 'dd332ab406cfff738014fda692d2a7e9',
  accessKeyId: '72f8091895ab5437564939505059b2ef',
  secretAccessKey: '843f978d07fb7ad00f27cceb818d23a81ee9cd23a15441d4a7594c5d87e7e085',
  publicUrl: 'https://pub-17ddb0e017e24d14af7f3558fe6f1892.r2.dev',
  bucketName: 'chat-storage'
};

export function setR2BucketName(name) {
  if (name) R2_CONFIG.bucketName = name.trim();
}

// Helper: Convert ArrayBuffer to Hex String
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper: SHA-256 Hash using Web Crypto
async function sha256Buffer(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(hashBuffer);
}

// Helper: HMAC-SHA256 using Web Crypto
async function hmacSha256(key, data) {
  const keyBuffer = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const dataBuffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  return await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
}

/**
 * Upload a Blob or File directly to Cloudflare R2 bucket using AWS SigV4
 * @param {Blob|File} fileBlob 
 * @param {string} objectKey (e.g. 'chat_media/images/1725000000.jpg')
 * @param {string} contentType (e.g. 'image/jpeg' or 'audio/webm')
 * @returns {Promise<string>} Public URL of the uploaded file
 */
export async function uploadToR2(fileBlob, objectKey, contentType = 'application/octet-stream') {
  const { accountId, accessKeyId, secretAccessKey, publicUrl, bucketName } = R2_CONFIG;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}`;

  const arrayBuffer = await fileBlob.arrayBuffer();
  const payloadHash = await sha256Buffer(arrayBuffer);

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateShort = dateStr.slice(0, 8); // YYYYMMDD
  const region = 'auto';
  const service = 's3';

  // Construct Canonical URI and Request
  const canonicalUri = `/${bucketName}/${objectKey}`;
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${dateStr}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const canonicalRequestHash = await sha256Buffer(canonicalRequest);

  // String to Sign
  const credentialScope = `${dateShort}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credentialScope}\n${canonicalRequestHash}`;

  // Calculate Signature
  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateShort);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signatureBuffer = await hmacSha256(kSigning, stringToSign);
  const signature = bufferToHex(signatureBuffer);

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Execute Direct PUT upload to R2
  const uploadUrl = `${endpoint}/${bucketName}/${objectKey}`;
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'x-amz-date': dateStr,
      'x-amz-content-sha256': payloadHash,
      'Authorization': authHeader
    },
    body: arrayBuffer
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    console.error(`R2 Upload Failed (${res.status}):`, errorText);
    throw new Error(`Cloudflare R2 Upload Failed (${res.status}): ${errorText || res.statusText}`);
  }

  // Construct Public Access URL
  const publicAccessUrl = `${publicUrl.replace(/\/$/, '')}/${objectKey}`;
  return publicAccessUrl;
}
