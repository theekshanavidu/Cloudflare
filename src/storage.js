import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { storage } from "./firebase.js";
import { uploadToR2 } from "./r2.js";

/**
 * Clean and preserve real user file name (supporting Sinhala, Tamil, English, and all Unicode)
 */
export function getCleanFileName(fileName, fallback = 'Document.pdf') {
  if (!fileName || typeof fileName !== 'string') return fallback;
  // Remove control and path traversal characters
  let clean = fileName.replace(/[\/\0\\:*?"<>|]/g, '').trim();
  // Strip dangerous HTML/script tags
  clean = clean.replace(/<\/?(?:script|iframe|object|embed)[^>]*>/gi, '').trim();
  // Enforce reasonable length limit (120 chars) while preserving extension
  if (clean.length > 120) {
    const lastDot = clean.lastIndexOf('.');
    const ext = lastDot > 0 ? clean.slice(lastDot) : '';
    clean = clean.slice(0, 100) + ext;
  }
  return clean || fallback;
}

/**
 * Convert Blob to Base64 Data URL
 */
export async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Robust Multi-Engine Storage Uploader.
 * Strategy:
 * 1. Firebase Storage (Standard Google Cloud Storage with web CORS)
 * 2. Cloudflare R2 (S3-compatible Direct Storage)
 * 3. Base64 Data URL fallback for files under 750KB
 */
export async function uploadMediaFile(fileBlob, destinationPath, contentType = 'application/octet-stream') {
  const errors = [];

  // 1. First attempt: Firebase Storage
  try {
    const fileRef = storageRef(storage, destinationPath);
    const snap = await uploadBytes(fileRef, fileBlob, { contentType });
    const downloadUrl = await getDownloadURL(snap.ref);
    if (downloadUrl) {
      return downloadUrl;
    }
  } catch (fbErr) {
    console.warn("Firebase Storage upload skipped/failed:", fbErr);
    errors.push(`Firebase Storage (${fbErr.code || fbErr.message})`);
  }

  // 2. Second attempt: Cloudflare R2
  try {
    const r2Url = await uploadToR2(fileBlob, destinationPath, contentType);
    if (r2Url) {
      return r2Url;
    }
  } catch (r2Err) {
    console.warn("Cloudflare R2 upload skipped/failed:", r2Err);
    errors.push(`Cloudflare R2 (${r2Err.message})`);
  }

  // 3. Fallback: Data URL if file is small enough for Firestore (< 750KB)
  if (fileBlob.size && fileBlob.size < 750 * 1024) {
    try {
      console.warn("Using local Data URL fallback for small attachment");
      return await blobToDataUrl(fileBlob);
    } catch (dataErr) {
      errors.push(`Data URL (${dataErr.message})`);
    }
  }

  const combined = errors.join(' | ');
  throw new Error(`Upload failed: ${combined}`);
}
