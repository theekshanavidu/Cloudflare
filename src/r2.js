// Cloudflare R2 Upload Helper
// Routed securely through same-origin Cloudflare Pages Serverless Proxy (/api/upload)
// Client-side hardcoded secrets have been removed to prevent credential exposure.

export const R2_CONFIG = {
  publicUrl: 'https://pub-17ddb0e017e24d14af7f3558fe6f1892.r2.dev',
  bucketName: 'chat-storage'
};

export function setR2BucketName(name) {
  if (name) R2_CONFIG.bucketName = name.trim();
}

/**
 * Upload a Blob or File safely via serverless Pages Function /api/upload
 * @param {Blob|File} fileBlob 
 * @param {string} objectKey (e.g. 'chat_media/images/1725000000.jpg')
 * @param {string} contentType (e.g. 'image/jpeg' or 'audio/webm')
 * @returns {Promise<string>} Public URL of the uploaded file
 */
export async function uploadToR2(fileBlob, objectKey, contentType = 'application/octet-stream') {
  const formData = new FormData();
  formData.append('file', fileBlob);
  formData.append('key', objectKey);
  formData.append('contentType', contentType);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Cloudflare Upload Failed (${res.status}): ${errText || res.statusText}`);
  }

  const data = await res.json();
  if (!data || !data.url) {
    throw new Error('Upload succeeded but no public URL returned');
  }

  return data.url;
}
