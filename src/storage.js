import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import {
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  where,
  limit,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { storage, db } from "./firebase.js";
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
 * Compute SHA-256 hash of a Blob / File using native Web Crypto API
 */
export async function computeFileHash(fileBlob) {
  try {
    if (!window.crypto || !window.crypto.subtle) return null;
    const arrayBuffer = await fileBlob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    console.warn("Could not compute file SHA-256 hash:", err);
    return null;
  }
}

/**
 * Check if the document was already uploaded to R2 / Storage previously.
 * 1. Checks Firestore 'fileRegistry' by SHA-256 hash (Fastest & exact content match)
 * 2. Checks 'tuteDocuments' & 'communityChat' collections by file size + clean name (Legacy match)
 */
export async function findExistingUploadedFile(fileBlob, originalFileName = '') {
  if (!fileBlob) return null;

  const cleanName = getCleanFileName(originalFileName || fileBlob.name || '');

  // 1. Exact SHA-256 content check via fileRegistry
  let hash = null;
  try {
    hash = await computeFileHash(fileBlob);
    if (hash) {
      const regDocRef = doc(db, 'fileRegistry', hash);
      const regSnap = await getDoc(regDocRef);
      if (regSnap.exists()) {
        const data = regSnap.data();
        if (data && data.mediaUrl) {
          console.log(`⚡ [Storage Deduplication] Exact SHA-256 match found in registry: ${hash} -> ${data.mediaUrl}`);
          return {
            mediaUrl: data.mediaUrl,
            sha256: hash,
            isDuplicate: true,
            source: 'registry'
          };
        }
      }
    }
  } catch (err) {
    console.warn("fileRegistry lookup failed:", err);
  }

  // 2. Legacy check: Size + Name in existing tuteDocuments or communityChat (for files uploaded earlier before registry was created)
  if (fileBlob.size && cleanName) {
    try {
      // Check in tuteDocuments
      const tutesQuery = query(
        collection(db, 'tuteDocuments'),
        where('fileName', '==', cleanName),
        where('fileSize', '==', fileBlob.size),
        limit(1)
      );
      const tutesSnap = await getDocs(tutesQuery);
      if (!tutesSnap.empty) {
        const existingTute = tutesSnap.docs[0].data();
        if (existingTute && existingTute.mediaUrl) {
          console.log(`⚡ [Storage Deduplication] Legacy tute match found (${cleanName}, ${fileBlob.size}b) -> ${existingTute.mediaUrl}`);
          if (hash) {
            setDoc(doc(db, 'fileRegistry', hash), {
              sha256: hash,
              mediaUrl: existingTute.mediaUrl,
              fileName: cleanName,
              fileSize: fileBlob.size,
              indexedFrom: 'legacy_tutes',
              createdAt: serverTimestamp()
            }).catch(e => console.warn("Failed to auto-index legacy file:", e));
          }
          return {
            mediaUrl: existingTute.mediaUrl,
            sha256: hash,
            isDuplicate: true,
            source: 'legacy_tutes'
          };
        }
      }

      // Check in communityChat
      const chatQuery = query(
        collection(db, 'communityChat'),
        where('messageType', '==', 'document'),
        where('fileName', '==', cleanName),
        where('fileSize', '==', fileBlob.size),
        limit(1)
      );
      const chatSnap = await getDocs(chatQuery);
      if (!chatSnap.empty) {
        const existingChat = chatSnap.docs[0].data();
        if (existingChat && existingChat.mediaUrl) {
          console.log(`⚡ [Storage Deduplication] Legacy chat match found (${cleanName}, ${fileBlob.size}b) -> ${existingChat.mediaUrl}`);
          if (hash) {
            setDoc(doc(db, 'fileRegistry', hash), {
              sha256: hash,
              mediaUrl: existingChat.mediaUrl,
              fileName: cleanName,
              fileSize: fileBlob.size,
              indexedFrom: 'legacy_chat',
              createdAt: serverTimestamp()
            }).catch(e => console.warn("Failed to auto-index legacy file:", e));
          }
          return {
            mediaUrl: existingChat.mediaUrl,
            sha256: hash,
            isDuplicate: true,
            source: 'legacy_chat'
          };
        }
      }
    } catch (err) {
      console.warn("Legacy file matching failed:", err);
    }
  }

  return { hash, isDuplicate: false };
}

/**
 * Attempt upload via same-origin Cloudflare Pages Function (/api/upload).
 * Because this request is same-origin (https://www.mathsrecoding.com/api/upload),
 * browser CORS preflight check is bypassed completely!
 */
export async function uploadViaPagesFunction(fileBlob, destinationPath, contentType) {
  try {
    const formData = new FormData();
    formData.append('file', fileBlob);
    formData.append('key', destinationPath);
    formData.append('contentType', contentType);

    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.url) {
        console.log("⚡ Upload succeeded via Cloudflare Pages Function:", data.url);
        return data.url;
      }
    } else {
      console.warn("Cloudflare Pages /api/upload responded with status:", res.status);
    }
  } catch (err) {
    console.warn("Pages Function /api/upload attempt failed:", err);
  }
  return null;
}

/**
 * Robust Multi-Engine Storage Uploader with Deduplication.
 * Strategy:
 * 0. Deduplication Pre-Check: If exact same file already exists in R2/Storage, immediately reuse its URL!
 * 1. Cloudflare Pages Function /api/upload (Same-Origin Serverless Upload -> 100% CORS-Free)
 * 2. Cloudflare R2 Direct Upload (Browser S3 SigV4)
 * 3. Firebase Storage (Standard Google Cloud Storage)
 * 4. Base64 Data URL fallback for files under 750KB
 */
export async function uploadMediaFile(fileBlob, destinationPath, contentType = 'application/octet-stream', originalFileName = '') {
  let fileHash = null;

  // 0. Deduplication Pre-Check: Instant reuse if file already exists in R2 / Cloud Storage
  try {
    const existing = await findExistingUploadedFile(fileBlob, originalFileName || fileBlob.name);
    if (existing && existing.isDuplicate && existing.mediaUrl) {
      return existing.mediaUrl;
    }
    if (existing && existing.hash) {
      fileHash = existing.hash;
    }
  } catch (e) {
    console.warn("Deduplication pre-check failed, continuing with direct upload:", e);
  }

  const errors = [];
  let uploadedUrl = null;

  // 1. First attempt: Same-origin Cloudflare Pages Function (/api/upload)
  try {
    const pagesUrl = await uploadViaPagesFunction(fileBlob, destinationPath, contentType);
    if (pagesUrl) {
      uploadedUrl = pagesUrl;
    }
  } catch (pfErr) {
    console.warn("Cloudflare Pages Function upload skipped/failed:", pfErr);
    errors.push(`Pages Function (${pfErr.message})`);
  }

  // 2. Second attempt: Cloudflare R2 Direct S3 SigV4
  if (!uploadedUrl) {
    try {
      const r2Url = await uploadToR2(fileBlob, destinationPath, contentType);
      if (r2Url) {
        uploadedUrl = r2Url;
      }
    } catch (r2Err) {
      console.warn("Cloudflare R2 direct upload skipped/failed:", r2Err);
      errors.push(`Cloudflare R2 (${r2Err.message})`);
    }
  }

  // 3. Third attempt: Firebase Storage
  if (!uploadedUrl) {
    try {
      const fileRef = storageRef(storage, destinationPath);
      const snap = await uploadBytes(fileRef, fileBlob, { contentType });
      const downloadUrl = await getDownloadURL(snap.ref);
      if (downloadUrl) {
        uploadedUrl = downloadUrl;
      }
    } catch (fbErr) {
      console.warn("Firebase Storage upload skipped/failed:", fbErr);
      errors.push(`Firebase Storage (${fbErr.code || fbErr.message})`);
    }
  }

  // 4. Fallback: Data URL if file is small enough for Firestore (< 750KB)
  if (!uploadedUrl && fileBlob.size && fileBlob.size < 750 * 1024) {
    try {
      console.warn("Using local Data URL fallback for small attachment");
      uploadedUrl = await blobToDataUrl(fileBlob);
    } catch (dataErr) {
      errors.push(`Data URL (${dataErr.message})`);
    }
  }

  if (uploadedUrl) {
    // Register file hash in registry for future deduplication lookups
    try {
      if (!fileHash) {
        fileHash = await computeFileHash(fileBlob);
      }
      if (fileHash) {
        setDoc(doc(db, 'fileRegistry', fileHash), {
          sha256: fileHash,
          mediaUrl: uploadedUrl,
          fileName: getCleanFileName(originalFileName || fileBlob.name || ''),
          fileSize: fileBlob.size || 0,
          contentType,
          createdAt: serverTimestamp()
        }).catch(err => console.warn("Failed to register uploaded file in registry:", err));
      }
    } catch (regErr) {
      console.warn("Registry recording failed:", regErr);
    }

    return uploadedUrl;
  }

  const combined = errors.join(' | ');
  throw new Error(`Upload failed: ${combined}`);
}
