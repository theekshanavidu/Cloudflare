import {
  collection,
  addDoc,
  doc,
  deleteDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  getDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { db, storage, ADMIN_UID, NILANTHA_MODERATORS, RAVINDU_MODERATORS } from "./firebase.js";
import { uploadToR2 } from "./r2.js";
import { sanitizeInput } from "./security.js";

// Cooldown tracker to prevent rapid spamming
let lastMessageTime = 0;
const SPAM_COOLDOWN_MS = 1500; // 1.5 seconds

// Sound notification state
let isSoundEnabled = localStorage.getItem('study_chat_sound_enabled') !== 'false';

// Play a pleasant web audio chime on new message
export function playChatChime() {
  if (!isSoundEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12); // A5

    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (e) {
    // Audio context may be restricted before user interaction
  }
}

export function toggleChatSound() {
  isSoundEnabled = !isSoundEnabled;
  localStorage.setItem('study_chat_sound_enabled', isSoundEnabled ? 'true' : 'false');
  return isSoundEnabled;
}

export function getChatSoundState() {
  return isSoundEnabled;
}

/**
 * Determine user role in community chat
 */
export async function getUserRole(uid) {
  if (uid === ADMIN_UID) return 'admin';
  if (NILANTHA_MODERATORS.includes(uid) || RAVINDU_MODERATORS.includes(uid)) return 'moderator';

  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) {
      const data = snap.data();
      if (data.role === 'moderator' || data.isModerator === true) {
        return 'moderator';
      }
    }
  } catch (e) {
    console.error("Error getting user role:", e);
  }
  return 'student';
}

/**
 * Real-time listener for community chat messages (Limit 60 newest messages, chronological display)
 */
export function listenCommunityChat(onMessagesUpdate, onError) {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  
  // We query the latest 60 messages ordered by createdAt descending, then reverse them for chronological UI
  const q = query(
    collection(db, 'communityChat'),
    orderBy('createdAt', 'desc'),
    limit(60)
  );

  let initialLoadDone = false;

  return onSnapshot(q, (snapshot) => {
    const messages = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const createdAtMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : (data.timestamp || Date.now());
      
      // Auto-filter any message older than 30 days
      if (createdAtMs >= thirtyDaysAgo) {
        messages.push({
          id: docSnap.id,
          ...data,
          createdAtMs
        });
      }
    });

    // Reverse to display oldest first at top, newest at bottom
    messages.reverse();

    if (initialLoadDone && snapshot.docChanges().some(change => change.type === 'added')) {
      playChatChime();
    }
    initialLoadDone = true;

    onMessagesUpdate(messages);
  }, (err) => {
    console.error("Chat listener error:", err);
    if (onError) onError(err);
  });
}

/**
 * Helper to get sanitized sender details respecting user privacy settings
 */
async function getSenderDetails(user) {
  let senderName = user.displayName || 'Student';
  let senderPhoto = null;
  let isPhotoPublic = false;
  let senderRole = 'student';

  if (user.uid === ADMIN_UID) {
    senderName = 'Admin';
    senderRole = 'admin';
    isPhotoPublic = true;
    senderPhoto = user.photoURL || '/icon.png';
  } else if (NILANTHA_MODERATORS.includes(user.uid) || RAVINDU_MODERATORS.includes(user.uid)) {
    senderRole = 'moderator';
  }

  try {
    const userDocSnap = await getDoc(doc(db, 'users', user.uid));
    if (userDocSnap.exists()) {
      const d = userDocSnap.data();
      const fullName = [d.firstName, d.lastName].filter(Boolean).join(' ');
      if (fullName) senderName = fullName;

      if (d.role === 'moderator' || d.isModerator === true) {
        senderRole = 'moderator';
      }

      // Privacy Check: Only expose photo if user explicitly set isPhotoPublic to true
      if (d.isPhotoPublic === true) {
        isPhotoPublic = true;
        senderPhoto = d.photoURL || user.photoURL || null;
      }
    }
  } catch (e) {
    console.warn("Could not fetch full user profile for chat message:", e);
  }

  return { senderName, senderPhoto, isPhotoPublic, senderRole };
}

/**
 * Send a plain text message
 */
export async function sendTextMessage(user, text, replyTo = null) {
  const rawText = (text || '').trim();
  const cleanText = sanitizeInput(rawText);
  if (!cleanText) return { success: false, error: "Message cannot be empty." };

  const now = Date.now();
  if (now - lastMessageTime < SPAM_COOLDOWN_MS) {
    const waitSec = Math.ceil((SPAM_COOLDOWN_MS - (now - lastMessageTime)) / 1000);
    return { success: false, error: `Please wait ${waitSec}s before sending another message.` };
  }

  const { senderName, senderPhoto, isPhotoPublic, senderRole } = await getSenderDetails(user);

  const expireAtTimestamp = now + (30 * 24 * 60 * 60 * 1000); // Exactly 30 days from now

  const sanitizedReplyTo = replyTo ? {
    id: replyTo.id,
    senderName: sanitizeInput(replyTo.senderName || ''),
    text: sanitizeInput(replyTo.text || ''),
    messageType: replyTo.messageType || 'text'
  } : null;

  const messageDoc = {
    senderId: user.uid,
    senderName: sanitizeInput(senderName),
    senderPhoto: senderPhoto,
    isPhotoPublic: isPhotoPublic,
    senderRole: senderRole,
    messageType: 'text',
    text: cleanText,
    mediaUrl: null,
    audioDuration: 0,
    replyTo: sanitizedReplyTo,
    createdAt: serverTimestamp(),
    timestamp: now,
    expireAt: new Date(expireAtTimestamp)
  };

  try {
    await addDoc(collection(db, 'communityChat'), messageDoc);
    lastMessageTime = Date.now();
    return { success: true };
  } catch (e) {
    console.error("Error sending text message:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Compress an image file for fast upload and lightweight viewing
 */
export async function compressChatImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Image compression failed"));
        }, 'image/jpeg', 0.82);
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

/**
 * Helper: Convert Blob to Base64 Data URL (Universal Fallback)
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
 * Send an image message
 */
export async function sendImageMessage(user, file, optionalCaption = '', replyTo = null) {
  if (!file) return { success: false, error: "No image file selected." };

  const now = Date.now();
  if (now - lastMessageTime < SPAM_COOLDOWN_MS) {
    return { success: false, error: "Please wait a moment before sending another message." };
  }

  try {
    const compressedBlob = await compressChatImage(file);
    const fileName = `chat_media/images/${Date.now()}_${user.uid}.jpg`;
    
    let mediaUrl;
    try {
      mediaUrl = await uploadToR2(compressedBlob, fileName, 'image/jpeg');
    } catch (r2Err) {
      console.warn("R2 upload blocked by CORS/Bucket rule. Using instant local Data URL fallback:", r2Err);
      mediaUrl = await blobToDataUrl(compressedBlob);
    }

    const { senderName, senderPhoto, isPhotoPublic, senderRole } = await getSenderDetails(user);
    const expireAtTimestamp = now + (30 * 24 * 60 * 60 * 1000);

    const sanitizedReplyTo = replyTo ? {
      id: replyTo.id,
      senderName: sanitizeInput(replyTo.senderName || ''),
      text: sanitizeInput(replyTo.text || ''),
      messageType: replyTo.messageType || 'text'
    } : null;

    const messageDoc = {
      senderId: user.uid,
      senderName: sanitizeInput(senderName),
      senderPhoto: senderPhoto,
      isPhotoPublic: isPhotoPublic,
      senderRole: senderRole,
      messageType: 'image',
      text: sanitizeInput((optionalCaption || '').trim()),
      mediaUrl: mediaUrl,
      audioDuration: 0,
      replyTo: sanitizedReplyTo,
      createdAt: serverTimestamp(),
      timestamp: now,
      expireAt: new Date(expireAtTimestamp)
    };

    await addDoc(collection(db, 'communityChat'), messageDoc);
    lastMessageTime = Date.now();
    return { success: true };
  } catch (e) {
    console.error("Error uploading image message:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Send a PDF document message
 */
export async function sendPdfMessage(user, file, optionalCaption = '', replyTo = null) {
  if (!file) return { success: false, error: "No PDF file selected." };
  
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    return { success: false, error: "Please select a valid PDF file (.pdf).\nකරුණාකර වලංගු PDF ගොනුවක් තෝරන්න." };
  }

  // Maximum file size: 25MB
  const MAX_SIZE_BYTES = 25 * 1024 * 1024;
  if (file.size > MAX_SIZE_BYTES) {
    return { success: false, error: "PDF file size exceeds the 25MB limit.\nPDF ගොනුවේ ප්‍රමාණය 25MB සීමාව ඉක්මවා ඇත." };
  }

  const now = Date.now();
  if (now - lastMessageTime < SPAM_COOLDOWN_MS) {
    return { success: false, error: "Please wait a moment before sending another message." };
  }

  try {
    const rawName = file.name.replace(/\.[^/.]+$/, "");
    const safeBaseName = sanitizeInput(rawName.replace(/[^\w\s.-]/gi, '_')).slice(0, 80);
    const safeFileName = `${safeBaseName || 'Document'}.pdf`;
    const objectKey = `chat_media/documents/${Date.now()}_${user.uid}_${safeFileName}`;

    let mediaUrl;
    try {
      mediaUrl = await uploadToR2(file, objectKey, 'application/pdf');
    } catch (r2Err) {
      console.warn("R2 PDF upload blocked. Using Data URL fallback:", r2Err);
      if (file.size > 8 * 1024 * 1024) {
        throw new Error("Cloudflare R2 upload failed and file is too large for fallback: " + r2Err.message);
      }
      mediaUrl = await blobToDataUrl(file);
    }

    const { senderName, senderPhoto, isPhotoPublic, senderRole } = await getSenderDetails(user);
    const expireAtTimestamp = now + (30 * 24 * 60 * 60 * 1000);

    const sanitizedReplyTo = replyTo ? {
      id: replyTo.id,
      senderName: sanitizeInput(replyTo.senderName || ''),
      text: sanitizeInput(replyTo.text || ''),
      messageType: replyTo.messageType || 'document'
    } : null;

    const messageDoc = {
      senderId: user.uid,
      senderName: sanitizeInput(senderName),
      senderPhoto: senderPhoto,
      isPhotoPublic: isPhotoPublic,
      senderRole: senderRole,
      messageType: 'document',
      fileName: safeFileName,
      fileSize: file.size,
      text: sanitizeInput((optionalCaption || '').trim()),
      mediaUrl: mediaUrl,
      audioDuration: 0,
      replyTo: sanitizedReplyTo,
      createdAt: serverTimestamp(),
      timestamp: now,
      expireAt: new Date(expireAtTimestamp)
    };

    await addDoc(collection(db, 'communityChat'), messageDoc);
    lastMessageTime = Date.now();
    return { success: true };
  } catch (e) {
    console.error("Error uploading PDF message:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Audio Recorder Manager using browser MediaRecorder API
 */
class VoiceRecorderManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.startTime = 0;
    this.timerInterval = null;
    this.isRecording = false;
  }

  async start(onTick) {
    if (this.isRecording) return;
    this.audioChunks = [];

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') 
        ? 'audio/webm' 
        : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/ogg');
      
      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.start(100);
      this.isRecording = true;
      this.startTime = Date.now();

      if (onTick) {
        onTick(0);
        this.timerInterval = setInterval(() => {
          const seconds = Math.floor((Date.now() - this.startTime) / 1000);
          onTick(seconds);
        }, 1000);
      }
      return true;
    } catch (err) {
      console.error("Microphone access denied or error:", err);
      throw new Error("Microphone permission denied. Please allow microphone access.");
    }
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording || !this.mediaRecorder) {
        return reject(new Error("No active recording session"));
      }

      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }

      const durationSeconds = Math.max(1, Math.floor((Date.now() - this.startTime) / 1000));

      this.mediaRecorder.onstop = () => {
        const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(this.audioChunks, { type: mimeType });

        // Stop all audio tracks
        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
          this.stream = null;
        }
        this.isRecording = false;
        resolve({ blob: audioBlob, duration: durationSeconds, mimeType });
      };

      this.mediaRecorder.stop();
    });
  }

  cancel() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.onstop = null;
      try { this.mediaRecorder.stop(); } catch(e) {}
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.audioChunks = [];
    this.isRecording = false;
  }
}

export const voiceRecorder = new VoiceRecorderManager();

/**
 * Send a recorded voice message
 */
export async function sendVoiceMessage(user, audioBlob, durationSeconds, replyTo = null) {
  if (!audioBlob) return { success: false, error: "No voice note data recorded." };

  const now = Date.now();
  if (now - lastMessageTime < SPAM_COOLDOWN_MS) {
    return { success: false, error: "Please wait a moment before sending another message." };
  }

  try {
    const extension = audioBlob.type.includes('mp4') ? 'mp4' : (audioBlob.type.includes('ogg') ? 'ogg' : 'webm');
    const fileName = `chat_media/voices/${Date.now()}_${user.uid}.${extension}`;
    const contentType = audioBlob.type || 'audio/webm';
    
    let mediaUrl;
    try {
      mediaUrl = await uploadToR2(audioBlob, fileName, contentType);
    } catch (r2Err) {
      console.warn("R2 voice upload blocked by CORS/Bucket rule. Using instant local Data URL fallback:", r2Err);
      mediaUrl = await blobToDataUrl(audioBlob);
    }

    const { senderName, senderPhoto, isPhotoPublic, senderRole } = await getSenderDetails(user);
    const expireAtTimestamp = now + (30 * 24 * 60 * 60 * 1000);

    const messageDoc = {
      senderId: user.uid,
      senderName: senderName,
      senderPhoto: senderPhoto,
      isPhotoPublic: isPhotoPublic,
      senderRole: senderRole,
      messageType: 'audio',
      text: '',
      mediaUrl: mediaUrl,
      audioDuration: durationSeconds || 1,
      replyTo: replyTo || null,
      createdAt: serverTimestamp(),
      timestamp: now,
      expireAt: new Date(expireAtTimestamp)
    };

    await addDoc(collection(db, 'communityChat'), messageDoc);
    lastMessageTime = Date.now();
    return { success: true };
  } catch (e) {
    console.error("Error uploading voice message:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Delete a message (Available to author or admin / moderator)
 */
export async function deleteCommunityMessage(messageId) {
  try {
    await deleteDoc(doc(db, 'communityChat', messageId));
    return { success: true };
  } catch (e) {
    console.error("Error deleting message:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Admin Action: Appoint or Revoke Moderator
 */
export async function setModeratorRole(targetUid, isModerator) {
  try {
    await updateDoc(doc(db, 'users', targetUid), {
      isModerator: isModerator,
      role: isModerator ? 'moderator' : 'student',
      updatedAt: Date.now()
    });
    return { success: true };
  } catch (e) {
    console.error("Error updating moderator role:", e);
    return { success: false, error: e.message };
  }
}

/**
 * User Action: Update Profile Photo Privacy in Community Chat
 */
export async function setPhotoPrivacy(uid, isPublic) {
  try {
    await updateDoc(doc(db, 'users', uid), {
      isPhotoPublic: isPublic
    });
    return { success: true };
  } catch (e) {
    console.error("Error updating photo privacy:", e);
    return { success: false, error: e.message };
  }
}
