// Cloudflare Pages Function: /api/upload
// Same-origin serverless proxy to upload files directly to Cloudflare R2 securely

const DEFAULT_R2_CONFIG = {
  accountId: 'dd332ab406cfff738014fda692d2a7e9',
  accessKeyId: '72f8091895ab5437564939505059b2ef',
  secretAccessKey: '843f978d07fb7ad00f27cceb818d23a81ee9cd23a15441d4a7594c5d87e7e085',
  publicUrl: 'https://pub-17ddb0e017e24d14af7f3558fe6f1892.r2.dev',
  bucketName: 'chat-storage'
};

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'audio/mpeg',
  'application/octet-stream'
]);

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Buffer(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(hashBuffer);
}

async function hmacSha256(key, data) {
  const keyBuffer = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const dataBuffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
}

function sanitizeObjectKey(key) {
  if (!key || typeof key !== 'string') return null;
  // Remove path traversal, leading slashes and unsafe characters
  let cleanKey = key.replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
  cleanKey = cleanKey.replace(/[^a-zA-Z0-9_\-\.\/]/g, '_');
  return cleanKey || null;
}

export async function onRequestPost(context) {
  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    const rawKey = formData.get('key');
    const requestedContentType = formData.get('contentType');

    if (!file || !rawKey) {
      return new Response(JSON.stringify({ error: 'Missing file or object key' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Enforce file size limit (25MB)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return new Response(JSON.stringify({ error: 'File size exceeds maximum allowed limit (25MB)' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Sanitize object key
    const objectKey = sanitizeObjectKey(rawKey);
    if (!objectKey) {
      return new Response(JSON.stringify({ error: 'Invalid object key specified' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Determine and validate Content-Type
    const contentType = requestedContentType || (file && file.type) || 'application/octet-stream';
    if (!ALLOWED_MIME_TYPES.has(contentType.toLowerCase())) {
      return new Response(JSON.stringify({ error: 'Unsupported file type' }), {
        status: 415,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Resolve R2 config from Cloudflare Pages environment variables, fallback to defaults
    const env = context.env || {};
    const accountId = env.R2_ACCOUNT_ID || DEFAULT_R2_CONFIG.accountId;
    const accessKeyId = env.R2_ACCESS_KEY_ID || DEFAULT_R2_CONFIG.accessKeyId;
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY || DEFAULT_R2_CONFIG.secretAccessKey;
    const publicUrl = (env.R2_PUBLIC_URL || DEFAULT_R2_CONFIG.publicUrl).replace(/\/$/, '');
    const bucketName = env.R2_BUCKET_NAME || DEFAULT_R2_CONFIG.bucketName;

    const host = `${accountId}.r2.cloudflarestorage.com`;

    const arrayBuffer = await file.arrayBuffer();
    const payloadHash = await sha256Buffer(arrayBuffer);

    const now = new Date();
    const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateShort = dateStr.slice(0, 8);
    const region = 'auto';
    const service = 's3';

    const canonicalUri = `/${bucketName}/${objectKey}`;
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${dateStr}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const canonicalRequestHash = await sha256Buffer(canonicalRequest);
    const credentialScope = `${dateShort}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credentialScope}\n${canonicalRequestHash}`;

    const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateShort);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, 'aws4_request');
    const signatureBuffer = await hmacSha256(kSigning, stringToSign);
    const signature = bufferToHex(signatureBuffer);

    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const uploadUrl = `https://${host}/${bucketName}/${objectKey}`;
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
      const errText = await res.text().catch(() => '');
      return new Response(JSON.stringify({ error: `R2 returned ${res.status}: ${errText}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const finalUrl = `${publicUrl}/${objectKey}`;
    return new Response(JSON.stringify({ success: true, url: finalUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
