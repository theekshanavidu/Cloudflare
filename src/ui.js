import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  GoogleAuthProvider,
  signInWithPopup,
  updateEmail,
  verifyBeforeUpdateEmail,
  reauthenticateWithCredential,
  EmailAuthProvider,
  confirmPasswordReset,
  verifyPasswordResetCode
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  setDoc,
  addDoc,
  collection,
  getDocs,
  getDoc,
  query,
  where,
  updateDoc,
  deleteDoc,
  orderBy,
  writeBatch,
  onSnapshot,
  arrayUnion,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db, ADMIN_UID, NILANTHA_MODERATORS, RAVINDU_MODERATORS } from "./firebase.js";
import {
  listenCommunityChat,
  sendTextMessage,
  sendImageMessage,
  sendPdfMessage,
  sendVoiceMessage,
  deleteCommunityMessage,
  voiceRecorder,
  toggleChatSound,
  getChatSoundState,
  getUserRole,
  setModeratorRole
} from "./chat.js";
import { sanitizeInput, sanitizeObject, sanitizeUrl, escapeHTML } from "./security.js";

function setCookie(name, value, days = 365) {
  const date = new Date();
  date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
  const expires = "; expires=" + date.toUTCString();
  document.cookie = name + "=" + (value || "")  + expires + "; path=/; SameSite=Lax";
}

const getLocalDateString = (d = new Date()) => {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
};

const formatSLTime = (timestamp) => {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleTimeString('en-US', {
    timeZone: 'Asia/Colombo',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
};

let userProfileCache = {}; // Global cache for user profile data (fixes Auth photoURL length limit)
async function getUserProfile(uid) {
  if (userProfileCache[uid]) return userProfileCache[uid];
  const snap = await getDoc(doc(db, 'users', uid));
  if (snap.exists()) {
    userProfileCache[uid] = snap.data();
    return userProfileCache[uid];
  }
  return null;
}

async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 400; const MAX_HEIGHT = 400;
        let width = img.width; let height = img.height;
        if (width > height) { if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; } }
        else { if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; } }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

const appContainer = document.getElementById('app-container');
const headerElement = document.getElementById('app-header');

// --- Notification Logic ---
let notificationUnsubscribe = null;
let globalNotificationUnsubscribe = null;

window.checkAndDisplayGlobalNotification = (user) => {
  if (!user) {
    if (globalNotificationUnsubscribe) {
      globalNotificationUnsubscribe();
      globalNotificationUnsubscribe = null;
    }
    return;
  }

  if (globalNotificationUnsubscribe) {
    globalNotificationUnsubscribe();
  }

  try {
    // Listen to latest 5 notifications to find the active one in real-time
    const q = query(collection(db, 'global_notifications'), orderBy('timestamp', 'desc'), limit(5));
    globalNotificationUnsubscribe = onSnapshot(q, async (snap) => {
      if (snap.empty) return;
      
      // Find the first active notification
      const notifDoc = snap.docs.find(doc => doc.data().active === true);
      if (!notifDoc) return;

      const notifData = notifDoc.data();
      const notifId = notifDoc.id;

      // Check if user has already dismissed this notification
      const userRef = doc(db, 'users', user.uid);
      const userDocSnap = await getDoc(userRef);
      if (userDocSnap.exists()) {
        const userData = userDocSnap.data();
        if (userData.dismissed_notifications && userData.dismissed_notifications.includes(notifId)) {
          return; // Already dismissed
        }
      }

      // Show the popup
      showFloatingModal(`
        <div class="text-center">
          <div class="w-16 h-16 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-500/30">
            <span class="text-3xl text-white">📣</span>
          </div>
          <h3 class="text-2xl font-bold text-[var(--text-primary)] mb-4">${notifData.title}</h3>
          <p class="text-[var(--text-secondary)] text-lg mb-6 leading-relaxed whitespace-pre-wrap">${notifData.message}</p>
          <button id="dismiss-popup-btn" class="btn-primary w-full py-3 font-bold text-lg">Okay / Dismiss</button>
        </div>
      `);

      // Save to database immediately that the user has viewed this notification
      try {
        await setDoc(userRef, {
          dismissed_notifications: arrayUnion(notifId)
        }, { merge: true });
      } catch (e) {
        console.error("Error saving viewed notification to database:", e);
      }

      const dismissBtn = document.getElementById('dismiss-popup-btn');
      if (dismissBtn) {
        dismissBtn.onclick = () => {
          closeFloatingModal();
        };
      }
    }, (e) => {
      console.error("Error listening to global notifications:", e);
    });
  } catch (e) {
    console.error("Error setting up global notification listener:", e);
  }
};

async function sendNotification(recipientId, title, message) {
  try {
    await addDoc(collection(db, 'notifications'), {
      userId: recipientId,
      title: title || 'New Notification',
      message: message,
      timestamp: Date.now(),
      isRead: false
    });

    // Attempt cleanup asynchronously, ignore errors
    cleanupOldNotifications(recipientId).catch(e => console.log('Cleanup minor error:', e));

    return true;
  } catch (e) {
    console.error("Error sending notification:", e);
    return e;
  }
}

async function cleanupOldNotifications(uid) {
  try {
    // Simple fetch without composite index, sort in JS
    const q = query(collection(db, 'notifications'), where('userId', '==', uid));
    const snap = await getDocs(q);
    if (snap.size > 5) {
      const docs = snap.docs.map(d => ({ ref: d.ref, ...d.data() }))
        .sort((a, b) => b.timestamp - a.timestamp); // Sort desc

      const batch = writeBatch(db);
      // Keep top 5, delete rest
      for (let i = 5; i < docs.length; i++) {
        batch.delete(docs[i].ref);
      }
      await batch.commit();
    }
  } catch (e) { console.error('Cleanup warning:', e); }
}

async function broadcastNotification(title, message) {
  try {
    const usersSnap = await getDocs(collection(db, 'users'));
    const batchSize = 400; // Firestore batch limit is 500
    let batch = writeBatch(db);
    let count = 0;

    for (const userDoc of usersSnap.docs) {
      const ref = doc(collection(db, 'notifications'));
      batch.set(ref, {
        userId: userDoc.id,
        title: title,
        message: message,
        timestamp: Date.now(),
        isRead: false
      });
      count++;
      if (count >= batchSize) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count > 0) await batch.commit();
    return true;
  } catch (e) {
    console.error("Broadcast failed:", e);
    return false;
  }
}

export function listenForNotifications(user) {
  if (!user) {
    if (notificationUnsubscribe) {
      notificationUnsubscribe();
      notificationUnsubscribe = null;
    }
    if (globalNotificationUnsubscribe) {
      globalNotificationUnsubscribe();
      globalNotificationUnsubscribe = null;
    }
    return;
  }

  if (notificationUnsubscribe) notificationUnsubscribe();

  const q = query(collection(db, 'notifications'), where('userId', '==', user.uid), orderBy('timestamp', 'desc'));

  notificationUnsubscribe = onSnapshot(q, (snapshot) => {
    const notifications = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    updateNotificationIcon(notifications);

    // Redundancy check: if more than 5, delete extras
    if (notifications.length > 5) {
      const batch = writeBatch(db);
      notifications.slice(5).forEach(n => {
        batch.delete(doc(db, 'notifications', n.id));
      });
      batch.commit();
    }
  });
}

function updateNotificationIcon(notifications) {
  const hasUnread = notifications.some(n => !n.isRead);
  console.log('Updating Notification Icon. Count:', notifications.length, 'Unread:', hasUnread);
  const badge = document.getElementById('notification-badge');
  if (badge) {
    if (hasUnread) {
      badge.style.display = 'block';
      badge.classList.remove('hidden');
    } else {
      badge.style.display = 'none';
      badge.classList.add('hidden');
    }
  }

  const modalContent = document.getElementById('notification-list-container');
  if (modalContent) {
    renderNotificationList(notifications);
  }
}

// Make sure it's globally available
window.showNotifications = async () => {
  console.log("🔔 Bell Clicked!");
  const user = auth.currentUser;
  if (!user) {
    console.log("No user logged in for notifications");
    return;
  }

  const q = query(collection(db, 'notifications'), where('userId', '==', user.uid), orderBy('timestamp', 'desc'));
  const snap = await getDocs(q);
  const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  showFloatingModal(`
        <div class="p-2">
            <h3 class="text-xl font-bold text-[var(--text-primary)] mb-4 flex items-center gap-2">
                <span>🔔</span> Notifications
            </h3>
            <div id="notification-list-container" class="space-y-3">
                <!-- Notifications will be injected here -->
            </div>
            ${notifications.length === 0 ? '<p class="text-center text-[var(--text-secondary)] py-8">No notifications yet.</p>' : ''}
        </div>
    `);

  renderNotificationList(notifications);

  // Mark as read
  const unread = notifications.filter(n => !n.isRead);
  if (unread.length > 0) {
    const batch = writeBatch(db);
    unread.forEach(n => {
      batch.update(doc(db, 'notifications', n.id), { isRead: true });
    });
    await batch.commit();
  }
};

function renderNotificationList(notifications) {
  const container = document.getElementById('notification-list-container');
  if (!container) return;

  if (notifications.length === 0) {
    container.innerHTML = '<p class="text-center text-[var(--text-secondary)] py-4">All caught up!</p>';
    return;
  }

  container.innerHTML = notifications.map(n => `
        <div class="p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-root)] relative overflow-hidden group">
            ${!n.isRead ? '<div class="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full"></div>' : ''}
            <p class="font-bold text-[var(--text-primary)] text-sm mb-1">${n.title || 'New Message'}</p>
            <p class="text-[var(--text-secondary)] text-sm">${n.message}</p>
            <p class="text-[0.65rem] text-[var(--text-secondary)] mt-2 opacity-50">${new Date(n.timestamp).toLocaleString()}</p>
        </div>
    `).join('');
}

// --- Theme Toggling ---
function toggleTheme() {
  // Remove any login/register page classes
  document.body.className = '';

  const root = document.documentElement;
  const currentTheme = root.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);

  // Dispatch custom event if needed
  window.dispatchEvent(new Event('theme-change'));
}

// Initial Theme Check
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
document.body.className = ''; // Remove any page-specific classes

// --- Helpers ---
function showFloatingModal(content) {
  const existing = document.getElementById('floating-modal-container');
  if (existing) existing.classList.remove('hidden');
  else {
    const modal = document.createElement('div');
    modal.id = "floating-modal-container";
    modal.className = "fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-3 sm:p-4 animate-in fade-in zoom-in duration-300";
    modal.innerHTML = `
            <div class="smart-card relative max-w-lg w-full max-h-[90vh] overflow-y-auto custom-scrollbar shadow-2xl bg-[var(--bg-secondary)] p-4 sm:p-6">
                <button onclick="document.getElementById('floating-modal-container').classList.add('hidden')" class="absolute top-3 right-3 sm:top-4 sm:right-4 text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-2xl font-bold w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--glass-border)] transition-colors z-10">&times;</button>
                <div id="modal-content">${content}</div>
            </div>
        `;
    document.body.appendChild(modal);
  }
  // Update content if re-using
  const c = document.getElementById('modal-content');
  if (c) c.innerHTML = content;
}

function closeFloatingModal() {
  const m = document.getElementById('floating-modal-container');
  if (m) m.classList.add('hidden');
}

// --- Header ---
export async function renderHeader(user, navigate, logout) {
  if (!user) {
    headerElement.style.display = 'none';
    return;
  }
  headerElement.style.display = 'flex';

  // Profile Picture Logic (Get from Firestore to avoid Auth photoURL limits)
  const profile = await getUserProfile(user.uid);
  const photoURL = profile?.photoURL || user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName}&background=4f46e5&color=fff`;

  const path = window.location.pathname;
  const getNavClass = (p) => {
    const active = path === p || (p === '/recordings' && path.startsWith('/recording/'));
    return `px-3 lg:px-5 py-1.5 lg:py-2 rounded-full font-semibold text-xs lg:text-sm transition-all duration-300 whitespace-nowrap ${active ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-md scale-105 border border-[var(--glass-border)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] hover:shadow-md'}`;
  };
  const adminActive = path === '/adminpanel';
  const adminClass = `px-3 lg:px-5 py-1.5 lg:py-2 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-md hover:shadow-lg font-bold text-xs lg:text-sm transition-all duration-300 flex items-center gap-1 whitespace-nowrap ${adminActive ? 'ring-2 ring-offset-2 ring-indigo-500 ring-offset-[var(--bg-root)] scale-105' : 'hover:scale-105'}`;

  headerElement.innerHTML = `
        <div class="flex items-center gap-2.5 sm:gap-3 cursor-pointer" onclick="navigateTo('/home')">
            <!-- Mobile Menu Toggle Button (Hamburger) -->
            <button id="mobile-drawer-toggle-btn" class="md:hidden p-2 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-root)] hover:bg-[var(--glass-border)] text-[var(--text-primary)] flex items-center justify-center cursor-pointer transition-colors" title="Menu">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"></path>
                </svg>
            </button>

            <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl overflow-hidden shadow-lg shadow-indigo-500/20 bg-white shrink-0">
                <img src="/icon.png" alt="StudyTracker Logo" class="w-full h-full object-contain p-1">
            </div>
            <span class="text-lg sm:text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-[var(--text-primary)] to-[var(--text-secondary)] hidden xs:block">StudyTracker</span>
        </div>

        <nav class="hidden md:flex gap-1 items-center flex-1 justify-center max-w-fit mx-auto bg-[var(--bg-root)] p-1.5 rounded-full border border-[var(--glass-border)] shadow-sm">
            <button class="${getNavClass('/home')}" onclick="navigateTo('/home')">Dashboard</button>
            <button class="${getNavClass('/timetable')}" onclick="navigateTo('/timetable')">Time Table</button>
            <button class="${getNavClass('/recordings')}" onclick="navigateTo('/recordings')">Lectures</button>
            <button class="${getNavClass('/live')} relative inline-flex items-center gap-1.5" onclick="navigateTo('/live')">
                <span>Live</span>
                <span class="live-indicator-dot w-2 h-2 rounded-full bg-red-500 shadow-md shadow-red-500/50 live-pulse-dot" style="display: ${window._hasLiveClasses ? 'inline-block' : 'none'};"></span>
            </button>
            <button class="${getNavClass('/chat')} relative inline-flex items-center gap-1.5" onclick="navigateTo('/chat')">
                <span>Chat Lounge</span>
                <span id="chat-unread-badge-desktop" class="px-1.5 min-w-[18px] h-[18px] text-[10px] font-black rounded-full bg-gradient-to-r from-red-500 to-rose-600 text-white inline-flex items-center justify-center shadow-sm" style="display: ${window._unreadChatCount > 0 ? 'inline-flex' : 'none'};">
                    ${window._unreadChatCount > 99 ? '99+' : (window._unreadChatCount || '')}
                </span>
            </button>
            <button class="${getNavClass('/contact')}" onclick="navigateTo('/contact')">Contact Us</button>
            <button class="${getNavClass('/simulation')}" onclick="navigateTo('/simulation')">Simulation</button>
            <button class="${getNavClass('/resources')}" onclick="navigateTo('/resources')">Resources</button>
            ${user.uid === ADMIN_UID ? `<button class="${adminClass}" onclick="navigateTo('/adminpanel')">Admin Dashboard</button>` : ''}
        </nav>

        <div class="flex items-center gap-2 sm:gap-4">
            <!-- Chat Lounge Quick Access Button & Unread Counter (Prominently visible at the top) -->
            <button onclick="navigateTo('/chat')" class="relative p-2 text-xl hover:bg-[var(--glass-border)] rounded-full transition-colors flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 text-[var(--text-primary)] cursor-pointer" title="Chat Lounge">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
                </svg>
                <span id="chat-unread-badge-header" class="absolute -top-1 -right-1 px-1.5 min-w-[18px] h-[18px] text-[10px] font-black rounded-full bg-gradient-to-r from-red-500 to-rose-600 text-white flex items-center justify-center shadow-md shadow-red-500/50 animate-pulse border-2 border-[var(--bg-secondary)]" style="display: ${window._unreadChatCount > 0 ? 'flex' : 'none'};">
                    ${window._unreadChatCount > 99 ? '99+' : (window._unreadChatCount || '')}
                </span>
            </button>

            <button onclick="window.showNotifications()" class="relative p-2 text-xl hover:bg-[var(--glass-border)] rounded-full transition-colors flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 text-[var(--text-primary)]">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path>
                </svg>
                <div id="notification-badge" class="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-[var(--bg-secondary)] shadow-sm" style="display: none;"></div>
            </button>

            <button id="theme-btn" class="theme-toggle-btn text-base sm:text-lg">
                ${localStorage.getItem('theme') === 'light' ? '🌗' : '☀️'}
            </button>
            
            <div class="relative group">
                <button id="profile-btn" class="w-9 h-9 sm:w-10 sm:h-10 rounded-full border border-[var(--glass-border)] overflow-hidden transition-transform hover:scale-105 focus:ring-2 focus:ring-indigo-500">
                    <img src="${photoURL}" class="w-full h-full object-cover">
                </button>
                
                <!-- Dropdown -->
                <div class="profile-dropdown">
                    <div class="profile-dropdown-content">
                        <div class="px-3 py-2 border-b border-[var(--glass-border)] mb-1">
                            <p class="text-sm font-bold text-[var(--text-primary)] truncate">${user.displayName}</p>
                            <p class="text-xs text-[var(--text-secondary)] truncate">${user.email}</p>
                        </div>
                        <button class="w-full text-left p-2 hover:bg-[var(--primary)] hover:text-white rounded-lg text-sm text-[var(--text-primary)] transition-colors" onclick="navigateTo('/profile')">Profile Settings</button>
                        <button class="w-full text-left p-2 hover:bg-[var(--primary)] hover:text-white rounded-lg text-sm text-[var(--text-primary)] transition-colors flex items-center gap-2" onclick="navigateTo('/chat')">Chat Lounge</button>
                        ${user.uid === ADMIN_UID ? `<button class="w-full text-left p-2 hover:bg-[var(--primary)] hover:text-white rounded-lg text-sm text-[var(--text-primary)] transition-colors" onclick="navigateTo('/adminpanel')">Admin Dashboard</button>` : ''}
                        <div class="h-px bg-[var(--glass-border)] my-1"></div>
                        <button id="logout-btn" class="w-full text-left p-2 hover:bg-red-500/10 text-red-400 rounded-lg text-sm transition-colors">Sign Out</button>
                    </div>
                </div>
            </div>
        </div>
    `;

  const drawerToggleBtn = document.getElementById('mobile-drawer-toggle-btn');
  if (drawerToggleBtn) {
    drawerToggleBtn.onclick = (e) => {
      e.stopPropagation();
      window.openMobileDrawer && window.openMobileDrawer();
    };
  }

  document.getElementById('theme-btn').onclick = async () => {
    toggleTheme();
    await renderHeader(user, navigate, logout);
  };

  // Proper event listener for logout
  document.getElementById('logout-btn').onclick = async () => {
    try {
      if (window._activityTrackingInterval) {
        clearInterval(window._activityTrackingInterval);
      }
      userProfileCache = {}; // Clear cache on logout
      await signOut(auth);
      navigate('/login');
    } catch (error) {
      console.error(error);
    }
  };
}

// --- Welcome Redirect ---
export function renderWelcome(navigate) { navigate('/login'); }

// --- Unified Exam Countdown Data & Helper (Used inside and outside) ---
export function getExamCountdownData() {
  const examTargetDate = new Date(2027, 7, 3, 0, 0, 0).getTime(); // August 3, 2027 00:00:00 local time
  const now = new Date();
  const distance = examTargetDate - now.getTime();

  if (distance <= 0) {
    return {
      v1: '00', l1: 'Days',
      v2: '00', l2: 'Hours',
      v3: '00', l3: 'Mins',
      v4: '00', l4: 'Secs',
      isExpired: true
    };
  }

  const pad = (n) => String(Math.max(0, n)).padStart(2, '0');

  // Calculate whole calendar months remaining
  let tempDate = new Date(now.getTime());
  let months = 0;
  while (true) {
    let nextMonthDate = new Date(tempDate.getTime());
    nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
    if (nextMonthDate.getTime() <= examTargetDate) {
      months++;
      tempDate = nextMonthDate;
    } else {
      break;
    }
  }

  // Stage 1: More than 6 months remaining (> 6 months) -> Months, Weeks, Days, Hours
  if (months >= 6) {
    const remMs = examTargetDate - tempDate.getTime();
    const totalRemDays = Math.floor(remMs / (1000 * 60 * 60 * 24));
    const weeks = Math.floor(totalRemDays / 7);
    const days = totalRemDays % 7;
    const hours = Math.floor((remMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    return {
      v1: pad(months), l1: 'Months',
      v2: pad(weeks), l2: 'Weeks',
      v3: pad(days), l3: 'Days',
      v4: pad(hours), l4: 'Hours',
      isExpired: false
    };
  } 
  // Stage 2: 6 months down to 2 months remaining (2 <= months < 6) -> Weeks, Days, Hours, Mins
  else if (months >= 2) {
    const totalDays = Math.floor(distance / (1000 * 60 * 60 * 24));
    const weeks = Math.floor(totalDays / 7);
    const days = totalDays % 7;
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));

    return {
      v1: pad(weeks), l1: 'Weeks',
      v2: pad(days), l2: 'Days',
      v3: pad(hours), l3: 'Hours',
      v4: pad(minutes), l4: 'Mins',
      isExpired: false
    };
  } 
  // Stage 3: Less than 2 months remaining (months < 2) -> Days, Hours, Mins, Secs
  else {
    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    return {
      v1: pad(days), l1: 'Days',
      v2: pad(hours), l2: 'Hours',
      v3: pad(minutes), l3: 'Mins',
      v4: pad(seconds), l4: 'Secs',
      isExpired: false
    };
  }
}

export function startAuthCountdownTimer() {
  if (window.authCountdownInterval) {
    clearInterval(window.authCountdownInterval);
    window.authCountdownInterval = null;
  }

  const updateAuthCountdown = () => {
    const v1 = document.getElementById('auth-countdown-val-1');
    const l1 = document.getElementById('auth-countdown-lbl-1');
    const v2 = document.getElementById('auth-countdown-val-2');
    const l2 = document.getElementById('auth-countdown-lbl-2');
    const v3 = document.getElementById('auth-countdown-val-3');
    const l3 = document.getElementById('auth-countdown-lbl-3');
    const v4 = document.getElementById('auth-countdown-val-4');
    const l4 = document.getElementById('auth-countdown-lbl-4');

    if (!v1 || !v2 || !v3 || !v4) {
      if (window.authCountdownInterval) {
        clearInterval(window.authCountdownInterval);
        window.authCountdownInterval = null;
      }
      return;
    }

    const data = getExamCountdownData();
    v1.textContent = data.v1;
    if (l1) l1.textContent = data.l1;
    v2.textContent = data.v2;
    if (l2) l2.textContent = data.l2;
    v3.textContent = data.v3;
    if (l3) l3.textContent = data.l3;
    v4.textContent = data.v4;
    if (l4) l4.textContent = data.l4;

    if (data.isExpired && window.authCountdownInterval) {
      clearInterval(window.authCountdownInterval);
      window.authCountdownInterval = null;
    }
  };

  updateAuthCountdown();
  window.authCountdownInterval = setInterval(updateAuthCountdown, 1000);
}

function getAuthHeroHTML() {
  const cd = getExamCountdownData();
  return `
    <div class="hidden lg:block lg:col-span-6 space-y-6 text-left pt-2">
        <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-indigo-500/20 to-cyan-500/20 border border-indigo-500/30 text-indigo-300 text-xs font-semibold">
            <span class="flex h-2 w-2 relative">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
            </span>
            <span>A/L Smart Study Ecosystem</span>
        </div>

        <h1 class="text-3xl md:text-4xl lg:text-5xl font-extrabold font-display leading-tight text-white">
            Master your A/Ls with 
            <span class="bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-sky-300 to-cyan-400">
                laser focus.
            </span>
        </h1>

        <p class="text-slate-300 text-sm md:text-base leading-relaxed max-w-lg">
            Track your daily study hours, attend high-yield live classes, watch recorded lessons, and supercharge your exam preparation in one workspace.
        </p>

        <!-- Exam Countdown Card (Matches Dashboard Inside Countdown Exactly) -->
        <div class="neo-glass-auth p-5 rounded-2xl border border-indigo-500/30 shadow-2xl relative overflow-hidden group hover:border-indigo-500/50 transition-all">
            <div class="absolute -right-8 -top-8 w-28 h-28 bg-indigo-500/10 rounded-full blur-2xl group-hover:bg-indigo-500/20 transition-all"></div>
            <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                    <span class="text-lg">⏳</span>
                    <div>
                        <div class="text-[10px] uppercase tracking-widest text-indigo-400 font-extrabold">Exam Countdown</div>
                        <span class="text-xs font-bold text-white">2027 A/L Exam</span>
                    </div>
                </div>
                <span class="text-[11px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono">August 3, 2027</span>
            </div>
            
            <div class="grid grid-cols-4 gap-2 text-center">
                <div class="bg-slate-900/85 rounded-xl p-2.5 border border-white/5 shadow-inner">
                    <div id="auth-countdown-val-1" class="text-xl md:text-2xl font-extrabold font-display text-white">${cd.v1}</div>
                    <div id="auth-countdown-lbl-1" class="text-[10px] text-slate-400 uppercase font-semibold">${cd.l1}</div>
                </div>
                <div class="bg-slate-900/85 rounded-xl p-2.5 border border-white/5 shadow-inner">
                    <div id="auth-countdown-val-2" class="text-xl md:text-2xl font-extrabold font-display text-indigo-200">${cd.v2}</div>
                    <div id="auth-countdown-lbl-2" class="text-[10px] text-slate-400 uppercase font-semibold">${cd.l2}</div>
                </div>
                <div class="bg-slate-900/85 rounded-xl p-2.5 border border-white/5 shadow-inner">
                    <div id="auth-countdown-val-3" class="text-xl md:text-2xl font-extrabold font-display text-cyan-200">${cd.v3}</div>
                    <div id="auth-countdown-lbl-3" class="text-[10px] text-slate-400 uppercase font-semibold">${cd.l3}</div>
                </div>
                <div class="bg-slate-900/85 rounded-xl p-2.5 border border-white/5 shadow-inner">
                    <div id="auth-countdown-val-4" class="text-xl md:text-2xl font-extrabold font-display text-rose-400">${cd.v4}</div>
                    <div id="auth-countdown-lbl-4" class="text-[10px] text-rose-400/80 uppercase font-semibold">${cd.l4}</div>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-3 pt-1">
            <div class="flex items-center gap-2 text-xs text-slate-300">
                <span class="text-indigo-400">⚡</span>
                <span>Real-time Live Classes</span>
            </div>
            <div class="flex items-center gap-2 text-xs text-slate-300">
                <span class="text-cyan-400">📹</span>
                <span>AL & Maths Recordings</span>
            </div>
            <div class="flex items-center gap-2 text-xs text-slate-300">
                <span class="text-indigo-400">🔒</span>
                <span>100% Encrypted & Safe</span>
            </div>
            <div class="flex items-center gap-2 text-xs text-slate-300">
                <span class="text-cyan-400">🏆</span>
                <span>Daily Study Streaks</span>
            </div>
        </div>
    </div>
  `;
}

// --- Login ---
export function renderLogin(navigate) {
  headerElement.style.display = 'none';
  document.body.classList.add('auth-page-mode');

  appContainer.innerHTML = `
        <div class="min-h-[85vh] w-full flex items-center justify-center p-4 md:p-8 lg:p-12 relative overflow-hidden">
            <!-- Background Ambient Aurora Glows -->
            <div class="aurora-orb w-96 h-96 bg-indigo-600/20 -top-20 -left-20 pointer-events-none"></div>
            <div class="aurora-orb w-96 h-96 bg-cyan-500/15 -bottom-20 -right-20 pointer-events-none" style="animation-delay: -4s;"></div>

            <div class="w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-center relative z-10">
                
                <!-- Left Hero Panel (Desktop & Tablet) -->
                ${getAuthHeroHTML()}

                <!-- Right Auth Card -->
                <div class="lg:col-span-6 w-full max-w-md mx-auto">
                    <div class="neo-glass-auth rounded-3xl p-6 md:p-8 relative border border-indigo-500/25 shadow-2xl overflow-hidden">
                        
                        <!-- Top Glow Highlight -->
                        <div class="hidden md:block absolute top-0 left-1/4 right-1/4 h-[2px] bg-gradient-to-r from-transparent via-indigo-400 to-transparent"></div>

                        <!-- Brand Header -->
                        <div class="flex items-center justify-between mb-5">
                            <div class="flex items-center gap-3">
                                <div class="w-12 h-12 rounded-2xl bg-white p-1.5 shadow-md shadow-indigo-500/20 flex-shrink-0">
                                    <img src="/icon.png" alt="StudyTracker Logo" class="w-full h-full object-contain">
                                </div>
                                <div>
                                    <h1 class="text-xl font-bold font-display text-white">Welcome Back! 👋</h1>
                                    <p class="text-xs text-slate-400">Sign in to your learning dashboard</p>
                                </div>
                            </div>
                            <span class="text-[10px] px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium flex items-center gap-1">
                                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                Secure
                            </span>
                        </div>

                        <!-- Segmented Tab Switcher [Sign In | Create Account] -->
                        <div class="bg-slate-950/80 p-1 rounded-2xl border border-white/10 mb-5 flex relative">
                            <button type="button" class="flex-1 py-2 text-xs font-bold rounded-xl text-white bg-indigo-600 shadow-md shadow-indigo-600/30">
                                Sign In
                            </button>
                            <button type="button" onclick="window.navigateTo('/register')" class="flex-1 py-2 text-xs font-bold rounded-xl text-slate-400 hover:text-slate-200 transition-colors">
                                Create Account
                            </button>
                        </div>

                        <!-- Login Form -->
                        <form id="login-form" class="space-y-4" action="javascript:void(0);" method="POST">
                            
                            <!-- Email Input -->
                            <div class="space-y-1.5 text-left">
                                <label class="text-xs font-semibold text-slate-300 flex items-center justify-between">
                                    <span>Email Address</span>
                                    <span class="text-[10px] text-slate-500">Student Account</span>
                                </label>
                                <div class="modern-auth-input-box">
                                    <input type="email" name="email" placeholder="student@studytracker.lk" class="modern-auth-input" required autocomplete="email">
                                    <svg class="auth-input-icon w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207"/>
                                    </svg>
                                </div>
                            </div>

                            <!-- Password Input -->
                            <div class="space-y-1.5 text-left">
                                <div class="flex items-center justify-between">
                                    <label class="text-xs font-semibold text-slate-300">Password</label>
                                    <button type="button" id="forgot-password-btn" class="text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium">Forgot Password?</button>
                                </div>
                                <div class="modern-auth-input-box">
                                    <input type="password" id="login-password-field" name="password" placeholder="••••••••••••" class="modern-auth-input pr-12" required autocomplete="current-password">
                                    <svg class="auth-input-icon w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                                    </svg>
                                    <button type="button" id="toggle-login-pass" class="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors p-1">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            <!-- Remember Me Checkbox -->
                            <div class="flex items-center justify-between text-xs text-slate-400 py-1">
                                <label class="flex items-center gap-2 cursor-pointer select-none">
                                    <input type="checkbox" checked class="w-4 h-4 rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900">
                                    <span>Remember this browser</span>
                                </label>
                                <span class="text-[11px] text-emerald-400 font-mono">● Safe Session</span>
                            </div>

                            <!-- Submit Button -->
                            <button type="submit" class="w-full btn-auth-gradient py-3.5 rounded-xl font-bold text-white shadow-xl flex items-center justify-center gap-2 text-sm tracking-wide mt-2">
                                <span>Sign In to StudyTracker</span>
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
                            </button>
                        </form>

                        <!-- Divider -->
                        <div class="relative my-5">
                            <div class="absolute inset-0 flex items-center"><div class="w-full border-t border-slate-700/60"></div></div>
                            <div class="relative flex justify-center text-[10px] uppercase font-bold text-slate-500"><span class="bg-[#0d1426] px-3">or continue with</span></div>
                        </div>

                        <!-- Google Login Button -->
                        <button id="google-login" type="button" class="w-full bg-slate-900/90 hover:bg-slate-800 text-slate-200 border border-slate-700/80 hover:border-slate-600 py-3 rounded-xl flex items-center justify-center gap-3 text-xs font-semibold shadow-md transition-all group">
                            <svg class="w-4 h-4 group-hover:scale-110 transition-transform" viewBox="0 0 24 24">
                                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                            </svg>
                            <span class="font-medium">Continue with Google</span>
                        </button>

                        <!-- Footer Links -->
                        <div class="mt-6 pt-4 border-t border-slate-800 text-center space-y-2">
                            <p class="text-xs text-slate-400">
                                Don't have an account? <a href="javascript:void(0)" onclick="window.navigateTo('/register')" class="text-indigo-400 font-bold hover:underline">Sign up for free</a>
                            </p>
                            <div class="flex justify-center gap-3 text-[11px] text-slate-500">
                                <a href="javascript:void(0)" onclick="window.navigateTo('/contact')" class="hover:text-slate-400">Contact Us</a>
                                <span>&bull;</span>
                                <a href="Privacy_Policy.html" class="hover:text-slate-400">Privacy Policy</a>
                                <span>&bull;</span>
                                <a href="Terms_of_Service.html" class="hover:text-slate-400">Terms of Service</a>
                            </div>
                        </div>

                    </div>
                </div>

            </div>
        </div>
    `;

  // Password Visibility Toggle
  const togglePassBtn = document.getElementById('toggle-login-pass');
  if (togglePassBtn) {
    togglePassBtn.onclick = () => {
      const passField = document.getElementById('login-password-field');
      if (passField) {
        passField.type = passField.type === 'password' ? 'text' : 'password';
      }
    };
  }

  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const email = sanitizeInput((e.target.email.value || '').trim());
      const password = e.target.password.value;
      if (!email || !password) {
        alert("Please enter both email and password.");
        return;
      }
      const pendingId = Date.now().toString() + Math.random().toString();
      localStorage.setItem('pendingSessionId', pendingId);
      setCookie('pendingSessionId', pendingId);
      await signInWithEmailAndPassword(auth, email, password);
      navigate('/home');
    } catch (err) { alert(err.message); }
  };

  document.getElementById('forgot-password-btn').onclick = async () => {
    let emailInput = sanitizeInput((document.querySelector('#login-form input[name="email"]')?.value || '').trim());
    if (!emailInput) {
      const promptEmail = prompt("Please enter your registered email address to reset password:\nමුරපදය reset කිරීමට ඔබගේ ලියාපදිංචි ඊමේල් ලිපිනය ඇතුළත් කරන්න:");
      if (!promptEmail) return;
      emailInput = sanitizeInput(promptEmail.trim());
      const emailField = document.querySelector('#login-form input[name="email"]');
      if (emailField) emailField.value = emailInput;
    }
    if (!emailInput) {
      alert("Please enter your email address first.\nකරුණාකර ඔබගේ ඊමේල් ලිපිනය ඇතුළත් කරන්න.");
      return;
    }

    const forgotBtn = document.getElementById('forgot-password-btn');
    const originalText = forgotBtn ? forgotBtn.innerHTML : '';
    if (forgotBtn) {
      forgotBtn.disabled = true;
      forgotBtn.innerHTML = '<span class="inline-flex items-center gap-1"><svg class="animate-spin h-3 w-3 text-indigo-400" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Sending...</span>';
    }

    const actionCodeSettings = {
      url: 'https://mathsrecording.com/reset-password',
      handleCodeInApp: true,
    };

    try {
      await sendPasswordResetEmail(auth, emailInput, actionCodeSettings);
      alert(`Password reset link sent successfully to ${emailInput}!\nPlease check your email inbox (and spam/junk folder).\n\nමුරපදය reset කිරීමේ ලින්ක් එක ඔබගේ ඊමේල් ලිපිනයට යවන ලදී. කරුණාකර Inbox හෝ Spam පරීක්ෂා කරන්න.`);
    } catch (err) {
      console.error("Password reset error:", err);
      if (err.code === 'auth/unauthorized-continue-uri') {
        try {
          await sendPasswordResetEmail(auth, emailInput);
          alert(`Password reset link sent to ${emailInput}!\n(Notice: Custom domain not yet authorized in Firebase Console; sent standard Firebase link).\nPlease check your Inbox or Spam folder.`);
          return;
        } catch (fallbackErr) {
          alert(fallbackErr.message || "Failed to send reset email.");
        }
      } else if (err.code === 'auth/user-not-found') {
        alert("No account found with this email address.\nමෙම ඊමේල් ලිපිනයට අදාළ ගිණුමක් හමු නොවීය.");
      } else if (err.code === 'auth/invalid-email') {
        alert("Please enter a valid email address.\nවලංගු ඊමේල් ලිපිනයක් ඇතුළත් කරන්න.");
      } else {
        alert(err.message || "Error sending password reset email.");
      }
    } finally {
      if (forgotBtn) {
        forgotBtn.disabled = false;
        forgotBtn.innerHTML = originalText;
      }
    }
  };

  document.getElementById('google-login').onclick = async () => {
    try {
      const pendingId = Date.now().toString() + Math.random().toString();
      localStorage.setItem('pendingSessionId', pendingId);
      setCookie('pendingSessionId', pendingId);
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      const u = result.user;
      const ref = doc(db, 'users', u.uid);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        const nameParts = (u.displayName || 'User').split(' ');
        const firstName = sanitizeInput(nameParts[0] || 'User');
        const lastName = sanitizeInput(nameParts.length > 1 ? nameParts.slice(1).join(' ') : '');
        await setDoc(ref, {
          firstName: firstName,
          lastName: lastName,
          email: sanitizeInput(u.email || ''),
          photoURL: sanitizeUrl(u.photoURL || ''),
          examYear: '2026 A/L',
          createdAt: new Date().toISOString()
        });
      }

      navigate('/home');
    } catch (err) { alert(err.message); }
  };

  startAuthCountdownTimer();
}

// --- Register ---
export function renderRegister(navigate) {
  headerElement.style.display = 'none';
  document.body.classList.add('auth-page-mode');

  appContainer.innerHTML = `
        <div class="min-h-[85vh] w-full flex items-center justify-center p-4 md:p-8 lg:p-12 relative overflow-hidden">
            <!-- Background Ambient Aurora Glows -->
            <div class="aurora-orb w-96 h-96 bg-indigo-600/20 -top-20 -left-20 pointer-events-none"></div>
            <div class="aurora-orb w-96 h-96 bg-cyan-500/15 -bottom-20 -right-20 pointer-events-none" style="animation-delay: -4s;"></div>

            <div class="w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-center relative z-10">
                
                <!-- Left Hero Panel (Desktop & Tablet) -->
                ${getAuthHeroHTML()}

                <!-- Right Register Card -->
                <div class="lg:col-span-6 w-full max-w-lg mx-auto">
                    <div class="neo-glass-auth rounded-3xl p-6 md:p-7 relative border border-indigo-500/25 shadow-2xl overflow-hidden">
                        
                        <!-- Top Glow Highlight -->
                        <div class="hidden md:block absolute top-0 left-1/4 right-1/4 h-[2px] bg-gradient-to-r from-transparent via-indigo-400 to-transparent"></div>

                        <!-- Brand Header -->
                        <div class="flex items-center justify-between mb-4">
                            <div class="flex items-center gap-3">
                                <div class="w-11 h-11 rounded-2xl bg-white p-1 shadow-md shadow-indigo-500/20 flex-shrink-0">
                                    <img src="/icon.png" alt="StudyTracker Logo" class="w-full h-full object-contain">
                                </div>
                                <div>
                                    <h2 class="text-lg md:text-xl font-bold font-display text-white">Create Account 🚀</h2>
                                    <p class="text-xs text-slate-400">Join the smart A/L study ecosystem</p>
                                </div>
                            </div>
                            <span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium flex items-center gap-1">
                                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                Secure
                            </span>
                        </div>

                        <!-- Segmented Tab Switcher [Sign In | Create Account] -->
                        <div class="bg-slate-950/80 p-1 rounded-2xl border border-white/10 mb-4 flex relative">
                            <button type="button" onclick="window.navigateTo('/login')" class="flex-1 py-1.5 text-xs font-bold rounded-xl text-slate-400 hover:text-slate-200 transition-colors">
                                Sign In
                            </button>
                            <button type="button" class="flex-1 py-1.5 text-xs font-bold rounded-xl text-white bg-indigo-600 shadow-md shadow-indigo-600/30">
                                Create Account
                            </button>
                        </div>

                        <!-- Register Form -->
                        <form id="register-form" class="space-y-3" action="javascript:void(0);" method="POST">
                            
                            <!-- Name Fields -->
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                <div class="space-y-1 text-left">
                                    <label class="text-[11px] font-semibold text-slate-300 block">First Name</label>
                                    <div class="modern-auth-input-box">
                                        <input name="firstName" placeholder="First Name" class="modern-auth-input !pl-9 text-xs" required>
                                        <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                                    </div>
                                </div>
                                <div class="space-y-1 text-left">
                                    <label class="text-[11px] font-semibold text-slate-300 block">Last Name</label>
                                    <div class="modern-auth-input-box">
                                        <input name="lastName" placeholder="Last Name" class="modern-auth-input !pl-9 text-xs" required>
                                        <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                                    </div>
                                </div>
                            </div>

                            <!-- Birthday & Optional Photo -->
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                <div class="space-y-1 text-left">
                                    <label class="text-[11px] font-semibold text-slate-300 block">Birthday</label>
                                    <div class="modern-auth-input-box">
                                        <input name="birthday" onfocus="(this.type='date')" placeholder="Birthday" class="modern-auth-input !pl-9 text-xs" required>
                                        <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                                    </div>
                                </div>
                                <div class="space-y-1 text-left">
                                    <label class="text-[11px] font-semibold text-slate-300 block">Profile Photo <span class="text-[9px] text-slate-500 font-normal">(Optional)</span></label>
                                    <div class="modern-auth-input-box">
                                        <input type="file" id="register-photo" accept="image/*" class="modern-auth-input !pl-9 text-xs file:hidden cursor-pointer">
                                        <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                                    </div>
                                </div>
                            </div>

                            <!-- Email Address -->
                            <div class="space-y-1 text-left">
                                <label class="text-[11px] font-semibold text-slate-300 block">Email Address</label>
                                <div class="modern-auth-input-box">
                                    <input name="email" type="email" placeholder="student@studytracker.lk" class="modern-auth-input !pl-9 text-xs" required autocomplete="email">
                                    <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                                </div>
                            </div>

                            <!-- Phone & A/L Batch -->
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                <div class="space-y-1 text-left">
                                    <label class="text-[11px] font-semibold text-slate-300 block">Phone (10 Digits)</label>
                                    <div class="modern-auth-input-box">
                                        <input type="tel" name="phone" pattern="[0-9]{10}" maxlength="10" placeholder="07XXXXXXXX" class="modern-auth-input !pl-9 text-xs" title="Please enter exactly 10 digits" required>
                                        <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
                                    </div>
                                </div>
                                <div class="space-y-1 text-left">
                                    <label class="text-[11px] font-semibold text-slate-300 block">A/L Target Batch</label>
                                    <div class="modern-auth-input-box">
                                        <select name="examYear" class="modern-auth-input !pl-9 text-xs appearance-none cursor-pointer bg-slate-900">
                                            <option value="2027 A/L" selected>2027 A/L</option>
                                            <option value="2026 A/L">2026 A/L</option>
                                            <option value="2028 A/L">2028 A/L</option>
                                            <option value="2029 A/L">2029 A/L</option>
                                        </select>
                                        <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                                    </div>
                                </div>
                            </div>

                            <!-- School -->
                            <div class="space-y-1 text-left">
                                <label class="text-[11px] font-semibold text-slate-300 block">School <span class="text-slate-500 font-normal">(Optional)</span></label>
                                <div class="modern-auth-input-box">
                                    <input name="school" placeholder="School Name (Optional)" class="modern-auth-input !pl-9 text-xs">
                                    <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
                                </div>
                            </div>

                            <!-- Password with Live Strength Meter -->
                            <div class="space-y-1 text-left">
                                <label class="text-[11px] font-semibold text-slate-300 block">Create Password</label>
                                <div class="modern-auth-input-box">
                                    <input name="password" id="register-password-field" type="password" placeholder="••••••••••••" class="modern-auth-input !pl-9 pr-10 text-xs" required autocomplete="new-password">
                                    <svg class="auth-input-icon !left-3 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                                    <button type="button" id="toggle-reg-pass" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                                    </button>
                                </div>
                                <div class="pt-1 space-y-1">
                                    <div class="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden flex">
                                        <div id="reg-strength-bar" class="h-full bg-rose-500 rounded-full transition-all duration-300" style="width: 25%;"></div>
                                    </div>
                                    <div class="flex justify-between text-[10px] text-slate-400">
                                        <span>Strength:</span>
                                        <span id="reg-strength-text" class="text-rose-400 font-bold">Too Weak</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Submit Button -->
                            <button type="submit" class="w-full btn-auth-gradient py-3.5 rounded-xl font-bold text-white shadow-xl flex items-center justify-center gap-2 text-sm tracking-wide mt-2">
                                <span>Create Free Account</span>
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
                            </button>
                        </form>

                        <!-- Divider -->
                        <div class="relative my-3">
                            <div class="absolute inset-0 flex items-center"><div class="w-full border-t border-slate-700/60"></div></div>
                            <div class="relative flex justify-center text-[10px] uppercase font-bold text-slate-500"><span class="bg-[#0d1426] px-3">or continue with</span></div>
                        </div>

                        <!-- Google Signup Button -->
                        <button id="google-signup" type="button" class="w-full bg-slate-900/90 hover:bg-slate-800 text-slate-200 border border-slate-700/80 hover:border-slate-600 py-2.5 rounded-xl flex items-center justify-center gap-3 text-xs font-semibold shadow-md transition-all group">
                            <svg class="w-4 h-4 group-hover:scale-110 transition-transform" viewBox="0 0 24 24">
                                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                            </svg>
                            <span class="font-medium">Continue with Google</span>
                        </button>

                        <!-- Footer Links -->
                        <div class="mt-4 pt-2.5 border-t border-slate-800 text-center space-y-1">
                            <p class="text-xs text-slate-400">
                                Already have an account? <a href="javascript:void(0)" onclick="window.navigateTo('/login')" class="text-indigo-400 font-bold hover:underline">Sign in here</a>
                            </p>
                            <div class="flex justify-center gap-3 text-[11px] text-slate-500">
                                <a href="javascript:void(0)" onclick="window.navigateTo('/contact')" class="hover:text-slate-400">Contact Us</a>
                                <span>&bull;</span>
                                <a href="Privacy_Policy.html" class="hover:text-slate-400">Privacy Policy</a>
                                <span>&bull;</span>
                                <a href="Terms_of_Service.html" class="hover:text-slate-400">Terms of Service</a>
                            </div>
                        </div>

                    </div>
                </div>

             </div>
        </div>
    `;

  // Password Visibility Toggle & Live Strength Meter
  const togglePassBtn = document.getElementById('toggle-reg-pass');
  const passInput = document.getElementById('register-password-field');
  const bar = document.getElementById('reg-strength-bar');
  const text = document.getElementById('reg-strength-text');

  if (togglePassBtn && passInput) {
    togglePassBtn.onclick = () => {
      passInput.type = passInput.type === 'password' ? 'text' : 'password';
    };
  }

  if (passInput && bar && text) {
    passInput.oninput = (e) => {
      const val = e.target.value;
      if (!val || val.length < 5) {
        bar.style.width = '25%';
        bar.className = 'h-full bg-rose-500 rounded-full transition-all duration-300';
        text.className = 'text-rose-400 font-bold';
        text.textContent = 'Too Weak';
      } else if (val.length < 8) {
        bar.style.width = '55%';
        bar.className = 'h-full bg-amber-400 rounded-full transition-all duration-300';
        text.className = 'text-amber-400 font-bold';
        text.textContent = 'Medium (Add symbols)';
      } else {
        bar.style.width = '100%';
        bar.className = 'h-full bg-emerald-400 rounded-full transition-all duration-300';
        text.className = 'text-emerald-400 font-bold';
        text.textContent = 'Strong Password ✓';
      }
    };
  }

  document.getElementById('register-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Creating Account...';
    try {
      let photoURL = null;
      const fileInput = document.getElementById('register-photo');
      if (fileInput && fileInput.files[0]) {
         photoURL = await compressImage(fileInput.files[0]);
         if (photoURL && typeof photoURL === 'string' && !photoURL.startsWith('data:image/')) {
           photoURL = sanitizeUrl(photoURL);
         }
      }
      const rawFirst = f.get('firstName') || '';
      const rawLast = f.get('lastName') || '';
      const cleanFirst = sanitizeInput(rawFirst.trim());
      const cleanLast = sanitizeInput(rawLast.trim());
      const cleanEmail = sanitizeInput((f.get('email') || '').trim());
      const rawPassword = f.get('password') || '';
      const cleanPhone = sanitizeInput((f.get('phone') || '').trim().replace(/[^0-9]/g, ''));
      const cleanBirthday = sanitizeInput((f.get('birthday') || '').trim());
      const cleanSchool = sanitizeInput((f.get('school') || '').trim());
      const cleanExamYear = sanitizeInput((f.get('examYear') || '').trim());

      if (!cleanEmail || !rawPassword) {
        throw new Error('Email and Password are required.');
      }
      if (cleanPhone && cleanPhone.length !== 10) {
        throw new Error('Please enter a valid 10-digit phone number (e.g., 07XXXXXXXX).');
      }

      const displayName = [cleanFirst, cleanLast].filter(Boolean).join(' ');
      const pendingId = Date.now().toString() + Math.random().toString();
      localStorage.setItem('pendingSessionId', pendingId);
      setCookie('pendingSessionId', pendingId);
      const cred = await createUserWithEmailAndPassword(auth, cleanEmail, rawPassword);
      const profileUpdate = { displayName };
      if (photoURL) profileUpdate.photoURL = photoURL;
      await updateProfile(cred.user, profileUpdate);
      const userDocData = {
        firstName: cleanFirst,
        lastName: cleanLast,
        email: cleanEmail,
        phone: cleanPhone,
        birthday: cleanBirthday,
        school: cleanSchool,
        examYear: cleanExamYear,
        createdAt: new Date().toISOString()
      };
      if (photoURL) userDocData.photoURL = photoURL;
      await setDoc(doc(db, 'users', cred.user.uid), userDocData);
      navigate('/home');
    } catch (err) { 
      alert(err.message); 
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  };

  // Google Sign Up
  document.getElementById('google-signup').onclick = async () => {
    try {
      const pendingId = Date.now().toString() + Math.random().toString();
      localStorage.setItem('pendingSessionId', pendingId);
      setCookie('pendingSessionId', pendingId);
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      const u = result.user;
      const ref = doc(db, 'users', u.uid);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        const nameParts = (u.displayName || 'User').split(' ');
        const firstName = sanitizeInput(nameParts[0] || 'User');
        const lastName = sanitizeInput(nameParts.length > 1 ? nameParts.slice(1).join(' ') : '');
        await setDoc(ref, {
          firstName: firstName,
          lastName: lastName,
          email: sanitizeInput(u.email || ''),
          photoURL: sanitizeUrl(u.photoURL || ''),
          examYear: '2026 A/L',
          createdAt: new Date().toISOString()
        });
      }

      navigate('/home');
    } catch (err) {
      alert(err.message);
    }
  };

  startAuthCountdownTimer();
}

// --- Reset Password Page ---
export function renderResetPassword(navigate) {
  headerElement.style.display = 'none';
  document.body.classList.add('auth-page-mode');

  // Parse reset code (oobCode) from URL search parameters or hash
  const urlParams = new URLSearchParams(window.location.search);
  let oobCode = urlParams.get('oobCode') || urlParams.get('code');
  if (!oobCode && window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#\/?/, ''));
    oobCode = hashParams.get('oobCode') || hashParams.get('code');
  }

  // Base shell with ambient glow and responsive layout
  const renderResetShell = (cardContent) => {
    appContainer.innerHTML = `
      <div class="min-h-[85vh] w-full flex items-center justify-center p-4 md:p-8 lg:p-12 relative overflow-hidden">
        <!-- Background Ambient Aurora Glows -->
        <div class="aurora-orb w-96 h-96 bg-indigo-600/20 -top-20 -left-20 pointer-events-none"></div>
        <div class="aurora-orb w-96 h-96 bg-cyan-500/15 -bottom-20 -right-20 pointer-events-none" style="animation-delay: -4s;"></div>

        <div class="w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-center relative z-10">
          <!-- Left Hero Panel (Desktop) -->
          ${getAuthHeroHTML()}

          <!-- Right Action Card -->
          <div class="lg:col-span-6 w-full max-w-md mx-auto">
            <div class="neo-glass-auth rounded-3xl p-6 md:p-8 relative border border-indigo-500/25 shadow-2xl overflow-hidden">
              <div class="hidden md:block absolute top-0 left-1/4 right-1/4 h-[2px] bg-gradient-to-r from-transparent via-indigo-400 to-transparent"></div>
              ${cardContent}
            </div>
          </div>
        </div>
      </div>
    `;
    startAuthCountdownTimer();
  };

  // Case 1: Missing oobCode
  if (!oobCode) {
    renderResetShell(`
      <div class="text-center py-4 space-y-4">
        <div class="w-16 h-16 mx-auto rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 text-2xl shadow-lg shadow-amber-500/10">
          ⚠️
        </div>
        <div class="space-y-1">
          <h2 class="text-xl font-bold font-display text-white">Invalid Reset Link</h2>
          <p class="text-xs text-slate-400 leading-relaxed">
            මුරපදය reset කිරීමේ කේතයක් (oobCode) හමු නොවීය. කරුණාකර Login පිටුවෙන් නැවත මුරපදය reset කිරීමට ඉල්ලුම් කරන්න.
          </p>
          <p class="text-[11px] text-slate-500">
            No password reset code found in this URL. Please request a new link from the login page.
          </p>
        </div>
        <button type="button" id="back-to-login-btn" class="w-full btn-auth-gradient py-3.5 rounded-xl font-bold text-white shadow-xl text-xs tracking-wide">
          Back to Sign In (නැවත පිවිසෙන්න)
        </button>
      </div>
    `);
    const backBtn = document.getElementById('back-to-login-btn');
    if (backBtn) backBtn.onclick = () => navigate('/login');
    return;
  }

  // Case 2: Verifying oobCode
  renderResetShell(`
    <div class="text-center py-8 space-y-4">
      <div class="w-16 h-16 mx-auto rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shadow-lg shadow-indigo-500/10">
        <svg class="animate-spin w-8 h-8" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
      </div>
      <div>
        <h2 class="text-lg font-bold font-display text-white">Verifying Reset Link...</h2>
        <p class="text-xs text-slate-400">කරුණාකර රැඳී සිටින්න, ආරක්ෂක කේතය පරීක්ෂා කෙරේ...</p>
      </div>
    </div>
  `);

  // Verify the code with Firebase Auth
  verifyPasswordResetCode(auth, oobCode)
    .then((userEmail) => {
      // Code is valid! Render password reset form
      renderResetShell(`
        <!-- Brand Header -->
        <div class="flex items-center justify-between mb-5">
          <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-2xl bg-white p-1.5 shadow-md shadow-indigo-500/20 flex-shrink-0">
              <img src="/icon.png" alt="StudyTracker Logo" class="w-full h-full object-contain">
            </div>
            <div>
              <h1 class="text-xl font-bold font-display text-white">Reset Password 🔑</h1>
              <p class="text-xs text-slate-400 truncate max-w-[210px]" title="${escapeHTML(userEmail || '')}">For: <span class="text-indigo-400 font-semibold">${escapeHTML(userEmail || '')}</span></p>
            </div>
          </div>
          <span class="text-[10px] px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            Verified
          </span>
        </div>

        <form id="new-password-form" class="space-y-4" action="javascript:void(0);" method="POST">
          <!-- New Password Input -->
          <div class="space-y-1.5 text-left">
            <label class="text-xs font-semibold text-slate-300 flex items-center justify-between">
              <span>New Password</span>
              <span class="text-[10px] text-slate-500">Min 6 characters</span>
            </label>
            <div class="modern-auth-input-box">
              <input type="password" id="reset-new-password" name="newPassword" placeholder="••••••••••••" class="modern-auth-input pr-12" required autocomplete="new-password">
              <svg class="auth-input-icon w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
              </svg>
              <button type="button" id="toggle-reset-new-pass" class="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors p-1" title="Show/Hide Password">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                </svg>
              </button>
            </div>
            <!-- Strength Indicator -->
            <div class="space-y-1 pt-1">
              <div class="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                <div id="reset-strength-bar" class="h-full w-0 transition-all duration-300"></div>
              </div>
              <div class="flex justify-between items-center text-[10px]">
                <span class="text-slate-500">Security:</span>
                <span id="reset-strength-text" class="text-slate-500">Enter a password</span>
              </div>
            </div>
          </div>

          <!-- Confirm Password Input -->
          <div class="space-y-1.5 text-left">
            <label class="text-xs font-semibold text-slate-300">Confirm New Password</label>
            <div class="modern-auth-input-box">
              <input type="password" id="reset-confirm-password" name="confirmPassword" placeholder="••••••••••••" class="modern-auth-input pr-12" required autocomplete="new-password">
              <svg class="auth-input-icon w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
              </svg>
              <button type="button" id="toggle-reset-confirm-pass" class="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors p-1" title="Show/Hide Password">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                </svg>
              </button>
            </div>
            <div id="reset-match-feedback" class="text-[10px] text-slate-500 pt-0.5"></div>
          </div>

          <!-- Submit Button -->
          <button type="submit" id="reset-submit-btn" class="w-full btn-auth-gradient py-3.5 rounded-xl font-bold text-white shadow-xl flex items-center justify-center gap-2 text-sm tracking-wide mt-2">
            <span>Update Password</span>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
            </svg>
          </button>
        </form>

        <div class="mt-6 pt-4 border-t border-slate-800 text-center">
          <p class="text-xs text-slate-400">
            Remember your credentials? 
            <button type="button" id="cancel-reset-btn" class="text-indigo-400 hover:text-indigo-300 font-semibold underline underline-offset-4 ml-1">
              Sign In
            </button>
          </p>
        </div>
      `);

      // Wire up password visibility toggle
      const newPassInput = document.getElementById('reset-new-password');
      const confirmPassInput = document.getElementById('reset-confirm-password');
      const toggleNewBtn = document.getElementById('toggle-reset-new-pass');
      const toggleConfirmBtn = document.getElementById('toggle-reset-confirm-pass');
      const strengthBar = document.getElementById('reset-strength-bar');
      const strengthText = document.getElementById('reset-strength-text');
      const matchFeedback = document.getElementById('reset-match-feedback');
      const cancelBtn = document.getElementById('cancel-reset-btn');

      if (cancelBtn) cancelBtn.onclick = () => navigate('/login');

      if (toggleNewBtn && newPassInput) {
        toggleNewBtn.onclick = () => {
          newPassInput.type = newPassInput.type === 'password' ? 'text' : 'password';
        };
      }
      if (toggleConfirmBtn && confirmPassInput) {
        toggleConfirmBtn.onclick = () => {
          confirmPassInput.type = confirmPassInput.type === 'password' ? 'text' : 'password';
        };
      }

      // Live password strength calculation
      if (newPassInput && strengthBar && strengthText) {
        newPassInput.oninput = (e) => {
          const val = e.target.value;
          if (!val) {
            strengthBar.style.width = '0%';
            strengthText.className = 'text-slate-500';
            strengthText.textContent = 'Enter a password';
          } else if (val.length < 6) {
            strengthBar.style.width = '25%';
            strengthBar.className = 'h-full bg-rose-500 rounded-full transition-all duration-300';
            strengthText.className = 'text-rose-400 font-bold';
            strengthText.textContent = 'Too Short (Min 6 chars)';
          } else if (val.length < 8) {
            strengthBar.style.width = '55%';
            strengthBar.className = 'h-full bg-amber-400 rounded-full transition-all duration-300';
            strengthText.className = 'text-amber-400 font-bold';
            strengthText.textContent = 'Medium (Add symbols/numbers)';
          } else {
            strengthBar.style.width = '100%';
            strengthBar.className = 'h-full bg-emerald-400 rounded-full transition-all duration-300';
            strengthText.className = 'text-emerald-400 font-bold';
            strengthText.textContent = 'Strong Password ✓';
          }

          if (confirmPassInput && confirmPassInput.value) {
            checkMatch();
          }
        };
      }

      const checkMatch = () => {
        if (!confirmPassInput || !matchFeedback) return;
        if (!confirmPassInput.value) {
          matchFeedback.textContent = '';
          return;
        }
        if (newPassInput && newPassInput.value === confirmPassInput.value) {
          matchFeedback.className = 'text-[10px] text-emerald-400 font-semibold pt-0.5';
          matchFeedback.textContent = 'Passwords match ✓';
        } else {
          matchFeedback.className = 'text-[10px] text-rose-400 font-semibold pt-0.5';
          matchFeedback.textContent = 'Passwords do not match ✗';
        }
      };

      if (confirmPassInput) {
        confirmPassInput.oninput = checkMatch;
      }

      // Password Reset Form Submit
      const resetForm = document.getElementById('new-password-form');
      if (resetForm) {
        resetForm.onsubmit = async (e) => {
          e.preventDefault();
          const newPassword = newPassInput ? newPassInput.value : '';
          const confirmPassword = confirmPassInput ? confirmPassInput.value : '';

          if (!newPassword || newPassword.length < 6) {
            alert("Password must be at least 6 characters long.\nමුරපදය අවම වශයෙන් අකුරු/ඉලක්කම් 6ක් විය යුතුය.");
            if (newPassInput) newPassInput.focus();
            return;
          }

          if (newPassword !== confirmPassword) {
            alert("Passwords do not match. Please re-enter.\nමුරපද දෙක නොගැලපේ. කරුණාකර නැවත පරීක්ෂා කරන්න.");
            if (confirmPassInput) confirmPassInput.focus();
            return;
          }

          const submitBtn = document.getElementById('reset-submit-btn');
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = `
              <svg class="animate-spin w-4 h-4 text-white" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              <span>Updating Password...</span>
            `;
          }

          try {
            await confirmPasswordReset(auth, oobCode, newPassword);

            // Trigger confetti
            if (typeof confetti === 'function') {
              confetti({
                particleCount: 100,
                spread: 70,
                origin: { y: 0.6 }
              });
            }

            // Render Success Screen
            renderResetShell(`
              <div class="text-center py-6 space-y-5">
                <div class="w-16 h-16 mx-auto rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 text-3xl shadow-lg shadow-emerald-500/20">
                  ✓
                </div>
                <div class="space-y-1.5">
                  <h2 class="text-xl font-bold font-display text-white">Password Updated! 🎉</h2>
                  <p class="text-xs text-slate-300 leading-relaxed">
                    Your password has been successfully changed.<br>
                    <span class="text-slate-400">ඔබගේ මුරපදය සාර්ථකව වෙනස් කරන ලදී. දැන් ඔබට නව මුරපදය මඟින් Login විය හැක.</span>
                  </p>
                </div>

                <div class="p-3 rounded-xl bg-slate-900/80 border border-white/5 text-xs text-slate-400">
                  Redirecting to Sign In in <span id="redirect-timer" class="text-indigo-400 font-bold">4</span>s...
                </div>

                <button type="button" id="go-login-now-btn" class="w-full btn-auth-gradient py-3.5 rounded-xl font-bold text-white shadow-xl text-sm tracking-wide">
                  Sign In Now (දැන් Login වන්න)
                </button>
              </div>
            `);

            let count = 4;
            const timerElem = document.getElementById('redirect-timer');
            const countdown = setInterval(() => {
              count--;
              if (timerElem) timerElem.textContent = count;
              if (count <= 0) {
                clearInterval(countdown);
                navigate('/login');
              }
            }, 1000);

            const goLoginBtn = document.getElementById('go-login-now-btn');
            if (goLoginBtn) {
              goLoginBtn.onclick = () => {
                clearInterval(countdown);
                navigate('/login');
              };
            }
          } catch (err) {
            console.error("confirmPasswordReset error:", err);
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.innerHTML = `<span>Update Password</span><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
            }
            if (err.code === 'auth/expired-action-code') {
              alert("This reset link has expired. Please request a new one.\nමෙම ලින්ක් එක කල් ඉකුත් වී ඇත. කරුණාකර නැවත ඉල්ලුම් කරන්න.");
              navigate('/login');
            } else if (err.code === 'auth/invalid-action-code') {
              alert("This reset code is invalid or has already been used.\nමෙම කේතය වලංගු නැත හෝ දැනටමත් භාවිතා කර ඇත.");
              navigate('/login');
            } else if (err.code === 'auth/weak-password') {
              alert("The password is too weak. Please choose a stronger password.\nමුරපදය ප්‍රමාණවත් තරම් ශක්තිමත් නැත. වඩා ශක්තිමත් මුරපදයක් ඇතුළත් කරන්න.");
            } else {
              alert(err.message || "Failed to reset password. Please try again.");
            }
          }
        };
      }
    })
    .catch((err) => {
      console.error("verifyPasswordResetCode error:", err);
      renderResetShell(`
        <div class="text-center py-5 space-y-4">
          <div class="w-16 h-16 mx-auto rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 text-3xl shadow-lg shadow-rose-500/10">
            ⚠️
          </div>
          <div class="space-y-1.5">
            <h2 class="text-lg font-bold font-display text-white">Reset Link Expired or Invalid</h2>
            <p class="text-xs text-slate-400 leading-relaxed">
              මෙම මුරපද යළි පිහිටුවීමේ ලින්ක් එක වලංගු නැත හෝ කල් ඉකුත් වී ඇත (දැනටමත් භාවිතා කර තිබිය හැක).
            </p>
            <p class="text-[11px] text-slate-500">
              The reset code is invalid or has expired. Please request a new link.
            </p>
          </div>
          <button type="button" id="request-new-link-btn" class="w-full btn-auth-gradient py-3.5 rounded-xl font-bold text-white shadow-xl text-xs tracking-wide">
            Request New Link (නව ලින්ක් එකක් ඉල්ලුම් කරන්න)
          </button>
        </div>
      `);
      const reqBtn = document.getElementById('request-new-link-btn');
      if (reqBtn) reqBtn.onclick = () => navigate('/login');
    });
}

// --- Dashboard ---
export async function renderHome(user) {
  document.body.classList.remove('auth-page-mode');
  if (window.authCountdownInterval) {
    clearInterval(window.authCountdownInterval);
    window.authCountdownInterval = null;
  }
  let dailyGoal = 4;
  try {
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    if (userDoc.exists()) {
        const d = userDoc.data();
        if (d.dailyGoal) dailyGoal = d.dailyGoal;
    }
  } catch (e) { console.error(e); }

  appContainer.innerHTML = `
        <div class="max-w-7xl mx-auto pt-8 pb-12">
            <!-- Exam Countdown Card -->
            <div class="mb-8 p-4 sm:p-6 rounded-2xl bg-gradient-to-r from-indigo-950/70 via-slate-900/80 to-purple-950/70 border border-indigo-500/20 shadow-xl shadow-indigo-950/20 relative overflow-hidden flex flex-col md:flex-row items-center justify-between gap-6">
                <!-- Decorative absolute glowing shapes -->
                <div class="absolute -right-20 -top-20 w-60 h-60 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>
                <div class="absolute -left-20 -bottom-20 w-60 h-60 bg-purple-500/10 rounded-full blur-3xl pointer-events-none"></div>
                
                <div class="flex items-center gap-4 relative z-10 w-full md:w-auto justify-start">
                    <div class="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-2xl shadow-inner shrink-0">
                        ⏳
                    </div>
                    <div>
                        <h2 class="text-xs uppercase tracking-widest text-indigo-400 font-extrabold">Exam Countdown</h2>
                        <h3 class="text-lg sm:text-xl font-black text-[var(--text-primary)]">2027 A/L Exam</h3>
                        <p class="text-xs text-[var(--text-secondary)] mt-0.5">Target Date: August 3, 2027</p>
                        <!-- ========================================================================= -->
                        <!-- ===== EXAM TIMETABLE POPUP CODE - DISABLED ============================== -->
                        <!--
                        <button onclick="window.showExamTimetablePopup()" class="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 transition-all cursor-pointer">
                            📅 කාලසටහන (Timetable)
                        </button>
                        -->
                        <!-- ========================================================================= -->
                    </div>
                </div>

                <!-- Timer Blocks -->
                <div id="exam-countdown-timer" class="flex flex-wrap sm:flex-nowrap justify-center gap-2 sm:gap-4 relative z-10 w-full md:w-auto">
                    <div class="flex flex-col items-center flex-1 sm:flex-initial min-w-[56px] sm:min-w-[64px] p-2 bg-black/40 backdrop-blur-md rounded-xl border border-[var(--glass-border)]">
                        <span id="countdown-val-1" class="text-xl sm:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-b from-white to-indigo-200">00</span>
                        <span id="countdown-lbl-1" class="text-[9px] uppercase tracking-wider text-[var(--text-secondary)] font-bold mt-1">Months</span>
                    </div>
                    <div class="flex flex-col items-center flex-1 sm:flex-initial min-w-[56px] sm:min-w-[64px] p-2 bg-black/40 backdrop-blur-md rounded-xl border border-[var(--glass-border)]">
                        <span id="countdown-val-2" class="text-xl sm:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-b from-white to-indigo-200">00</span>
                        <span id="countdown-lbl-2" class="text-[9px] uppercase tracking-wider text-[var(--text-secondary)] font-bold mt-1">Weeks</span>
                    </div>
                    <div class="flex flex-col items-center flex-1 sm:flex-initial min-w-[56px] sm:min-w-[64px] p-2 bg-black/40 backdrop-blur-md rounded-xl border border-[var(--glass-border)]">
                        <span id="countdown-val-3" class="text-xl sm:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-b from-white to-indigo-200">00</span>
                        <span id="countdown-lbl-3" class="text-[9px] uppercase tracking-wider text-[var(--text-secondary)] font-bold mt-1">Days</span>
                    </div>
                    <div class="flex flex-col items-center flex-1 sm:flex-initial min-w-[56px] sm:min-w-[64px] p-2 bg-black/40 backdrop-blur-md rounded-xl border border-[var(--glass-border)]">
                        <span id="countdown-val-4" class="text-xl sm:text-3xl font-black text-rose-400">00</span>
                        <span id="countdown-lbl-4" class="text-[9px] uppercase tracking-wider text-rose-400/80 font-bold mt-1">Hours</span>
                    </div>
                </div>
            </div>

            <!-- Greeting & Quick Actions -->
            <div class="flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
                <div>
                    <h1 class="text-3xl font-bold text-[var(--text-primary)]">Hello, ${user.displayName?.split(' ')[0]}! 👋</h1>
                    <p class="text-[var(--text-secondary)]">Track your progress and stay consistent.</p>
                </div>
                <button onclick="openLogEntryModal()" class="btn-primary flex items-center gap-2">
                    <span class="text-xl">+</span> Log Study Time
                </button>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <!-- Main Stats Column -->
                <div class="lg:col-span-2 space-y-8">
                    <!-- Weekly Chart -->
                    <div class="smart-card">
                         <div class="flex justify-between items-center mb-6">
                            <h3 class="font-bold text-[var(--text-primary)]">Weekly Performance 📊</h3>
                            <select id="chart-duration" class="bg-[var(--bg-root)] text-sm text-[var(--text-primary)] border border-[var(--glass-border)] rounded-lg px-3 py-1 outline-none cursor-pointer">
                                <option value="7">Last 7 Days</option>
                                <option value="14">Last 14 Days</option>
                            </select>
                        </div>
                        <div class="h-64"><canvas id="weekly-chart"></canvas></div>
                    </div>

                    <!-- Monthly Chart -->
                    <div class="smart-card">
                         <div class="flex justify-between items-center mb-6">
                            <h3 class="font-bold text-[var(--text-primary)]">Monthly Overview 📅</h3>
                            <span class="text-xs text-[var(--text-secondary)]">Total hours per month</span>
                        </div>
                        <div class="h-64"><canvas id="monthly-chart"></canvas></div>
                    </div>
                </div>

                <!-- Side Panel -->
                <div class="space-y-6">
                    <!-- Daily Goal Widget -->
                    <div class="smart-card text-center relative">
                        <div class="flex justify-between items-center mb-2">
                            <h3 class="text-sm font-bold text-[var(--text-secondary)] uppercase">Daily Goal</h3>
                            <button onclick="editDailyGoal(${dailyGoal})" class="text-indigo-400 hover:text-indigo-300 transition-colors p-2 bg-indigo-500/10 rounded-lg" title="Edit Daily Goal">
                                <span class="text-lg">✏️</span>
                            </button>
                        </div>
                         <div class="relative w-40 h-40 mx-auto flex items-center justify-center">
                            <svg class="w-full h-full transform -rotate-90">
                                <circle cx="80" cy="80" r="70" stroke="currentColor" stroke-width="10" fill="transparent" class="text-[var(--bg-root)]" />
                                <circle id="goal-ring" cx="80" cy="80" r="70" stroke="currentColor" stroke-width="10" fill="transparent" class="text-indigo-500 transition-all duration-1000" stroke-dasharray="439.8" stroke-dashoffset="439.8" stroke-linecap="round" />
                            </svg>
                            <div class="absolute inset-0 flex flex-col items-center justify-center">
                                <span id="today-hours" class="text-4xl font-bold text-[var(--text-primary)]">0</span>
                                <span class="text-sm text-[var(--text-secondary)]">of ${dailyGoal}h</span>
                            </div>
                        </div>
                        <p id="goal-msg" class="text-sm text-[var(--text-secondary)] mt-4">Keep pushing!</p>
                    </div>

                    <!-- Quick Links -->
                    <div class="smart-card">
                        <h3 class="text-sm font-bold text-[var(--text-secondary)] uppercase mb-4">Quick Access</h3>
                        <div class="grid grid-cols-2 gap-3">
                             <button onclick="navigateTo('/timetable')" class="flex flex-col items-center p-4 rounded-xl bg-[var(--bg-root)] hover:bg-[var(--glass-border)] transition-colors border border-[var(--glass-border)]">
                                <span class="text-3xl mb-2">📅</span>
                                <span class="font-bold text-sm text-[var(--text-primary)]">Schedule</span>
                             </button>
                             <button onclick="navigateTo('/recordings')" class="lecture-highlight flex flex-col items-center p-4 rounded-xl transition-all duration-300 border-2">
                                <span class="text-3xl mb-2">🎥</span>
                                <span class="font-bold text-sm">Lectures</span>
                             </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

  // Initialize logic
  let currentDuration = 7;
  const durationSelect = document.getElementById('chart-duration');

  const updateCharts = () => renderCharts(user.uid, dailyGoal, currentDuration);

  durationSelect.onchange = (e) => {
    currentDuration = parseInt(e.target.value);
    updateCharts();
  };

  updateCharts();

  // Initialize Exam Countdown Timer (August 3, 2027)
  if (window.examCountdownInterval) {
    clearInterval(window.examCountdownInterval);
    window.examCountdownInterval = null;
  }

  const updateExamCountdown = () => {
    const val1 = document.getElementById('countdown-val-1');
    const lbl1 = document.getElementById('countdown-lbl-1');
    const val2 = document.getElementById('countdown-val-2');
    const lbl2 = document.getElementById('countdown-lbl-2');
    const val3 = document.getElementById('countdown-val-3');
    const lbl3 = document.getElementById('countdown-lbl-3');
    const val4 = document.getElementById('countdown-val-4');
    const lbl4 = document.getElementById('countdown-lbl-4');

    if (!val1 || !val2 || !val3 || !val4 || !lbl1 || !lbl2 || !lbl3 || !lbl4) {
      if (window.examCountdownInterval) {
        clearInterval(window.examCountdownInterval);
        window.examCountdownInterval = null;
      }
      return;
    }

    const data = getExamCountdownData();
    val1.textContent = data.v1;
    lbl1.textContent = data.l1;
    val2.textContent = data.v2;
    lbl2.textContent = data.l2;
    val3.textContent = data.v3;
    lbl3.textContent = data.l3;
    val4.textContent = data.v4;
    lbl4.textContent = data.l4;

    if (data.isExpired && window.examCountdownInterval) {
      clearInterval(window.examCountdownInterval);
      window.examCountdownInterval = null;
    }
  };

  updateExamCountdown();
  window.examCountdownInterval = setInterval(updateExamCountdown, 1000);

  // -- Floating Functions for Window Scope --
  window.editDailyGoal = async (current) => {
    const rawGoal = prompt("Set new daily goal (hours):", current);
    if (rawGoal !== null) {
      const cleanGoal = sanitizeInput(String(rawGoal).trim());
      const num = Number(cleanGoal);
      if (!isNaN(num) && num >= 0 && num <= 24) {
        await setDoc(doc(db, 'users', user.uid), { dailyGoal: num }, { merge: true });
        renderHome(user); // refresh
      } else {
        alert("Please enter a valid study goal between 0 and 24 hours.");
      }
    }
  };

  window.openLogEntryModal = () => {
    showFloatingModal(`
            <h3 class="text-xl font-bold text-[var(--text-primary)] mb-4">Log Study Session</h3>
            <form id="log-form" class="grid gap-4">
                <input type="date" name="date" value="${getLocalDateString()}" class="smart-input">
                <input type="number" name="hours" placeholder="Hours (e.g. 2.5)" step="0.1" max="24" class="smart-input" required>
                <button class="btn-primary w-full py-3 rounded-xl">Save Entry</button>
            </form>
        `);
    document.getElementById('log-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const date = sanitizeInput((f.date.value || '').trim());
      const rawHours = Number(f.hours.value);
      const hours = isNaN(rawHours) || rawHours < 0 ? 0 : Math.min(rawHours, 24);

      const q = query(collection(db, 'studyLogs'), where('userId', '==', user.uid), where('date', '==', date));
      const s = await getDocs(q);
      if (!s.empty) await updateDoc(doc(db, 'studyLogs', s.docs[0].id), { hours });
      else await addDoc(collection(db, 'studyLogs'), { userId: user.uid, date, hours, createdAt: new Date().toISOString() });

      closeFloatingModal();
      renderHome(user);
    };
  };
}


let weeklyChartInstance = null;
let monthlyChartInstance = null;

async function renderCharts(uid, dailyGoal, days) {
  const q = query(collection(db, 'studyLogs'), where('userId', '==', uid));
  const snap = await getDocs(q);
  const data = snap.docs.map(d => d.data());

  const today = new Date();

  // --- Daily Goal Ring Logic ---
  const todayStr = getLocalDateString(today);
  const todayLog = data.find(x => x.date === todayStr);
  const todayHours = todayLog ? todayLog.hours : 0;

  const ring = document.getElementById('goal-ring');
  const todayText = document.getElementById('today-hours');
  if (ring && todayText) {
    todayText.textContent = todayHours;
    const pct = Math.min(todayHours / dailyGoal, 1);
    const dash = 439.8;
    const offset = dash - (dash * pct);
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = pct >= 1 ? 'var(--success)' : 'var(--primary)';
    document.getElementById('goal-msg').textContent = pct >= 1 ? "Goal Reached! 🎉" : `${(dailyGoal - todayHours).toFixed(1)}h remaining`;
  }

  // --- Weekly Line Chart Data ---
  const wLabels = [];
  const wValues = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);
    const ds = getLocalDateString(d);
    wLabels.push(d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }));
    const entry = data.find(x => x.date === ds);
    wValues.push(entry ? entry.hours : 0);
  }

  // --- Monthly Bar Chart Data ---
  const mData = {};
  data.forEach(d => {
    const k = d.date.slice(0, 7); // YYYY-MM
    mData[k] = (mData[k] || 0) + d.hours;
  });
  const mLabels = Object.keys(mData).sort();
  const mValues = mLabels.map(k => mData[k]);


  // --- Render Weekly ---
  const ctxW = document.getElementById('weekly-chart');
  if (ctxW) {
    if (weeklyChartInstance) weeklyChartInstance.destroy();
    weeklyChartInstance = new Chart(ctxW.getContext('2d'), {
      type: 'line',
      data: {
        labels: wLabels,
        datasets: [{
          label: 'Study Hours',
          data: wValues,
          borderColor: '#4f46e5',
          backgroundColor: 'rgba(79, 70, 229, 0.1)',
          borderWidth: 3,
          tension: 0.4,
          fill: true,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#4f46e5',
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(125,125,125,0.1)' } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  // --- Render Monthly ---
  const ctxM = document.getElementById('monthly-chart');
  if (ctxM) {
    if (monthlyChartInstance) monthlyChartInstance.destroy();
    monthlyChartInstance = new Chart(ctxM.getContext('2d'), {
      type: 'bar',
      data: {
        labels: mLabels,
        datasets: [{
          label: 'Total Hours',
          data: mValues,
          backgroundColor: '#06b6d4',
          borderRadius: 6,
          barPercentage: 0.6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(125,125,125,0.1)' } },
          x: { grid: { display: false } }
        }
      }
    });
  }
}

// --- Admin Panel (Enhanced with Real-time Stats) ---
export async function renderAdmin(user) {
  appContainer.innerHTML = `
        <div class="max-w-7xl mx-auto pt-8">
            <div class="flex flex-col md:flex-row justify-between items-center mb-6">
                <h2 class="text-3xl font-bold text-[var(--text-primary)]">Admin Console 🛠️</h2>
                <div class="flex gap-2 mt-4 md:mt-0 flex-wrap justify-end">
                    <button onclick="window.fixUserNames()" class="btn-ghost border border-[var(--glass-border)] flex items-center gap-2" title="Fix First/Last Names in DB">
                        <span>🔧</span> Names
                    </button>
                    <button onclick="window.openEmailRequestsModal()" class="btn-ghost border border-[var(--glass-border)] flex items-center gap-2">
                        <span>📧</span> Requests
                    </button>
                    <button onclick="window.openContactMessagesModal()" class="btn-ghost border border-[var(--glass-border)] flex items-center gap-2 text-cyan-400 hover:text-cyan-300">
                        <span>💬</span> Messages
                    </button>
                    <button onclick="window.openBroadcastModal()" class="btn-primary flex items-center gap-2">
                        <span>📢</span> Broadcast
                    </button>
                    <button onclick="window.openGlobalPopupModal()" class="btn-primary bg-emerald-600 hover:bg-emerald-700 flex items-center gap-2">
                        <span>📣</span> Global Pop-up
                    </button>
                    <button onclick="window.openVikumResourcesModal()" class="btn-primary bg-purple-600 hover:bg-purple-700 flex items-center gap-2">
                        <span>🔗</span> Vikum Link
                    </button>
                    <button onclick="window.openLectureHallPermissionsModal()" class="btn-primary bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 flex items-center gap-2 shadow-lg shadow-amber-600/25" title="Appoint users who can post Text + Links in Lecture Hall">
                        <span>📚</span> Lecture Hall Access
                    </button>
                </div>
            </div>
            
            <!-- Stats Cards -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                <div class="smart-card text-center cursor-pointer hover:border-indigo-500 transition-colors" id="active-users-card">
                    <h3 class="text-sm font-bold text-[var(--text-secondary)] uppercase mb-2">Active Users</h3>
                    <p id="active-users-count" class="text-4xl font-bold text-indigo-400">—</p>
                    <p class="text-xs text-[var(--text-secondary)] mt-1">Currently online (Click to view)</p>
                </div>
                <div class="smart-card text-center cursor-pointer hover:border-cyan-500 transition-colors" id="daily-logins-card">
                    <h3 class="text-sm font-bold text-[var(--text-secondary)] uppercase mb-2">Daily Logins</h3>
                    <p id="daily-logins-count" class="text-4xl font-bold text-cyan-400">—</p>
                    <p class="text-xs text-[var(--text-secondary)] mt-1">Today's unique visitors (Click to view)</p>
                </div>
                <div class="smart-card text-center">
                    <h3 class="text-sm font-bold text-[var(--text-secondary)] uppercase mb-2">Total Users</h3>
                    <p id="total-users-count" class="text-4xl font-bold text-emerald-400">—</p>
                    <p class="text-xs text-[var(--text-secondary)] mt-1">Registered accounts</p>
                </div>
            </div>
            
            <!-- Filters -->
            <div class="smart-card mb-6">
                <div class="flex flex-wrap gap-4 items-center mb-4">
                    <input id="search-term" placeholder="Search name/email/school..." class="smart-input flex-1 min-w-[200px]">
                    <select id="filter-batch" class="smart-input w-auto">
                        <option value="">All Batches</option>
                        <option value="2026 A/L">2026 A/L</option>
                        <option value="2027 A/L">2027 A/L</option>
                        <option value="2028 A/L">2028 A/L</option>
                        <option value="2029 A/L">2029 A/L</option>
                    </select>
                </div>
            </div>

            <div class="smart-card overflow-hidden p-0">
                <div class="overflow-x-auto">
                    <table class="smart-table">
                        <thead class="bg-[var(--bg-root)]">
                            <tr>
                                <th>Student</th>
                                <th>Email</th>
                                <th>School</th>
                                <th>Batch</th>
                                <th>Phone</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody id="user-table-body">
                            <tr><td colspan="6" class="text-center p-8">Loading...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

  // Fetch users and set up real-time listener
  const usersSnap = await getDocs(collection(db, 'users'));
  const allUsers = usersSnap.docs.map(dsc => ({ id: dsc.id, ...dsc.data() }));

  // Update total users count
  document.getElementById('total-users-count').textContent = allUsers.length;

  // Track daily logins (users who logged in today)
  const today = getLocalDateString();
  const dailyLoginQuery = query(
    collection(db, 'userActivity'),
    where('date', '==', today)
  );

  let currentDailyUsers = [];
  let currentActiveUsers = [];

  // Real-time listener for both Daily Logins and Active Users
  try {
    onSnapshot(dailyLoginQuery, (snapshot) => {
      currentDailyUsers = snapshot.docs.map(doc => doc.data());
      
      // 1. Daily Logins (Unique users who had any activity today)
      const uniqueDailyIds = new Set(currentDailyUsers.map(d => d.userId));
      document.getElementById('daily-logins-count').textContent = uniqueDailyIds.size || 0;

      // 2. Active Users (Users active within last 5 minutes)
      const updateActiveCount = () => {
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        currentActiveUsers = currentDailyUsers.filter(d => d.lastActive > fiveMinutesAgo);
        const uniqueActiveIds = new Set(currentActiveUsers.map(d => d.userId));
        document.getElementById('active-users-count').textContent = uniqueActiveIds.size || 0;
      };

      // Initial update
      updateActiveCount();

      // Periodically update active count as time passes (every 30s)
      if (window._adminStatsInterval) clearInterval(window._adminStatsInterval);
      window._adminStatsInterval = setInterval(updateActiveCount, 30000);
    }, (error) => {
      console.log('Activity query error:', error);
      document.getElementById('daily-logins-count').textContent = '0';
      document.getElementById('active-users-count').textContent = '0';
    });
  } catch (e) {
    document.getElementById('daily-logins-count').textContent = '0';
    document.getElementById('active-users-count').textContent = '0';
  }

  const showUsersListModal = (title, userIds, allUsersData) => {
      if(userIds.length === 0) {
          showFloatingModal(`<h3 class="text-xl font-bold mb-4">${title}</h3><p class="text-sm text-[var(--text-secondary)]">No users found.</p><button onclick="closeFloatingModal()" class="btn-ghost shadow-lg mt-6 w-full">Close</button>`);
          return;
      }
      
      const listHtml = userIds.map(uid => {
          const u = allUsersData.find(x => x.id === uid);
          if(!u) return '';
          const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unknown User';
          return `<div class="flex justify-between items-center bg-[var(--bg-root)] p-3 rounded-lg mb-2">
                     <div><p class="font-bold text-sm">${name}</p><p class="text-xs text-[var(--text-secondary)]">${u.email}</p></div>
                     <button onclick="viewUserDetail('${uid}')" class="btn-ghost text-xs border border-[var(--glass-border)] py-1 px-3">View</button>
                  </div>`;
      }).join('');
      
      showFloatingModal(`
          <div class="max-h-[60vh] flex flex-col">
              <h3 class="text-xl font-bold mb-4 text-[var(--text-primary)] border-b border-[var(--glass-border)] pb-2 flex justify-between items-center sticky top-0 bg-[var(--bg-secondary)] z-10 pr-10">
                  ${title} <span class="bg-indigo-500/20 text-indigo-400 text-xs px-2 py-1 rounded-full">${userIds.length}</span>
              </h3>
              <div class="overflow-y-auto flex-1 pr-2 mb-4 custom-scrollbar">
                  ${listHtml}
              </div>
              <button onclick="closeFloatingModal()" class="btn-secondary w-full py-2 shadow-lg mt-2">Close</button>
          </div>
      `);
  };

  window.openDailyLoginsModal = async (selectedDate) => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      const minDate = getLocalDateString(d);
      const todayDate = getLocalDateString();
      const dateToUse = selectedDate || todayDate;

      showFloatingModal(`
          <div class="max-h-[60vh] flex flex-col">
              <h3 class="text-xl font-bold mb-4 text-[var(--text-primary)] border-b border-[var(--glass-border)] pb-2 flex justify-between items-center sticky top-0 bg-[var(--bg-secondary)] z-10 pr-10">
                  Daily Logins
                  <input type="date" id="daily-login-date" class="smart-input text-sm py-1 px-2 w-auto border border-indigo-500/30" min="${minDate}" max="${todayDate}" value="${dateToUse}">
              </h3>
              <div id="daily-logins-list" class="overflow-y-auto flex-1 pr-2 mb-4 custom-scrollbar">
                  <p class="text-center text-sm text-[var(--text-secondary)] py-4">Loading...</p>
              </div>
              <button onclick="closeFloatingModal()" class="btn-secondary w-full py-2 shadow-lg mt-2">Close</button>
          </div>
      `);

      const loadData = async (date) => {
          const listContainer = document.getElementById('daily-logins-list');
          if(!listContainer) return;
          listContainer.innerHTML = '<p class="text-center text-sm text-[var(--text-secondary)] py-4">Loading...</p>';
          
          try {
              const q = query(collection(db, 'userActivity'), where('date', '==', date));
              const snap = await getDocs(q);
              const activities = snap.docs.map(doc => doc.data());
              
              if(activities.length === 0) {
                  listContainer.innerHTML = '<p class="text-sm text-[var(--text-secondary)] text-center py-4">No logins on this date.</p>';
                  return;
              }

              const listHtml = activities.map(act => {
                  const u = allUsers.find(x => x.id === act.userId);
                  if(!u) return '';
                  const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unknown User';
                  
                  let visitsHtml = '';
                  if(act.loginTimes && act.loginTimes.length > 0) {
                      visitsHtml = act.loginTimes.map(ts => `<span class="inline-block bg-indigo-500/10 text-indigo-400 text-[0.65rem] px-2 py-0.5 rounded mr-1 mb-1">${formatSLTime(ts)}</span>`).join('');
                  } else if (act.lastActive) {
                      visitsHtml = `<span class="inline-block bg-indigo-500/10 text-indigo-400 text-[0.65rem] px-2 py-0.5 rounded mr-1 mb-1">${formatSLTime(act.lastActive)}</span>`;
                  } else {
                      visitsHtml = '<span class="text-[0.65rem] opacity-50">Time not recorded</span>';
                  }

                  return `<div class="flex flex-col bg-[var(--bg-root)] p-3 rounded-lg mb-2">
                             <div class="flex justify-between items-start mb-2">
                                 <div><p class="font-bold text-sm text-[var(--text-primary)]">${name}</p><p class="text-xs text-[var(--text-secondary)]">${u.email}</p></div>
                                 <button onclick="viewUserDetail('${act.userId}')" class="btn-ghost text-[0.65rem] border border-[var(--glass-border)] py-1 px-2">Profile</button>
                             </div>
                             <div class="flex flex-wrap mt-1">
                                 <span class="text-[0.65rem] text-[var(--text-secondary)] mr-2 mt-0.5 uppercase font-bold">Visits:</span>
                                 ${visitsHtml}
                             </div>
                          </div>`;
              }).join('');
              
              listContainer.innerHTML = listHtml;
          } catch(e) {
              listContainer.innerHTML = '<p class="text-sm text-red-400 text-center py-4">Error loading data.</p>';
          }
      };

      await loadData(dateToUse);

      const dateInput = document.getElementById('daily-login-date');
      if(dateInput) {
          dateInput.onchange = (e) => loadData(e.target.value);
      }
  };

  document.getElementById('daily-logins-card').onclick = () => {
      window.openDailyLoginsModal(getLocalDateString());
  };

  document.getElementById('active-users-card').onclick = () => {
      const uniqueActiveIds = [...new Set(currentActiveUsers.map(d => d.userId))];
      showUsersListModal("Currently Online", uniqueActiveIds, allUsers);
  };

  const renderTable = (users) => {
    const tbody = document.getElementById('user-table-body');
    tbody.innerHTML = users.map(u => {
      const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'N/A';
      const isMod = u.role === 'moderator' || u.isModerator === true || NILANTHA_MODERATORS.includes(u.id) || RAVINDU_MODERATORS.includes(u.id);
      const isLectureEditor = u.canPostLectureHall === true || u.isLectureHallEditor === true;
      return `
            <tr>
                <td class="font-bold">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span>${displayName}</span>
                        ${isMod ? '<span class="badge-moderator">🛡️ MOD</span>' : ''}
                        ${isLectureEditor ? '<span class="badge-lecture-editor">📚 LECTURE EDITOR</span>' : ''}
                    </div>
                </td>
                <td class="text-sm text-[var(--text-secondary)]">${u.email}</td>
                <td>${u.school || '-'}</td>
                <td><span class="px-2 py-1 bg-indigo-500/10 text-indigo-400 rounded text-xs font-bold">${u.examYear || 'N/A'}</span></td>
                <td class="text-sm">${u.phone || '-'}</td>
                <td>
                    <div class="flex gap-2 flex-wrap">
                        <button onclick="viewUserDetail('${u.id}')" class="btn-ghost text-xs border border-[var(--glass-border)]">View</button>
                        <button onclick="openNotificationModal('${u.id}', '${displayName.replace(/'/g, "\\'")}')" class="btn-ghost text-xs border border-[var(--glass-border)] text-indigo-400">Notify</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
  };

  renderTable(allUsers);

  // Filtering Logic
  const filter = () => {
    const term = document.getElementById('search-term').value.toLowerCase();
    const batch = document.getElementById('filter-batch').value;
    const filtered = allUsers.filter(u => {
      const matchName = (u.firstName || '').toLowerCase().includes(term) || (u.lastName || '').toLowerCase().includes(term) || (u.email || '').toLowerCase().includes(term) || (u.school || '').toLowerCase().includes(term);
      const matchBatch = batch ? u.examYear === batch : true;
      return matchName && matchBatch;
    });
    renderTable(filtered);
  };

  document.getElementById('search-term').oninput = filter;
  document.getElementById('filter-batch').onchange = filter;

  window.viewUserDetail = async (uid) => {
    const u = allUsers.find(x => x.id === uid);
    if (!u) return;

    // Fetch logs for mini chart
    const logQ = query(collection(db, 'studyLogs'), where('userId', '==', uid));
    const logSnap = await getDocs(logQ);
    const logs = logSnap.docs.map(d => d.data());
    const totalHours = logs.reduce((a, b) => a + b.hours, 0);

    const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'User Name';
    const isCurrentlyMod = u.role === 'moderator' || u.isModerator === true || NILANTHA_MODERATORS.includes(uid) || RAVINDU_MODERATORS.includes(uid);
    const isLectureEditor = u.canPostLectureHall === true || u.isLectureHallEditor === true;

    // Prepare 7-day chart data
    const wLabels = [];
    const wValues = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(today.getDate() - i);
        const ds = getLocalDateString(d);
        wLabels.push(d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }));
        const entry = logs.find(x => x.date === ds);
        wValues.push(entry ? entry.hours : 0);
    }

    // Prepare Monthly chart data
    const mData = {};
    logs.forEach(d => {
        const k = d.date.slice(0, 7); // YYYY-MM
        mData[k] = (mData[k] || 0) + d.hours;
    });
    const mLabels = Object.keys(mData).sort();
    const mValues = mLabels.map(k => mData[k]);

    showFloatingModal(`
            <div class="text-center w-full max-w-lg mx-auto">
                <div class="flex justify-between items-start mb-4">
                     <div class="w-16 h-16 rounded-full bg-slate-700 overflow-hidden border-2 border-indigo-500 shrink-0">
                          <img src="${u.photoURL || 'https://ui-avatars.com/api/?name=' + displayName.replace(/ /g, '+')}" class="w-full h-full object-cover">
                     </div>
                     <div class="text-left ml-4 flex-1">
                          <div class="flex items-center gap-2 flex-wrap">
                               <h3 class="text-xl font-bold text-[var(--text-primary)]">${displayName}</h3>
                               ${isCurrentlyMod ? '<span class="badge-moderator">🛡️ MODERATOR</span>' : ''}
                               ${isLectureEditor ? '<span class="badge-lecture-editor">📚 LECTURE EDITOR</span>' : ''}
                          </div>
                          <p class="text-sm text-[var(--text-secondary)]">${u.email}</p>
                     </div>
                </div>
                
                <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6 text-left bg-[var(--bg-root)] p-4 rounded-xl shadow-inner text-sm">
                    <div><p class="text-[0.65rem] text-[var(--text-secondary)] uppercase">Batch</p><p class="font-bold truncate" title="${u.examYear || '-'}">${u.examYear || '-'}</p></div>
                    <div><p class="text-[0.65rem] text-[var(--text-secondary)] uppercase">School</p><p class="font-bold truncate" title="${u.school || '-'}">${u.school || '-'}</p></div>
                    <div><p class="text-[0.65rem] text-[var(--text-secondary)] uppercase">Phone</p><p class="font-bold truncate" title="${u.phone || '-'}">${u.phone || '-'}</p></div>
                    <div><p class="text-[0.65rem] text-[var(--text-secondary)] uppercase">Birthday</p><p class="font-bold truncate" title="${u.birthday || '-'}">${u.birthday || '-'}</p></div>
                    <div><p class="text-[0.65rem] text-[var(--text-secondary)] uppercase">Joined</p><p class="font-bold truncate" title="${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</p></div>
                    <div><p class="text-[0.65rem] text-[var(--text-secondary)] uppercase">Total Study</p><p class="font-bold text-indigo-400">${totalHours} Hrs</p></div>
                </div>

                <div class="grid grid-cols-2 gap-4 mb-6">
                    <div class="bg-[var(--bg-root)] p-4 rounded-xl shadow-inner">
                        <h4 class="text-xs font-bold text-left text-[var(--text-secondary)] uppercase mb-2">Last 7 Days</h4>
                        <div class="h-32 w-full"><canvas id="admin-user-chart-weekly"></canvas></div>
                    </div>
                    <div class="bg-[var(--bg-root)] p-4 rounded-xl shadow-inner">
                        <h4 class="text-xs font-bold text-left text-[var(--text-secondary)] uppercase mb-2">Monthly</h4>
                        <div class="h-32 w-full"><canvas id="admin-user-chart-monthly"></canvas></div>
                    </div>
                </div>

                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                     <button onclick="closeFloatingModal()" class="btn-ghost w-full border border-[var(--glass-border)] hover:bg-[var(--glass-border)] text-xs">Close</button>
                     <button onclick="window.toggleUserModerator('${uid}', ${!isCurrentlyMod})" class="${isCurrentlyMod ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/40' : 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/40'} py-2 rounded-lg font-bold text-xs transition-colors cursor-pointer">
                         ${isCurrentlyMod ? 'Revoke Mod 🛡️' : 'Make Mod 🛡️'}
                     </button>
                     <button onclick="window.toggleLectureHallEditor('${uid}', ${!isLectureEditor})" class="${isLectureEditor ? 'bg-orange-500/20 text-orange-300 hover:bg-orange-500/30 border border-orange-500/40' : 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/40'} py-2 rounded-lg font-bold text-xs transition-colors cursor-pointer">
                         ${isLectureEditor ? 'Revoke Lecture 📚' : 'Grant Lecture 📚'}
                     </button>
                     <button onclick="window.deleteUser('${uid}')" class="bg-red-500/10 text-red-400 hover:bg-red-500/20 py-2 rounded-lg font-bold text-xs transition-colors cursor-pointer">Delete</button>
                </div>
            </div>
        `);

    setTimeout(() => {
        const ctxW = document.getElementById('admin-user-chart-weekly');
        if (ctxW) {
            new Chart(ctxW.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: wLabels,
                    datasets: [{ label: 'Hours', data: wValues, backgroundColor: '#4f46e5', borderRadius: 4 }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: 'rgba(125,125,125,0.1)' }, ticks: { font: { size: 10 } } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } }
                }
            });
        }
        const ctxM = document.getElementById('admin-user-chart-monthly');
        if (ctxM) {
            new Chart(ctxM.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: mLabels,
                    datasets: [{ label: 'Hours', data: mValues, backgroundColor: '#06b6d4', borderRadius: 4 }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: 'rgba(125,125,125,0.1)' }, ticks: { font: { size: 10 } } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } }
                }
            });
        }
    }, 100);
  };

  window.deleteUser = async (uid) => {
    if (confirm("Are you sure? This cannot be undone.")) {
      await deleteDoc(doc(db, 'users', uid));
      closeFloatingModal();
      renderAdmin(user);
    }
  };

  window.toggleUserModerator = async (uid, makeMod) => {
    const actionText = makeMod ? "appoint as Moderator" : "remove Moderator privileges from";
    if (!confirm(`Are you sure you want to ${actionText} this user?`)) return;
    try {
      const res = await setModeratorRole(uid, makeMod);
      if (res.success) {
        alert(makeMod ? "User appointed as Moderator successfully!" : "Moderator privileges removed successfully!");
        closeFloatingModal();
        renderAdmin(user);
      } else {
        alert("Failed to update role: " + res.error);
      }
    } catch(e) {
      alert("Error: " + e.message);
    }
  };

  window.toggleLectureHallEditor = async (uid, grant) => {
    const actionText = grant ? "grant Lecture Hall Text + Link posting access to" : "remove Lecture Hall posting access from";
    if (!confirm(`Are you sure you want to ${actionText} this user?`)) return;
    try {
      await updateDoc(doc(db, 'users', uid), {
        canPostLectureHall: grant,
        isLectureHallEditor: grant,
        updatedAt: Date.now()
      });

      try {
        const settingsRef = doc(db, 'settings', 'lecture_hall_permissions');
        const snap = await getDoc(settingsRef);
        let editors = snap.exists() && Array.isArray(snap.data().editors) ? snap.data().editors : [];
        if (grant) {
          if (!editors.includes(uid)) editors.push(uid);
        } else {
          editors = editors.filter(id => id !== uid);
        }
        await setDoc(settingsRef, { editors, updatedAt: Date.now() }, { merge: true });
      } catch (sErr) {
        console.warn("Settings sync warning:", sErr);
      }

      const targetUser = allUsers.find(u => u.id === uid);
      if (targetUser) {
        targetUser.canPostLectureHall = grant;
        targetUser.isLectureHallEditor = grant;
      }

      alert(grant ? "User granted Lecture Hall access successfully! 📚" : "User Lecture Hall access revoked successfully.");
      closeFloatingModal();
      if (document.getElementById('lecture-hall-permissions-modal')) {
        window.openLectureHallPermissionsModal();
      } else {
        renderAdmin(user);
      }
    } catch(e) {
      alert("Error: " + e.message);
    }
  };

  window.openLectureHallPermissionsModal = async () => {
    const existing = document.getElementById('lecture-hall-permissions-modal');
    if (existing) existing.remove();

    let currentUsers = allUsers;
    try {
      const snap = await getDocs(collection(db, 'users'));
      currentUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e) {
      console.warn("Using cached allUsers:", e);
    }

    const modal = document.createElement('div');
    modal.id = 'lecture-hall-permissions-modal';
    modal.className = 'fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in';
    
    function renderModalContent() {
      const contributors = currentUsers.filter(u => u.canPostLectureHall === true || u.isLectureHallEditor === true);

      modal.innerHTML = `
        <div class="bg-[var(--bg-secondary)] border border-amber-500/30 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <!-- Header -->
            <div class="flex items-center justify-between px-6 py-4 border-b border-[var(--glass-border)] bg-[var(--bg-root)] shrink-0">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white text-xl shadow-md">
                        📚
                    </div>
                    <div>
                        <h3 class="font-bold text-lg text-[var(--text-primary)]">Lecture Hall Access Management</h3>
                        <p class="text-xs text-[var(--text-secondary)]">Text & Links ඇතුලත් කිරීමට අවසර ඇති පුද්ගලයින් පත් කිරීම (Admin Only)</p>
                    </div>
                </div>
                <button type="button" id="lh-modal-close-btn" class="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-white/10 cursor-pointer">✕</button>
            </div>

            <!-- Content Area -->
            <div class="p-6 overflow-y-auto space-y-6 custom-scrollbar">
                <!-- Info Alert -->
                <div class="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200/90 leading-relaxed flex items-start gap-2.5">
                    <span class="text-base shrink-0">ℹ️</span>
                    <div>
                        <strong>Lecture Hall අවසර පාලනය:</strong> මෙහිදී පත් කරනු ලබන පරිශීලකයින්ට (Contributors) Lecture Hall 📚 තුළ ඇති Lessons වලට නව <strong>Video / Material Links</strong> සහ <strong>Titles</strong> ඇතුලත් කිරීමට, සංස්කරණය කිරීමට සහ කළමනාකරණය කිරීමට පමණක් විශේෂ අවසරය හිමිවේ.
                    </div>
                </div>

                <!-- Add New Contributor Section -->
                <div class="p-4 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)]">
                    <h4 class="text-xs uppercase font-bold text-amber-400 mb-3 flex items-center gap-1.5">
                        <span>➕</span> නව පුද්ගලයෙකු පත් කරන්න (Appoint New Contributor)
                    </h4>
                    <div class="flex flex-col sm:flex-row gap-2.5">
                        <div class="flex-1 relative">
                            <input 
                                id="lh-user-search-input" 
                                type="text" 
                                placeholder="Search student name or email..." 
                                class="smart-input w-full text-xs sm:text-sm"
                            >
                            <div id="lh-search-results" class="hidden absolute top-full left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-xl bg-[var(--bg-secondary)] border border-[var(--glass-border)] shadow-xl p-1 space-y-1"></div>
                        </div>
                    </div>
                </div>

                <!-- Current Appointed List -->
                <div>
                    <div class="flex items-center justify-between mb-3">
                        <h4 class="text-xs uppercase font-bold text-[var(--text-secondary)]">
                            දැනට පත් කර ඇති පුද්ගලයින් (${contributors.length})
                        </h4>
                    </div>

                    ${contributors.length === 0 ? `
                        <div class="p-8 text-center rounded-xl border border-dashed border-[var(--glass-border)] text-[var(--text-secondary)]">
                            <p class="text-3xl mb-2">🧑‍🏫</p>
                            <p class="text-sm font-semibold text-[var(--text-primary)]">වෙනම පත් කළ පුද්ගලයින් කිසිවෙකු නොමැත</p>
                            <p class="text-xs mt-1">ඉහත Search කොටුවෙන් සිසුවෙකු තෝරා 'Appoint' ක්ලික් කරන්න.</p>
                        </div>
                    ` : `
                        <div class="space-y-2.5">
                            ${contributors.map(u => {
                              const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unnamed User';
                              return `
                                <div class="p-3 sm:p-4 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] hover:border-amber-500/30 flex items-center justify-between gap-3 transition-all">
                                    <div class="flex items-center gap-3 min-w-0">
                                        <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-amber-600 to-orange-600 flex items-center justify-center font-bold text-white text-sm shrink-0 shadow-sm">
                                            ${(fullName || 'U').charAt(0).toUpperCase()}
                                        </div>
                                        <div class="min-w-0">
                                            <div class="flex items-center gap-1.5 flex-wrap">
                                                <p class="text-xs sm:text-sm font-bold text-[var(--text-primary)] truncate">${fullName}</p>
                                                <span class="badge-lecture-editor">📚 LECTURE EDITOR</span>
                                            </div>
                                            <p class="text-[11px] text-[var(--text-secondary)] truncate">${u.email || 'No email'}</p>
                                            <div class="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--text-secondary)]">
                                                <span>Batch: ${u.examYear || 'N/A'}</span>
                                                <span>•</span>
                                                <span>${u.school || 'School -'}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <button onclick="window.toggleLectureHallEditor('${u.id}', false)" class="btn-ghost py-1.5 px-3 rounded-lg text-xs font-bold text-red-400 hover:bg-red-500/10 border border-red-500/20 cursor-pointer shrink-0" title="Remove Lecture Hall Permission">
                                        Revoke ✕
                                    </button>
                                </div>
                              `;
                            }).join('')}
                        </div>
                    `}
                </div>
            </div>

            <!-- Footer -->
            <div class="px-6 py-3.5 border-t border-[var(--glass-border)] bg-[var(--bg-root)] flex justify-end shrink-0">
                <button type="button" id="lh-modal-done-btn" class="btn-primary py-2 px-5 text-xs font-bold rounded-xl cursor-pointer">
                    Done (අවසන් කරන්න)
                </button>
            </div>
        </div>
      `;

      modal.querySelector('#lh-modal-close-btn').onclick = () => modal.remove();
      modal.querySelector('#lh-modal-done-btn').onclick = () => modal.remove();

      // Search Handler
      const searchInput = modal.querySelector('#lh-user-search-input');
      const resultsContainer = modal.querySelector('#lh-search-results');

      searchInput.oninput = () => {
        const query = (searchInput.value || '').toLowerCase().trim();
        if (!query) {
          resultsContainer.classList.add('hidden');
          resultsContainer.innerHTML = '';
          return;
        }

        const matches = currentUsers.filter(u => {
          const name = [u.firstName, u.lastName].filter(Boolean).join(' ').toLowerCase();
          const email = (u.email || '').toLowerCase();
          return (name.includes(query) || email.includes(query)) && !u.canPostLectureHall;
        }).slice(0, 6);

        if (matches.length === 0) {
          resultsContainer.innerHTML = `<div class="p-3 text-center text-xs text-[var(--text-secondary)]">No eligible users found</div>`;
          resultsContainer.classList.remove('hidden');
          return;
        }

        resultsContainer.innerHTML = matches.map(m => {
          const mName = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email;
          return `
            <div class="p-2.5 rounded-lg hover:bg-white/10 flex items-center justify-between gap-2 cursor-pointer transition-colors" data-uid="${m.id}">
                <div class="min-w-0">
                    <p class="text-xs font-bold text-[var(--text-primary)] truncate">${mName}</p>
                    <p class="text-[10px] text-[var(--text-secondary)] truncate">${m.email} • ${m.examYear || 'Batch N/A'}</p>
                </div>
                <button type="button" class="btn-primary text-[11px] py-1 px-2.5 bg-amber-600 hover:bg-amber-500 rounded-lg shrink-0 font-bold">
                    Appoint ➕
                </button>
            </div>
          `;
        }).join('');

        resultsContainer.querySelectorAll('[data-uid]').forEach(el => {
          el.onclick = async () => {
            const uid = el.getAttribute('data-uid');
            resultsContainer.classList.add('hidden');
            searchInput.value = '';
            await window.toggleLectureHallEditor(uid, true);
          };
        });

        resultsContainer.classList.remove('hidden');
      };
    }

    renderModalContent();
    document.body.appendChild(modal);
  };

  window.fixUserNames = async () => {
    if(!confirm("Are you sure you want to fix all user names where First Name contains both First and Last names?")) return;
    let count = 0;
    try {
        for (const u of allUsers) {
            if (u.firstName && u.firstName.includes(' ') && (!u.lastName || u.lastName.trim() === '')) {
                const parts = u.firstName.trim().split(' ');
                const fName = parts[0];
                const lName = parts.slice(1).join(' ');
                await setDoc(doc(db, 'users', u.id), { firstName: fName, lastName: lName }, { merge: true });
                count++;
            }
        }
        alert(count === 0 ? "No users found needing a name fix." : `Successfully fixed ${count} users!`);
        renderAdmin(user);
    } catch(e) {
        alert("Failed: " + e.message);
    }
  };

  window.openNotificationModal = (uid, name) => {
    showFloatingModal(`
            <h3 class="text-xl font-bold text-[var(--text-primary)] mb-4">Send Alert to ${name} 🔔</h3>
            <form id="notification-form" class="space-y-4">
                <input name="title" placeholder="Title (e.g. Class Update)" class="smart-input" required>
                <textarea name="message" placeholder="Type your message here..." class="smart-input min-h-[100px]" required></textarea>
                <button type="submit" class="btn-primary w-full py-3">Send Notification</button>
            </form>
        `);

    document.getElementById('notification-form').onsubmit = async (e) => {
      e.preventDefault();
      const title = sanitizeInput((e.target.title.value || '').trim());
      const msg = sanitizeInput((e.target.message.value || '').trim());
      const success = await sendNotification(uid, title, msg);
      if (success === true) {
        alert("Notification sent successfully!");
        closeFloatingModal();
      } else {
        alert("Failed to send notification. Error: " + (success.message || "Unknown Error"));
      }
    };
  };

  window.openBroadcastModal = () => {
    showFloatingModal(`
            <h3 class="text-xl font-bold text-[var(--text-primary)] mb-4">Broadcast to ALL Users 📢</h3>
            <p class="text-red-400 text-sm mb-4">Warning: This will send a notification to every registered user.</p>
            <form id="broadcast-form" class="space-y-4">
                <input name="title" placeholder="Title (e.g. System Maintenance)" class="smart-input" required>
                <textarea name="message" placeholder="Type your message here..." class="smart-input min-h-[100px]" required></textarea>
                <button type="submit" class="btn-primary w-full py-3 bg-red-600 hover:bg-red-700">Send Broadcast</button>
            </form>
        `);

    document.getElementById('broadcast-form').onsubmit = async (e) => {
      e.preventDefault();
      if (!confirm("Are you surely want to send this to everyone?")) return;

      const title = sanitizeInput((e.target.title.value || '').trim());
      const msg = sanitizeInput((e.target.message.value || '').trim());

      const success = await broadcastNotification(title, msg);
      if (success) {
        alert("Broadcast sent successfully!");
        closeFloatingModal();
      } else {
        alert("Failed to send broadcast.");
      }
    };
  };

  window.openGlobalPopupModal = () => {
    showFloatingModal(`
            <h3 class="text-xl font-bold text-[var(--text-primary)] mb-4">Create Global Pop-up 📣</h3>
            <p class="text-[var(--text-secondary)] text-sm mb-4">This will show as a pop-up to ALL users on their next login. Users who dismiss it will not see it again.</p>
            <form id="global-popup-form" class="space-y-4">
                <input name="title" placeholder="Title (e.g. Happy New Year!)" class="smart-input" required>
                <textarea name="message" placeholder="Type your message here..." class="smart-input min-h-[100px]" required></textarea>
                <button type="submit" class="btn-primary w-full py-3 bg-emerald-600 hover:bg-emerald-700">Set Global Pop-up</button>
            </form>
        `);

    document.getElementById('global-popup-form').onsubmit = async (e) => {
      e.preventDefault();
      if (!confirm("Are you sure you want to set this as the new Global Pop-up?")) return;

      const title = sanitizeInput((e.target.title.value || '').trim());
      const msg = sanitizeInput((e.target.message.value || '').trim());

      try {
        await addDoc(collection(db, 'global_notifications'), {
          title: title,
          message: msg,
          timestamp: Date.now(),
          active: true
        });
        alert("Global Pop-up created successfully!");
        closeFloatingModal();
      } catch (err) {
        console.error("Error creating global popup:", err);
        alert("Failed to create Global Pop-up.");
      }
    };
  };

  window.openVikumResourcesModal = async () => {
    let currentLink = 'https://drive.google.com/drive/folders/1nQSEX2Q5cPhu-YsMpQUKWQuRh-0vqZ-G?usp=drive_link';
    try {
      const docRef = doc(db, 'settings', 'vikum_resources');
      const docSnap = await getDoc(docRef);
      if (docSnap.exists() && docSnap.data().link) {
        currentLink = docSnap.data().link;
      }
    } catch (e) {
      console.error(e);
    }

    showFloatingModal(`
        <h3 class="text-xl font-bold text-[var(--text-primary)] mb-4">Vikum Harshana Resources Link 🔗</h3>
        <p class="text-[var(--text-secondary)] text-sm mb-4">Update the Resources link for Vikum Harshana (Combine Maths Supportive).</p>
        <form id="vikum-resources-form" class="space-y-4">
            <input name="link" placeholder="Enter link (e.g. https://t.me/...)" class="smart-input" value="${currentLink}" required>
            <button type="submit" class="btn-primary w-full py-3 bg-purple-600 hover:bg-purple-700">Update Link</button>
        </form>
    `);

    document.getElementById('vikum-resources-form').onsubmit = async (e) => {
      e.preventDefault();
      const rawLink = (e.target.link.value || '').trim();
      const link = sanitizeUrl(rawLink);
      try {
        await setDoc(doc(db, 'settings', 'vikum_resources'), { link, updatedAt: Date.now() }, { merge: true });
        alert("Resources link updated successfully!");
        closeFloatingModal();
      } catch (err) {
        console.error("Error updating Vikum resources link:", err);
        alert("Failed to update link.");
      }
    };
  };

  window.openEmailRequestsModal = async () => {
      showFloatingModal(`<h3 class="text-xl font-bold mb-4">Loading Email Requests...</h3>`);
      
      try {
          const q = query(collection(db, 'emailRequests'), where('status', '==', 'pending'));
          const snap = await getDocs(q);
          
          if (snap.empty) {
              showFloatingModal(`
                  <h3 class="text-xl font-bold text-[var(--text-primary)] mb-4">Email Requests 📧</h3>
                  <p class="text-[var(--text-secondary)] py-8 text-center">No pending email change requests.</p>
                  <button onclick="closeFloatingModal()" class="btn-ghost w-full">Close</button>
              `);
              return;
          }
          
          const reqs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          
          const listHtml = reqs.map(r => `
              <div class="bg-[var(--bg-root)] p-4 rounded-xl border border-[var(--glass-border)] mb-3">
                  <p class="font-bold text-sm mb-1">${r.userName || 'Unknown User'}</p>
                  <p class="text-xs text-[var(--text-secondary)] mb-3">Current: <span class="text-[var(--text-primary)]">${r.currentEmail}</span> ➡️ New: <span class="text-indigo-400 font-bold">${r.newEmail}</span></p>
                  <div class="flex gap-2">
                      <button onclick="window.approveEmailReq('${r.id}')" class="btn-primary text-xs py-1 px-3 bg-emerald-500 hover:bg-emerald-600">Approve</button>
                      <button onclick="window.rejectEmailReq('${r.id}')" class="btn-ghost text-xs py-1 px-3 text-red-400 hover:bg-red-500/10 border-none">Reject</button>
                  </div>
              </div>
          `).join('');
          
          showFloatingModal(`
              <div class="max-h-[70vh] flex flex-col">
                  <h3 class="text-xl font-bold mb-4 text-[var(--text-primary)] flex justify-between items-center sticky top-0 bg-[var(--bg-secondary)] z-10 pb-2 border-b border-[var(--glass-border)]">
                      Email Requests 📧 <span class="bg-indigo-500/20 text-indigo-400 text-xs px-2 py-1 rounded-full">${reqs.length}</span>
                  </h3>
                  <div class="overflow-y-auto flex-1 pr-2 mb-4 custom-scrollbar">
                      ${listHtml}
                  </div>
                  <button onclick="closeFloatingModal()" class="btn-secondary w-full py-2 shadow-lg mt-2">Close</button>
              </div>
          `);
      } catch (error) {
          console.error("Error loading email requests:", error);
          showFloatingModal(`
              <h3 class="text-xl font-bold text-red-500 mb-4">Error</h3>
              <p class="text-[var(--text-secondary)] mb-4">Could not load email requests. Please check Firestore security rules for 'emailRequests' collection.</p>
              <button onclick="closeFloatingModal()" class="btn-ghost w-full">Close</button>
          `);
      }
  };

  window.approveEmailReq = async (id) => {
      if(!confirm("Approve this email change request?")) return;
      await updateDoc(doc(db, 'emailRequests', id), { status: 'approved' });
      window.openEmailRequestsModal(); // refresh
  };
  
  window.rejectEmailReq = async (id) => {
      if(!confirm("Reject this email change request?")) return;
      await updateDoc(doc(db, 'emailRequests', id), { status: 'rejected' });
      window.openEmailRequestsModal(); // refresh
  };

  // Contact Messages Admin View
  window.openContactMessagesModal = async () => {
      showFloatingModal(`
          <h3 class="text-xl font-bold text-[var(--text-primary)] mb-4 flex items-center gap-2"><span>💬</span> User Messages</h3>
          <div id="contact-messages-container" class="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
              <p class="text-center text-[var(--text-secondary)]">Loading messages...</p>
          </div>
          <button onclick="closeFloatingModal()" class="btn-ghost shadow-lg mt-6 w-full">Close</button>
      `);

      try {
          const q = query(collection(db, 'contactMessages'), orderBy('createdAt', 'desc'));
          const snap = await getDocs(q);
          const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));

          const container = document.getElementById('contact-messages-container');
          if (messages.length === 0) {
              container.innerHTML = '<p class="text-center text-[var(--text-secondary)] py-8">No contact messages found.</p>';
              return;
          }

          container.innerHTML = messages.map(msg => {
              // Extract digits only for wa.me link. Assume +94 if local 10 digit
              let waNumber = msg.whatsapp.replace(/[^0-9]/g, '');
              if (waNumber.startsWith('0') && waNumber.length === 10) {
                  waNumber = '94' + waNumber.substring(1);
              }
              
              return `
              <div class="p-4 bg-[var(--bg-root)] border border-[var(--glass-border)] rounded-xl relative group">
                  <div class="flex justify-between items-start mb-3">
                      <div>
                          <p class="font-bold text-[var(--text-primary)] text-sm flex items-center gap-2">
                              <span>📧</span>
                              <a href="mailto:${msg.email}" class="hover:text-indigo-400 hover:underline transition-colors">${msg.email}</a>
                          </p>
                          <p class="text-[0.65rem] text-[var(--text-secondary)] opacity-70 mt-1">${new Date(msg.createdAt).toLocaleString()}</p>
                      </div>
                      <a href="https://wa.me/${waNumber}?text=${encodeURIComponent('Hello! Replying to your message on StudyTracker Pro: ')}" target="_blank" class="bg-[#25D366]/20 text-[#25D366] px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-[#25D366] hover:text-white transition-all flex items-center gap-1.5 shadow-sm">
                          <span>WhatsApp</span>
                          <span>${msg.whatsapp}</span>
                      </a>
                  </div>
                  <div class="text-sm text-[var(--text-primary)] whitespace-pre-wrap bg-[var(--bg-secondary)] p-3 rounded-lg border border-[var(--glass-border)] break-words">${msg.message}</div>
                  
                  <button onclick="deleteContactMessage('${msg.id}')" class="absolute top-2 right-2 invisible group-hover:visible bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white w-6 h-6 rounded-full flex items-center justify-center transition-colors" title="Delete Message">
                      &times;
                  </button>
              </div>
          `}).join('');
      } catch(e) {
          console.error(e);
          document.getElementById('contact-messages-container').innerHTML = '<p class="text-center text-red-400 py-8">Failed to load messages.<br>Make sure you added the Firestore Rule for contactMessages.</p>';
      }
  };

  window.deleteContactMessage = async (id) => {
      if(!confirm('Are you sure you want to delete this message?')) return;
      try {
          await deleteDoc(doc(db, 'contactMessages', id));
          window.openContactMessagesModal(); // refresh
      } catch(e) {
          console.error(e);
          alert('Failed to delete message.');
      }
  };
}

// --- Timetable (with user-specific caching) ---
let timetableCache = {};
let timetableCacheTime = {};
const CACHE_DURATION = 30000; // 30 seconds

export async function renderTimetable(user) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const formatHour = (h) => {
    if (h === 0) return '12 AM';
    if (h === 12) return '12 PM';
    return h > 12 ? `${h - 12} PM` : `${h} AM`;
  };

  // Check cache first (user-specific)
  let data;
  const now = Date.now();
  if (timetableCache[user.uid] && (now - timetableCacheTime[user.uid] < CACHE_DURATION)) {
    data = timetableCache[user.uid];
  } else {
    const docRef = doc(db, "timetable", user.uid);
    const snap = await getDoc(docRef);
    data = snap.exists() ? snap.data() : {};
    timetableCache[user.uid] = data;
    timetableCacheTime[user.uid] = now;
  }

  appContainer.innerHTML = `
        <div class="max-w-7xl mx-auto pt-8 pb-16">
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                    <h2 class="text-3xl font-bold text-[var(--text-primary)]">24-Hour Time Table 📅</h2>
                    <p class="text-sm text-[var(--text-secondary)] mt-1">Plan and manage your entire 24-hour study and routine schedule.</p>
                </div>
                <div class="flex gap-2 w-full sm:w-auto">
                    <button id="tt-save" class="btn-primary text-sm px-5 flex-1 sm:flex-initial shadow-md">Save Changes</button>
                    <button id="tt-pdf" class="btn-ghost border border-[var(--glass-border)] text-sm px-5 flex-1 sm:flex-initial">Export PDF</button>
                </div>
            </div>
            
            <div class="smart-card p-0 overflow-hidden shadow-xl border border-[var(--glass-border)]">
                <div class="overflow-x-auto max-h-[75vh] custom-scrollbar">
                    <table class="smart-table min-w-full text-left border-collapse">
                        <thead class="bg-[var(--bg-secondary)] text-[var(--primary-light)] sticky top-0 z-20 backdrop-blur-md shadow-sm">
                            <tr>
                                <th class="w-28 text-center py-3.5 px-3 font-bold border-b border-[var(--glass-border)]">Time</th>
                                ${days.map(d => `<th class="text-center py-3.5 px-3 font-bold border-b border-[var(--glass-border)]">${d}</th>`).join('')}
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-[var(--glass-border)]">
                            ${hours.map(h => {
                              const isNight = h >= 0 && h < 6;
                              return `
                                <tr class="${isNight ? 'bg-black/20' : ''} hover:bg-[var(--bg-secondary)]/50 transition-colors">
                                    <td class="text-center font-bold text-xs sm:text-sm text-[var(--text-secondary)] border-r border-[var(--glass-border)] bg-[var(--bg-root)] py-2.5 px-2 whitespace-nowrap sticky left-0 z-10">
                                        <span class="inline-block ${isNight ? 'text-indigo-400/80' : 'text-[var(--text-primary)]'}">${formatHour(h)}</span>
                                    </td>
                                    ${days.map((d, i) => {
                                        const k = `tt_${i}_${h}`;
                                        return `<td class="p-1 border-r border-[var(--glass-border)] last:border-r-0">
                                            <input id="${k}" value="${(data[k] || '').replace(/"/g, '&quot;')}" class="w-full bg-transparent border border-transparent hover:border-[var(--glass-border)] focus:border-indigo-500 text-center outline-none text-xs sm:text-sm placeholder-opacity-20 hover:bg-[var(--bg-root)] focus:bg-[var(--bg-root)] rounded-lg transition-all py-2 px-1 text-[var(--text-primary)]" placeholder="-">
                                        </td>`;
                                    }).join('')}
                                </tr>
                            `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

  document.getElementById('tt-save').onclick = async () => {
    const saveBtn = document.getElementById('tt-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
        const newData = {};
        hours.forEach(h => days.forEach((d, i) => {
            const k = `tt_${i}_${h}`;
            const el = document.getElementById(k);
            if (el && el.value.trim()) newData[k] = sanitizeInput(el.value.trim());
        }));
        const docRef = doc(db, "timetable", user.uid);
        await setDoc(docRef, newData);
        timetableCache[user.uid] = newData;
        timetableCacheTime[user.uid] = Date.now();
        alert("Timetable Saved Successfully! \nකාලසටහන සාර්ථකව සුරැකිණි!");
    } catch (e) {
        console.error(e);
        alert("Failed to save timetable: " + e.message);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
  };

  // PDF Logic
  document.getElementById('tt-pdf').onclick = () => {
    if (typeof jspdf === 'undefined' || !jspdf.jsPDF) {
        alert("PDF generator library is still loading. Please try again in a moment.");
        return;
    }
    const pdf = new jspdf.jsPDF('l', 'pt', 'a4');
    const body = hours.map(h => [
        formatHour(h),
        ...days.map((d, i) => {
            const el = document.getElementById(`tt_${i}_${h}`);
            return el ? el.value : '';
        })
    ]);
    pdf.autoTable({
        head: [['Time', ...days]],
        body,
        theme: 'grid',
        styles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 7, cellPadding: 3 },
        headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold', halign: 'center' },
        columnStyles: { 0: { halign: 'center', fontStyle: 'bold', fillColor: [30, 41, 59] } }
    });
    pdf.save('TimeTable_24Hours.pdf');
  };
}

// --- Lecture Hall Year / Batch Management ---
export function getLectureYear() {
  const saved = localStorage.getItem('lecture_selected_year');
  if (saved === '2026' || saved === '2027') return saved;
  return '2026';
}

export function setLectureYear(year) {
  localStorage.setItem('lecture_selected_year', year);
}

window.switchLectureYear = (year) => {
  setLectureYear(year);
  document.dispatchEvent(new CustomEvent('refresh-content'));
  // Trigger popstate so the current route re-renders with the new year
  window.dispatchEvent(new Event('popstate'));
};

export function renderLectureYearSwitcher(activeYear, size = 'normal') {
  const isLarge = size === 'large';
  const containerClass = isLarge
    ? "lecture-year-toggle inline-flex p-1.5 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--glass-border)] shadow-inner gap-1"
    : "lecture-year-toggle inline-flex p-1 rounded-xl bg-[var(--bg-secondary)] border border-[var(--glass-border)] shadow-inner gap-1 text-xs";
  
  const btn2026Class = isLarge
    ? `px-5 py-2 rounded-xl text-sm font-bold transition-all duration-300 flex items-center gap-1.5 ${activeYear === '2026' ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-md shadow-indigo-500/25 scale-[1.02]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/5'}`
    : `px-3.5 py-1.5 rounded-lg font-bold transition-all duration-300 flex items-center gap-1 ${activeYear === '2026' ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm shadow-indigo-500/25' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/5'}`;

  const btn2027Class = isLarge
    ? `px-5 py-2 rounded-xl text-sm font-bold transition-all duration-300 flex items-center gap-1.5 ${activeYear === '2027' ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-md shadow-purple-500/25 scale-[1.02]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/5'}`
    : `px-3.5 py-1.5 rounded-lg font-bold transition-all duration-300 flex items-center gap-1 ${activeYear === '2027' ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-sm shadow-purple-500/25' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/5'}`;

  return `
    <div class="${containerClass}">
      <button type="button" class="${btn2026Class}" onclick="window.switchLectureYear('2026')">
        <span>🎓</span>
        <span>2026 A/L</span>
      </button>
      <button type="button" class="${btn2027Class}" onclick="window.switchLectureYear('2027')">
        <span>✨</span>
        <span>2027 A/L</span>
      </button>
    </div>
  `;
}

// --- Dynamic Content Management (Order, Edit, Delete) ---
// --- Content Actions helper (re-export safe) ---
window.deleteItem = async (id, lessonId, year) => {
  if (confirm("Remove this item?")) {
    await deleteDoc(doc(db, "lessonContents", id));
    const activeYear = year || getLectureYear();
    if (lessonId) {
      delete contentCache[`${lessonId}_${activeYear}`];
      delete contentCacheTime[`${lessonId}_${activeYear}`];
    }
    document.dispatchEvent(new CustomEvent('refresh-content'));
  }
};

window.editItem = async (id, oldText, oldLink, lessonId, year) => {
  const text = prompt("Edit Title:", oldText);
  const link = prompt("Edit Link:", oldLink);
  if (text && link) {
    await updateDoc(doc(db, "lessonContents", id), { text, link });
    const activeYear = year || getLectureYear();
    if (lessonId) {
      delete contentCache[`${lessonId}_${activeYear}`];
      delete contentCacheTime[`${lessonId}_${activeYear}`];
    }
    document.dispatchEvent(new CustomEvent('refresh-content'));
  }
};

// Move item up/down with year filtering
window.moveItemUp = async (id, currentIndex, lessonId, year) => {
  try {
    const activeYear = year || getLectureYear();
    const q = query(collection(db, "lessonContents"), where("lessonId", "==", lessonId), orderBy("order", "asc"));
    const snap = await getDocs(q);
    const allItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    let items;
    if (activeYear === '2026') {
      items = allItems.filter(d => d.year === '2026' || d.batch === '2026' || (!d.year && !d.batch));
    } else {
      items = allItems.filter(d => d.year === '2027' || d.batch === '2027');
    }

    if (currentIndex <= 0) return; // Can't move up if already first

    // Swap with previous item
    const temp = items[currentIndex];
    items[currentIndex] = items[currentIndex - 1];
    items[currentIndex - 1] = temp;

    // Renumber these items
    const batch = writeBatch(db);
    items.forEach((item, index) => {
      const itemRef = doc(db, "lessonContents", item.id);
      batch.update(itemRef, { order: index + 1 });
    });

    await batch.commit();

    // Clear cache for this lesson & year
    delete contentCache[`${lessonId}_${activeYear}`];
    delete contentCacheTime[`${lessonId}_${activeYear}`];

    document.dispatchEvent(new CustomEvent('refresh-content'));
  } catch (error) {
    console.error('Move up error:', error);
    alert('Failed to move item');
  }
};

window.moveItemDown = async (id, currentIndex, lessonId, year) => {
  try {
    const activeYear = year || getLectureYear();
    const q = query(collection(db, "lessonContents"), where("lessonId", "==", lessonId), orderBy("order", "asc"));
    const snap = await getDocs(q);
    const allItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    let items;
    if (activeYear === '2026') {
      items = allItems.filter(d => d.year === '2026' || d.batch === '2026' || (!d.year && !d.batch));
    } else {
      items = allItems.filter(d => d.year === '2027' || d.batch === '2027');
    }

    if (currentIndex >= items.length - 1) return; // Can't move down if already last

    // Swap with next item
    const temp = items[currentIndex];
    items[currentIndex] = items[currentIndex + 1];
    items[currentIndex + 1] = temp;

    // Renumber these items
    const batch = writeBatch(db);
    items.forEach((item, index) => {
      const itemRef = doc(db, "lessonContents", item.id);
      batch.update(itemRef, { order: index + 1 });
    });

    await batch.commit();

    // Clear cache for this lesson & year
    delete contentCache[`${lessonId}_${activeYear}`];
    delete contentCacheTime[`${lessonId}_${activeYear}`];

    document.dispatchEvent(new CustomEvent('refresh-content'));
  } catch (error) {
    console.error('Move down error:', error);
    alert('Failed to move item');
  }
};

// --- Render Content Page with BIG CARDS (with caching & batch isolation) ---
let contentCache = {};
let contentCacheTime = {};
const CONTENT_CACHE_DURATION = 20000; // 20 seconds

/**
 * Check if a user is authorized to add/edit Text + Link materials in Lecture Hall
 */
export async function checkCanEditLecture(user, subject = null) {
  if (!user) return false;
  if (user.uid === ADMIN_UID) return true;
  if (NILANTHA_MODERATORS.includes(user.uid) && subject === 'physics-nilantha') return true;
  if (RAVINDU_MODERATORS.includes(user.uid) && subject === 'ravindu-ict') return true;

  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (snap.exists()) {
      const data = snap.data();
      if (data.canPostLectureHall === true || data.isLectureHallEditor === true) {
        return true;
      }
    }
    const settingsSnap = await getDoc(doc(db, 'settings', 'lecture_hall_permissions'));
    if (settingsSnap.exists()) {
      const editors = settingsSnap.data().editors || [];
      if (editors.includes(user.uid)) {
        return true;
      }
    }
  } catch (e) {
    console.error("Error checking lecture hall permission:", e);
  }
  return false;
}

export async function openLessonPage(subject, type, day, user) {
  const currentYear = getLectureYear();

  if (currentYear === '2027' && (subject === 'com-maths-ruwan-full' || subject === 'biology' || subject === 'ravindu-ict')) {
    if (window.navigateTo) window.navigateTo('/recordings');
    return;
  }

  const lessonId = `${subject}_${type}_${day}`;
  const cacheKey = `${lessonId}_${currentYear}`;
  const canEdit = await checkCanEditLecture(user, subject);

  let headingText = `Day ${day} Content`;
  if (subject === 'chemistry' && type === 'midnight-video') {
    headingText = 'Midnight Session Videos';
  } else if (subject === 'vikum-maths' && type === 'video') {
    headingText = 'Supportive Program Videos';
  } else if (type === 'final-revise') {
    headingText = `${parseInt(day)} Month Content`;
  } else if (subject === 'vikum-maths' && type === 'rapid') {
    headingText = `${parseInt(day)} Month Content`;
  }

  const subjectDisplayNames = {
    'ravindu-ict': 'ICT',
    'vikum-maths': 'Combine Maths',
    'com-maths-manoj': currentYear === '2027' ? 'Combine Maths' : 'Combine Maths 2025',
    'com-maths-ruwan-full': 'Com Maths Full Syllabus 2025',
    'physics-nilantha': 'Physics',
    'chemistry': 'Chemistry',
    'physics': 'Physics',
    'maths': 'Combined Maths',
    'biology': 'Biology'
  };
  const subjectDisplay = subjectDisplayNames[subject] || subject.replace(/-/g, ' ');

  appContainer.innerHTML = `
        <div class="max-w-5xl mx-auto pt-8">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                <div>
                    <div class="flex items-center gap-2 mb-2 flex-wrap">
                        <button onclick="navigateTo('/recording/${subject}/${type}')" class="text-xs text-[var(--text-secondary)] hover:text-indigo-400 flex items-center gap-1 transition-colors">
                            <span>←</span> Back to Lessons
                        </button>
                        <span class="text-xs text-[var(--text-secondary)]">•</span>
                        <span class="text-xs text-[var(--text-secondary)] font-medium capitalize">${subjectDisplay}</span>
                        <span class="text-xs text-[var(--text-secondary)]">•</span>
                        <span class="text-xs font-bold px-2 py-0.5 rounded-full ${currentYear === '2026' ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'}">${currentYear} A/L</span>
                    </div>
                    <h2 class="text-2xl md:text-3xl font-bold text-[var(--text-primary)]">${headingText}</h2>
                </div>
                ${renderLectureYearSwitcher(currentYear, 'normal')}
            </div>

            <div id="content-list" class="grid grid-cols-2 gap-3 md:gap-4 mb-8">
                <div class="col-span-full py-12 flex justify-center"><div class="animate-spin h-8 w-8 border-4 border-indigo-500 rounded-full border-t-transparent"></div></div>
            </div>
            
            ${canEdit ? `
                <div class="smart-card border-dashed border-2 border-[var(--glass-border)] shadow-none">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-sm font-bold text-[var(--test-secondary)] uppercase">Upload Material</h3>
                        <span class="text-xs font-bold px-2.5 py-1 rounded-md ${currentYear === '2026' ? 'bg-indigo-500/20 text-indigo-300' : 'bg-purple-500/20 text-purple-300'}">Target: ${currentYear} A/L</span>
                    </div>
                    <div class="flex flex-col sm:flex-row gap-3">
                        <input id="add-text" placeholder="Title (e.g. Video Part 1)" class="smart-input flex-1">
                        <input id="add-link" placeholder="Share Link URL" class="smart-input flex-1">
                        <button id="add-btn" class="btn-primary whitespace-nowrap">Add to ${currentYear}</button>
                    </div>
                </div>
            `: ''}
        </div>
    `;

  const loadContent = async (forceRefresh = false) => {
    const list = document.getElementById('content-list');
    if (!list) return;

    // Check cache first
    const now = Date.now();
    if (!forceRefresh && contentCache[cacheKey] && contentCacheTime[cacheKey] && (now - contentCacheTime[cacheKey] < CONTENT_CACHE_DURATION)) {
      renderContentCards(contentCache[cacheKey], list, canEdit, lessonId, currentYear);
      return;
    }

    // Fetch from Firebase
    const q = query(collection(db, "lessonContents"), where("lessonId", "==", lessonId), orderBy("order", "asc"));
    const snap = await getDocs(q);

    const allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Filter by active year:
    let filteredData;
    if (currentYear === '2026') {
      // 2026 gets items explicitly marked 2026 OR legacy items without year/batch
      filteredData = allDocs.filter(d => d.year === '2026' || d.batch === '2026' || (!d.year && !d.batch));
    } else {
      // 2027 gets only items marked 2027
      filteredData = allDocs.filter(d => d.year === '2027' || d.batch === '2027');
    }

    if (filteredData.length === 0) {
      list.innerHTML = `<div class="col-span-full p-8 text-center text-[var(--text-secondary)] italic border border-[var(--glass-border)] rounded-xl">No content uploaded for ${currentYear} A/L yet.</div>`;
      return;
    }

    // Update cache
    contentCache[cacheKey] = filteredData;
    contentCacheTime[cacheKey] = now;

    renderContentCards(filteredData, list, canEdit, lessonId, currentYear);
  };

  // Refresh listener for external window functions
  const refreshHandler = () => loadContent(true);
  document.addEventListener('refresh-content', refreshHandler, { once: true });

  if (canEdit) {
    document.getElementById('add-btn').onclick = async () => {
      const rawText = document.getElementById('add-text').value.trim();
      const rawLink = document.getElementById('add-link').value.trim();
      const text = sanitizeInput(rawText);
      const link = sanitizeUrl(rawLink);
      if (!text || !link || link === '#') {
        alert("Please enter a valid title and URL.");
        return;
      }

      const q = query(collection(db, "lessonContents"), where("lessonId", "==", lessonId));
      const sn = await getDocs(q);
      const currentYearItems = sn.docs.map(d => d.data()).filter(d => {
        if (currentYear === '2026') return d.year === '2026' || d.batch === '2026' || (!d.year && !d.batch);
        return d.year === '2027' || d.batch === '2027';
      });

      await addDoc(collection(db, "lessonContents"), { 
        lessonId, 
        text, 
        link, 
        year: currentYear, 
        batch: currentYear, 
        order: currentYearItems.length + 1, 
        createdAt: Date.now() 
      });

      document.getElementById('add-text').value = '';
      document.getElementById('add-link').value = '';
      delete contentCache[cacheKey];
      delete contentCacheTime[cacheKey];
      loadContent(true);
    };
  }
  loadContent();
}

function renderContentCards(contentData, listElement, canEdit, lessonId, currentYear) {
  listElement.innerHTML = contentData.map((item, index) => {
    const isFirst = index === 0;
    const isLast = index === contentData.length - 1;
    const safeText = (item.text || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeLink = (item.link || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return `
      <div class="smart-card recording-card-big relative group p-0">
          <a href="${item.link}" target="_blank" rel="noopener noreferrer" class="flex flex-col items-center justify-center text-center h-full p-3 md:p-6 text-[var(--text-primary)]">
              <div class="recording-icon-big text-2xl md:text-5xl mb-2 md:mb-4 text-indigo-400">▶</div>
              <h3 class="text-xs md:text-xl font-bold mb-1 md:mb-2 group-hover:text-[var(--primary)] transition-colors line-clamp-2">${item.text}</h3>
              <p class="text-[10px] md:text-xs text-[var(--text-secondary)]">Click to watch</p>
          </a>
          ${canEdit ? `
              <div class="absolute top-2 right-2 flex gap-1 bg-[var(--bg-secondary)] rounded-lg shadow-sm opacity-0 group-hover:opacity-100 transition-opacity p-1">
                   ${!isFirst ? `<button onclick="moveItemUp('${item.id}', ${index}, '${lessonId}', '${currentYear}')" class="p-1 text-xs hover:text-blue-400" title="Move Up">⬆️</button>` : ''}
                   ${!isLast ? `<button onclick="moveItemDown('${item.id}', ${index}, '${lessonId}', '${currentYear}')" class="p-1 text-xs hover:text-blue-400" title="Move Down">⬇️</button>` : ''}
                   <button onclick="editItem('${item.id}', '${safeText}', '${safeLink}', '${lessonId}', '${currentYear}')" class="p-1 text-xs hover:text-yellow-400" title="Edit">✏️</button>
                   <button onclick="deleteItem('${item.id}', '${lessonId}', '${currentYear}')" class="p-1 text-xs hover:text-red-400" title="Delete">🗑️</button>
              </div>
          ` : ''}
      </div>
    `;
  }).join('');
}

// --- Profile (with Custom Avatar) ---
export async function renderProfile(user) {
  const snap = await getDoc(doc(db, "users", user.uid));
  const d = snap.exists() ? snap.data() : {};
  userProfileCache[user.uid] = d; // Sync cache

  let currentReq = null;
  try {
      const reqQ = query(collection(db, 'emailRequests'), where('userId', '==', user.uid));
      const reqSnap = await getDocs(reqQ);
      if (!reqSnap.empty) {
          const reqs = reqSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
          currentReq = reqs[0];
      }
  } catch (e) {
      console.error("Error fetching email requests:", e);
  }

  let emailHtml = '';
  if (currentReq) {
      if (currentReq.status === 'pending') {
          emailHtml = `<div>
              <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Email</label>
              <div class="flex gap-2">
                  <input type="email" value="${user.email}" class="smart-input flex-1 opacity-50" readonly>
                  <button type="button" class="btn-ghost text-xs whitespace-nowrap bg-yellow-500/10 text-yellow-500 cursor-not-allowed border-none">Pending</button>
                  <button type="button" onclick="window.cancelEmailChange('${currentReq.id}')" class="btn-ghost text-xs px-2 text-red-400 hover:text-red-300 border-none bg-red-500/10" title="Cancel Request">✖</button>
              </div>
              <p class="text-[0.65rem] mt-1 text-[var(--text-secondary)]">Requested change to: ${currentReq.newEmail}</p>
          </div>`;
      } else if (currentReq.status === 'approved') {
          emailHtml = `<div>
              <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Email</label>
              <div class="flex gap-2">
                  <input type="email" value="${user.email}" class="smart-input flex-1 opacity-50" readonly>
                  <button type="button" onclick="window.confirmEmailChange('${currentReq.id}', '${currentReq.newEmail}')" class="btn-primary text-xs whitespace-nowrap bg-emerald-500 hover:bg-emerald-600 border-none shadow-md">Confirm</button>
                  <button type="button" onclick="window.cancelEmailChange('${currentReq.id}')" class="btn-ghost text-xs px-2 text-red-400 hover:text-red-300 border-none bg-red-500/10" title="Cancel Request">✖</button>
              </div>
              <p class="text-[0.65rem] mt-1 text-emerald-400">Approved to: ${currentReq.newEmail}</p>
          </div>`;
      } else if (currentReq.status === 'verification_sent') {
          if (user.email === currentReq.newEmail) {
              await deleteDoc(doc(db, 'emailRequests', currentReq.id));
              await setDoc(doc(db, 'users', user.uid), { email: user.email }, { merge: true });
              renderProfile(user);
              return;
          }
          emailHtml = `<div>
              <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Email</label>
              <div class="flex gap-2">
                  <input type="email" value="${user.email}" class="smart-input flex-1 opacity-50" readonly>
                  <button type="button" class="btn-ghost text-xs whitespace-nowrap bg-blue-500/10 text-blue-500 cursor-not-allowed border-none">Sent</button>
                  <button type="button" onclick="window.cancelEmailChange('${currentReq.id}')" class="btn-ghost text-xs px-2 text-red-400 hover:text-red-300 border-none bg-red-500/10" title="Cancel Request">✖</button>
              </div>
              <p class="text-[0.65rem] mt-1 text-blue-400">Please click the link sent to ${currentReq.newEmail} to verify. Refresh this page after verifying.</p>
          </div>`;
      } else {
          emailHtml = `<div>
              <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Email</label>
              <div class="flex gap-2">
                  <input type="email" value="${user.email}" class="smart-input flex-1 opacity-50" readonly>
                  <button type="button" onclick="window.requestEmailChange()" class="btn-ghost text-xs whitespace-nowrap border border-[var(--glass-border)] hover:bg-[var(--glass-border)]">Change Email</button>
              </div>
              <p class="text-[0.65rem] mt-1 text-red-400">Previous request was rejected.</p>
          </div>`;
      }
  } else {
      emailHtml = `<div>
          <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Email</label>
          <div class="flex gap-2">
              <input type="email" value="${user.email}" class="smart-input flex-1 opacity-50" readonly>
              <button type="button" onclick="window.requestEmailChange()" class="btn-ghost text-xs whitespace-nowrap border border-[var(--glass-border)] hover:bg-[var(--glass-border)]">Change Email</button>
          </div>
      </div>`;
  }

  appContainer.innerHTML = `
        <div class="max-w-2xl mx-auto pt-2 md:pt-10">
            <h2 class="text-2xl md:text-3xl font-bold text-[var(--text-primary)] mb-4 md:mb-8">Profile Settings</h2>
            
            <div class="smart-card mb-4 md:mb-6 flex items-center gap-4 sm:gap-6">
                 <div class="w-16 h-16 sm:w-24 sm:h-24 rounded-full border-2 border-indigo-500 overflow-hidden relative group shrink-0">
                    <img id="profile-preview" src="${d.photoURL || user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName}`}" class="w-full h-full object-cover">
                    <button onclick="changeAvatar()" class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white font-bold transition-opacity text-xs sm:text-base">Change</button>
                 </div>
                 <div>
                    <h3 class="text-lg sm:text-xl font-bold text-[var(--text-primary)]">${d.firstName}</h3>
                    <p class="text-sm sm:text-base text-[var(--text-secondary)]">Student • ${d.examYear || 'Batch N/A'}</p>
                 </div>
            </div>

            <form id="profile-form" class="smart-card space-y-4">
                 <div class="grid md:grid-cols-2 gap-4">
                     <div><label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">First Name</label><input name="firstName" value="${d.firstName || ''}" class="smart-input" required></div>
                     <div><label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Last Name</label><input name="lastName" value="${d.lastName || ''}" class="smart-input" required></div>
                 </div>
                 <div class="grid md:grid-cols-2 gap-4">
                     ${emailHtml}
                     <div><label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Birthday</label><input name="birthday" type="date" value="${d.birthday || ''}" class="smart-input" required></div>
                 </div>
                 <div class="grid md:grid-cols-2 gap-4">
                      <div><label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">School <span class="text-xs text-[var(--text-secondary)] font-normal lowercase">(optional)</span></label><input name="school" value="${d.school || ''}" class="smart-input" placeholder="School Name (Optional)"></div>
                      <div><label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Phone</label><input type="tel" name="phone" pattern="[0-9]{10}" maxlength="10" title="Please enter exactly 10 digits" value="${d.phone || ''}" class="smart-input" required></div>
                 </div>
                 <div>
                      <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">A/L Batch</label>
                      <select name="examYear" class="smart-input w-full" required>
                          <option value="2026 A/L" ${d.examYear === '2026 A/L' ? 'selected' : ''}>2026 A/L</option>
                          <option value="2027 A/L" ${d.examYear === '2027 A/L' ? 'selected' : ''}>2027 A/L</option>
                          <option value="2028 A/L" ${d.examYear === '2028 A/L' ? 'selected' : ''}>2028 A/L</option>
                          <option value="2029 A/L" ${d.examYear === '2029 A/L' ? 'selected' : ''}>2029 A/L</option>
                      </select>
                 </div>
                 <!-- Privacy Toggle for Community Chat -->
                 <div class="p-4 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] flex items-center justify-between gap-4">
                     <div>
                         <p class="font-bold text-sm text-[var(--text-primary)] flex items-center gap-2">
                             <span>🔒</span> Community Chat Photo Privacy
                         </p>
                         <p class="text-xs text-[var(--text-secondary)] mt-0.5">
                             Default is Private (Hidden). Turn ON to show your Profile Picture in Community Chat.
                         </p>
                     </div>
                     <label class="switch shrink-0">
                         <input type="checkbox" name="isPhotoPublic" id="isPhotoPublicCheckbox" ${d.isPhotoPublic === true ? 'checked' : ''}>
                         <span class="switch-slider"></span>
                     </label>
                 </div>
                 <button type="submit" class="btn-primary w-full mt-4">Save Changes</button>
            </form>
        </div>
    `;

  window.changeAvatar = async () => {
    // Create file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // Show loading state
      const preview = document.getElementById('profile-preview');
      const originalSrc = preview.src;
      preview.style.opacity = '0.5';

      try {
        // Use Canvas to resize image and reduce Base64 size
        const photoURL = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsDataURL(file);
          reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
              const canvas = document.createElement('canvas');
              const MAX_WIDTH = 400; // Profile pic doesn't need to be huge
              const MAX_HEIGHT = 400;
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
              resolve(canvas.toDataURL('image/jpeg', 0.8)); // 80% quality
            };
            img.onerror = reject;
          };
          reader.onerror = reject;
        });

        // Update database (Don't use updateProfile as Auth photoURL has short length limits)
        await setDoc(doc(db, 'users', user.uid), { photoURL }, { merge: true });
        userProfileCache[user.uid] = { ...(userProfileCache[user.uid] || {}), photoURL };

        // Update preview
        preview.src = photoURL;
        preview.style.opacity = '1';
        alert("Profile picture updated!");
        await renderHeader(user, window.navigateTo, signOut);
      } catch (error) {
        console.error('Upload error:', error);
        alert('Failed to update image. Try a smaller file.');
        preview.src = originalSrc;
        preview.style.opacity = '1';
      }
    };

    input.click();
  };

  document.getElementById('profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const saveBtn = e.target.querySelector('button');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }
    
    try {
      const isPhotoPublic = document.getElementById('isPhotoPublicCheckbox') ? document.getElementById('isPhotoPublicCheckbox').checked : false;
      const cleanFirstName = sanitizeInput((f.get('firstName') || '').trim());
      const cleanLastName = sanitizeInput((f.get('lastName') || '').trim());
      const cleanSchool = sanitizeInput((f.get('school') || '').trim());
      const cleanPhone = sanitizeInput((f.get('phone') || '').trim());
      const cleanBirthday = sanitizeInput((f.get('birthday') || '').trim());
      const cleanExamYear = sanitizeInput((f.get('examYear') || '').trim());

      await setDoc(doc(db, 'users', user.uid), {
        firstName: cleanFirstName,
        lastName: cleanLastName,
        school: cleanSchool,
        phone: cleanPhone,
        birthday: cleanBirthday,
        examYear: cleanExamYear,
        email: user.email,
        isPhotoPublic: isPhotoPublic
      }, { merge: true });
      const displayName = [cleanFirstName, cleanLastName].filter(Boolean).join(' ');
      await updateProfile(user, { displayName });
      
      userProfileCache[user.uid] = { 
        ...userProfileCache[user.uid], 
        firstName: cleanFirstName,
        lastName: cleanLastName,
        school: cleanSchool,
        phone: cleanPhone,
        birthday: cleanBirthday,
        examYear: cleanExamYear,
        email: user.email,
        isPhotoPublic: isPhotoPublic
      };
      
      alert("Profile Updated!");
      if (window.navigateTo) window.navigateTo('/home');
    } catch (error) {
      console.error(error);
      alert("Failed to save profile: " + error.message);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    }
  };

  window.requestEmailChange = async () => {
      const newEmail = prompt("Enter the new email address you want to use:");
      if (!newEmail) return;
      if (newEmail === user.email) return alert("This is your current email.");
      if (!newEmail.includes('@') || !newEmail.includes('.')) return alert("Invalid email format.");
      
      try {
          await addDoc(collection(db, 'emailRequests'), {
              userId: user.uid,
              userName: d.firstName + ' ' + d.lastName,
              currentEmail: user.email,
              newEmail: newEmail,
              status: 'pending',
              createdAt: Date.now()
          });
          alert("Request submitted to Admin! You can change your email once it is approved.");
          renderProfile(user); // refresh
      } catch (error) {
          alert("Failed to submit request: " + error.message);
      }
  };

  window.confirmEmailChange = async (reqId, newEmail) => {
      const providerId = user.providerData[0]?.providerId;
      if (providerId === 'google.com') {
          alert("You are logged in with Google. You cannot change your email address.");
          return;
      }

      const pwd = prompt(`Please enter your current password to confirm changing email to: ${newEmail}`);
      if (!pwd) return;

      try {
          const cred = EmailAuthProvider.credential(user.email, pwd);
          await reauthenticateWithCredential(user, cred);
          
          await verifyBeforeUpdateEmail(user, newEmail);
          await updateDoc(doc(db, 'emailRequests', reqId), { status: 'verification_sent' });
          
          alert("Firebase has sent a verification link to " + newEmail + ". Please check your inbox and click the link to confirm your new email. Once verified, your email will be updated automatically.");
          renderProfile(user);
      } catch (error) {
          console.error(error);
          if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
              alert("Incorrect password.");
          } else {
              alert("Failed to update email: " + error.message);
          }
      }
  };

  window.cancelEmailChange = async (reqId) => {
      if (!confirm("Are you sure you want to cancel your email change request?")) return;
      try {
          await deleteDoc(doc(db, 'emailRequests', reqId));
          alert("Request cancelled successfully.");
          renderProfile(user); // refresh
      } catch (error) {
          alert("Failed to cancel request: " + error.message);
      }
  };
}

// Preserve other necessary exports (renderSubjects, renderType, etc.) simply referencing the updated styles


import dineshImg from '../assets/teachers/Dinesh Muthugala.png';
import monojImg from '../assets/teachers/monoj.jpg';
import vikumImg from '../assets/teachers/vikum.jpg';
import ravinduImg from '../assets/teachers/ravindu.jpg';

export function renderSubjects(navigate) {
  const currentYear = getLectureYear();
  let TEACHERS = [];

  if (currentYear === '2027') {
    TEACHERS = [
      { id: 'maths', name: 'Ruwan Darshana', subject: 'Combined Maths', img: 'https://api.combinedmaths.lk/files-public/profiles/281124/1862199793225306112.jpg', color: 'indigo' },
      { id: 'com-maths-manoj', name: 'Manoj Solangarachchi', subject: 'Combine Maths', img: monojImg, color: 'blue' },
      { id: 'physics', name: 'Anuradha Perera', subject: 'Physics', img: 'https://static.indeepa.lk/lecturer/7/en/652248466c448.jpg', color: 'cyan' },
      { id: 'chemistry', name: 'Amila Dasanayake', subject: 'Chemistry', img: 'https://static.indeepa.lk/lecturer/6/en/6522475ddf2bf.jpg', color: 'emerald' },
      { id: 'vikum-maths', name: 'Vikum Harshana', subject: 'Combine Maths', img: vikumImg, color: 'purple' }
    ];
  } else {
    // 2026 Batch (Default)
    TEACHERS = [
      { id: 'maths', name: 'Ruwan Darshana', subject: 'Combined Maths', img: 'https://api.combinedmaths.lk/files-public/profiles/281124/1862199793225306112.jpg', color: 'indigo' },
      { id: 'com-maths-ruwan-full', name: 'Ruwan Darshana', subject: 'Com Maths Full Syllabus 2025', img: 'https://api.combinedmaths.lk/files-public/profiles/281124/1862199793225306112.jpg', color: 'indigo' },
      { id: 'com-maths-manoj', name: 'Manoj Solangarachchi', subject: 'Combine Maths 2025', img: monojImg, color: 'blue' },
      { id: 'biology', name: 'Dinesh Muthugala', subject: 'Biology', img: dineshImg, color: 'green' },
      { id: 'physics', name: 'Anuradha Perera', subject: 'Physics', img: 'https://static.indeepa.lk/lecturer/7/en/652248466c448.jpg', color: 'cyan' },
      { id: 'chemistry', name: 'Amila Dasanayake', subject: 'Chemistry', img: 'https://static.indeepa.lk/lecturer/6/en/6522475ddf2bf.jpg', color: 'emerald' },
      { id: 'vikum-maths', name: 'Vikum Harshana', subject: 'Combine Maths', img: vikumImg, color: 'purple' },
      { id: 'ravindu-ict', name: 'Ravindu Bandaranayake', subject: 'ICT', img: ravinduImg, color: 'sky' }
    ];
  }

  const gridClass = currentYear === '2027' 
    ? 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 md:gap-8 justify-center'
    : 'grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-8 justify-center';

  appContainer.innerHTML = `
        <div class="max-w-6xl mx-auto pt-8">
            <div class="flex flex-col sm:flex-row items-center justify-between gap-4 mb-8">
                <div>
                    <h2 class="text-3xl font-bold text-[var(--text-primary)]">Lecture Hall 📚</h2>
                    <p class="text-sm text-[var(--text-secondary)] mt-1">Viewing recordings for <span class="font-bold text-indigo-400">${currentYear} A/L</span> batch</p>
                </div>
                ${renderLectureYearSwitcher(currentYear, 'large')}
            </div>
            <div class="${gridClass}">
                ${TEACHERS.map(t => `
                    <div class="smart-card p-0 overflow-hidden cursor-pointer group flex flex-col" onclick="navigateTo('/recording/${t.id}')">
                        <div class="h-28 sm:h-56 overflow-hidden"><img src="${t.img}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"></div>
                        <div class="p-3 md:p-6 flex-1 flex flex-col justify-center text-center">
                            <span class="text-[10px] md:text-sm font-bold uppercase tracking-wider text-${t.color}-400 mb-1 md:mb-2 block">${t.subject}</span>
                            <h3 class="text-xs md:text-2xl font-bold text-[var(--text-primary)] group-hover:text-indigo-400 transition-colors line-clamp-2">${t.name}</h3>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

export function renderType(subject, navigate) {
  const currentYear = getLectureYear();

  if (currentYear === '2027' && (subject === 'com-maths-ruwan-full' || subject === 'biology' || subject === 'ravindu-ict')) {
    navigate('/recordings');
    return;
  }

  if (subject === 'vikum-maths') {
    appContainer.innerHTML = `
        <div class="max-w-4xl mx-auto pt-8">
            <div class="flex items-center justify-between mb-8 flex-wrap gap-3">
                <button onclick="navigateTo('/recordings')" class="btn-ghost flex items-center gap-2 text-sm border border-[var(--glass-border)] hover:bg-[var(--glass-border)]">
                    <span>←</span> Back to Subjects
                </button>
                ${renderLectureYearSwitcher(currentYear, 'normal')}
            </div>
            <div class="text-center mb-8">
                <h2 class="text-4xl font-bold text-[var(--text-primary)] mb-2 uppercase tracking-widest">Combine Maths</h2>
                <p class="text-sm text-[var(--text-secondary)]">Vikum Harshana • <span class="font-bold text-indigo-400">${currentYear} A/L</span></p>
            </div>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8 max-w-4xl mx-auto">
                <div onclick="navigateTo('/recording/vikum-maths/supportive')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">🤝</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Maths Supportive</h3>
                </div>
                <div onclick="navigateTo('/recording/vikum-maths/revision')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">🔄</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Revision</h3>
                </div>
                <div onclick="navigateTo('/recording/vikum-maths/rapid')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">⚡</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Rapid Revision</h3>
                </div>
                <div onclick="navigateTo('/recording/vikum-maths/final-revise')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">🎯</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Final Revise</h3>
                </div>
            </div>
        </div>
    `;
    return;
  }

  if (subject === 'ravindu-ict') {
    appContainer.innerHTML = `
        <div class="max-w-4xl mx-auto pt-8">
            <div class="flex items-center justify-between mb-8 flex-wrap gap-3">
                <button onclick="navigateTo('/recordings')" class="btn-ghost flex items-center gap-2 text-sm border border-[var(--glass-border)] hover:bg-[var(--glass-border)]">
                    <span>←</span> Back to Subjects
                </button>
                ${renderLectureYearSwitcher(currentYear, 'normal')}
            </div>
            <div class="text-center mb-8">
                <h2 class="text-4xl font-bold text-[var(--text-primary)] mb-2 uppercase tracking-widest">ICT</h2>
                <p class="text-sm text-[var(--text-secondary)]">Ravindu Bandaranayake • <span class="font-bold text-indigo-400">${currentYear} A/L</span></p>
            </div>
            <div class="grid grid-cols-2 gap-4 mt-8 max-w-xl mx-auto">
                <div onclick="navigateTo('/recording/ravindu-ict/theory')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">📚</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Theory</h3>
                </div>
                <div onclick="navigateTo('/recording/ravindu-ict/revision')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">🔄</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Revision</h3>
                </div>
            </div>
        </div>
    `;
    return;
  }

  if (subject === 'com-maths-manoj' || subject === 'com-maths-ruwan-full') {
    const title = subject === 'com-maths-ruwan-full' ? 'Com Maths Full Syllabus 2025' : (currentYear === '2027' ? 'Combine Maths' : 'Combine Maths 2025');
    const teacherName = subject === 'com-maths-ruwan-full' ? 'Ruwan Darshana' : 'Manoj Solangarachchi';
    appContainer.innerHTML = `
        <div class="max-w-4xl mx-auto pt-8">
            <div class="flex items-center justify-between mb-8 flex-wrap gap-3">
                <button onclick="navigateTo('/recordings')" class="btn-ghost flex items-center gap-2 text-sm border border-[var(--glass-border)] hover:bg-[var(--glass-border)]">
                    <span>←</span> Back to Subjects
                </button>
                ${renderLectureYearSwitcher(currentYear, 'normal')}
            </div>
            <div class="text-center mb-8">
                <h2 class="text-4xl font-bold text-[var(--text-primary)] mb-2 uppercase tracking-widest">${title}</h2>
                <p class="text-sm text-[var(--text-secondary)]">${teacherName} • <span class="font-bold text-indigo-400">${currentYear} A/L</span></p>
            </div>
            <div class="grid grid-cols-2 gap-4 mt-8 max-w-2xl mx-auto">
                <div onclick="navigateTo('/recording/${subject}/pure-maths')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center"><div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">📐</div><h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Pure Maths</h3></div>
                <div onclick="navigateTo('/recording/${subject}/applied-maths')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center"><div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">⚙️</div><h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Applied Maths</h3></div>
            </div>
        </div>
    `;
    return;
  }

  let items = [
    { id: 'theory', icon: '📚', label: 'Theory' },
    { id: 'revision', icon: '🔄', label: 'Revision' },
    { id: 'paper', icon: '📝', label: 'Paper Class' },
    { id: 'rapid', icon: '⚡', label: 'Rapid Revision' }
  ];
  if (subject === 'chemistry') {
    items.push({ id: 'midnight', icon: '🌙', label: 'Midnight Session' });
  }
  if (subject === 'physics') {
    items.push({ id: 'final-revise', icon: '🎯', label: 'Final Revise' });
  }

  const gridColsClass = items.length === 5 ? 'grid-cols-2 sm:grid-cols-2 lg:grid-cols-5' : 'grid-cols-2 sm:grid-cols-2 lg:grid-cols-4';

  const subjectDisplayNames = {
    'maths': 'Combined Maths (Ruwan Darshana)',
    'chemistry': 'Chemistry (Amila Dasanayake)',
    'physics': 'Physics (Anuradha Perera)',
    'biology': 'Biology (Dinesh Muthugala)'
  };
  const titleDisplay = subjectDisplayNames[subject] || subject.toUpperCase();

  appContainer.innerHTML = `
        <div class="max-w-4xl mx-auto pt-8">
            <div class="flex items-center justify-between mb-8 flex-wrap gap-3">
                <button onclick="navigateTo('/recordings')" class="btn-ghost flex items-center gap-2 text-sm border border-[var(--glass-border)] hover:bg-[var(--glass-border)]">
                    <span>←</span> Back to Subjects
                </button>
                ${renderLectureYearSwitcher(currentYear, 'normal')}
            </div>
            <div class="text-center mb-8">
                <h2 class="text-3xl md:text-4xl font-bold text-[var(--text-primary)] mb-2 uppercase tracking-widest">${titleDisplay}</h2>
                <p class="text-sm text-[var(--text-secondary)]"><span class="font-bold text-indigo-400">${currentYear} A/L</span></p>
            </div>
            <div class="grid ${gridColsClass} gap-4 md:gap-6 mt-8">
                ${items.map(i => `<div onclick="navigateTo('/recording/${subject}/${i.id}')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center"><div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">${i.icon}</div><h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">${i.label}</h3></div>`).join('')}
            </div>
        </div>
    `;
}

export async function renderLessons(subject, type, navigate, user) {
  const currentYear = getLectureYear();

  if (currentYear === '2027' && (subject === 'com-maths-ruwan-full' || subject === 'biology' || subject === 'ravindu-ict')) {
    navigate('/recordings');
    return;
  }

  if (subject === 'vikum-maths' && type === 'supportive') {
    appContainer.innerHTML = `
        <div class="max-w-4xl mx-auto pt-8">
            <div class="flex items-center justify-between mb-8 flex-wrap gap-3">
                <button onclick="navigateTo('/recording/vikum-maths')" class="btn-ghost flex items-center gap-2 text-sm border border-[var(--glass-border)] hover:bg-[var(--glass-border)]">
                    <span>←</span> Back to Types
                </button>
                ${renderLectureYearSwitcher(currentYear, 'normal')}
            </div>
            <div class="text-center mb-8">
                <h2 class="text-4xl font-bold text-[var(--text-primary)] mb-2 uppercase tracking-widest">Combine Maths / Supportive</h2>
                <p class="text-sm text-[var(--text-secondary)]">Vikum Harshana • <span class="font-bold text-indigo-400">${currentYear} A/L</span></p>
            </div>
            <div class="grid grid-cols-2 gap-4 mt-8 max-w-xl mx-auto">
                <div id="vikum-resources-btn" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">📂</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Resources</h3>
                </div>
                <div onclick="navigateTo('/recording/vikum-maths/video/lesson01')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">🎥</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Video</h3>
                </div>
            </div>
        </div>
    `;

    const btn = document.getElementById('vikum-resources-btn');
    btn.onclick = async () => {
        let link = 'https://drive.google.com/drive/folders/1nQSEX2Q5cPhu-YsMpQUKWQuRh-0vqZ-G?usp=drive_link';
        try {
            const docSnap = await getDoc(doc(db, 'settings', 'vikum_resources'));
            if (docSnap.exists() && docSnap.data().link) {
                link = docSnap.data().link;
            }
        } catch (e) {
            console.error("Firestore read failed, falling back to default link:", e);
        }
        window.open(link, '_blank');
    };
    return;
  }

  if (subject === 'chemistry' && type === 'midnight') {
    appContainer.innerHTML = `
        <div class="max-w-4xl mx-auto pt-8">
            <div class="flex items-center justify-between mb-8 flex-wrap gap-3">
                <button onclick="navigateTo('/recording/chemistry')" class="btn-ghost flex items-center gap-2 text-sm border border-[var(--glass-border)] hover:bg-[var(--glass-border)]">
                    <span>←</span> Back to Types
                </button>
                ${renderLectureYearSwitcher(currentYear, 'normal')}
            </div>
            <div class="text-center mb-8">
                <h2 class="text-4xl font-bold text-[var(--text-primary)] mb-2 uppercase tracking-widest">Chemistry / Midnight Session</h2>
                <p class="text-sm text-[var(--text-secondary)]"><span class="font-bold text-indigo-400">${currentYear} A/L</span></p>
            </div>
            <div class="grid grid-cols-2 gap-4 mt-8 max-w-xl mx-auto">
                <div onclick="window.open('https://t.me/echemres26R/10559', '_blank')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">📂</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Resources</h3>
                </div>
                <div onclick="navigateTo('/recording/chemistry/midnight-video/lesson01')" class="smart-card hover:border-indigo-500 cursor-pointer group p-4 md:p-8 text-center">
                    <div class="text-3xl md:text-6xl mb-2 md:mb-4 group-hover:scale-110 transition-transform">🎥</div>
                    <h3 class="text-base md:text-2xl font-bold text-[var(--text-primary)]">Video</h3>
                </div>
            </div>
        </div>
    `;
    return;
  }

  const isRapid = type === 'rapid';
  const isUnitBased = (subject === 'com-maths-manoj' || subject === 'com-maths-ruwan-full');
  let maxLessons = isRapid ? 1 : (isUnitBased ? 15 : 20);
  if (subject === 'vikum-maths' && type === 'revision') {
    maxLessons = 30;
  }
  if (type === 'final-revise') {
    maxLessons = 2;
  }
  if (subject === 'vikum-maths' && type === 'rapid') {
    maxLessons = 5;
  }

  const isRapidSingle = isRapid && !(subject === 'vikum-maths' && type === 'rapid');
  const gridClass = isRapidSingle ? "grid grid-cols-1 max-w-lg mx-auto gap-4 mt-8" : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4";
  
  let displayType = type.replace('-', ' ');
  if (type === 'midnight-video') displayType = 'Midnight Session Video';

  const subjectDisplayNames = {
    'ravindu-ict': 'ICT',
    'vikum-maths': 'Combine Maths',
    'com-maths-manoj': currentYear === '2027' ? 'Combine Maths' : 'Combine Maths 2025',
    'com-maths-ruwan-full': 'Com Maths Full Syllabus 2025',
    'physics-nilantha': 'Physics',
    'chemistry': 'Chemistry',
    'physics': 'Physics',
    'maths': 'Combined Maths',
    'biology': 'Biology'
  };
  const subjectDisplay = subjectDisplayNames[subject] || subject.replace(/-/g, ' ');
  
  appContainer.innerHTML = `
        <div class="max-w-5xl mx-auto pt-8">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                <div>
                    <div class="flex items-center gap-2 mb-2 flex-wrap">
                        <button onclick="navigateTo('/recording/${subject}')" class="text-xs text-[var(--text-secondary)] hover:text-indigo-400 flex items-center gap-1 transition-colors">
                            <span>←</span> Back to Types
                        </button>
                        <span class="text-xs text-[var(--text-secondary)]">•</span>
                        <span class="text-xs font-bold px-2 py-0.5 rounded-full ${currentYear === '2026' ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'}">${currentYear} A/L</span>
                    </div>
                    <h2 class="text-2xl font-bold text-[var(--text-primary)] capitalize">${subjectDisplay} / ${displayType}</h2>
                </div>
                ${renderLectureYearSwitcher(currentYear, 'normal')}
            </div>
            <div class="${gridClass}" id="lesson-grid"><div class="animate-spin h-8 w-8 border-4 border-indigo-500 rounded-full border-t-transparent mx-auto"></div></div>
        </div>
    `;
  const lessonMap = {};
  try {
    const q = query(collection(db, "lessons"), where("subject", "==", subject), where("type", "==", type));
    const snap = await getDocs(q);
    snap.forEach(d => {
      const data = d.data();
      const docYear = data.year || '2026';
      if (currentYear === '2026') {
        if (docYear === '2026' || !data.year) {
          lessonMap[data.day] = data.title;
        }
      } else if (currentYear === '2027') {
        if (docYear === '2027') {
          lessonMap[data.day] = data.title;
        }
      }
    });
  } catch (e) { console.error(e); }
  const grid = document.getElementById('lesson-grid');
  grid.innerHTML = '';
  const canEdit = await checkCanEditLecture(user, subject);

  for (let i = 1; i <= maxLessons; i++) {
    const day = String(i).padStart(2, "0");
    let defaultTitle;
    if (type === 'final-revise') {
      defaultTitle = `${i} Month`;
    } else if (subject === 'vikum-maths' && type === 'rapid') {
      defaultTitle = `${i} Month`;
    } else if (isRapid) {
      defaultTitle = "Rapid Revision Content";
    } else if (isUnitBased) {
      defaultTitle = `Unit ${day}`;
    } else {
      defaultTitle = `Day ${day} Lesson`;
    }

    const title = lessonMap[day] || defaultTitle;
    const useBigCard = isRapid || type === 'final-revise';
    const card = document.createElement('div');
    
    if (useBigCard) {
        const icon = type === 'final-revise' ? '🎯' : '⚡';
        card.className = "smart-card p-8 flex flex-col justify-center items-center group cursor-pointer hover:border-indigo-500 transition-colors text-center shadow-lg relative";
        card.innerHTML = `
            <div class="w-full" onclick="navigateTo('/recording/${subject}/${type}/lesson${day}')">
                <div class="w-20 h-20 mx-auto rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-4xl mb-4 group-hover:scale-110 transition-transform">${icon}</div>
                <h3 class="text-2xl font-bold text-[var(--text-primary)]">${title}</h3>
                <p class="text-sm text-[var(--text-secondary)] mt-2">Click to view content</p>
            </div>
        `;
    } else {
        card.className = "smart-card p-4 flex justify-between items-center group cursor-pointer hover:bg-[var(--glass-border)]";
        card.innerHTML = `<div class="flex items-center gap-4" onclick="navigateTo('/recording/${subject}/${type}/lesson${day}')"><div class="w-10 h-10 rounded bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold">${day}</div><span class="font-medium text-[var(--text-primary)]">${title}</span></div>`;
    }

    if (canEdit) {
      const btn = document.createElement('button');
      if (useBigCard) {
          btn.innerHTML = `✎ Edit Title`;
          btn.className = "mt-6 text-indigo-400 hover:text-yellow-400 hover:bg-slate-800 p-2 px-4 font-bold bg-indigo-500/10 rounded-lg transition-colors border border-indigo-500/30";
          card.appendChild(btn);
      } else {
          btn.innerHTML = `✎`;
          btn.className = "text-[var(--text-secondary)] hover:text-yellow-400 p-2 invisible group-hover:visible";
          card.appendChild(btn);
      }
      
      btn.onclick = (e) => {
        e.stopPropagation();
        const newT = prompt("Rename Lesson:", title);
        if (newT) {
          const docId = currentYear === '2026' ? `${subject}_${type}_${day}` : `${subject}_${type}_${day}_${currentYear}`;
          setDoc(doc(db, "lessons", docId), { 
            title: newT, 
            subject, 
            type, 
            day, 
            year: currentYear,
            updatedAt: Date.now() 
          }).then(() => renderLessons(subject, type, navigate, user));
        }
      };
    }
    grid.appendChild(card);
  }
}

// --- Smart Mobile Side Drawer Navigation (Zero Emojis, Pure Crisp SVGs) ---
export function updateMobileNav(currentPath) {
  // Remove existing mobile drawer if any
  const existing = document.getElementById('mobile-drawer-root');
  if (existing) existing.remove();

  // Don't show on login/register pages
  if (currentPath === '/login' || currentPath === '/register' || currentPath === '/' || currentPath === '/welcome') {
    return;
  }

  const currentUser = auth.currentUser;
  const isHome = currentPath === '/home';
  const isTimetable = currentPath === '/timetable';
  const isRecordings = currentPath.startsWith('/recording') || currentPath === '/recordings';
  const isLive = currentPath === '/live';
  const isChat = currentPath === '/chat';
  const isSimulation = currentPath === '/simulation' || currentPath === '/organicgame';
  const isResources = currentPath === '/resources';
  const isContact = currentPath === '/contact';
  const isProfile = currentPath === '/profile';
  const isAdmin = currentPath === '/adminpanel';

  const drawerRoot = document.createElement('div');
  drawerRoot.id = 'mobile-drawer-root';
  drawerRoot.className = 'mobile-drawer-backdrop';
  drawerRoot.innerHTML = `
    <div class="mobile-drawer-panel" onclick="event.stopPropagation()">
        <!-- Drawer Header (App Brand & Close Button) -->
        <div class="p-4 border-b border-[var(--glass-border)] bg-[var(--bg-root)] flex items-center justify-between gap-3 shrink-0">
            <div class="flex items-center gap-2.5 cursor-pointer" onclick="window.closeMobileDrawer(); navigateTo('/home')">
                <div class="w-8 h-8 rounded-xl overflow-hidden shadow-md shadow-indigo-500/20 bg-white shrink-0">
                    <img src="/icon.png" alt="StudyTracker Logo" class="w-full h-full object-contain p-0.5">
                </div>
                <span class="text-base font-bold bg-clip-text text-transparent bg-gradient-to-r from-[var(--text-primary)] to-[var(--text-secondary)]">StudyTracker</span>
            </div>
            <button id="close-mobile-drawer-btn" class="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--glass-border)] cursor-pointer" title="Close">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>

        <!-- Navigation Links (Pure SVGs, No Emojis) -->
        <div class="flex-1 py-3 px-1 overflow-y-auto space-y-1">
            <div class="mobile-drawer-item ${isHome ? 'active' : ''}" onclick="window.closeMobileDrawer(); navigateTo('/home')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="7" height="9" rx="1"></rect>
                    <rect x="14" y="3" width="7" height="5" rx="1"></rect>
                    <rect x="14" y="12" width="7" height="9" rx="1"></rect>
                    <rect x="3" y="16" width="7" height="5" rx="1"></rect>
                </svg>
                <span>Dashboard</span>
            </div>

            <div class="mobile-drawer-item ${isTimetable ? 'active' : ''}" onclick="window.closeMobileDrawer(); navigateTo('/timetable')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="16" y1="2" x2="16" y2="6"></line>
                    <line x1="8" y1="2" x2="8" y2="6"></line>
                    <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                <span>Time Table</span>
            </div>

            <div class="mobile-drawer-item ${isRecordings ? 'active' : ''}" onclick="window.closeMobileDrawer(); navigateTo('/recordings')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7"></polygon>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                </svg>
                <span>Lectures & Lessons</span>
            </div>

            <div class="mobile-drawer-item ${isLive ? 'active' : ''} justify-between" onclick="window.closeMobileDrawer(); navigateTo('/live')">
                <div class="flex items-center gap-3">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4.93 4.93a10 10 0 0 1 14.14 0"></path>
                        <path d="M7.76 7.76a6 6 0 0 1 8.48 0"></path>
                        <circle cx="12" cy="12" r="2"></circle>
                        <path d="M12 14v8"></path>
                    </svg>
                    <span>Live Classes</span>
                </div>
                ${window._hasLiveClasses ? `<span class="w-2.5 h-2.5 rounded-full bg-red-500 shadow-md shadow-red-500/50 live-pulse-dot"></span>` : ''}
            </div>

            <div class="mobile-drawer-item ${isChat ? 'active' : ''} justify-between" onclick="window.closeMobileDrawer(); navigateTo('/chat')">
                <div class="flex items-center gap-3">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                    </svg>
                    <span>Chat Lounge</span>
                </div>
                <span id="chat-unread-badge-drawer" class="px-2 py-0.5 text-xs font-black rounded-full bg-gradient-to-r from-red-500 to-rose-600 text-white shadow-sm" style="display: ${window._unreadChatCount > 0 ? 'inline-flex' : 'none'};">
                    ${window._unreadChatCount > 99 ? '99+' : (window._unreadChatCount || '')}
                </span>
            </div>

            <div class="mobile-drawer-item ${isSimulation ? 'active' : ''}" onclick="window.closeMobileDrawer(); navigateTo('/simulation')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10 2v7.31L4.41 18.5A2 2 0 0 0 6 22h12a2 2 0 0 0 1.59-3.5L14 9.31V2"></path>
                    <line x1="8.5" y1="2" x2="15.5" y2="2"></line>
                    <line x1="7" y1="15" x2="17" y2="15"></line>
                </svg>
                <span>Simulation Labs</span>
            </div>

            <div class="mobile-drawer-item ${isResources ? 'active' : ''}" onclick="window.closeMobileDrawer(); navigateTo('/resources')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="2" y1="12" x2="22" y2="12"></line>
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                </svg>
                <span>Resources Web</span>
            </div>

            <div class="mobile-drawer-item ${isContact ? 'active' : ''}" onclick="window.closeMobileDrawer(); navigateTo('/contact')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                </svg>
                <span>Contact Support</span>
            </div>

            <div class="mobile-drawer-item ${isProfile ? 'active' : ''}" onclick="window.closeMobileDrawer(); navigateTo('/profile')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                </svg>
                <span>Profile Settings</span>
            </div>

            ${currentUser?.uid === ADMIN_UID ? `
            <div class="mobile-drawer-item ${isAdmin ? 'active' : ''} text-amber-300 font-bold" onclick="window.closeMobileDrawer(); navigateTo('/adminpanel')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                </svg>
                <span>Admin Dashboard</span>
            </div>
            ` : ''}
        </div>

        <!-- Drawer Footer -->
        <div class="p-3 border-t border-[var(--glass-border)] bg-[var(--bg-root)] flex items-center justify-between shrink-0">
            <button onclick="toggleTheme(); renderHeader(auth.currentUser, navigateTo, signOut)" class="flex items-center gap-2 text-xs font-bold text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-3 py-2 rounded-xl hover:bg-[var(--glass-border)] cursor-pointer">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="5"></circle>
                    <line x1="12" y1="1" x2="12" y2="3"></line>
                    <line x1="12" y1="21" x2="12" y2="23"></line>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                    <line x1="1" y1="12" x2="3" y2="12"></line>
                    <line x1="21" y1="12" x2="23" y2="12"></line>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                </svg>
                <span>Theme</span>
            </button>

            <button onclick="window.closeMobileDrawer(); signOut(auth); navigateTo('/login')" class="flex items-center gap-2 text-xs font-bold text-red-400 hover:text-red-300 px-3 py-2 rounded-xl hover:bg-red-500/10 cursor-pointer">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
                </svg>
                <span>Sign Out</span>
            </button>
        </div>
    </div>
  `;

  document.body.appendChild(drawerRoot);

  window.openMobileDrawer = () => {
    drawerRoot.classList.add('open');
  };

  window.closeMobileDrawer = () => {
    drawerRoot.classList.remove('open');
  };

  drawerRoot.onclick = () => {
    window.closeMobileDrawer();
  };

  const closeBtn = drawerRoot.querySelector('#close-mobile-drawer-btn');
  if (closeBtn) closeBtn.onclick = () => window.closeMobileDrawer();
}

// --- User Activity Tracking ---
export async function trackUserActivity(userId) {
  if (!userId) return;

  // Clear existing interval if any
  if (window._activityTrackingInterval) {
    clearInterval(window._activityTrackingInterval);
  }

  try {
    const today = getLocalDateString();
    const activityRef = doc(db, 'userActivity', `${userId}_${today}`);

    // Fetch existing first to check last active
    const snap = await getDoc(activityRef);
    let loginTimes = [];
    let previousLastActive = 0;
    
    if (snap.exists()) {
      const data = snap.data();
      loginTimes = data.loginTimes || [];
      previousLastActive = data.lastActive || 0;
    }

    // If more than 30 mins since last active, or first visit today, it's a new visit
    if (!previousLastActive || Date.now() - previousLastActive > 30 * 60 * 1000) {
      loginTimes.push(Date.now());
    }

    // Update or create activity document
    await setDoc(activityRef, {
      userId: userId,
      date: today,
      lastActive: Date.now(),
      loginTimes: loginTimes
    }, { merge: true });

    // Set up periodic updates (every 2 minutes while active)
    const intervalId = setInterval(async () => {
      try {
        await updateDoc(activityRef, {
          lastActive: Date.now()
        });
      } catch (e) {
        console.error('Activity tracking update failed:', e);
      }
    }, 2 * 60 * 1000);

    // Store interval ID for cleanup
    window._activityTrackingInterval = intervalId;
  } catch (error) {
    console.error('Failed to track user activity:', error);
  }
}

// --- New Year Popup ---
export function checkNewYearPopup(user) {
    if (!user) return;
    const today = new Date();
    const month = today.getMonth() + 1; // 1-12
    const date = today.getDate(); // 1-31
    const year = today.getFullYear();
    
    // Check if within April 12 to April 18
    if (month === 4 && date >= 12 && date <= 18) {
        const storageKey = `newYearPopupIgnored_${user.uid}`;
        const lastSeenDate = localStorage.getItem(storageKey);
        const currentDateString = `${year}-${month}-${date}`;
        
        if (lastSeenDate !== currentDateString) {
            showNewYearPopup(storageKey, currentDateString);
        }
    }
}

function showNewYearPopup(storageKey, currentDateString) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300';
    overlay.id = 'new-year-overlay';
    
    // Start fireworks
    let duration = 60 * 1000;
    let animationEnd = Date.now() + duration;
    let defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 101, colors: ['#26ccff', '#a25afd', '#ff5e7e', '#88ff5a', '#fcff42', '#ffa62d', '#ff36ff'] };
    let fireworksInterval;

    function stopFireworks() {
        if (fireworksInterval) clearInterval(fireworksInterval);
    }

    if (window.confetti) {
        function randomInRange(min, max) { return Math.random() * (max - min) + min; }
        fireworksInterval = setInterval(function() {
            var timeLeft = animationEnd - Date.now();
            if (timeLeft <= 0) { return stopFireworks(); }
            var particleCount = 50 * (timeLeft / duration);
            window.confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } }));
            window.confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } }));
        }, 250);
    }

    const modal = document.createElement('div');
    modal.className = 'bg-[var(--bg-secondary)] border-2 border-indigo-500/50 p-6 rounded-2xl shadow-[0_0_40px_rgba(79,70,229,0.4)] w-[90%] max-w-sm mx-auto text-center transform scale-0 transition-transform duration-500 ease-out z-[102] relative';
    
    modal.innerHTML = `
        <h2 class="text-[clamp(1.25rem,5vw,1.75rem)] font-bold text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-yellow-200 to-yellow-400 mb-4 drop-shadow-md pb-1">සුභම සුභ අලුත් අවුරුද්දක් වේවා!</h2>
        <img src="/new_year.png" alt="Happy New Year" class="w-full h-auto max-h-[50vh] rounded-xl mb-6 shadow-md border border-[var(--glass-border)] object-contain bg-black/20">
        <button id="close-ny-popup" class="btn-primary w-full py-3 shadow-lg hover:shadow-indigo-500/30 transition-all font-bold text-sm sm:text-base">Close & Celebrate</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Animate in
    setTimeout(() => { modal.style.transform = 'scale(1)'; }, 10);

    const closePopup = () => {
        localStorage.setItem(storageKey, currentDateString);
        stopFireworks();
        modal.style.transform = 'scale(0)';
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 300);
    };

    document.getElementById('close-ny-popup').onclick = closePopup;
    overlay.onclick = (e) => {
        if (e.target === overlay) closePopup();
    };
}

// --- Contact Us ---
export function renderContact(navigate, user) {
    if (user) {
        headerElement.style.display = 'flex';
    } else {
        headerElement.style.display = 'none';
    }

    appContainer.innerHTML = `
        <div class="flex min-h-[80vh] items-center justify-center p-4">
            <div class="smart-card w-full max-w-lg bg-[var(--bg-secondary)] relative border border-indigo-500/20">
                ${!user ? `
                <div class="absolute top-4 left-4 z-10">
                    <button onclick="window.navigateTo('/login')" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1 font-medium bg-[var(--bg-root)] px-3 py-1 rounded-lg border border-[var(--glass-border)]">
                        <span class="text-xl">&larr;</span> Back
                    </button>
                </div>
                ` : ''}
                <div class="text-center mb-6 mt-4">
                    <div class="flex justify-center mb-4">
                        <div class="w-16 h-16 rounded-2xl shadow-xl shadow-indigo-500/20 overflow-hidden bg-white">
                            <img src="/icon.png" alt="StudyTracker Logo" class="w-full h-full object-contain p-1">
                        </div>
                    </div>
                    <h2 class="text-2xl font-bold text-[var(--text-primary)]">Contact Us</h2>
                    <p class="text-[var(--text-secondary)] text-sm mt-1">We are here to help you</p>
                </div>
                
                <div class="space-y-6">
                    <div class="bg-[var(--bg-root)] p-4 rounded-xl border border-[var(--glass-border)] flex items-center gap-4 hover:shadow-lg transition-all">
                        <div class="w-12 h-12 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-400 text-2xl shrink-0">📧</div>
                        <div>
                            <p class="text-xs text-[var(--text-secondary)] uppercase font-bold tracking-wider">Email Contact</p>
                            <a href="mailto:studytrackerproadmin@gmail.com" class="text-[var(--text-primary)] font-medium hover:text-indigo-400 transition-colors break-all">studytrackerproadmin@gmail.com</a>
                        </div>
                    </div>

                    <div class="bg-[var(--bg-root)] p-4 rounded-xl border border-[var(--glass-border)] flex items-center gap-4 cursor-pointer hover:bg-[var(--glass-border)] hover:shadow-lg transition-all" onclick="window.open('https://t.me/StudyTrackerHelp', '_blank')">
                        <div class="w-12 h-12 rounded-full bg-[#0088cc]/20 flex items-center justify-center text-[#0088cc] text-2xl shrink-0">
                           <svg class="w-7 h-7" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>
                        </div>
                        <div>
                            <p class="text-xs text-[var(--text-secondary)] uppercase font-bold tracking-wider">Telegram Support</p>
                            <span class="text-[var(--text-primary)] font-medium text-[#0088cc]">@StudyTrackerHelp</span>
                        </div>
                    </div>

                    <form id="contact-form" class="space-y-4 pt-4 border-t border-[var(--glass-border)]" action="javascript:void(0);" method="POST">
                        <p class="text-sm text-[var(--text-secondary)] mb-2 text-center">Or send us a message directly and we will reply via WhatsApp:</p>
                        <input type="email" name="email" placeholder="Your Email Address" class="smart-input w-full" required value="${user ? user.email : ''}" ${user ? 'readonly' : ''}>
                        <input type="tel" name="whatsapp" placeholder="Your WhatsApp Number (e.g. 07XXXXXXXX)" class="smart-input w-full" pattern="[0-9]{10}" maxlength="10" title="Please enter exactly 10 digits" required>
                        <textarea name="message" placeholder="Your Question or Message..." class="smart-input w-full min-h-[120px] resize-y p-3" required></textarea>
                        <button type="submit" class="w-full bg-gradient-to-r from-indigo-500 to-cyan-500 text-white font-bold py-3 rounded-xl hover:shadow-lg hover:shadow-indigo-500/30 transition-all flex items-center justify-center gap-2">
                            <span>Send Message</span>
                            <span class="text-lg">✉️</span>
                        </button>
                    </form>
                </div>
            </div>
        </div>
    `;

    document.getElementById('contact-form').onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const email = sanitizeInput((f.get('email') || '').trim());
        const whatsapp = sanitizeInput((f.get('whatsapp') || '').trim());
        const message = sanitizeInput((f.get('message') || '').trim());
        const btn = e.target.querySelector('button[type="submit"]');

        btn.disabled = true;
        btn.innerHTML = '<span class="animate-pulse">Sending...</span>';

        try {
            await addDoc(collection(db, 'contactMessages'), {
                email,
                whatsapp,
                message,
                userId: user ? user.uid : null,
                createdAt: new Date().toISOString(),
                status: 'unread'
            });

            alert('Your message has been sent successfully. We will contact you via WhatsApp soon!');
            if (!user) {
                e.target.reset();
            } else {
                e.target.whatsapp.value = '';
                e.target.message.value = '';
            }
        } catch (err) {
            console.error(err);
            alert('Failed to send message. Please try again or use Telegram/Email directly.');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span>Send Message</span><span class="text-lg">✉️</span>';
        }
    };
}

export function renderSimulation(navigate) {
  const appContainer = document.getElementById('app-container');
  appContainer.innerHTML = `
        <div id="simulation-testing-popup" class="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[100] transition-opacity duration-300">
            <div class="bg-[var(--bg-secondary)] border-2 border-indigo-500/50 p-8 rounded-2xl shadow-[0_0_40px_rgba(79,70,229,0.4)] w-[90%] max-w-md mx-auto text-center transform scale-95 transition-transform duration-300">
                <div class="text-6xl mb-4">🧪</div>
                <h3 class="text-2xl font-bold text-white mb-4">Simulation Under Testing</h3>
                <p class="text-slate-300 mb-6">Please note that the simulation features are currently in Testing Mode.</p>
                <button onclick="document.getElementById('simulation-testing-popup').remove()" class="btn-primary w-full py-3 font-bold text-lg">OK</button>
            </div>
        </div>
        <div class="max-w-4xl mx-auto pt-8 pb-12">
            <div class="text-center mb-12">
                <h1 class="text-4xl font-bold text-[var(--text-primary)] mb-4">Interactive Simulations</h1>
                <p class="text-lg text-[var(--text-secondary)]">Choose a subject to dive into our immersive learning environments.</p>
            </div>
            
            <div class="grid md:grid-cols-2 gap-8">
                <!-- Physics Card -->
                <div onclick="alert('ඉදිරියේදි මෙය ඔබට ලැබෙනු ඇත')" class="smart-card cursor-pointer group hover:border-blue-500 transition-all text-center p-12 flex flex-col items-center">
                    <div class="text-8xl mb-6 group-hover:scale-110 transition-transform">⚛️</div>
                    <h2 class="text-3xl font-bold text-[var(--text-primary)] mb-2">Physics</h2>
                    <p class="text-[var(--text-secondary)]">Explore mechanics, waves, and quantum phenomena.</p>
                </div>
                
                <!-- Chemistry Card -->
                <div id="chemistry-card" class="smart-card cursor-pointer group hover:border-cyan-500 transition-all text-center p-12 flex flex-col items-center relative overflow-hidden">
                    <div id="chemistry-initial">
                        <div class="text-8xl mb-6 group-hover:scale-110 transition-transform">🧪</div>
                        <h2 class="text-3xl font-bold text-[var(--text-primary)] mb-2">Chemistry</h2>
                        <p class="text-[var(--text-secondary)]">Master reactions, organic conversions, and physical chemistry.</p>
                    </div>
                    
                    <div id="chemistry-sub" class="absolute inset-0 bg-[var(--bg-secondary)] flex flex-col items-center justify-center translate-y-full transition-transform duration-300">
                        <h3 class="text-2xl font-bold text-[var(--text-primary)] mb-6">Select Sub-Topic</h3>
                        <div class="flex gap-4">
                            <button onclick="navigateTo('/organicgame')" class="btn-primary py-3 px-6 rounded-xl flex items-center gap-2 text-lg">
                                <span>⬡</span> Organic Chemistry
                            </button>
                        </div>
                        <button id="chemistry-back" class="mt-8 text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline">Back</button>
                    </div>
                </div>
            </div>
        </div>
    `;

  document.getElementById('chemistry-card').onclick = (e) => {
    if (e.target.closest('#chemistry-back') || e.target.closest('button')) return;
    document.getElementById('chemistry-sub').classList.remove('translate-y-full');
  };
  
  document.getElementById('chemistry-back').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('chemistry-sub').classList.add('translate-y-full');
  };
}

export async function renderOrganicGame() {
  const appContainer = document.getElementById('app-container');
  appContainer.innerHTML = `
    <div id="organic-game-root" style="width: 100%; height: 100%; min-height: calc(100vh - 80px);">
        <div style="display: flex; justify-content: center; align-items: center; height: 100%;">
            <div class="animate-pulse text-[var(--text-primary)]">Loading Chemistry Engine...</div>
        </div>
    </div>
  `;

  if (window.mountChemistryGame) {
    window.mountChemistryGame();
    return;
  }

  try {
    const htmlResponse = await fetch('/organic/index.html?t=' + Date.now(), { cache: 'no-store' });
    const htmlText = await htmlResponse.text();
    
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    
    doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      const href = link.getAttribute('href');
      if (!document.querySelector(`link[href="${href}"]`)) {
        const newLink = document.createElement('link');
        newLink.rel = 'stylesheet';
        newLink.href = href;
        document.head.appendChild(newLink);
      }
    });

    doc.querySelectorAll('script').forEach(script => {
      const src = script.getAttribute('src');
      if (src && !document.querySelector(`script[src="${src}"]`)) {
        const newScript = document.createElement('script');
        newScript.type = script.getAttribute('type') || 'text/javascript';
        newScript.src = src;
        if (script.hasAttribute('crossorigin')) {
           newScript.crossOrigin = script.getAttribute('crossorigin');
        }
        document.body.appendChild(newScript);
      }
    });
  } catch (error) {
    console.error(error);
    appContainer.innerHTML = `<div class="text-center p-8 text-red-500">Failed to load game environment.</div>`;
  }
}

export function renderResources(navigate) {
  const appContainer = document.getElementById('app-container');
  appContainer.innerHTML = `
    <div class="max-w-6xl mx-auto pt-8 pb-12 px-4">
      <div class="text-center mb-12 fade-in">
        <h1 class="text-4xl md:text-5xl font-extrabold text-[var(--text-primary)] mb-4 tracking-tight">
          <span class="bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">Resources Web</span>
        </h1>
        <p class="text-lg text-[var(--text-secondary)] max-w-2xl mx-auto">
          Explore and access Combined Mathematics, Physics resources, web systems, and mobile applications from MathsRecoding.
        </p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 fade-in">
        <!-- Card 1: Combine Paper Marking -->
        <a href="https://combine.mathsrecoding.com" target="_blank" class="smart-card group hover:border-indigo-500/50 transition-all flex flex-col justify-between h-full relative overflow-hidden bg-gradient-to-br from-slate-900/40 to-slate-950/20 backdrop-blur-xl border border-white/5 shadow-2xl p-6 rounded-2xl hover:-translate-y-2 duration-300">
          <div class="absolute -top-10 -right-10 w-24 h-24 bg-indigo-500/10 rounded-full blur-2xl group-hover:bg-indigo-500/20 transition-all duration-300"></div>
          <div>
            <div class="w-14 h-14 rounded-2xl bg-indigo-500/10 flex items-center justify-center text-3xl mb-5 border border-indigo-500/20 group-hover:scale-110 transition-transform duration-300">
              📝
            </div>
            <h3 class="text-xl font-bold text-white mb-2 group-hover:text-indigo-400 transition-colors">
              Combine Paper Marking
            </h3>
            <p class="text-slate-400 text-sm leading-relaxed mb-6">
              Access the official Combined Mathematics Paper Marking resources. Track guidelines, schemes, and evaluations.
            </p>
          </div>
          <div class="flex items-center text-indigo-400 font-semibold text-sm group-hover:translate-x-1 transition-transform">
            Visit Website <span class="ml-2">→</span>
          </div>
        </a>

        <!-- Card 2: Physics F To A plan AP -->
        <a href="https://physics.mathsrecoding.com" target="_blank" class="smart-card group hover:border-pink-500/50 transition-all flex flex-col justify-between h-full relative overflow-hidden bg-gradient-to-br from-slate-900/40 to-slate-950/20 backdrop-blur-xl border border-white/5 shadow-2xl p-6 rounded-2xl hover:-translate-y-2 duration-300">
          <div class="absolute -top-10 -right-10 w-24 h-24 bg-pink-500/10 rounded-full blur-2xl group-hover:bg-pink-500/20 transition-all duration-300"></div>
          <div>
            <div class="w-14 h-14 rounded-2xl bg-pink-500/10 flex items-center justify-center text-3xl mb-5 border border-pink-500/20 group-hover:scale-110 transition-transform duration-300">
              ⚛️
            </div>
            <h3 class="text-xl font-bold text-white mb-2 group-hover:text-pink-400 transition-colors">
              Physics F To A plan AP
            </h3>
            <p class="text-slate-400 text-sm leading-relaxed mb-6">
              Boost your Physics grades with the structured F To A study plan. Complete resources for theory, revisions, and exam prep.
            </p>
          </div>
          <div class="flex items-center text-pink-400 font-semibold text-sm group-hover:translate-x-1 transition-transform">
            Visit Website <span class="ml-2">→</span>
          </div>
        </a>

        <!-- Card 3: Time Reminder Site -->
        <a href="https://time.mathsrecoding.com" target="_blank" class="smart-card group hover:border-cyan-500/50 transition-all flex flex-col justify-between h-full relative overflow-hidden bg-gradient-to-br from-slate-900/40 to-slate-950/20 backdrop-blur-xl border border-white/5 shadow-2xl p-6 rounded-2xl hover:-translate-y-2 duration-300">
          <div class="absolute -top-10 -right-10 w-24 h-24 bg-cyan-500/10 rounded-full blur-2xl group-hover:bg-cyan-500/20 transition-all duration-300"></div>
          <div>
            <div class="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-3xl mb-5 border border-cyan-500/20 group-hover:scale-110 transition-transform duration-300">
              ⏰
            </div>
            <h3 class="text-xl font-bold text-white mb-2 group-hover:text-cyan-400 transition-colors">
              Time Reminder Site
            </h3>
            <p class="text-slate-400 text-sm leading-relaxed mb-6">
              Online scheduling and tracking system. Organize your alarms, reminders, and study plans efficiently from any web browser.
            </p>
          </div>
          <div class="flex items-center text-cyan-400 font-semibold text-sm group-hover:translate-x-1 transition-transform">
            Visit Website <span class="ml-2">→</span>
          </div>
        </a>

        <!-- Card 4: Time Reminder Android App -->
        <a href="/Edu.apk" download class="smart-card group hover:border-emerald-500/50 transition-all flex flex-col justify-between h-full relative overflow-hidden bg-gradient-to-br from-slate-900/40 to-slate-950/20 backdrop-blur-xl border border-white/5 shadow-2xl p-6 rounded-2xl hover:-translate-y-2 duration-300">
          <div class="absolute -top-10 -right-10 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl group-hover:bg-emerald-500/20 transition-all duration-300"></div>
          <div>
            <div class="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-3xl mb-5 border border-emerald-500/20 group-hover:scale-110 transition-transform duration-300">
              📲
            </div>
            <h3 class="text-xl font-bold text-white mb-2 group-hover:text-emerald-400 transition-colors">
              Time Reminder Android App
            </h3>
            <span class="absolute top-4 right-4 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-bold text-[10px] px-2 py-0.5 rounded-full">
              APK Download
            </span>
            <p class="text-slate-400 text-sm leading-relaxed mb-6">
              Download the official Time Reminder Android Application. Stay connected to your studies with local notifications and alarms.
            </p>
          </div>
          <div class="flex items-center text-emerald-400 font-semibold text-sm group-hover:translate-x-1 transition-transform">
            Download App <span class="ml-2">↓</span>
          </div>
        </a>
      </div>
    </div>
  `;
}

/* ========================================================================= */
/* ===== EXAM TIMETABLE POPUP CODE - DISABLED (PRESERVED AS TEXT ONLY) ===== */
/* ========================================================================= */

// Safe fallback exports
export function checkExamTimetablePopup(user) {}
export function showExamTimetablePopup() {}
window.showExamTimetablePopup = showExamTimetablePopup;

/*
--- PRESERVED A/L EXAM TIMETABLE POPUP CODE ---

const EXAM_TIMETABLE_DATA = [
  { id: 'cm1', subject: 'Combine Maths I', dateStr: 'අගෝස්තු 10', timeStr: '08.30 - 11.40', start: new Date(2026, 7, 10, 8, 30), end: new Date(2026, 7, 10, 11, 40), tag: 'Maths' },
  { id: 'cm2', subject: 'Combine Maths II', dateStr: 'අගෝස්තු 12', timeStr: '08.30 - 11.40', start: new Date(2026, 7, 12, 8, 30), end: new Date(2026, 7, 12, 11, 40), tag: 'Maths' },
  
  { id: 'bio1', subject: 'Biology I', dateStr: 'අගෝස්තු 10', timeStr: '13.00 - 15.00', start: new Date(2026, 7, 10, 13, 0), end: new Date(2026, 7, 10, 15, 0), tag: 'Biology' },
  { id: 'bio2', subject: 'Biology II', dateStr: 'අගෝස්තු 11', timeStr: '13.00 - 16.10', start: new Date(2026, 7, 11, 13, 0), end: new Date(2026, 7, 11, 16, 10), tag: 'Biology' },

  { id: 'phy1', subject: 'Physics I', dateStr: 'අගෝස්තු 14', timeStr: '08.30 - 10.30', start: new Date(2026, 7, 14, 8, 30), end: new Date(2026, 7, 14, 10, 30), tag: 'Physics' },
  { id: 'phy2', subject: 'Physics II', dateStr: 'අගෝස්තු 17', timeStr: '08.30 - 11.40', start: new Date(2026, 7, 17, 8, 30), end: new Date(2026, 7, 17, 11, 40), tag: 'Physics' },

  { id: 'chem1', subject: 'Chemistry I', dateStr: 'අගෝස්තු 19', timeStr: '08.30 - 10.30', start: new Date(2026, 7, 19, 8, 30), end: new Date(2026, 7, 19, 10, 30), tag: 'Chemistry' },
  { id: 'chem2', subject: 'Chemistry II', dateStr: 'අගෝස්තු 21', timeStr: '08.30 - 11.40', start: new Date(2026, 7, 21, 8, 30), end: new Date(2026, 7, 21, 11, 40), tag: 'Chemistry' },

  { id: 'eng1', subject: 'General English I', dateStr: 'අගෝස්තු 24', timeStr: '13.00 - 14.00', start: new Date(2026, 7, 24, 13, 0), end: new Date(2026, 7, 24, 14, 0), tag: 'English' },
  { id: 'eng2', subject: 'General English II', dateStr: 'අගෝස්තු 24', timeStr: '08.30 - 11.40', start: new Date(2026, 7, 24, 8, 30), end: new Date(2026, 7, 24, 11, 40), tag: 'English' },

  { id: 'ict1', subject: 'ICT I', dateStr: 'අගෝස්තු 29', timeStr: '13.00 - 15.00', start: new Date(2026, 7, 29, 13, 0), end: new Date(2026, 7, 29, 15, 0), tag: 'ICT' },
  { id: 'ict2', subject: 'ICT II', dateStr: 'සැප්තැම්බර් 01', timeStr: '08.30 - 11.40', start: new Date(2026, 8, 1, 8, 30), end: new Date(2026, 8, 1, 11, 40), tag: 'ICT' },

  { id: 'ct', subject: 'Common Test', dateStr: 'අගෝස්තු 22', timeStr: '08.30 - 10.30', start: new Date(2026, 7, 22, 8, 30), end: new Date(2026, 7, 22, 10, 30), tag: 'General', isFullWidth: true }
];

let examPopupTimerId = null;

function calculateExamHoursInfo(exam, now = new Date()) {
    const startMs = exam.start.getTime();
    const endMs = exam.end.getTime();
    const nowMs = now.getTime();

    if (nowMs > endMs) {
        return {
            status: 'completed',
            isUpcoming: false,
            badgeHtml: `
                <div class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/90 text-slate-400 border border-slate-700 text-xs font-bold">
                    <span>✅ අවසන් (Finished)</span>
                </div>
            `
        };
    }

    if (nowMs >= startMs && nowMs <= endMs) {
        return {
            status: 'ongoing',
            isUpcoming: false,
            badgeHtml: `
                <div class="inline-flex flex-col items-start sm:items-end px-3 py-1.5 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                    <span class="text-xs sm:text-sm font-black">⚡ දැනට පැවැත්වේ (Ongoing)</span>
                    <span class="text-[10px]">ප්‍රශ්න පත්‍රයට පිළිතුරු ලියන වෙලාවයි</span>
                </div>
            `
        };
    }

    const diffMs = startMs - nowMs;
    const totalHoursInt = Math.floor(diffMs / (1000 * 60 * 60));
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hoursRem = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minsRem = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const secsRem = Math.floor((diffMs % (1000 * 60)) / 1000);

    const pad = (n) => String(n).padStart(2, '0');

    let borderColor = totalHoursInt <= 24 
        ? 'border-rose-500/40 bg-rose-500/10' 
        : totalHoursInt <= 72 
            ? 'border-amber-500/40 bg-amber-500/10' 
            : 'border-indigo-500/30 bg-indigo-500/10';

    let secColor = totalHoursInt <= 24 ? 'text-rose-400 border-rose-500/50' : 'text-cyan-400 border-cyan-500/50';

    const badgeHtml = `
        <div class="inline-flex flex-col items-start sm:items-end px-3 py-1.5 rounded-xl border ${borderColor} w-full sm:w-auto shadow-inner">
            <div class="flex items-center gap-1 font-mono text-xs sm:text-sm font-black tracking-wider">
                <span class="bg-black/60 px-1.5 py-0.5 rounded border border-white/10 text-white">${pad(days)}<span class="text-[9px] text-slate-400 font-normal ml-0.5">d</span></span>
                <span class="text-slate-400 font-bold">:</span>
                <span class="bg-black/60 px-1.5 py-0.5 rounded border border-white/10 text-white">${pad(hoursRem)}<span class="text-[9px] text-slate-400 font-normal ml-0.5">h</span></span>
                <span class="text-slate-400 font-bold">:</span>
                <span class="bg-black/60 px-1.5 py-0.5 rounded border border-white/10 text-white">${pad(minsRem)}<span class="text-[9px] text-slate-400 font-normal ml-0.5">m</span></span>
                <span class="text-slate-400 font-bold">:</span>
                <span class="bg-black/60 px-1.5 py-0.5 rounded border ${secColor} font-extrabold animate-pulse">${pad(secsRem)}<span class="text-[9px] opacity-80 font-normal ml-0.5">s</span></span>
            </div>
            <div class="text-[10px] font-bold text-indigo-300/90 mt-1">
                ⏱️ තව පැය ${totalHoursInt} යි (Total: ${totalHoursInt} hrs)
            </div>
        </div>
    `;

    return {
        status: 'upcoming',
        isUpcoming: true,
        badgeHtml
    };
}

function checkExamTimetablePopupOriginal(user) {
    if (!user) return;
    showExamTimetablePopupOriginal();
}

function showExamTimetablePopupOriginal() {
    const existingOverlay = document.getElementById('exam-timetable-overlay');
    if (existingOverlay) existingOverlay.remove();

    if (examPopupTimerId) {
        clearInterval(examPopupTimerId);
        examPopupTimerId = null;
    }

    const overlay = document.createElement('div');
    overlay.id = 'exam-timetable-overlay';
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-5 transition-opacity duration-300 opacity-0';

    const modal = document.createElement('div');
    modal.className = 'bg-[#111827]/95 border border-indigo-500/30 w-full max-w-[95vw] md:max-w-4xl rounded-2xl shadow-2xl shadow-indigo-950/50 flex flex-col max-h-[90vh] overflow-hidden transform scale-95 transition-all duration-300 relative';

    modal.innerHTML = `
        <!-- Modal Header -->
        <div class="p-4 sm:p-5 border-b border-white/10 bg-gradient-to-r from-indigo-950/80 via-slate-900 to-purple-950/80 relative flex items-center justify-between">
            <div class="flex items-center gap-3 pr-8">
                <div class="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-xl shadow-inner shrink-0">
                    ⏳
                </div>
                <div>
                    <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 mb-1">
                        A/L 2026 Live Countdown
                    </div>
                    <h2 class="text-lg sm:text-xl font-bold text-white leading-tight">විභාග කාලසටහන (Exam Schedule)</h2>
                </div>
            </div>
            <!-- Close Button X -->
            <button id="close-exam-popup-x" class="text-slate-400 hover:text-white bg-white/5 hover:bg-white/15 border border-white/10 w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0">
                ✕
            </button>
        </div>

        <!-- Wish Banner Top (Fixed, Unclipped) -->
        <div class="px-4 py-3 sm:py-4 bg-gradient-to-r from-amber-500/20 via-indigo-950/90 to-purple-950/90 border-b border-amber-400/30 text-center relative shrink-0">
            <h3 class="text-base sm:text-xl md:text-2xl font-black text-amber-300 drop-shadow-md flex items-center justify-center gap-2 flex-wrap leading-normal">
                <span>🎓</span>
                <span>Wish You All the Best for A/L 2026!</span>
                <span>✨</span>
            </h3>
            <p class="text-xs sm:text-sm font-semibold text-slate-200 mt-1">
                ඔබගේ උසස් පෙළ විභාගයට උණුසුම් සුභ පැතුම්!
            </p>
        </div>

        <!-- Exam List Container (2 Columns on Desktop, 1 Column on Mobile) -->
        <div id="exam-popup-list" class="p-3 sm:p-5 grid grid-cols-1 md:grid-cols-2 gap-3 overflow-y-auto max-h-[60vh] custom-scrollbar">
            <!-- Timetable cards rendered dynamically -->
        </div>

        <!-- Modal Footer -->
        <div class="p-3 sm:p-4 border-t border-white/10 bg-slate-900/90 flex items-center justify-end">
            <button id="close-exam-popup-btn" class="w-full sm:w-auto px-6 py-2.5 rounded-xl font-bold text-sm bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-600/30 transition-all cursor-pointer flex items-center justify-center gap-2">
                <span>Close</span>
                <span>✕</span>
            </button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function renderListItems() {
        const listContainer = document.getElementById('exam-popup-list');
        if (!listContainer) return;

        const now = new Date();

        let html = '';

        EXAM_TIMETABLE_DATA.forEach((exam) => {
            const info = calculateExamHoursInfo(exam, now);

            let tagColor = 'bg-slate-700/50 text-slate-300';
            if (exam.tag === 'Maths') tagColor = 'bg-blue-500/20 text-blue-300 border-blue-500/30';
            if (exam.tag === 'Physics') tagColor = 'bg-purple-500/20 text-purple-300 border-purple-500/30';
            if (exam.tag === 'Chemistry') tagColor = 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30';
            if (exam.tag === 'Biology') tagColor = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
            if (exam.tag === 'ICT') tagColor = 'bg-pink-500/20 text-pink-300 border-pink-500/30';

            const fullSpanClass = exam.isFullWidth ? 'md:col-span-2' : '';

            html += `
                <div class="p-3 sm:p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 hover:border-indigo-500/30 transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 ${fullSpanClass}">
                    <div class="space-y-1">
                        <div class="flex items-center gap-2 flex-wrap">
                            <h4 class="font-bold text-sm sm:text-base text-slate-100">${exam.subject}</h4>
                            <span class="text-[10px] px-2 py-0.5 rounded-md border font-semibold ${tagColor}">${exam.tag}</span>
                        </div>
                        <div class="flex items-center gap-3 text-xs text-slate-400">
                            <span class="flex items-center gap-1 font-medium text-indigo-300">
                                📆 ${exam.dateStr}
                            </span>
                            <span class="flex items-center gap-1">
                                ⏰ ${exam.timeStr}
                            </span>
                        </div>
                    </div>

                    <!-- Live Countdown Badge -->
                    <div class="w-full sm:w-auto text-left sm:text-right shrink-0">
                        ${info.badgeHtml}
                    </div>
                </div>
            `;
        });

        listContainer.innerHTML = html;
    }

    renderListItems();
    // Live update every 1 second (1000ms) for countdown ticker
    examPopupTimerId = setInterval(renderListItems, 1000);

    requestAnimationFrame(() => {
        overlay.classList.remove('opacity-0');
        modal.classList.remove('scale-95');
    });

    const closeHandler = () => {
        if (examPopupTimerId) {
            clearInterval(examPopupTimerId);
            examPopupTimerId = null;
        }
        overlay.classList.add('opacity-0');
        modal.classList.add('scale-95');
        setTimeout(() => overlay.remove(), 300);
    };

    document.getElementById('close-exam-popup-x').onclick = closeHandler;
    document.getElementById('close-exam-popup-btn').onclick = closeHandler;

    overlay.onclick = (e) => {
        if (e.target === overlay) closeHandler();
    };
}
*/
/* ========================================================================= */
/* ===== EXAM TIMETABLE POPUP CODE - END =================================== */
/* ========================================================================= */

/* ========================================================================= */
/* ===== 2027 A/L BATCH UPGRADE POPUP (STARTS SEPT 2 MIDNIGHT) ===== */
/* ========================================================================= */

export function isBatchTransitionPeriod() {
  // Starts September 2, 2026 at 00:00:00 (Sri Lanka time UTC+5:30)
  const transitionStart = new Date('2026-09-02T00:00:00+05:30').getTime();
  return Date.now() >= transitionStart;
}

export async function checkLectureHallAccess(user, navigateTo) {
  if (!user || user.uid === ADMIN_UID) return true;

  if (!isBatchTransitionPeriod()) return true;

  try {
    const userDocSnap = await getDoc(doc(db, 'users', user.uid));
    if (userDocSnap.exists()) {
      const userData = userDocSnap.data();
      userProfileCache[user.uid] = userData;
      if (userData.examYear !== '2027 A/L') {
        showBatchUpgradePopup(user, navigateTo, userData);
        return false;
      }
    } else {
      showBatchUpgradePopup(user, navigateTo, {});
      return false;
    }
  } catch (err) {
    console.error("Error checking lecture hall batch access:", err);
  }
  return true;
}

export function showBatchUpgradePopup(user, navigateTo, userData = {}) {
  // Remove existing if any
  const existing = document.getElementById('batch-upgrade-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'batch-upgrade-overlay';
  overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 transition-opacity duration-300 opacity-0';

  overlay.innerHTML = `
    <div id="batch-upgrade-modal" class="smart-card w-full max-w-md bg-[var(--bg-secondary)] border-2 border-indigo-500/40 shadow-2xl relative p-6 text-center transform scale-95 transition-transform duration-300">
        <div class="w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center mx-auto mb-4 text-3xl shadow-lg shadow-indigo-500/30">
            🎓
        </div>
        <h3 class="text-2xl font-bold text-[var(--text-primary)] mb-1">Exam Batch Update</h3>
        <p class="text-xs text-indigo-400 font-semibold uppercase tracking-wider mb-4">2nd Shy / 2027 A/L Transition</p>
        
        <div class="bg-[var(--bg-root)] p-4 rounded-xl border border-[var(--glass-border)] mb-5 text-sm text-[var(--text-secondary)] leading-relaxed text-left">
            <p class="mb-2 font-medium text-[var(--text-primary)]">
                📢 <strong>Lecture Hall 📚</strong> වෙත ප්‍රවේශ වීම සඳහා කරුණාකර ඔබගේ Exam Year එක <span class="text-indigo-400 font-bold">2027 A/L</span> ලෙස යාවත්කාලීන කරන්න.
            </p>
            <p class="text-xs text-[var(--text-secondary)] opacity-85">
                (Please update your Exam Year to <strong>2027 A/L</strong> to access the Lecture Hall & recordings.)
            </p>
        </div>

        <div class="bg-[var(--bg-root)] p-4 rounded-xl border border-[var(--glass-border)] mb-6 text-left">
            <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-2 block">New Exam Year</label>
            <select id="upgrade-exam-year-select" class="smart-input w-full font-bold text-indigo-400">
                <option value="2027 A/L" selected>2027 A/L (2nd Shy / 2027 Batch)</option>
            </select>
        </div>

        <div class="flex flex-col gap-3">
            <button id="confirm-batch-upgrade-btn" class="btn-primary w-full py-3 font-bold text-base flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 shadow-lg shadow-indigo-600/30 transition-all cursor-pointer">
                <span>Update to 2027 A/L & Enter</span> <span>🚀</span>
            </button>
            <button id="cancel-batch-upgrade-btn" class="btn-ghost w-full py-2.5 text-sm border border-[var(--glass-border)] hover:bg-[var(--glass-border)] text-[var(--text-secondary)] transition-all cursor-pointer">
                Not Now (Go to Home 🏠)
            </button>
        </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const modal = document.getElementById('batch-upgrade-modal');

  requestAnimationFrame(() => {
    overlay.classList.remove('opacity-0');
    modal.classList.remove('scale-95');
  });

  const confirmBtn = document.getElementById('confirm-batch-upgrade-btn');
  const cancelBtn = document.getElementById('cancel-batch-upgrade-btn');

  confirmBtn.onclick = async () => {
    const selectedYear = document.getElementById('upgrade-exam-year-select').value;
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `<span class="animate-spin h-5 w-5 border-2 border-white rounded-full border-t-transparent inline-block mr-2"></span> Updating...`;

    try {
      await updateDoc(doc(db, 'users', user.uid), {
        examYear: selectedYear,
        updatedAt: Date.now()
      });

      if (userProfileCache[user.uid]) {
        userProfileCache[user.uid].examYear = selectedYear;
      }
      setLectureYear('2027');

      overlay.classList.add('opacity-0');
      modal.classList.add('scale-95');
      setTimeout(() => {
        overlay.remove();
        // Re-trigger navigation to refresh the view with access granted
        window.dispatchEvent(new Event('popstate'));
      }, 300);
    } catch (err) {
      console.error("Failed to update exam year:", err);
      alert("Failed to update exam year: " + err.message);
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `<span>Update to 2027 A/L & Enter</span> <span>🚀</span>`;
    }
  };

  cancelBtn.onclick = () => {
    overlay.classList.add('opacity-0');
    modal.classList.add('scale-95');
    setTimeout(() => {
      overlay.remove();
      if (navigateTo) navigateTo('/home');
    }, 300);
  };
}

/* ========================================================================= */
/* ===== LIVE CLASSES & BROADCASTS SYSTEM ===== */
/* ========================================================================= */

const LIVE_TEACHERS_MAP = {
  'Ruwan Darshana': { subject: 'Combined Maths', img: 'https://api.combinedmaths.lk/files-public/profiles/281124/1862199793225306112.jpg', color: 'indigo' },
  'Anuradha Perera': { subject: 'Physics', img: 'https://static.indeepa.lk/lecturer/7/en/652248466c448.jpg', color: 'cyan' },
  'Amila Dasanayake': { subject: 'Chemistry', img: 'https://static.indeepa.lk/lecturer/6/en/6522475ddf2bf.jpg', color: 'emerald' },
  'Dinesh Muthugala': { subject: 'Biology', img: dineshImg, color: 'green' },
  'Vikum Harshana': { subject: 'Combined Maths', img: vikumImg, color: 'purple' },
  'Manoj Solangarachchi': { subject: 'Combined Maths', img: monojImg, color: 'blue' },
  'Ravindu Bandaranayake': { subject: 'ICT', img: ravinduImg, color: 'sky' }
};

let liveClassesUnsubscribe = null;
window._hasLiveClasses = false;
window._liveClassesData = [];

export function formatTime12h(timeStr) {
  if (!timeStr) return '';
  if (timeStr.toLowerCase().includes('am') || timeStr.toLowerCase().includes('pm')) {
    return timeStr;
  }
  const parts = timeStr.split(':');
  if (parts.length < 2) return timeStr;
  let hours = parseInt(parts[0], 10);
  const minutes = (parts[1] || '00').slice(0, 2).padStart(2, '0');
  if (isNaN(hours)) return timeStr;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const strHours = hours < 10 ? '0' + hours : hours;
  return `${strHours}:${minutes} ${ampm}`;
}

export function timeTo24h(timeStr) {
  if (!timeStr) return '19:30';
  if (!timeStr.toLowerCase().includes('am') && !timeStr.toLowerCase().includes('pm')) {
    return timeStr.slice(0, 5);
  }
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!match) return '19:30';
  let hours = parseInt(match[1], 10);
  const minutes = (match[2] || '00').slice(0, 2).padStart(2, '0');
  const ampm = (match[3] || '').toUpperCase();
  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return `${hours < 10 ? '0' + hours : hours}:${minutes}`;
}

export function getClassEndTimestamp(scheduledDate, scheduledStartTime, scheduledEndTime) {
  if (!scheduledDate || !scheduledEndTime) return null;
  try {
    const dateParts = scheduledDate.split('-');
    if (dateParts.length !== 3) return null;
    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1;
    const day = parseInt(dateParts[2], 10);

    const end24 = timeTo24h(scheduledEndTime);
    const [endH, endM] = end24.split(':').map(v => parseInt(v, 10));

    const endDate = new Date(year, month, day, endH, endM, 0, 0);

    if (scheduledStartTime) {
      const start24 = timeTo24h(scheduledStartTime);
      const [startH, startM] = start24.split(':').map(v => parseInt(v, 10));
      const startDate = new Date(year, month, day, startH, startM, 0, 0);
      if (endDate <= startDate) {
        endDate.setDate(endDate.getDate() + 1);
      }
    }

    return endDate.getTime();
  } catch (e) {
    console.error("Error calculating class end timestamp:", e);
    return null;
  }
}

export function isClassExpired(c) {
  if (!c) return false;
  if (c.endTimestamp && typeof c.endTimestamp === 'number') {
    return Date.now() >= c.endTimestamp;
  }
  if (c.scheduledEndTime && c.scheduledDate) {
    const endMs = getClassEndTimestamp(c.scheduledDate, c.scheduledTime, c.scheduledEndTime);
    if (endMs && Date.now() >= endMs) {
      return true;
    }
  }
  return false;
}

export function startLiveClassesListener() {
  if (liveClassesUnsubscribe) return;

  try {
    const q = query(collection(db, 'liveClasses'), orderBy('createdAt', 'desc'));
    liveClassesUnsubscribe = onSnapshot(q, (snapshot) => {
      const rawClasses = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

      // Automatically filter out and delete expired classes
      const activeClasses = [];
      rawClasses.forEach(c => {
        if (isClassExpired(c)) {
          deleteDoc(doc(db, 'liveClasses', c.id)).catch(err => {
            console.warn("Could not delete expired live class:", c.id, err);
          });
        } else {
          activeClasses.push(c);
        }
      });

      window._liveClassesData = activeClasses;

      const liveList = activeClasses.filter(c => c.status === 'live');
      const hasLive = liveList.length > 0;
      window._hasLiveClasses = hasLive;

      // Update pulsating red dots in desktop header and mobile navigation in real time
      document.querySelectorAll('.live-indicator-dot').forEach(el => {
        el.style.display = hasLive ? 'inline-block' : 'none';
      });
      document.querySelectorAll('.mobile-live-indicator-dot').forEach(el => {
        el.style.display = hasLive ? 'block' : 'none';
      });

      // Update /live page immediately without page refresh
      if (window.location.pathname === '/live' && typeof window._renderLiveCards === 'function') {
        window._renderLiveCards(activeClasses);
      }
    }, (error) => {
      console.error("Error listening to live classes in real-time:", error);
    });

    // Run periodic check every 15 seconds to ensure classes auto-delete right after end time passes
    if (!window._liveClassCleanupInterval) {
      window._liveClassCleanupInterval = setInterval(() => {
        if (!window._liveClassesData || window._liveClassesData.length === 0) return;
        const expired = window._liveClassesData.filter(c => isClassExpired(c));
        if (expired.length > 0) {
          expired.forEach(c => {
            deleteDoc(doc(db, 'liveClasses', c.id)).catch(err => console.warn(err));
          });
          window._liveClassesData = window._liveClassesData.filter(c => !isClassExpired(c));
          const hasLive = window._liveClassesData.some(c => c.status === 'live');
          window._hasLiveClasses = hasLive;
          document.querySelectorAll('.live-indicator-dot').forEach(el => {
            el.style.display = hasLive ? 'inline-block' : 'none';
          });
          document.querySelectorAll('.mobile-live-indicator-dot').forEach(el => {
            el.style.display = hasLive ? 'block' : 'none';
          });
          if (window.location.pathname === '/live' && typeof window._renderLiveCards === 'function') {
            window._renderLiveCards(window._liveClassesData);
          }
        }
      }, 15000);
    }
  } catch (err) {
    console.error("Failed to start live classes listener:", err);
  }
}

export async function renderLiveClasses(user, navigateTo) {
  const userRole = user ? await getUserRole(user.uid) : 'student';
  const isMod = user && (userRole === 'moderator' || NILANTHA_MODERATORS.includes(user.uid) || RAVINDU_MODERATORS.includes(user.uid));
  const canManageLive = user && (user.uid === ADMIN_UID || isMod);

  appContainer.innerHTML = `
    <div class="max-w-6xl mx-auto pt-8 pb-12 px-2 sm:px-4">
        <!-- Header -->
        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
            <div>
                <div class="flex items-center gap-2 mb-1">
                    <h2 class="text-3xl font-bold text-[var(--text-primary)]">Live Classes & Broadcasts 📡</h2>
                </div>
                <p class="text-sm text-[var(--text-secondary)]">Join active live lectures or view upcoming scheduled classes.</p>
            </div>
            ${canManageLive ? `
                <button onclick="window.openAddLiveClassModal()" class="btn-primary py-2.5 px-5 rounded-xl font-bold text-sm flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 shadow-lg shadow-indigo-500/25">
                    <span>➕</span>
                    <span>Add New Class</span>
                </button>
            ` : ''}
        </div>

        <!-- Live Content Container (Real-Time Reactive) -->
        <div id="live-content-container">
            <div class="py-16 text-center">
                <div class="animate-spin h-8 w-8 border-4 border-indigo-500 rounded-full border-t-transparent mx-auto mb-3"></div>
                <p class="text-sm text-[var(--text-secondary)]">Connecting to live feed...</p>
            </div>
        </div>
    </div>
  `;

  // Function to render cards dynamically
  window._renderLiveCards = (classes) => {
    const container = document.getElementById('live-content-container');
    if (!container) return;

    const activeClasses = (classes || []).filter(c => !isClassExpired(c));
    const liveClasses = activeClasses.filter(c => c.status === 'live');
    const upcomingClasses = activeClasses.filter(c => c.status === 'upcoming');

    if (liveClasses.length === 0 && upcomingClasses.length === 0) {
      container.innerHTML = `
        <div class="smart-card text-center p-12 max-w-xl mx-auto border border-[var(--glass-border)] rounded-2xl">
            <div class="w-20 h-20 rounded-3xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center text-4xl mx-auto mb-4">
                📡
            </div>
            <h3 class="text-xl font-bold text-[var(--text-primary)] mb-2">No Live Classes Right Now</h3>
            <p class="text-sm text-[var(--text-secondary)] leading-relaxed mb-6">
                දැනට සක්‍රීය හෝ ඉදිරි Live Class කිසිවක් නොමැත. නව Class එකක් ආරම්භ වූ වහාම මෙහි දිස්වනු ඇත.
            </p>
            ${canManageLive ? `
                <button onclick="window.openAddLiveClassModal()" class="btn-primary py-2.5 px-6 font-bold text-sm">
                    Schedule Your First Class
                </button>
            ` : ''}
        </div>
      `;
      return;
    }

    let html = '';

    // 1. LIVE NOW SECTION
    if (liveClasses.length > 0) {
      html += `
        <div class="mb-10">
            <div class="flex items-center gap-3 mb-6">
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 text-xs font-black tracking-wider uppercase">
                    <span class="w-2 h-2 rounded-full bg-red-500 live-pulse-dot"></span>
                    <span>LIVE NOW (${liveClasses.length})</span>
                </span>
                <div class="h-px flex-1 bg-gradient-to-r from-red-500/30 to-transparent"></div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                ${liveClasses.map(c => {
                  const teacherInfo = LIVE_TEACHERS_MAP[c.teacher] || { color: 'indigo', img: c.teacherImg || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(c.teacher || 'Teacher') };
                  const tColor = teacherInfo.color || 'indigo';
                  const teacherImg = c.teacherImg || teacherInfo.img;

                  return `
                    <div class="smart-card live-card-glow relative overflow-hidden flex flex-col justify-between border border-red-500/40 bg-gradient-to-b from-[var(--bg-card)] to-[var(--bg-root)] p-5 transition-all">
                        <div>
                            <!-- Top live badges -->
                            <div class="flex items-center justify-between gap-2 mb-4">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">${c.subject || 'General'}</span>
                                    <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/10 text-[var(--text-secondary)] border border-[var(--glass-border)]">${c.batch || 'All Batches'}</span>
                                </div>
                                <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/40 text-[11px] font-black uppercase">
                                    <span class="w-2 h-2 rounded-full bg-red-500 live-pulse-dot"></span>
                                    <span>LIVE</span>
                                </div>
                            </div>

                            <!-- Teacher & Title -->
                            <div class="flex items-center gap-3.5 mb-4">
                                <div class="w-14 h-14 rounded-2xl overflow-hidden border-2 border-red-500/30 shrink-0 bg-slate-800 shadow-md">
                                    <img src="${teacherImg}" alt="${c.teacher}" class="w-full h-full object-cover">
                                </div>
                                <div class="min-w-0 flex-1">
                                    <h4 class="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wider truncate">${c.teacher}</h4>
                                    <h3 class="text-base font-bold text-[var(--text-primary)] line-clamp-2 mt-0.5">${c.title}</h3>
                                </div>
                            </div>

                            <!-- Date / Time on Live card -->
                            <div class="flex items-center gap-2 bg-red-500/10 p-2.5 rounded-xl border border-red-500/20 text-xs font-semibold text-[var(--text-secondary)] mb-4">
                                <span class="flex items-center gap-1 text-red-400 font-bold">
                                    <span>⏰</span> ${formatTime12h(c.scheduledTime) || 'Started'}${c.scheduledEndTime ? ' - ' + formatTime12h(c.scheduledEndTime) : ''}
                                </span>
                                ${c.scheduledEndTime ? `<span class="text-[10px] text-[var(--text-secondary)] ml-auto opacity-75">Auto-ends: ${formatTime12h(c.scheduledEndTime)}</span>` : ''}
                            </div>

                            ${c.description ? `<p class="text-xs text-[var(--text-secondary)] mb-4 line-clamp-2 bg-[var(--bg-root)] p-2.5 rounded-lg border border-[var(--glass-border)]">${c.description}</p>` : ''}
                        </div>

                        <!-- Action buttons -->
                        <div class="space-y-2 mt-4 pt-3 border-t border-[var(--glass-border)]">
                            <a href="${c.link || '#'}" target="_blank" rel="noopener noreferrer" class="btn-primary w-full py-3 font-bold text-sm flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 shadow-lg shadow-red-600/30 transition-all cursor-pointer">
                                <span>Join Live Broadcast 🎥</span>
                            </a>

                            ${canManageLive ? `
                                <div class="grid grid-cols-3 gap-2 pt-1">
                                    <button onclick="window.endLiveClass('${c.id}')" class="btn-ghost py-1.5 px-2 text-xs font-bold text-red-400 hover:bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-center gap-1 cursor-pointer" title="End Live Class">
                                        <span>🛑 End</span>
                                    </button>
                                    <button onclick="window.openEditLiveClassModal('${c.id}')" class="btn-ghost py-1.5 px-2 text-xs font-bold text-yellow-400 hover:bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex items-center justify-center gap-1 cursor-pointer" title="Edit Class Details">
                                        <span>✏️ Edit</span>
                                    </button>
                                    <button onclick="window.deleteLiveClass('${c.id}')" class="btn-ghost py-1.5 px-2 text-xs font-bold text-slate-400 hover:bg-white/10 border border-[var(--glass-border)] rounded-lg flex items-center justify-center gap-1 cursor-pointer" title="Delete">
                                        <span>🗑️ Del</span>
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                  `;
                }).join('')}
            </div>
        </div>
      `;
    }

    // 2. UPCOMING SECTION
    if (upcomingClasses.length > 0) {
      html += `
        <div>
            <div class="flex items-center gap-3 mb-6">
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs font-bold uppercase tracking-wider">
                    <span>⏳ SCHEDULED & UPCOMING (${upcomingClasses.length})</span>
                </span>
                <div class="h-px flex-1 bg-gradient-to-r from-indigo-500/20 to-transparent"></div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                ${upcomingClasses.map(c => {
                  const teacherInfo = LIVE_TEACHERS_MAP[c.teacher] || { color: 'indigo', img: c.teacherImg || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(c.teacher || 'Teacher') };
                  const teacherImg = c.teacherImg || teacherInfo.img;

                  return `
                    <div class="smart-card relative overflow-hidden flex flex-col justify-between border border-[var(--glass-border)] hover:border-indigo-500/40 transition-all p-5">
                        <div>
                            <div class="flex items-center justify-between gap-2 mb-4">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">${c.subject || 'General'}</span>
                                    <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/5 text-[var(--text-secondary)] border border-[var(--glass-border)]">${c.batch || 'All Batches'}</span>
                                </div>
                                <div class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-[11px] font-bold">
                                    <span>📅 Scheduled</span>
                                </div>
                            </div>

                            <!-- Teacher & Title -->
                            <div class="flex items-center gap-3.5 mb-4">
                                <div class="w-14 h-14 rounded-2xl overflow-hidden border border-[var(--glass-border)] shrink-0 bg-slate-800 shadow-sm">
                                    <img src="${teacherImg}" alt="${c.teacher}" class="w-full h-full object-cover">
                                </div>
                                <div class="min-w-0 flex-1">
                                    <h4 class="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wider truncate">${c.teacher}</h4>
                                    <h3 class="text-base font-bold text-[var(--text-primary)] line-clamp-2 mt-0.5">${c.title}</h3>
                                </div>
                            </div>

                            <!-- Date / Time -->
                            <div class="flex items-center gap-3 bg-[var(--bg-root)] p-3 rounded-xl border border-[var(--glass-border)] text-xs font-semibold text-[var(--text-secondary)] mb-4">
                                <span class="flex items-center gap-1 text-[var(--text-primary)]">
                                    <span>📅</span> ${c.scheduledDate || 'TBD'}
                                </span>
                                <span class="text-slate-600">•</span>
                                <span class="flex items-center gap-1 text-indigo-400">
                                    <span>⏰</span> ${formatTime12h(c.scheduledTime) || 'TBD'}${c.scheduledEndTime ? ' - ' + formatTime12h(c.scheduledEndTime) : ''}
                                </span>
                            </div>

                            ${c.description ? `<p class="text-xs text-[var(--text-secondary)] mb-4 line-clamp-2">${c.description}</p>` : ''}
                        </div>

                        <!-- Admin / Moderator controls or student status -->
                        <div class="space-y-2 mt-4 pt-3 border-t border-[var(--glass-border)]">
                            ${canManageLive ? `
                                <button onclick="window.startLiveClassModal('${c.id}', '${(c.title || '').replace(/'/g, "\\'")}', '${encodeURIComponent(c.link || '')}')" class="btn-primary w-full py-2.5 font-bold text-sm flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-md shadow-emerald-600/25 cursor-pointer">
                                    <span>🔴 Go Live (Start Class)</span>
                                </button>
                                <div class="grid grid-cols-2 gap-2">
                                    <button onclick="window.openEditLiveClassModal('${c.id}')" class="btn-ghost py-1.5 px-2 text-xs font-bold text-yellow-400 hover:bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex items-center justify-center gap-1 cursor-pointer" title="Edit Class Details">
                                        <span>✏️ Edit</span>
                                    </button>
                                    <button onclick="window.deleteLiveClass('${c.id}')" class="btn-ghost py-1.5 px-2 text-xs font-bold text-red-400 hover:bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-center gap-1 cursor-pointer" title="Cancel Class">
                                        <span>🗑️ Cancel</span>
                                    </button>
                                </div>
                            ` : `
                                <div class="p-2.5 text-center text-xs text-[var(--text-secondary)] bg-[var(--bg-root)] rounded-xl border border-[var(--glass-border)] italic">
                                    ⏳ Stream link will activate when class goes live
                                </div>
                            `}
                        </div>
                    </div>
                  `;
                }).join('')}
            </div>
        </div>
      `;
    }

    container.innerHTML = html;
  };

  // If live classes data is already loaded, render immediately
  if (window._liveClassesData && window._liveClassesData.length >= 0) {
    window._renderLiveCards(window._liveClassesData);
  }
}

// --- Admin Modals & Action Helpers for Live Classes ---
window.openAddLiveClassModal = () => {
  const existing = document.getElementById('add-live-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'add-live-modal';
  modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in';

  modal.innerHTML = `
    <div class="smart-card w-full max-w-lg bg-[var(--bg-secondary)] border border-indigo-500/30 shadow-2xl relative p-6 max-h-[90vh] overflow-y-auto custom-scrollbar">
        <div class="flex items-center justify-between pb-4 border-b border-[var(--glass-border)] mb-4">
            <h3 class="text-xl font-bold text-[var(--text-primary)] flex items-center gap-2">
                <span>📡</span> Add Live / Upcoming Class
            </h3>
            <button type="button" onclick="document.getElementById('add-live-modal').remove()" class="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer">✕</button>
        </div>

        <form id="live-class-form" class="space-y-4">
            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Lecturer / Teacher</label>
                <select id="live-teacher-select" class="smart-input w-full font-medium" onchange="window.handleLiveTeacherChange(this.value)">
                    <option value="Ruwan Darshana" data-subject="Combined Maths">Ruwan Darshana (Combined Maths)</option>
                    <option value="Anuradha Perera" data-subject="Physics">Anuradha Perera (Physics)</option>
                    <option value="Amila Dasanayake" data-subject="Chemistry">Amila Dasanayake (Chemistry)</option>
                    <option value="Dinesh Muthugala" data-subject="Biology">Dinesh Muthugala (Biology)</option>
                    <option value="Vikum Harshana" data-subject="Combined Maths">Vikum Harshana (Combined Maths)</option>
                    <option value="Manoj Solangarachchi" data-subject="Combined Maths">Manoj Solangarachchi (Combined Maths)</option>
                    <option value="Ravindu Bandaranayake" data-subject="ICT">Ravindu Bandaranayake (ICT)</option>
                    <option value="__custom__">Custom Teacher Name...</option>
                </select>
                <input id="live-teacher-custom" placeholder="Enter lecturer name..." class="smart-input w-full mt-2" style="display: none;">
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Subject</label>
                    <select id="live-subject-select" class="smart-input w-full font-medium">
                        <option value="Combined Maths">Combined Maths</option>
                        <option value="Physics">Physics</option>
                        <option value="Chemistry">Chemistry</option>
                        <option value="Biology">Biology</option>
                        <option value="ICT">ICT</option>
                        <option value="General">General</option>
                    </select>
                </div>
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Target Batch</label>
                    <select id="live-batch-select" class="smart-input w-full font-medium">
                        <option value="All Batches">All Batches</option>
                        <option value="2026 A/L">2026 A/L</option>
                        <option value="2027 A/L">2027 A/L</option>
                        <option value="2028 A/L">2028 A/L</option>
                    </select>
                </div>
            </div>

            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Class Title / Topic</label>
                <input id="live-title-input" placeholder="e.g. Wave Optics Theory Revision" class="smart-input w-full" required>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Scheduled Date</label>
                    <input type="date" id="live-date-input" class="smart-input w-full" value="${new Date().toISOString().slice(0, 10)}" required>
                </div>
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Start Time</label>
                    <input type="time" id="live-time-input" class="smart-input w-full" value="19:30" required>
                </div>
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">End Time (Auto Delete)</label>
                    <input type="time" id="live-end-time-input" class="smart-input w-full" value="22:00" required>
                </div>
            </div>

            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Meeting / Live Stream Link (Zoom / YouTube Live)</label>
                <input id="live-link-input" placeholder="https://zoom.us/... or https://youtube.com/live/..." class="smart-input w-full">
            </div>

            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Description / Notes (Optional)</label>
                <textarea id="live-desc-input" placeholder="Additional notes or instructions..." rows="2" class="smart-input w-full"></textarea>
            </div>

            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-2 block">Initial Status</label>
                <div class="grid grid-cols-2 gap-3">
                    <label class="flex items-center gap-2 p-3 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] cursor-pointer hover:border-indigo-500">
                        <input type="radio" name="live-initial-status" value="upcoming" checked class="text-indigo-600">
                        <span class="text-sm font-bold text-[var(--text-primary)]">⏳ Upcoming</span>
                    </label>
                    <label class="flex items-center gap-2 p-3 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] cursor-pointer hover:border-red-500">
                        <input type="radio" name="live-initial-status" value="live" class="text-red-600">
                        <span class="text-sm font-bold text-red-400">🔴 Start Live Now</span>
                    </label>
                </div>
            </div>

            <div class="flex gap-3 pt-3">
                <button type="submit" id="save-live-class-btn" class="btn-primary flex-1 py-3 font-bold cursor-pointer">
                    Save Class
                </button>
                <button type="button" onclick="document.getElementById('add-live-modal').remove()" class="btn-ghost py-3 px-5 border border-[var(--glass-border)] cursor-pointer">
                    Cancel
                </button>
            </div>
        </form>
    </div>
  `;

  document.body.appendChild(modal);

  window.handleLiveTeacherChange = (val) => {
    const customInput = document.getElementById('live-teacher-custom');
    const subjectSelect = document.getElementById('live-subject-select');
    if (val === '__custom__') {
      customInput.style.display = 'block';
      customInput.required = true;
    } else {
      customInput.style.display = 'none';
      customInput.required = false;
      const tInfo = LIVE_TEACHERS_MAP[val];
      if (tInfo && tInfo.subject) {
        subjectSelect.value = tInfo.subject;
      }
    }
  };

  document.getElementById('live-class-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('save-live-class-btn');
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin h-5 w-5 border-2 border-white rounded-full border-t-transparent inline-block mr-2"></span> Saving...`;

    const teacherSelect = document.getElementById('live-teacher-select').value;
    const rawTeacherName = teacherSelect === '__custom__' ? document.getElementById('live-teacher-custom').value.trim() : teacherSelect;
    const teacherName = sanitizeInput(rawTeacherName);
    const subject = sanitizeInput(document.getElementById('live-subject-select').value);
    const batch = sanitizeInput(document.getElementById('live-batch-select').value);
    const title = sanitizeInput(document.getElementById('live-title-input').value.trim());
    const scheduledDate = sanitizeInput(document.getElementById('live-date-input').value);
    const scheduledTime = sanitizeInput(document.getElementById('live-time-input').value.trim());
    const scheduledEndTime = sanitizeInput(document.getElementById('live-end-time-input').value.trim());
    const endTimestamp = getClassEndTimestamp(scheduledDate, scheduledTime, scheduledEndTime);
    const link = sanitizeUrl(document.getElementById('live-link-input').value.trim());
    const description = sanitizeInput(document.getElementById('live-desc-input').value.trim());
    const status = sanitizeInput(document.querySelector('input[name="live-initial-status"]:checked').value);

    const teacherInfo = LIVE_TEACHERS_MAP[teacherName];
    const teacherImg = teacherInfo ? teacherInfo.img : '';

    try {
      await addDoc(collection(db, 'liveClasses'), {
        title,
        teacher: teacherName,
        teacherImg,
        subject,
        batch,
        scheduledDate,
        scheduledTime,
        scheduledEndTime,
        endTimestamp,
        link,
        description,
        status,
        startedAt: status === 'live' ? Date.now() : null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      modal.remove();
    } catch (err) {
      console.error("Failed to add live class:", err);
      alert("Failed to save class: " + err.message);
      btn.disabled = false;
      btn.innerHTML = `Save Class`;
    }
  };
};

window.openEditLiveClassModal = async (classId) => {
  const existing = document.getElementById('edit-live-modal');
  if (existing) existing.remove();

  let c = (window._liveClassesData || []).find(item => item.id === classId);
  if (!c) {
    try {
      const snap = await getDoc(doc(db, 'liveClasses', classId));
      if (snap.exists()) {
        c = { id: snap.id, ...snap.data() };
      }
    } catch (e) {
      console.error("Error finding class:", e);
    }
  }

  if (!c) {
    alert("Live class not found or failed to load.");
    return;
  }

  const isPredefinedTeacher = Boolean(LIVE_TEACHERS_MAP[c.teacher]);

  const modal = document.createElement('div');
  modal.id = 'edit-live-modal';
  modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in';

  modal.innerHTML = `
    <div class="smart-card w-full max-w-lg bg-[var(--bg-secondary)] border border-yellow-500/30 shadow-2xl relative p-6 max-h-[90vh] overflow-y-auto custom-scrollbar">
        <div class="flex items-center justify-between pb-4 border-b border-[var(--glass-border)] mb-4">
            <h3 class="text-xl font-bold text-[var(--text-primary)] flex items-center gap-2">
                <span>✏️</span> Edit Live / Upcoming Class
            </h3>
            <button type="button" onclick="document.getElementById('edit-live-modal').remove()" class="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer">✕</button>
        </div>

        <form id="edit-live-class-form" class="space-y-4">
            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Lecturer / Teacher</label>
                <select id="edit-live-teacher-select" class="smart-input w-full font-medium" onchange="window.handleEditLiveTeacherChange(this.value)">
                    <option value="Ruwan Darshana" ${c.teacher === 'Ruwan Darshana' ? 'selected' : ''}>Ruwan Darshana (Combined Maths)</option>
                    <option value="Anuradha Perera" ${c.teacher === 'Anuradha Perera' ? 'selected' : ''}>Anuradha Perera (Physics)</option>
                    <option value="Amila Dasanayake" ${c.teacher === 'Amila Dasanayake' ? 'selected' : ''}>Amila Dasanayake (Chemistry)</option>
                    <option value="Dinesh Muthugala" ${c.teacher === 'Dinesh Muthugala' ? 'selected' : ''}>Dinesh Muthugala (Biology)</option>
                    <option value="Vikum Harshana" ${c.teacher === 'Vikum Harshana' ? 'selected' : ''}>Vikum Harshana (Combined Maths)</option>
                    <option value="Manoj Solangarachchi" ${c.teacher === 'Manoj Solangarachchi' ? 'selected' : ''}>Manoj Solangarachchi (Combined Maths)</option>
                    <option value="Ravindu Bandaranayake" ${c.teacher === 'Ravindu Bandaranayake' ? 'selected' : ''}>Ravindu Bandaranayake (ICT)</option>
                    <option value="__custom__" ${!isPredefinedTeacher ? 'selected' : ''}>Custom Teacher Name...</option>
                </select>
                <input id="edit-live-teacher-custom" value="${!isPredefinedTeacher ? (c.teacher || '') : ''}" placeholder="Enter lecturer name..." class="smart-input w-full mt-2" style="display: ${!isPredefinedTeacher ? 'block' : 'none'};">
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Subject</label>
                    <select id="edit-live-subject-select" class="smart-input w-full font-medium">
                        <option value="Combined Maths" ${c.subject === 'Combined Maths' ? 'selected' : ''}>Combined Maths</option>
                        <option value="Physics" ${c.subject === 'Physics' ? 'selected' : ''}>Physics</option>
                        <option value="Chemistry" ${c.subject === 'Chemistry' ? 'selected' : ''}>Chemistry</option>
                        <option value="Biology" ${c.subject === 'Biology' ? 'selected' : ''}>Biology</option>
                        <option value="ICT" ${c.subject === 'ICT' ? 'selected' : ''}>ICT</option>
                        <option value="General" ${c.subject === 'General' ? 'selected' : ''}>General</option>
                    </select>
                </div>
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Target Batch</label>
                    <select id="edit-live-batch-select" class="smart-input w-full font-medium">
                        <option value="All Batches" ${c.batch === 'All Batches' ? 'selected' : ''}>All Batches</option>
                        <option value="2026 A/L" ${c.batch === '2026 A/L' ? 'selected' : ''}>2026 A/L</option>
                        <option value="2027 A/L" ${c.batch === '2027 A/L' ? 'selected' : ''}>2027 A/L</option>
                        <option value="2028 A/L" ${c.batch === '2028 A/L' ? 'selected' : ''}>2028 A/L</option>
                    </select>
                </div>
            </div>

            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Class Title / Topic</label>
                <input id="edit-live-title-input" value="${(c.title || '').replace(/"/g, '&quot;')}" placeholder="e.g. Wave Optics Theory Revision" class="smart-input w-full" required>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Scheduled Date</label>
                    <input type="date" id="edit-live-date-input" class="smart-input w-full" value="${c.scheduledDate || new Date().toISOString().slice(0, 10)}" required>
                </div>
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Start Time</label>
                    <input type="time" id="edit-live-time-input" class="smart-input w-full" value="${timeTo24h(c.scheduledTime)}" required>
                </div>
                <div>
                    <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">End Time (Auto Delete)</label>
                    <input type="time" id="edit-live-end-time-input" class="smart-input w-full" value="${timeTo24h(c.scheduledEndTime || '22:00')}" required>
                </div>
            </div>

            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Meeting / Live Stream Link (Zoom / YouTube Live)</label>
                <input id="edit-live-link-input" value="${c.link || ''}" placeholder="https://zoom.us/... or https://youtube.com/live/..." class="smart-input w-full">
            </div>

            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Description / Notes (Optional)</label>
                <textarea id="edit-live-desc-input" placeholder="Additional notes or instructions..." rows="2" class="smart-input w-full">${(c.description || '').replace(/</g, '&lt;')}</textarea>
            </div>

            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-2 block">Status</label>
                <div class="grid grid-cols-2 gap-3">
                    <label class="flex items-center gap-2 p-3 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] cursor-pointer hover:border-indigo-500">
                        <input type="radio" name="edit-live-status" value="upcoming" ${c.status === 'upcoming' ? 'checked' : ''} class="text-indigo-600">
                        <span class="text-sm font-bold text-[var(--text-primary)]">⏳ Upcoming</span>
                    </label>
                    <label class="flex items-center gap-2 p-3 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] cursor-pointer hover:border-red-500">
                        <input type="radio" name="edit-live-status" value="live" ${c.status === 'live' ? 'checked' : ''} class="text-red-600">
                        <span class="text-sm font-bold text-red-400">🔴 Live Now</span>
                    </label>
                </div>
            </div>

            <div class="flex gap-3 pt-3">
                <button type="submit" id="update-live-class-btn" class="btn-primary flex-1 py-3 font-bold bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 shadow-lg cursor-pointer">
                    Update Class
                </button>
                <button type="button" onclick="document.getElementById('edit-live-modal').remove()" class="btn-ghost py-3 px-5 border border-[var(--glass-border)] cursor-pointer">
                    Cancel
                </button>
            </div>
        </form>
    </div>
  `;

  document.body.appendChild(modal);

  window.handleEditLiveTeacherChange = (val) => {
    const customInput = document.getElementById('edit-live-teacher-custom');
    const subjectSelect = document.getElementById('edit-live-subject-select');
    if (val === '__custom__') {
      customInput.style.display = 'block';
      customInput.required = true;
    } else {
      customInput.style.display = 'none';
      customInput.required = false;
      const tInfo = LIVE_TEACHERS_MAP[val];
      if (tInfo && tInfo.subject) {
        subjectSelect.value = tInfo.subject;
      }
    }
  };

  document.getElementById('edit-live-class-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('update-live-class-btn');
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin h-5 w-5 border-2 border-white rounded-full border-t-transparent inline-block mr-2"></span> Updating...`;

    const teacherSelect = document.getElementById('edit-live-teacher-select').value;
    const rawTeacherName = teacherSelect === '__custom__' ? document.getElementById('edit-live-teacher-custom').value.trim() : teacherSelect;
    const teacherName = sanitizeInput(rawTeacherName);
    const subject = sanitizeInput(document.getElementById('edit-live-subject-select').value);
    const batch = sanitizeInput(document.getElementById('edit-live-batch-select').value);
    const title = sanitizeInput(document.getElementById('edit-live-title-input').value.trim());
    const scheduledDate = sanitizeInput(document.getElementById('edit-live-date-input').value);
    const scheduledTime = sanitizeInput(document.getElementById('edit-live-time-input').value.trim());
    const scheduledEndTime = sanitizeInput(document.getElementById('edit-live-end-time-input').value.trim());
    const endTimestamp = getClassEndTimestamp(scheduledDate, scheduledTime, scheduledEndTime);
    const link = sanitizeUrl(document.getElementById('edit-live-link-input').value.trim());
    const description = sanitizeInput(document.getElementById('edit-live-desc-input').value.trim());
    const status = sanitizeInput(document.querySelector('input[name="edit-live-status"]:checked').value);

    const teacherInfo = LIVE_TEACHERS_MAP[teacherName];
    const teacherImg = teacherInfo ? teacherInfo.img : (c.teacherImg || '');

    const updatePayload = {
      title,
      teacher: teacherName,
      teacherImg,
      subject,
      batch,
      scheduledDate,
      scheduledTime,
      scheduledEndTime,
      endTimestamp,
      link,
      description,
      status,
      updatedAt: Date.now()
    };

    if (status === 'live' && c.status !== 'live') {
      updatePayload.startedAt = Date.now();
    }

    try {
      await updateDoc(doc(db, 'liveClasses', classId), updatePayload);
      modal.remove();
    } catch (err) {
      console.error("Failed to update live class:", err);
      alert("Failed to update class: " + err.message);
      btn.disabled = false;
      btn.innerHTML = `Update Class`;
    }
  };
};

window.startLiveClassModal = (id, classTitle, currentLinkEncoded) => {
  const currentLink = decodeURIComponent(currentLinkEncoded || '');
  const existing = document.getElementById('start-live-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'start-live-modal';
  modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in';

  modal.innerHTML = `
    <div class="smart-card w-full max-w-md bg-[var(--bg-secondary)] border-2 border-emerald-500/40 shadow-2xl relative p-6">
        <div class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-600 flex items-center justify-center mx-auto mb-4 text-2xl shadow-lg shadow-emerald-500/30">
            📡
        </div>
        <h3 class="text-xl font-bold text-[var(--text-primary)] text-center mb-1">Start Live Broadcast</h3>
        <p class="text-xs text-[var(--text-secondary)] text-center mb-5 truncate">${classTitle}</p>

        <form id="start-live-form" class="space-y-4">
            <div>
                <label class="text-xs uppercase font-bold text-[var(--text-secondary)] mb-1 block">Live Stream Link (Zoom / YouTube Live / Meet)</label>
                <input id="start-live-link-input" value="${currentLink}" placeholder="https://zoom.us/... or https://youtube.com/live/..." class="smart-input w-full" required autofocus>
            </div>

            <div class="flex flex-col gap-2 pt-2">
                <button type="submit" id="confirm-go-live-btn" class="btn-primary w-full py-3 font-bold bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 shadow-lg shadow-red-600/30 cursor-pointer flex items-center justify-center gap-2">
                    <span>🔴 Go Live (Notify Students)</span>
                </button>
                <button type="button" onclick="document.getElementById('start-live-modal').remove()" class="btn-ghost w-full py-2 text-sm border border-[var(--glass-border)] cursor-pointer">
                    Cancel
                </button>
            </div>
        </form>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('start-live-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('confirm-go-live-btn');
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin h-5 w-5 border-2 border-white rounded-full border-t-transparent inline-block mr-2"></span> Going Live...`;

    const rawLink = document.getElementById('start-live-link-input').value.trim();
    const link = sanitizeUrl(rawLink);
    if (!link || link === '#') {
      alert("Please enter a valid live stream URL.");
      btn.disabled = false;
      btn.innerHTML = `<span>🔴 Go Live (Notify Students)</span>`;
      return;
    }

    try {
      await updateDoc(doc(db, 'liveClasses', id), {
        status: 'live',
        link: link,
        startedAt: Date.now(),
        updatedAt: Date.now()
      });

      modal.remove();
    } catch (err) {
      console.error("Failed to start live class:", err);
      alert("Failed to start live class: " + err.message);
      btn.disabled = false;
      btn.innerHTML = `<span>🔴 Go Live (Notify Students)</span>`;
    }
  };
};

window.endLiveClass = async (id) => {
  if (!confirm("Are you sure you want to end this Live Class?\nමෙම Live Class එක අවසන් කිරීමට ඔබට විශ්වාසද?")) return;
  try {
    await deleteDoc(doc(db, 'liveClasses', id));
  } catch (err) {
    console.error("Failed to end live class:", err);
    alert("Failed to end class: " + err.message);
  }
};

window.deleteLiveClass = async (id) => {
  if (!confirm("Delete this class card?\nමෙම Class Card එක මකා දැමීමට ඔබට විශ්වාසද?")) return;
  try {
    await deleteDoc(doc(db, 'liveClasses', id));
  } catch (err) {
    console.error("Failed to delete class:", err);
    alert("Failed to delete: " + err.message);
  }
};

window.editLiveClassLink = async (id, currentLinkEncoded) => {
  const currentLink = decodeURIComponent(currentLinkEncoded || '');
  const newLink = prompt("Update Live Stream Link (Zoom / YouTube Live):", currentLink);
  if (newLink !== null && newLink.trim() !== '') {
    try {
      await updateDoc(doc(db, 'liveClasses', id), {
        link: newLink.trim(),
        updatedAt: Date.now()
      });
    } catch (err) {
      console.error("Failed to update link:", err);
      alert("Failed to update link: " + err.message);
    }
  }
};

/* ========================================================================= */
/* ===== COMMUNITY CHAT & VOICE NOTE SYSTEM ===== */
/* ========================================================================= */

let chatUnsubscribe = null;
let currentPlayingAudio = null;
let currentPlayingBtn = null;
let chatSelectedImageFile = null;

let unreadChatUnsubscribe = null;
window._unreadChatCount = 0;

export function updateUnreadChatBadges(count) {
  window._unreadChatCount = count;
  const countDisplay = count > 99 ? '99+' : (count > 0 ? String(count) : '');
  const isVisible = count > 0;

  // Header quick icon badge
  const headerBadge = document.getElementById('chat-unread-badge-header');
  if (headerBadge) {
    headerBadge.textContent = countDisplay;
    headerBadge.style.display = isVisible ? 'flex' : 'none';
  }

  // Desktop nav badge
  const desktopBadge = document.getElementById('chat-unread-badge-desktop');
  if (desktopBadge) {
    desktopBadge.textContent = countDisplay;
    desktopBadge.style.display = isVisible ? 'inline-flex' : 'none';
  }

  // Mobile drawer badge
  const drawerBadge = document.getElementById('chat-unread-badge-drawer');
  if (drawerBadge) {
    drawerBadge.textContent = countDisplay;
    drawerBadge.style.display = isVisible ? 'inline-flex' : 'none';
  }
}

export function listenForUnreadChat(user) {
  if (unreadChatUnsubscribe) {
    unreadChatUnsubscribe();
    unreadChatUnsubscribe = null;
  }
  if (!user) {
    updateUnreadChatBadges(0);
    return;
  }

  // Initialize last viewed timestamp if not set
  if (!localStorage.getItem('study_last_chat_viewed_time')) {
    localStorage.setItem('study_last_chat_viewed_time', Date.now().toString());
  }

  const q = query(
    collection(db, 'communityChat'),
    orderBy('createdAt', 'desc'),
    limit(100)
  );

  unreadChatUnsubscribe = onSnapshot(q, (snapshot) => {
    // If the user is currently on the chat page, mark as viewed and clear badges
    if (window.location.pathname === '/chat') {
      localStorage.setItem('study_last_chat_viewed_time', Date.now().toString());
      updateUnreadChatBadges(0);
      return;
    }

    const lastViewed = parseInt(localStorage.getItem('study_last_chat_viewed_time') || '0', 10);
    let count = 0;

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const createdAtMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : (data.timestamp || 0);
      const senderUid = data.senderId || data.userId;

      // Only count messages that arrived after lastViewed and not sent by current user
      if (createdAtMs > lastViewed && senderUid !== user.uid) {
        count++;
      }
    });

    updateUnreadChatBadges(count);
  }, (err) => {
    console.warn("Unread chat listener error:", err);
  });
}

// Clean helper to format timestamp
function formatChatTime(timestamp) {
  if (!timestamp) return 'Just now';
  const d = new Date(timestamp);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  const timeStr = d.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Colombo',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  if (isToday) {
    return timeStr;
  }

  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${timeStr}`;
  }

  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${timeStr}`;
}

// Convert links in text to clickable HTML links safely
function formatChatText(text) {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return escaped.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="underline text-cyan-300 hover:text-cyan-200 break-all">${url}</a>`;
  }).replace(/\n/g, '<br>');
}

function formatFileSize(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export async function renderCommunityChat(user, navigateTo) {
  if (!user) {
    navigateTo('/login');
    return;
  }

  // Activate full viewport layout for chat
  document.body.classList.add('chat-fullscreen-mode');

  // Immediately mark chat as viewed and clear unread badge
  localStorage.setItem('study_last_chat_viewed_time', Date.now().toString());
  updateUnreadChatBadges(0);

  // Cleanup old audio or listeners
  if (currentPlayingAudio) {
    currentPlayingAudio.pause();
    currentPlayingAudio = null;
  }
  if (chatUnsubscribe) {
    chatUnsubscribe();
    chatUnsubscribe = null;
  }

  const userRole = await getUserRole(user.uid);
  const isPrivilegedUser = user.uid === ADMIN_UID || userRole === 'moderator';

  appContainer.innerHTML = `
    <div class="chat-full-wrapper max-w-6xl mx-auto">
        <!-- Top Chat Header Card -->
        <div class="smart-card chat-header-bar flex items-center justify-between gap-3 bg-[var(--bg-secondary)] border border-[var(--glass-border)] shadow-md relative overflow-hidden">
            <div class="flex items-center gap-2.5 sm:gap-3 min-w-0">
                <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/30 shrink-0">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                    </svg>
                </div>
                <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h2 class="text-base sm:text-lg font-bold text-[var(--text-primary)] truncate">💬 Chat Lounge</h2>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            Live
                        </span>
                        ${isPrivilegedUser ? `<span class="${user.uid === ADMIN_UID ? 'badge-admin' : 'badge-moderator'}"><span>🛡️</span> <span>${user.uid === ADMIN_UID ? 'Admin' : 'Mod'}</span></span>` : ''}
                    </div>
                    <p class="text-[10px] sm:text-xs text-[var(--text-secondary)] truncate">
                        Connect & learn with A/L students across Sri Lanka • 30-day auto-purge
                    </p>
                </div>
            </div>

            <!-- Action Buttons: Avatar Settings, Guidelines & Sound Toggle -->
            <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
                <button id="chat-profile-settings-btn" class="btn-ghost text-xs px-2.5 py-1.5 border border-[var(--glass-border)] rounded-xl flex items-center gap-1.5 hover:bg-[var(--glass-border)] cursor-pointer text-[var(--text-primary)]" title="Profile Icon & Privacy Settings">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                        <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                    <span class="hidden sm:inline font-semibold">Avatar</span>
                </button>
                <button id="chat-guidelines-btn" class="btn-ghost text-xs px-2.5 py-1.5 border border-[var(--glass-border)] rounded-xl flex items-center gap-1.5 hover:bg-[var(--glass-border)] cursor-pointer text-[var(--text-primary)]" title="Chat Rules">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                    </svg>
                    <span class="hidden sm:inline font-semibold">Rules</span>
                </button>
                <button id="chat-sound-toggle-btn" class="btn-ghost text-xs px-2.5 py-1.5 border border-[var(--glass-border)] rounded-xl flex items-center gap-1.5 hover:bg-[var(--glass-border)] cursor-pointer text-[var(--text-primary)]" title="Toggle Sound">
                    <span id="chat-sound-icon">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                        </svg>
                    </span>
                    <span id="chat-sound-text" class="hidden sm:inline font-semibold">${getChatSoundState() ? 'Sound On' : 'Muted'}</span>
                </button>
            </div>
        </div>

        <!-- Chat Container Box (Full Remaining Viewport Height) -->
        <div class="smart-card chat-container p-0 overflow-hidden bg-[var(--bg-secondary)] border border-[var(--glass-border)] shadow-2xl relative flex flex-col flex-1 min-h-0">
            
            <!-- Message Stream Area (Only this area scrolls) -->
            <div id="chat-messages-container" class="flex-1 p-3 sm:p-4 overflow-y-auto chat-messages-scroll space-y-3 sm:space-y-4 min-h-0">
                <div class="flex flex-col items-center justify-center h-64 text-center text-[var(--text-secondary)]">
                    <div class="w-10 h-10 rounded-full border-2 border-indigo-500/30 border-t-indigo-500 animate-spin mb-3"></div>
                    <p class="text-sm font-medium">Connecting to Community Lounge...</p>
                </div>
            </div>

            <!-- Pinned Bottom Input Section (Never scrolls away) -->
            <div class="chat-input-section flex flex-col shrink-0">
                <!-- Voice Recording Active Bar (Hidden by default) -->
                <div id="chat-recording-container" class="hidden px-3 sm:px-4 py-2.5 bg-red-950/40 border-t border-red-500/30 flex items-center justify-between gap-3 animate-fade-in">
                    <div class="flex items-center gap-2 sm:gap-3">
                        <span class="w-2.5 h-2.5 rounded-full bg-red-500 voice-recording-pulse"></span>
                        <span class="text-xs font-bold text-red-400">Recording Voice Note...</span>
                        <span id="chat-recording-timer" class="text-xs font-mono font-bold text-white bg-red-500/20 px-2 py-0.5 rounded border border-red-500/30">00:00</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <button id="chat-cancel-recording-btn" type="button" class="btn-ghost text-xs px-2.5 py-1.5 text-red-400 hover:bg-red-500/20 border-red-500/30 rounded-xl cursor-pointer flex items-center gap-1">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"></path></svg>
                            <span>Discard</span>
                        </button>
                        <button id="chat-stop-recording-btn" type="button" class="btn-primary text-xs px-3.5 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 font-bold rounded-xl cursor-pointer flex items-center gap-1.5 shadow-md shadow-indigo-600/30">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
                            <span>Finish & Review</span>
                        </button>
                    </div>
                </div>

                <!-- Voice Note Review Player Bar (Listen before sending) -->
                <div id="chat-voice-review-container" class="hidden px-3 sm:px-4 py-2.5 voice-review-bar flex flex-col gap-2 animate-fade-in">
                    <div class="flex items-center justify-between text-xs text-[var(--text-secondary)]">
                        <span class="flex items-center gap-1.5 font-bold text-indigo-400">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                            <span>Voice Note Preview</span>
                        </span>
                        <span id="voice-review-time-display" class="font-mono text-xs font-semibold text-white">00:00 / 00:00</span>
                    </div>
                    
                    <div class="flex items-center gap-2 sm:gap-3">
                        <!-- Play/Pause Button -->
                        <button id="voice-review-play-btn" type="button" class="w-9 h-9 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center text-sm shadow cursor-pointer shrink-0">
                            <span id="voice-review-play-icon">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                            </span>
                        </button>
                        
                        <!-- Audio Element (hidden) -->
                        <audio id="voice-review-audio-el" class="hidden"></audio>

                        <!-- Progress Slider -->
                        <input id="voice-review-progress" type="range" min="0" max="100" value="0" class="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-400">

                        <!-- Discard / Delete Button -->
                        <button id="voice-review-discard-btn" type="button" class="text-red-400 hover:text-red-300 p-2 rounded-xl text-sm bg-red-500/10 hover:bg-red-500/20 cursor-pointer" title="Discard Voice Note">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </button>

                        <!-- Re-record Button -->
                        <button id="voice-review-rerecord-btn" type="button" class="text-amber-400 hover:text-amber-300 p-2 rounded-xl text-sm bg-amber-500/10 hover:bg-amber-500/20 cursor-pointer" title="Re-record">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        </button>

                        <!-- Send Audio Button (WhatsApp Style) -->
                        <button id="voice-review-send-btn" type="button" class="btn-primary text-xs px-3.5 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 font-bold rounded-xl cursor-pointer flex items-center gap-1.5 shadow-md shadow-emerald-600/30">
                            <span>Send</span>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                        </button>
                    </div>
                </div>

                <!-- Active Reply / Mention Banner (Hidden by default) -->
                <div id="chat-reply-banner" class="chat-reply-banner hidden"></div>

                <!-- Emoji Shortcuts Bar -->
                <div class="px-2.5 sm:px-4 py-1 bg-[var(--bg-root)] border-t border-[var(--glass-border)] flex items-center gap-1 sm:gap-1.5 overflow-x-auto no-scrollbar">
                    <span class="text-[9px] uppercase font-bold text-[var(--text-secondary)] mr-0.5 shrink-0">Quick:</span>
                    ${['👍', '❤️', '🔥', '📚', '💡', '❓', '👏', '😂', '💯', '🎯'].map(emoji => `
                        <button type="button" class="chat-emoji-pill px-1.5 py-0.5 rounded-lg text-xs sm:text-sm hover:bg-[var(--glass-border)] hover:scale-125 transition-transform cursor-pointer shrink-0" data-emoji="${emoji}">${emoji}</button>
                    `).join('')}
                </div>

                <!-- Bottom Input Bar -->
                <div class="p-2 sm:p-3 bg-[var(--bg-secondary)] border-t border-[var(--glass-border)] flex items-end gap-1.5 sm:gap-2">
                    
                    <!-- Attachment Button (Photo with WhatsApp Editor) -->
                    <input type="file" id="chat-file-input" accept="image/*" class="hidden">
                    <button id="chat-attach-image-btn" type="button" class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] hover:border-indigo-500 text-[var(--text-secondary)] hover:text-indigo-400 flex items-center justify-center transition-all hover:scale-105 cursor-pointer shrink-0" title="Attach & Edit Photo">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                            <circle cx="12" cy="13" r="4"></circle>
                        </svg>
                    </button>

                    <!-- Attachment Button (PDF Document) -->
                    <input type="file" id="chat-pdf-input" accept="application/pdf,.pdf" class="hidden">
                    <button id="chat-attach-pdf-btn" type="button" class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] hover:border-rose-500 text-[var(--text-secondary)] hover:text-rose-400 flex items-center justify-center transition-all hover:scale-105 cursor-pointer shrink-0" title="Share PDF Document / PDF ලේඛනයක්">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                            <path d="M9 13h6"></path>
                            <path d="M9 17h6"></path>
                            <path d="M9 9h1"></path>
                        </svg>
                    </button>

                    <!-- Voice Record Button -->
                    <button id="chat-start-voice-btn" type="button" class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] hover:border-red-500 text-[var(--text-secondary)] hover:text-red-400 flex items-center justify-center transition-all hover:scale-105 cursor-pointer shrink-0" title="Record Voice Note">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" y1="19" x2="12" y2="23"></line>
                            <line x1="8" y1="23" x2="16" y2="23"></line>
                        </svg>
                    </button>

                    <!-- Message Text Input -->
                    <div class="flex-1 relative">
                        <textarea 
                            id="chat-message-input" 
                            placeholder="Type a message (Press Enter to send)..." 
                            rows="1" 
                            maxlength="1000"
                            class="smart-input w-full py-2 px-3 text-xs sm:text-sm resize-none rounded-xl custom-scrollbar max-h-24 overflow-y-auto"
                        ></textarea>
                    </div>

                    <!-- WhatsApp-Style Send Button (SVG Icon) -->
                    <button id="chat-send-btn" type="button" class="btn-primary w-9 h-9 sm:w-10 sm:h-10 rounded-xl p-0 flex items-center justify-center bg-gradient-to-tr from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white cursor-pointer shrink-0 shadow-lg shadow-emerald-500/25 transition-all hover:scale-105 active:scale-95" title="Send Message">
                        <span id="chat-send-btn-icon">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" class="translate-x-0.5"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                        </span>
                    </button>
                </div>
            </div>
        </div>
    </div>
  `;

  const messagesContainer = document.getElementById('chat-messages-container');
  const messageInput = document.getElementById('chat-message-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const sendBtnIcon = document.getElementById('chat-send-btn-icon');
  const fileInput = document.getElementById('chat-file-input');
  const attachBtn = document.getElementById('chat-attach-image-btn');
  const pdfInput = document.getElementById('chat-pdf-input');
  const attachPdfBtn = document.getElementById('chat-attach-pdf-btn');
  const startVoiceBtn = document.getElementById('chat-start-voice-btn');
  const recordingContainer = document.getElementById('chat-recording-container');
  const recordingTimer = document.getElementById('chat-recording-timer');
  const cancelRecordingBtn = document.getElementById('chat-cancel-recording-btn');
  const stopRecordingBtn = document.getElementById('chat-stop-recording-btn');
  
  // Voice Review Elements
  const voiceReviewContainer = document.getElementById('chat-voice-review-container');
  const voiceReviewAudioEl = document.getElementById('voice-review-audio-el');
  const voiceReviewPlayBtn = document.getElementById('voice-review-play-btn');
  const voiceReviewPlayIcon = document.getElementById('voice-review-play-icon');
  const voiceReviewTimeDisplay = document.getElementById('voice-review-time-display');
  const voiceReviewProgress = document.getElementById('voice-review-progress');
  const voiceReviewDiscardBtn = document.getElementById('voice-review-discard-btn');
  const voiceReviewRerecordBtn = document.getElementById('voice-review-rerecord-btn');
  const voiceReviewSendBtn = document.getElementById('voice-review-send-btn');

  let currentRecordedVoiceData = null; // { blob, duration, objectUrl }

  const soundToggleBtn = document.getElementById('chat-sound-toggle-btn');
  const guidelinesBtn = document.getElementById('chat-guidelines-btn');
  const profileSettingsBtn = document.getElementById('chat-profile-settings-btn');

  // Avatar & Profile Privacy Quick Settings Modal
  if (profileSettingsBtn) {
    profileSettingsBtn.onclick = async () => {
      const userProfile = await getUserProfile(user.uid);
      const photoURL = userProfile?.photoURL || user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || 'User')}&background=4f46e5&color=fff`;
      const isPhotoPublic = userProfile?.isPhotoPublic === true;

      showFloatingModal(`
        <div class="text-left space-y-4">
            <div class="flex items-center gap-3 mb-1">
                <div class="w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                        <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                </div>
                <div>
                    <h3 class="text-base font-bold text-[var(--text-primary)]">Chat Avatar & Privacy Settings</h3>
                    <p class="text-xs text-[var(--text-secondary)]">Manage your chat photo and public visibility</p>
                </div>
            </div>

            <!-- Current Avatar Box -->
            <div class="p-4 bg-[var(--bg-root)] border border-[var(--glass-border)] rounded-2xl flex flex-col sm:flex-row items-center gap-4">
                <div class="relative group">
                    <div class="w-20 h-20 rounded-full border-2 border-indigo-500/50 overflow-hidden shadow-lg bg-indigo-600/20 flex items-center justify-center shrink-0">
                        <img id="chat-modal-avatar-preview" src="${photoURL}" class="w-full h-full object-cover">
                    </div>
                </div>

                <div class="flex-1 text-center sm:text-left space-y-1.5 min-w-0">
                    <p class="text-sm font-bold text-[var(--text-primary)] truncate">${user.displayName || 'Student'}</p>
                    <p class="text-xs text-[var(--text-secondary)] truncate">${user.email}</p>
                    <div class="pt-1 flex justify-center sm:justify-start">
                        <button id="chat-modal-choose-photo-btn" type="button" class="btn-ghost text-xs px-3.5 py-1.5 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10 rounded-xl cursor-pointer flex items-center gap-1.5 font-semibold">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
                            <span>Upload New Photo</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- Privacy Toggle for Chat -->
            <div class="p-4 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] flex items-center justify-between gap-4">
                <div class="space-y-0.5">
                    <p class="font-bold text-xs sm:text-sm text-[var(--text-primary)] flex items-center gap-2">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-indigo-400"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                        <span>Show Profile Picture in Chat</span>
                    </p>
                    <p class="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                        When ON, your photo is shown publicly next to your messages. When OFF (Default), only your first initial is displayed.
                    </p>
                </div>
                <label class="switch shrink-0">
                    <input type="checkbox" id="chat-modal-privacy-checkbox" ${isPhotoPublic ? 'checked' : ''}>
                    <span class="switch-slider"></span>
                </label>
            </div>

            <div class="flex gap-2 justify-end pt-2">
                <button onclick="closeFloatingModal()" class="btn-ghost text-xs px-4 py-2 rounded-xl cursor-pointer">Cancel</button>
                <button id="chat-modal-save-btn" class="btn-primary text-xs px-5 py-2 rounded-xl font-bold cursor-pointer">Save Settings</button>
            </div>
        </div>
      `);

      const previewImg = document.getElementById('chat-modal-avatar-preview');
      const chooseBtn = document.getElementById('chat-modal-choose-photo-btn');
      const privacyCheckbox = document.getElementById('chat-modal-privacy-checkbox');
      const saveBtn = document.getElementById('chat-modal-save-btn');
      let pendingPhotoURL = null;

      const handleFileSelect = () => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.onchange = async (ev) => {
          const file = ev.target.files[0];
          if (!file) return;

          if (previewImg) previewImg.style.opacity = '0.5';
          try {
            const resizedBase64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.readAsDataURL(file);
              reader.onload = (event) => {
                const img = new Image();
                img.src = event.target.result;
                img.onload = () => {
                  const canvas = document.createElement('canvas');
                  const MAX_SIDE = 400;
                  let w = img.width;
                  let h = img.height;
                  if (w > h && w > MAX_SIDE) { h *= MAX_SIDE / w; w = MAX_SIDE; }
                  else if (h > MAX_SIDE) { w *= MAX_SIDE / h; h = MAX_SIDE; }
                  canvas.width = Math.round(w);
                  canvas.height = Math.round(h);
                  const ctx = canvas.getContext('2d');
                  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                  resolve(canvas.toDataURL('image/jpeg', 0.85));
                };
                img.onerror = reject;
              };
              reader.onerror = reject;
            });

            pendingPhotoURL = resizedBase64;
            if (previewImg) previewImg.src = resizedBase64;
          } catch (err) {
            alert("Error processing photo: " + err.message);
          } finally {
            if (previewImg) previewImg.style.opacity = '1';
          }
        };
        fileInput.click();
      };

      if (chooseBtn) chooseBtn.onclick = handleFileSelect;

      if (saveBtn) {
        saveBtn.onclick = async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
          try {
            const newIsPublic = privacyCheckbox ? privacyCheckbox.checked : false;
            const updatePayload = { isPhotoPublic: newIsPublic };
            if (pendingPhotoURL) {
              updatePayload.photoURL = pendingPhotoURL;
            }

            await setDoc(doc(db, 'users', user.uid), updatePayload, { merge: true });
            userProfileCache[user.uid] = { ...(userProfileCache[user.uid] || {}), ...updatePayload };

            await renderHeader(user, window.navigateTo, signOut);
            closeFloatingModal();
            alert("Profile & Avatar settings updated successfully!");
          } catch (err) {
            console.error("Save error:", err);
            alert("Failed to save: " + err.message);
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Settings';
          }
        };
      }
    };
  }

  // Helpers for Upload Indicator
  function showChatUploadIndicator(text = 'Uploading to Cloudflare R2...') {
    let indicator = document.getElementById('chat-upload-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'chat-upload-indicator';
      indicator.className = 'chat-upload-indicator animate-pulse';
      const chatContainer = document.querySelector('.chat-container');
      if (chatContainer) chatContainer.prepend(indicator);
    }
    indicator.innerHTML = `
      <span class="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin"></span>
      <span id="chat-upload-text">${text}</span>
    `;
    indicator.classList.remove('hidden');
  }

  function hideChatUploadIndicator() {
    const indicator = document.getElementById('chat-upload-indicator');
    if (indicator) indicator.remove();
  }

  // Auto-resize textarea
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 100) + 'px';
  });

  // Enter to send (Shift+Enter for newline)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  // Quick Emoji insertion
  document.querySelectorAll('.chat-emoji-pill').forEach(btn => {
    btn.onclick = () => {
      const emoji = btn.getAttribute('data-emoji');
      messageInput.value += emoji;
      messageInput.focus();
      messageInput.dispatchEvent(new Event('input'));
    };
  });

  // Sound Toggle Handler
  soundToggleBtn.onclick = () => {
    const enabled = toggleChatSound();
    document.getElementById('chat-sound-icon').textContent = enabled ? '🔔' : '🔕';
    document.getElementById('chat-sound-text').textContent = enabled ? 'Sound On' : 'Muted';
  };

  // Guidelines Modal
  guidelinesBtn.onclick = () => {
    showFloatingModal(`
      <div class="text-left space-y-4">
          <div class="flex items-center gap-3 mb-2">
              <div class="w-12 h-12 rounded-2xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-2xl">
                  📜
              </div>
              <div>
                  <h3 class="text-lg font-bold text-[var(--text-primary)]">Community Lounge Rules</h3>
                  <p class="text-xs text-[var(--text-secondary)]">StudyTracker Pro Discussion Guidelines</p>
              </div>
          </div>
          <div class="space-y-3 text-sm text-[var(--text-secondary)] bg-[var(--bg-root)] p-4 rounded-xl border border-[var(--glass-border)] leading-relaxed">
              <p>🤝 <strong>Respect & Helpfulness:</strong> Treat everyone kindly. Use this space for study questions, past papers, and motivation.</p>
              <p>🔒 <strong>Privacy by Default:</strong> Only your name is shown. Your profile picture remains private unless you enable it in Profile Settings.</p>
              <p>⏳ <strong>30-Day Auto Expiration:</strong> All messages, images, and voice notes automatically purge from the database after 30 days.</p>
              <p>🚫 <strong>No Inappropriate Content:</strong> Spamming, promotional ads, and inappropriate behavior are strictly prohibited. Moderators can delete messages and restrict access.</p>
          </div>
          <button onclick="closeFloatingModal()" class="btn-primary w-full py-2.5 font-bold">I Understand</button>
      </div>
    `);
  };

  // WhatsApp-Style Image Editor Modal Function with Interactive Crop Tool
  function openWhatsAppImageEditor(file, onSendCallback) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const originalSrc = ev.target.result;
      let currentWorkingSrc = originalSrc;
      let rotation = 0;
      let flipped = false;
      let currentFilter = 'normal';
      let isCropMode = false;
      let activeAspectRatio = 'free'; // 'free', '1:1', '4:3', '16:9'

      const editorModal = document.createElement('div');
      editorModal.id = 'chat-image-editor-modal';
      editorModal.className = 'chat-image-editor-modal animate-fade-in';
      editorModal.innerHTML = `
        <!-- Top Toolbar -->
        <div class="flex items-center justify-between px-4 py-3 bg-black/50 border-b border-white/10 shrink-0">
            <button id="editor-close-btn" class="text-white hover:text-gray-300 p-2 rounded-xl text-lg font-bold cursor-pointer flex items-center justify-center" title="Cancel">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
            <h3 class="text-base font-bold text-white flex items-center gap-2">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 19l7-7 3 3-7 7-3-3z"></path>
                    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path>
                </svg>
                <span>Edit Photo</span>
            </h3>
            <div class="flex items-center gap-1.5 sm:gap-2">
                <button id="editor-crop-toggle-btn" class="btn-ghost text-xs px-2.5 py-1.5 border border-white/10 rounded-xl flex items-center gap-1 hover:bg-white/10 text-cyan-300 cursor-pointer" title="Crop Image">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"></path>
                        <path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"></path>
                    </svg>
                    <span class="hidden sm:inline font-semibold">Crop</span>
                </button>
                <button id="editor-rotate-left-btn" class="btn-ghost text-xs px-2.5 py-1.5 border border-white/10 rounded-xl flex items-center gap-1 hover:bg-white/10 text-white cursor-pointer" title="Rotate Left">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="1 4 1 10 7 10"></polyline>
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                    </svg>
                </button>
                <button id="editor-rotate-right-btn" class="btn-ghost text-xs px-2.5 py-1.5 border border-white/10 rounded-xl flex items-center gap-1 hover:bg-white/10 text-white cursor-pointer" title="Rotate Right">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10"></polyline>
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                    </svg>
                </button>
                <button id="editor-flip-btn" class="btn-ghost text-xs px-2.5 py-1.5 border border-white/10 rounded-xl flex items-center gap-1 hover:bg-white/10 text-white cursor-pointer" title="Flip Horizontal">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="17 8 21 12 17 16"></polyline>
                        <line x1="21" y1="12" x2="9" y2="12"></line>
                        <polyline points="7 16 3 12 7 8"></polyline>
                        <line x1="3" y1="12" x2="15" y2="12"></line>
                    </svg>
                </button>
                <button id="editor-reset-btn" class="btn-ghost text-xs px-2.5 py-1.5 border border-white/10 rounded-xl flex items-center gap-1 hover:bg-white/10 text-amber-300 cursor-pointer" title="Reset All">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                        <path d="M3 3v5h5"></path>
                    </svg>
                </button>
            </div>
        </div>

        <!-- Crop Sub-Toolbar (Shown only in crop mode) -->
        <div id="editor-crop-bar" class="hidden px-4 py-2 bg-indigo-950/60 border-b border-indigo-500/30 flex items-center justify-between gap-2 shrink-0 animate-fade-in">
            <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                <span class="text-[10px] font-bold text-indigo-300 uppercase mr-1">Ratio:</span>
                <button type="button" class="crop-ratio-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-indigo-600 text-white cursor-pointer" data-ratio="free">Free</button>
                <button type="button" class="crop-ratio-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer" data-ratio="1:1">1:1 Square</button>
                <button type="button" class="crop-ratio-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer" data-ratio="4:3">4:3</button>
                <button type="button" class="crop-ratio-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer" data-ratio="16:9">16:9</button>
            </div>
            <div class="flex items-center gap-2">
                <button id="crop-cancel-btn" type="button" class="btn-ghost text-xs px-3 py-1.5 text-red-400 hover:bg-red-500/20 border-red-500/30 rounded-xl cursor-pointer flex items-center gap-1">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"></path></svg>
                    <span>Cancel</span>
                </button>
                <button id="crop-apply-btn" type="button" class="btn-primary text-xs px-3.5 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 font-bold rounded-xl cursor-pointer flex items-center gap-1.5 shadow-md">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <span>Apply Crop</span>
                </button>
            </div>
        </div>

        <!-- Center Image Viewport -->
        <div id="editor-viewport" class="chat-editor-viewport">
            <img id="editor-preview-img" src="${originalSrc}" class="chat-editor-img filter-normal">
        </div>

        <!-- Filter Selector Pills (Hidden during crop mode) -->
        <div id="editor-filter-bar" class="px-4 py-2 bg-black/40 border-t border-white/10 flex items-center gap-2 overflow-x-auto no-scrollbar justify-center shrink-0">
            <span class="text-[10px] uppercase font-bold text-gray-400 mr-1">Filters:</span>
            <button type="button" class="editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-indigo-600 text-white cursor-pointer" data-filter="normal">Normal</button>
            <button type="button" class="editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer" data-filter="vivid">Vivid</button>
            <button type="button" class="editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer" data-filter="warm">Warm</button>
            <button type="button" class="editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer" data-filter="bw">B&W</button>
            <button type="button" class="editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer" data-filter="contrast">Contrast</button>
            <button type="button" class="editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer" data-filter="soft">Soft</button>
        </div>

        <!-- Bottom Caption and Send Bar -->
        <div class="p-3 sm:p-4 bg-black/60 border-t border-white/10 flex flex-col gap-2 shrink-0">
            <!-- Quick Emojis -->
            <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar justify-center">
                ${['👍', '❤️', '🔥', '📚', '💡', '❓', '👏', '😂', '💯', '🎯'].map(em => `
                    <button type="button" class="editor-emoji-btn px-2 py-0.5 rounded-lg text-sm hover:bg-white/10 cursor-pointer" data-emoji="${em}">${em}</button>
                `).join('')}
            </div>

            <div class="flex items-center gap-2 max-w-4xl mx-auto w-full">
                <input id="editor-caption-input" type="text" placeholder="Add an optional caption..." maxlength="500" class="smart-input flex-1 py-2.5 px-4 text-sm bg-white/10 border-white/20 text-white placeholder-gray-400 rounded-xl focus:border-indigo-400">
                <button id="editor-send-btn" class="btn-primary px-5 py-2.5 rounded-xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white flex items-center gap-2 shadow-lg shadow-emerald-600/30 cursor-pointer shrink-0">
                    <span id="editor-send-text">Send Photo</span>
                    <span id="editor-send-icon">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </span>
                </button>
            </div>
        </div>
      `;

      document.body.appendChild(editorModal);

      const viewport = editorModal.querySelector('#editor-viewport');
      const cropBar = editorModal.querySelector('#editor-crop-bar');
      const filterBar = editorModal.querySelector('#editor-filter-bar');
      const previewImg = editorModal.querySelector('#editor-preview-img');
      const captionInput = editorModal.querySelector('#editor-caption-input');
      const closeBtn = editorModal.querySelector('#editor-close-btn');
      const cropToggleBtn = editorModal.querySelector('#editor-crop-toggle-btn');
      const cropCancelBtn = editorModal.querySelector('#crop-cancel-btn');
      const cropApplyBtn = editorModal.querySelector('#crop-apply-btn');
      const rotateLeftBtn = editorModal.querySelector('#editor-rotate-left-btn');
      const rotateRightBtn = editorModal.querySelector('#editor-rotate-right-btn');
      const flipBtn = editorModal.querySelector('#editor-flip-btn');
      const resetBtn = editorModal.querySelector('#editor-reset-btn');
      const sendPhotoBtn = editorModal.querySelector('#editor-send-btn');
      const sendPhotoText = editorModal.querySelector('#editor-send-text');
      const sendPhotoIcon = editorModal.querySelector('#editor-send-icon');

      function updatePreviewTransform() {
        if (isCropMode) return;
        previewImg.src = currentWorkingSrc;
        previewImg.style.transform = `rotate(${rotation}deg) scaleX(${flipped ? -1 : 1})`;
        previewImg.className = `chat-editor-img filter-${currentFilter}`;
      }

      // --- CROPPER ENGINE ---
      let cropState = {
        boxX: 20,
        boxY: 20,
        boxW: 200,
        boxH: 200,
        isDragging: false,
        activeHandle: null,
        startX: 0,
        startY: 0,
        initialBoxX: 0,
        initialBoxY: 0,
        initialBoxW: 0,
        initialBoxH: 0
      };

      function enterCropMode() {
        isCropMode = true;
        cropBar.classList.remove('hidden');
        filterBar.classList.add('hidden');
        cropToggleBtn.classList.add('bg-cyan-600', 'text-white');

        viewport.innerHTML = `
          <div class="crop-workspace" id="crop-workspace-el">
              <img id="crop-workspace-img" src="${currentWorkingSrc}">
              <div id="crop-box-el" class="crop-box">
                  <div class="crop-grid"></div>
                  <div class="crop-handle crop-handle-nw" data-handle="nw"></div>
                  <div class="crop-handle crop-handle-ne" data-handle="ne"></div>
                  <div class="crop-handle crop-handle-sw" data-handle="sw"></div>
                  <div class="crop-handle crop-handle-se" data-handle="se"></div>
              </div>
          </div>
        `;

        const workspaceImg = viewport.querySelector('#crop-workspace-img');
        const cropBoxEl = viewport.querySelector('#crop-box-el');

        workspaceImg.onload = () => {
          const imgW = workspaceImg.clientWidth || 300;
          const imgH = workspaceImg.clientHeight || 300;

          // Initial 75% centered box
          cropState.boxW = Math.round(imgW * 0.75);
          cropState.boxH = Math.round(imgH * 0.75);
          applyRatioToCropBox(imgW, imgH);

          cropState.boxX = Math.round((imgW - cropState.boxW) / 2);
          cropState.boxY = Math.round((imgH - cropState.boxH) / 2);

          renderCropBox(cropBoxEl);
          attachCropInteractions(cropBoxEl, workspaceImg);
        };
        if (workspaceImg.complete) workspaceImg.onload();
      }

      function applyRatioToCropBox(imgW, imgH) {
        if (activeAspectRatio === '1:1') {
          const side = Math.min(cropState.boxW, cropState.boxH, imgW, imgH);
          cropState.boxW = side;
          cropState.boxH = side;
        } else if (activeAspectRatio === '4:3') {
          cropState.boxH = Math.min(imgH, Math.round(cropState.boxW * (3 / 4)));
          cropState.boxW = Math.min(imgW, Math.round(cropState.boxH * (4 / 3)));
        } else if (activeAspectRatio === '16:9') {
          cropState.boxH = Math.min(imgH, Math.round(cropState.boxW * (9 / 16)));
          cropState.boxW = Math.min(imgW, Math.round(cropState.boxH * (16 / 9)));
        }
      }

      function renderCropBox(cropBoxEl) {
        cropBoxEl.style.left = `${cropState.boxX}px`;
        cropBoxEl.style.top = `${cropState.boxY}px`;
        cropBoxEl.style.width = `${cropState.boxW}px`;
        cropBoxEl.style.height = `${cropState.boxH}px`;
      }

      function attachCropInteractions(cropBoxEl, workspaceImg) {
        const getPointerPos = (e) => {
          const t = e.touches ? e.touches[0] : e;
          return { x: t.clientX, y: t.clientY };
        };

        const onPointerDown = (e) => {
          e.preventDefault();
          const target = e.target;
          cropState.activeHandle = target.getAttribute('data-handle');
          cropState.isDragging = true;

          const p = getPointerPos(e);
          cropState.startX = p.x;
          cropState.startY = p.y;
          cropState.initialBoxX = cropState.boxX;
          cropState.initialBoxY = cropState.boxY;
          cropState.initialBoxW = cropState.boxW;
          cropState.initialBoxH = cropState.boxH;

          window.addEventListener('mousemove', onPointerMove);
          window.addEventListener('mouseup', onPointerUp);
          window.addEventListener('touchmove', onPointerMove, { passive: false });
          window.addEventListener('touchend', onPointerUp);
        };

        const onPointerMove = (e) => {
          if (!cropState.isDragging) return;
          e.preventDefault();
          const p = getPointerPos(e);
          const dx = p.x - cropState.startX;
          const dy = p.y - cropState.startY;
          const maxW = workspaceImg.clientWidth;
          const maxH = workspaceImg.clientHeight;

          if (cropState.activeHandle) {
            // Resizing via Handles
            let newW = cropState.initialBoxW;
            let newH = cropState.initialBoxH;
            let newX = cropState.initialBoxX;
            let newY = cropState.initialBoxY;

            if (cropState.activeHandle.includes('e')) {
              newW = Math.max(50, Math.min(maxW - newX, cropState.initialBoxW + dx));
            }
            if (cropState.activeHandle.includes('s')) {
              newH = Math.max(50, Math.min(maxH - newY, cropState.initialBoxH + dy));
            }
            if (cropState.activeHandle.includes('w')) {
              const proposedW = Math.max(50, cropState.initialBoxW - dx);
              if (cropState.initialBoxX + (cropState.initialBoxW - proposedW) >= 0) {
                newW = proposedW;
                newX = cropState.initialBoxX + (cropState.initialBoxW - proposedW);
              }
            }
            if (cropState.activeHandle.includes('n')) {
              const proposedH = Math.max(50, cropState.initialBoxH - dy);
              if (cropState.initialBoxY + (cropState.initialBoxH - proposedH) >= 0) {
                newH = proposedH;
                newY = cropState.initialBoxY + (cropState.initialBoxH - proposedH);
              }
            }

            cropState.boxX = newX;
            cropState.boxY = newY;
            cropState.boxW = newW;
            cropState.boxH = newH;
          } else {
            // Dragging whole box
            let newX = Math.max(0, Math.min(maxW - cropState.boxW, cropState.initialBoxX + dx));
            let newY = Math.max(0, Math.min(maxH - cropState.boxH, cropState.initialBoxY + dy));
            cropState.boxX = newX;
            cropState.boxY = newY;
          }

          renderCropBox(cropBoxEl);
        };

        const onPointerUp = () => {
          cropState.isDragging = false;
          cropState.activeHandle = null;
          window.removeEventListener('mousemove', onPointerMove);
          window.removeEventListener('mouseup', onPointerUp);
          window.removeEventListener('touchmove', onPointerMove);
          window.removeEventListener('touchend', onPointerUp);
        };

        cropBoxEl.addEventListener('mousedown', onPointerDown);
        cropBoxEl.addEventListener('touchstart', onPointerDown, { passive: false });
      }

      function exitCropMode() {
        isCropMode = false;
        cropBar.classList.add('hidden');
        filterBar.classList.remove('hidden');
        cropToggleBtn.classList.remove('bg-cyan-600', 'text-white');

        viewport.innerHTML = `
          <img id="editor-preview-img" src="${currentWorkingSrc}" class="chat-editor-img filter-${currentFilter}">
        `;
        const newPreview = viewport.querySelector('#editor-preview-img');
        newPreview.style.transform = `rotate(${rotation}deg) scaleX(${flipped ? -1 : 1})`;
      }

      // Crop Ratio Button clicks
      editorModal.querySelectorAll('.crop-ratio-btn').forEach(btn => {
        btn.onclick = () => {
          activeAspectRatio = btn.getAttribute('data-ratio');
          editorModal.querySelectorAll('.crop-ratio-btn').forEach(b => {
            b.className = 'crop-ratio-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer';
          });
          btn.className = 'crop-ratio-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-indigo-600 text-white cursor-pointer';

          const workspaceImg = viewport.querySelector('#crop-workspace-img');
          const cropBoxEl = viewport.querySelector('#crop-box-el');
          if (workspaceImg && cropBoxEl) {
            applyRatioToCropBox(workspaceImg.clientWidth, workspaceImg.clientHeight);
            renderCropBox(cropBoxEl);
          }
        };
      });

      cropToggleBtn.onclick = () => {
        if (isCropMode) exitCropMode();
        else enterCropMode();
      };

      cropCancelBtn.onclick = () => {
        exitCropMode();
      };

      cropApplyBtn.onclick = async () => {
        const workspaceImg = viewport.querySelector('#crop-workspace-img');
        if (!workspaceImg) return;

        const img = new Image();
        img.src = currentWorkingSrc;
        await new Promise(r => { img.onload = r; });

        const scaleX = (img.naturalWidth || img.width) / workspaceImg.clientWidth;
        const scaleY = (img.naturalHeight || img.height) / workspaceImg.clientHeight;

        const sx = cropState.boxX * scaleX;
        const sy = cropState.boxY * scaleY;
        const sw = cropState.boxW * scaleX;
        const sh = cropState.boxH * scaleY;

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(sw);
        canvas.height = Math.round(sh);

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

        currentWorkingSrc = canvas.toDataURL('image/jpeg', 0.95);
        exitCropMode();
      };

      rotateLeftBtn.onclick = () => {
        if (isCropMode) exitCropMode();
        rotation = (rotation - 90) % 360;
        updatePreviewTransform();
      };

      rotateRightBtn.onclick = () => {
        if (isCropMode) exitCropMode();
        rotation = (rotation + 90) % 360;
        updatePreviewTransform();
      };

      flipBtn.onclick = () => {
        if (isCropMode) exitCropMode();
        flipped = !flipped;
        updatePreviewTransform();
      };

      resetBtn.onclick = () => {
        currentWorkingSrc = originalSrc;
        rotation = 0;
        flipped = false;
        currentFilter = 'normal';
        editorModal.querySelectorAll('.editor-filter-btn').forEach(btn => {
          btn.className = btn.dataset.filter === 'normal'
            ? 'editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-indigo-600 text-white cursor-pointer'
            : 'editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer';
        });
        if (isCropMode) exitCropMode();
        updatePreviewTransform();
      };

      // Filter clicks
      editorModal.querySelectorAll('.editor-filter-btn').forEach(btn => {
        btn.onclick = () => {
          currentFilter = btn.getAttribute('data-filter');
          editorModal.querySelectorAll('.editor-filter-btn').forEach(b => {
            b.className = 'editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-white/10 text-gray-300 hover:bg-white/20 cursor-pointer';
          });
          btn.className = 'editor-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-indigo-600 text-white cursor-pointer';
          updatePreviewTransform();
        };
      });

      // Quick Emoji in editor
      editorModal.querySelectorAll('.editor-emoji-btn').forEach(btn => {
        btn.onclick = () => {
          captionInput.value += btn.getAttribute('data-emoji');
          captionInput.focus();
        };
      });

      // Close modal
      closeBtn.onclick = () => {
        editorModal.remove();
      };

      // Send edited photo
      sendPhotoBtn.onclick = async () => {
        if (isCropMode) exitCropMode();

        sendPhotoBtn.disabled = true;
        sendPhotoText.textContent = "Processing...";
        sendPhotoIcon.innerHTML = `<span class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin inline-block"></span>`;

        try {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.src = currentWorkingSrc;
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
          });

          // Canvas Transformation
          const canvas = document.createElement('canvas');
          const isRotated90or270 = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
          const origW = img.naturalWidth || img.width;
          const origH = img.naturalHeight || img.height;

          canvas.width = isRotated90or270 ? origH : origW;
          canvas.height = isRotated90or270 ? origW : origH;

          const ctx = canvas.getContext('2d');

          // Apply Filter on Canvas Context
          switch (currentFilter) {
            case 'vivid': ctx.filter = 'contrast(1.15) saturate(1.25) brightness(1.05)'; break;
            case 'warm': ctx.filter = 'sepia(0.25) saturate(1.2) brightness(1.02)'; break;
            case 'bw': ctx.filter = 'grayscale(100%) contrast(1.1)'; break;
            case 'contrast': ctx.filter = 'contrast(1.4) brightness(0.95)'; break;
            case 'soft': ctx.filter = 'brightness(1.1) contrast(0.95) saturate(0.9)'; break;
            default: ctx.filter = 'none';
          }

          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((rotation * Math.PI) / 180);
          ctx.scale(flipped ? -1 : 1, 1);
          ctx.drawImage(img, -origW / 2, -origH / 2);

          const finalCaption = captionInput.value.trim();

          canvas.toBlob(async (blob) => {
            editorModal.remove();
            if (blob && onSendCallback) {
              const replyToData = activeReplyTarget ? { ...activeReplyTarget } : null;
              await onSendCallback(blob, finalCaption, replyToData);
            }
          }, 'image/jpeg', 0.85);

        } catch (err) {
          console.error("Editor error:", err);
          alert("Error preparing image: " + err.message);
          editorModal.remove();
        }
      };
    };
    reader.readAsDataURL(file);
  }

  // Image Attachment Trigger
  attachBtn.onclick = () => fileInput.click();

  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert("Please select a valid image file.");
      return;
    }
    fileInput.value = '';
    
    // Open WhatsApp-style Editor
    openWhatsAppImageEditor(file, async (editedBlob, caption, replyToData) => {
      showChatUploadIndicator("Uploading Image to Cloudflare R2... 📷");
      try {
        const res = await sendImageMessage(user, editedBlob, caption, replyToData);
        if (!res.success) {
          alert(res.error || "Failed to send photo.");
        } else {
          clearChatReplyTarget();
        }
      } catch (err) {
        alert("Upload error: " + err.message);
      } finally {
        hideChatUploadIndicator();
      }
    });
  };

  // PDF Share Modal (WhatsApp / Telegram style document preview & caption dialog)
  function openPdfShareModal(file, onSendCallback) {
    const existing = document.getElementById('chat-pdf-share-modal');
    if (existing) existing.remove();

    const formattedSize = file.size < 1024 * 1024 
      ? (file.size / 1024).toFixed(1) + ' KB' 
      : (file.size / (1024 * 1024)).toFixed(2) + ' MB';
      
    const cleanFileName = escapeHTML(file.name || 'document.pdf');

    const modal = document.createElement('div');
    modal.id = 'chat-pdf-share-modal';
    modal.className = 'fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in';
    modal.innerHTML = `
      <div class="bg-[var(--bg-secondary)] border border-[var(--glass-border)] rounded-2xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col animate-scale-in">
          <!-- Header -->
          <div class="flex items-center justify-between px-5 py-3.5 border-b border-[var(--glass-border)] bg-[var(--bg-root)]">
              <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-xl bg-rose-500/15 text-rose-400 flex items-center justify-center font-bold">
                      📄
                  </div>
                  <div>
                      <h4 class="font-bold text-sm text-[var(--text-primary)]">Share PDF Document</h4>
                      <p class="text-[10px] text-[var(--text-secondary)]">Community Lounge</p>
                  </div>
              </div>
              <button id="pdf-modal-close-btn" type="button" class="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-all cursor-pointer">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
          </div>

          <!-- Document Info Card -->
          <div class="p-5 flex flex-col gap-4">
              <div class="p-4 rounded-xl bg-[var(--bg-root)] border border-[var(--glass-border)] flex items-center gap-3.5 shadow-inner">
                  <div class="w-12 h-14 rounded-xl bg-gradient-to-br from-rose-500 to-red-700 flex flex-col items-center justify-center text-white shadow-md shrink-0">
                      <span class="text-[8px] font-black tracking-wider uppercase">PDF</span>
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                          <polyline points="14 2 14 8 20 8"></polyline>
                      </svg>
                  </div>
                  <div class="flex-1 min-w-0">
                      <p class="text-sm font-semibold text-[var(--text-primary)] truncate" title="${cleanFileName}">${cleanFileName}</p>
                      <div class="flex items-center gap-2 mt-1">
                          <span class="text-xs text-[var(--text-secondary)]">${formattedSize}</span>
                          <span class="inline-block w-1 h-1 rounded-full bg-slate-500"></span>
                          <span class="text-[10px] px-1.5 py-0.5 rounded-md bg-rose-500/20 text-rose-300 font-bold uppercase">PDF</span>
                      </div>
                  </div>
              </div>

              <!-- Caption Input -->
              <div class="flex flex-col gap-1.5">
                  <label class="text-xs font-semibold text-[var(--text-secondary)]">Add a Caption / සටහනක් (Optional):</label>
                  <textarea 
                      id="pdf-caption-input" 
                      rows="2" 
                      maxlength="300"
                      placeholder="e.g. 2024 Past Paper, Model Questions, Short Note..." 
                      class="smart-input w-full py-2 px-3 text-xs sm:text-sm resize-none rounded-xl custom-scrollbar"
                  ></textarea>
                  
                  <!-- Quick Emojis -->
                  <div class="flex items-center gap-1.5 mt-1 overflow-x-auto no-scrollbar">
                      ${['📚', '📝', '💡', '🔥', '✅', '❓', '🎯', '📄'].map(em => `
                          <button type="button" class="pdf-emoji-btn px-2 py-0.5 rounded-lg text-xs hover:bg-[var(--glass-border)] cursor-pointer text-slate-300" data-emoji="${em}">${em}</button>
                      `).join('')}
                  </div>
              </div>
          </div>

          <!-- Bottom Action Buttons -->
          <div class="px-5 py-3.5 border-t border-[var(--glass-border)] bg-[var(--bg-root)] flex items-center justify-end gap-2.5">
              <button id="pdf-modal-cancel-btn" type="button" class="btn-ghost text-xs px-4 py-2 text-[var(--text-secondary)] hover:text-white rounded-xl cursor-pointer">
                  Cancel (අවලංගු කරන්න)
              </button>
              <button id="pdf-modal-send-btn" type="button" class="btn-primary text-xs px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold rounded-xl flex items-center gap-2 shadow-lg shadow-emerald-500/25 cursor-pointer transition-all hover:scale-105 active:scale-95">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  <span id="pdf-send-btn-text">Send PDF (යවන්න)</span>
              </button>
          </div>
      </div>
    `;

    document.body.appendChild(modal);

    const captionInput = modal.querySelector('#pdf-caption-input');
    const sendBtn = modal.querySelector('#pdf-modal-send-btn');
    const cancelBtn = modal.querySelector('#pdf-modal-cancel-btn');
    const closeBtn = modal.querySelector('#pdf-modal-close-btn');

    modal.querySelectorAll('.pdf-emoji-btn').forEach(btn => {
      btn.onclick = () => {
        captionInput.value += btn.getAttribute('data-emoji');
        captionInput.focus();
      };
    });

    const closeModal = () => modal.remove();
    closeBtn.onclick = closeModal;
    cancelBtn.onclick = closeModal;
    modal.onclick = (e) => {
      if (e.target === modal) closeModal();
    };

    sendBtn.onclick = async () => {
      const caption = (captionInput.value || '').trim();
      const sendBtnText = modal.querySelector('#pdf-send-btn-text');
      if (sendBtnText) sendBtnText.textContent = "Sending...";
      sendBtn.disabled = true;

      const replyToData = activeReplyTarget ? { ...activeReplyTarget } : null;
      closeModal();
      if (onSendCallback) {
        await onSendCallback(file, caption, replyToData);
      }
    };
  }

  // PDF Attachment Trigger
  if (attachPdfBtn && pdfInput) {
    attachPdfBtn.onclick = () => pdfInput.click();

    pdfInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        alert("Please select a valid PDF file (.pdf).\nකරුණාකර වලංගු PDF ගොනුවක් තෝරන්න.");
        pdfInput.value = '';
        return;
      }

      if (file.size > 25 * 1024 * 1024) {
        alert("PDF file size exceeds 25MB limit.\nPDF ගොනුවේ ප්‍රමාණය 25MB සීමාව ඉක්මවා ඇත.");
        pdfInput.value = '';
        return;
      }

      pdfInput.value = '';

      openPdfShareModal(file, async (selectedFile, caption, replyToData) => {
        showChatUploadIndicator("Uploading PDF Document to Cloudflare R2... 📄");
        try {
          const res = await sendPdfMessage(user, selectedFile, caption, replyToData);
          if (!res.success) {
            alert(res.error || "Failed to send PDF document.");
          } else {
            clearChatReplyTarget();
          }
        } catch (err) {
          alert("Upload error: " + err.message);
        } finally {
          hideChatUploadIndicator();
        }
      });
    };
  }

  // Voice Recording Handlers
  startVoiceBtn.onclick = async () => {
    // Hide review player if open
    cleanupVoiceReview();

    try {
      await voiceRecorder.start((seconds) => {
        const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
        const secs = String(seconds % 60).padStart(2, '0');
        recordingTimer.textContent = `${mins}:${secs}`;
      });
      recordingContainer.classList.remove('hidden');
    } catch (err) {
      alert(err.message || "Failed to start audio recording.");
    }
  };

  cancelRecordingBtn.onclick = () => {
    voiceRecorder.cancel();
    recordingContainer.classList.add('hidden');
  };

  // Stop Recording and Switch to Review Player
  stopRecordingBtn.onclick = async () => {
    try {
      const { blob, duration } = await voiceRecorder.stop();
      recordingContainer.classList.add('hidden');

      // Setup Voice Review Bar
      setupVoiceReview(blob, duration);
    } catch (err) {
      alert(err.message || "Error finishing voice recording.");
      recordingContainer.classList.add('hidden');
    }
  };

  function setupVoiceReview(blob, duration) {
    if (currentRecordedVoiceData && currentRecordedVoiceData.objectUrl) {
      URL.revokeObjectURL(currentRecordedVoiceData.objectUrl);
    }

    const objectUrl = URL.createObjectURL(blob);
    currentRecordedVoiceData = { blob, duration, objectUrl };

    voiceReviewAudioEl.src = objectUrl;
    voiceReviewAudioEl.currentTime = 0;
    voiceReviewProgress.value = 0;

    const mins = String(Math.floor(duration / 60)).padStart(2, '0');
    const secs = String(duration % 60).padStart(2, '0');
    voiceReviewTimeDisplay.textContent = `00:00 / ${mins}:${secs}`;
    voiceReviewPlayIcon.innerHTML = SVG_PLAY;

    voiceReviewContainer.classList.remove('hidden');
  }

  function cleanupVoiceReview() {
    if (voiceReviewAudioEl) {
      voiceReviewAudioEl.pause();
      voiceReviewAudioEl.removeAttribute('src');
    }
    if (currentRecordedVoiceData && currentRecordedVoiceData.objectUrl) {
      URL.revokeObjectURL(currentRecordedVoiceData.objectUrl);
      currentRecordedVoiceData = null;
    }
    voiceReviewPlayIcon.innerHTML = SVG_PLAY;
    voiceReviewProgress.value = 0;
    voiceReviewContainer.classList.add('hidden');
  }

  // Voice Review Play/Pause (Pure SVGs)
  const SVG_PLAY = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
  const SVG_PAUSE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
  const SVG_WHATSAPP_SEND = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" class="translate-x-0.5"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

  voiceReviewPlayBtn.onclick = () => {
    if (voiceReviewAudioEl.paused) {
      voiceReviewAudioEl.play();
      voiceReviewPlayIcon.innerHTML = SVG_PAUSE;
    } else {
      voiceReviewAudioEl.pause();
      voiceReviewPlayIcon.innerHTML = SVG_PLAY;
    }
  };

  voiceReviewAudioEl.ontimeupdate = () => {
    if (!voiceReviewAudioEl.duration) return;
    const progress = (voiceReviewAudioEl.currentTime / voiceReviewAudioEl.duration) * 100;
    voiceReviewProgress.value = progress;

    const curM = String(Math.floor(voiceReviewAudioEl.currentTime / 60)).padStart(2, '0');
    const curS = String(Math.floor(voiceReviewAudioEl.currentTime % 60)).padStart(2, '0');
    const totM = String(Math.floor(voiceReviewAudioEl.duration / 60)).padStart(2, '0');
    const totS = String(Math.floor(voiceReviewAudioEl.duration % 60)).padStart(2, '0');
    voiceReviewTimeDisplay.textContent = `${curM}:${curS} / ${totM}:${totS}`;
  };

  voiceReviewAudioEl.onended = () => {
    voiceReviewPlayIcon.innerHTML = SVG_PLAY;
    voiceReviewProgress.value = 0;
  };

  voiceReviewProgress.oninput = () => {
    if (voiceReviewAudioEl.duration) {
      voiceReviewAudioEl.currentTime = (voiceReviewProgress.value / 100) * voiceReviewAudioEl.duration;
    }
  };

  voiceReviewDiscardBtn.onclick = () => {
    cleanupVoiceReview();
  };

  voiceReviewRerecordBtn.onclick = async () => {
    cleanupVoiceReview();
    startVoiceBtn.click();
  };

  voiceReviewSendBtn.onclick = async () => {
    if (!currentRecordedVoiceData || !currentRecordedVoiceData.blob) return;

    voiceReviewSendBtn.disabled = true;
    voiceReviewSendBtn.innerHTML = `<span class="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin inline-block"></span> <span>Uploading...</span>`;
    showChatUploadIndicator("Uploading Voice Note to Cloudflare R2...");

    try {
      const { blob, duration } = currentRecordedVoiceData;
      const replyToData = activeReplyTarget ? { ...activeReplyTarget } : null;
      const res = await sendVoiceMessage(user, blob, duration, replyToData);
      if (!res.success) {
        alert(res.error || "Failed to send voice note.");
      } else {
        cleanupVoiceReview();
        clearChatReplyTarget();
      }
    } catch (err) {
      alert("Error uploading voice note: " + err.message);
    } finally {
      hideChatUploadIndicator();
      voiceReviewSendBtn.disabled = false;
      voiceReviewSendBtn.innerHTML = `<span>Send</span> <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
    }
  };

  // --- Mention & Reply Target Manager ---
  let activeReplyTarget = null;

  function renderChatReplyBanner() {
    const bannerEl = document.getElementById('chat-reply-banner');
    if (!bannerEl) return;

    if (!activeReplyTarget) {
      bannerEl.classList.add('hidden');
      bannerEl.innerHTML = '';
      return;
    }

    bannerEl.classList.remove('hidden');
    bannerEl.innerHTML = `
      <div class="flex items-center gap-2 min-w-0 flex-1">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-indigo-400 shrink-0"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
          <div class="min-w-0">
              <p class="text-xs font-bold text-indigo-300 truncate">Replying to @${activeReplyTarget.senderName}</p>
              <p class="text-[11px] text-[var(--text-secondary)] truncate">${activeReplyTarget.textSnippet}</p>
          </div>
      </div>
      <button id="cancel-reply-btn" type="button" class="p-1 text-[var(--text-secondary)] hover:text-white rounded-lg hover:bg-white/10 cursor-pointer" title="Cancel Reply">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"></path></svg>
      </button>
    `;

    const cancelBtn = bannerEl.querySelector('#cancel-reply-btn');
    if (cancelBtn) {
      cancelBtn.onclick = clearChatReplyTarget;
    }
  }

  function clearChatReplyTarget() {
    activeReplyTarget = null;
    renderChatReplyBanner();
  }

  window.handleReplyToMessage = (msgId, senderName, textSnippet, messageType) => {
    const safeId = String(msgId || '').trim();
    const safeSender = decodeURIComponent(senderName || 'Student');
    const safeSnippet = decodeURIComponent(textSnippet || 'Message');
    const safeType = messageType || 'text';

    activeReplyTarget = {
      id: safeId,
      messageId: safeId,
      senderName: safeSender,
      text: safeSnippet,
      textSnippet: safeSnippet,
      messageType: safeType
    };
    renderChatReplyBanner();
    if (messageInput) {
      messageInput.focus();
    }
  };

  window.jumpToChatMessage = (messageId) => {
    if (!messageId) return;
    const el = document.getElementById(`msg-item-${messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('msg-flash-highlight');
      setTimeout(() => el.classList.remove('msg-flash-highlight'), 1800);
    }
  };

  // Main Send Function (Text Only, since Images go via WhatsApp Editor)
  async function handleSendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    sendBtn.disabled = true;
    sendBtnIcon.innerHTML = `<span class="animate-spin h-4 w-4 border-2 border-white rounded-full border-t-transparent inline-block"></span>`;

    try {
      const replyToData = activeReplyTarget ? { ...activeReplyTarget } : null;
      const res = await sendTextMessage(user, text, replyToData);
      if (!res.success) {
        alert(res.error || "Failed to send message.");
      } else {
        messageInput.value = '';
        messageInput.style.height = 'auto';
        clearChatReplyTarget();
      }
    } catch (err) {
      console.error(err);
      alert("Error sending message: " + err.message);
    } finally {
      sendBtn.disabled = false;
      sendBtnIcon.innerHTML = SVG_WHATSAPP_SEND;
      messageInput.focus();
    }
  }

  sendBtn.onclick = handleSendMessage;

  // Window delete handler for chat messages
  window.handleDeleteChatMsg = async (msgId) => {
    if (!confirm("Are you sure you want to delete this message?\nමෙම පණිවිඩය මකා දැමීමට ඔබට විශ්වාසද?")) return;
    try {
      const res = await deleteCommunityMessage(msgId);
      if (!res.success) {
        alert("Failed to delete message: " + res.error);
      }
    } catch (e) {
      alert("Error: " + e.message);
    }
  };

  // Window audio player toggle
  window.toggleChatAudio = (btnEl, audioUrl) => {
    const audio = btnEl.querySelector('audio');
    const playIcon = btnEl.querySelector('.chat-audio-icon');
    const progressBar = btnEl.parentElement.querySelector('.chat-audio-progress');
    const timeDisplay = btnEl.parentElement.querySelector('.chat-audio-time');

    if (!audio) return;

    if (currentPlayingAudio && currentPlayingAudio !== audio) {
      currentPlayingAudio.pause();
      currentPlayingAudio.currentTime = 0;
      if (currentPlayingBtn) {
        const prevIcon = currentPlayingBtn.querySelector('.chat-audio-icon');
        if (prevIcon) prevIcon.textContent = '▶️';
      }
    }

    if (audio.paused) {
      audio.play().then(() => {
        playIcon.textContent = '⏸️';
        currentPlayingAudio = audio;
        currentPlayingBtn = btnEl;
      }).catch(err => {
        console.error("Audio playback error:", err);
      });
    } else {
      audio.pause();
      playIcon.textContent = '▶️';
      currentPlayingAudio = null;
      currentPlayingBtn = null;
    }

    audio.ontimeupdate = () => {
      if (audio.duration) {
        const pct = (audio.currentTime / audio.duration) * 100;
        if (progressBar) progressBar.style.width = pct + '%';
        if (timeDisplay) {
          const curMins = Math.floor(audio.currentTime / 60);
          const curSecs = String(Math.floor(audio.currentTime % 60)).padStart(2, '0');
          timeDisplay.textContent = `${curMins}:${curSecs}`;
        }
      }
    };

    audio.onended = () => {
      playIcon.textContent = '▶️';
      if (progressBar) progressBar.style.width = '0%';
      currentPlayingAudio = null;
      currentPlayingBtn = null;
    };
  };

  // Download Chat Image Helper (Direct device save)
  window.downloadChatImage = async (imageUrl, filename = 'StudyTracker_Chat_Image.jpg') => {
    try {
      const res = await fetch(imageUrl);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      // Fallback
      const a = document.createElement('a');
      a.href = imageUrl;
      a.download = filename;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  // Download Chat PDF Helper (Direct device save)
  window.downloadChatPdf = async (pdfUrl, filename = 'Document.pdf') => {
    try {
      const res = await fetch(pdfUrl);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      // Fallback
      const a = document.createElement('a');
      a.href = pdfUrl;
      a.download = filename;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  // Full-Screen Image Lightbox Viewer (Back & Download support)
  window.openChatImageZoom = (imageUrl, caption = '') => {
    const existing = document.getElementById('chat-lightbox-modal');
    if (existing) existing.remove();

    const lightbox = document.createElement('div');
    lightbox.id = 'chat-lightbox-modal';
    lightbox.className = 'fixed inset-0 z-50 bg-black/95 backdrop-blur-md flex flex-col justify-between animate-fade-in';
    lightbox.innerHTML = `
      <!-- Top Action Bar -->
      <div class="flex items-center justify-between p-3 sm:p-4 bg-gradient-to-b from-black/90 to-transparent shrink-0">
          <button id="lightbox-back-btn" class="flex items-center gap-2 text-white hover:text-indigo-300 px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition-all font-semibold text-xs sm:text-sm cursor-pointer shadow">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12"></line>
                  <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
              <span>Back</span>
          </button>

          <div class="flex items-center gap-2">
              <!-- Download Button -->
              <button id="lightbox-download-btn" class="flex items-center gap-1.5 text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 px-4 py-2 rounded-xl font-bold text-xs sm:text-sm transition-all shadow-lg shadow-emerald-600/30 cursor-pointer">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="7 10 12 15 17 10"></polyline>
                      <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  <span>Download</span>
              </button>

              <!-- Close Button (X) -->
              <button id="lightbox-close-btn" class="p-2 text-gray-300 hover:text-white rounded-xl bg-white/10 hover:bg-white/20 transition-all cursor-pointer" title="Close">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M6 18L18 6M6 6l12 12"></path>
                  </svg>
              </button>
          </div>
      </div>

      <!-- Center Image Viewport -->
      <div id="lightbox-viewport" class="flex-1 flex items-center justify-center p-2 sm:p-4 overflow-hidden cursor-zoom-out">
          <img src="${imageUrl}" class="max-h-[82vh] max-w-full object-contain rounded-xl shadow-2xl transition-all select-none pointer-events-auto" style="user-select: none;">
      </div>

      <!-- Bottom Caption Bar -->
      ${caption ? `
      <div class="p-3 sm:p-4 bg-gradient-to-t from-black/90 via-black/60 to-transparent text-center shrink-0">
          <p class="text-white text-xs sm:text-sm font-medium max-w-2xl mx-auto bg-black/60 px-4 py-2 rounded-xl backdrop-blur-md border border-white/15 inline-block">${caption}</p>
      </div>
      ` : '<div class="h-4"></div>'}
    `;

    document.body.appendChild(lightbox);

    const closeHandler = () => lightbox.remove();
    lightbox.querySelector('#lightbox-back-btn').onclick = closeHandler;
    lightbox.querySelector('#lightbox-close-btn').onclick = closeHandler;
    lightbox.querySelector('#lightbox-viewport').onclick = (e) => {
      if (e.target.tagName !== 'IMG') closeHandler();
    };

    lightbox.querySelector('#lightbox-download-btn').onclick = () => {
      const fileName = `StudyTracker_Chat_${Date.now()}.jpg`;
      window.downloadChatImage(imageUrl, fileName);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        lightbox.remove();
        window.removeEventListener('keydown', onKeyDown);
      }
    };
    window.addEventListener('keydown', onKeyDown);
  };

  // Real-time messages renderer
  function renderMessagesList(messages) {
    if (!messagesContainer) return;

    if (messages.length === 0) {
      messagesContainer.innerHTML = `
        <div class="flex flex-col items-center justify-center h-64 text-center text-[var(--text-secondary)] space-y-3">
            <div class="w-16 h-16 rounded-2xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center text-3xl">
                💬
            </div>
            <div>
                <h4 class="font-bold text-[var(--text-primary)]">No messages in the lounge yet</h4>
                <p class="text-xs text-[var(--text-secondary)] mt-1">Be the first to say hello and start the conversation!</p>
            </div>
        </div>
      `;
      return;
    }

    const wasNearBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 120;

    messagesContainer.innerHTML = messages.map(m => {
      const isMine = m.senderId === user.uid;
      const canDelete = isMine || isPrivilegedUser;

      // Extract text snippet for reply
      let replySnippet = m.text || '';
      if (m.messageType === 'image') replySnippet = '📷 Photo' + (m.text ? `: ${m.text}` : '');
      else if (m.messageType === 'audio') replySnippet = '🎙️ Voice Note';
      else if (m.messageType === 'document' || m.messageType === 'pdf') replySnippet = '📄 PDF: ' + (m.fileName || 'Document');
      if (replySnippet.length > 70) replySnippet = replySnippet.slice(0, 70) + '...';

      // Avatar
      let avatarHtml = '';
      if (m.isPhotoPublic === true && m.senderPhoto) {
        avatarHtml = `<img src="${m.senderPhoto}" class="w-8 h-8 sm:w-9 sm:h-9 rounded-full object-cover border border-indigo-500/40 shrink-0 shadow-sm" alt="${m.senderName}">`;
      } else {
        const initial = (m.senderName || 'U').charAt(0).toUpperCase();
        avatarHtml = `<div class="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center font-bold text-white text-xs sm:text-sm shrink-0 border border-white/15 shadow-sm">${initial}</div>`;
      }

      // Role Badge
      let roleBadgeHtml = '';
      if (m.senderRole === 'admin' || m.senderId === ADMIN_UID) {
        roleBadgeHtml = `<span class="badge-admin">👑 ADMIN</span>`;
      } else if (m.senderRole === 'moderator') {
        roleBadgeHtml = `<span class="badge-moderator">🛡️ MOD</span>`;
      }

      // Quoted Reply Card
      let quotedReplyHtml = '';
      if (m.replyTo && (m.replyTo.senderName || m.replyTo.text || m.replyTo.textSnippet)) {
        const replyTargetId = m.replyTo.messageId || m.replyTo.id || '';
        const sender = m.replyTo.senderName || 'Student';
        const snippet = m.replyTo.textSnippet || m.replyTo.text || 'Replied message';
        quotedReplyHtml = `
          <div class="chat-reply-quote" onclick="window.jumpToChatMessage('${replyTargetId}')" title="Click to view quoted message">
              <p class="font-bold text-indigo-300 text-[10px] truncate flex items-center gap-1">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
                  <span>@${sender}</span>
              </p>
              <p class="text-[11px] opacity-85 truncate text-[var(--text-primary)] mt-0.5">${snippet}</p>
          </div>
        `;
      }

      // Message Content Body
      let bodyHtml = '';
      if (m.messageType === 'image') {
        bodyHtml = `
          <div class="space-y-2">
              ${quotedReplyHtml}
              <div class="rounded-xl overflow-hidden cursor-pointer border border-white/10 max-w-[260px] sm:max-w-[320px] max-h-[300px] bg-black/20 hover:opacity-95 transition-opacity" onclick="window.openChatImageZoom('${m.mediaUrl}', '${(m.text || '').replace(/'/g, "\\'")}')">
                  <img src="${m.mediaUrl}" class="w-full h-full object-cover" loading="lazy">
              </div>
              ${m.text ? `<p class="text-xs sm:text-sm whitespace-pre-wrap break-words leading-relaxed">${formatChatText(m.text)}</p>` : ''}
          </div>
        `;
      } else if (m.messageType === 'audio') {
        const durStr = m.audioDuration ? `${Math.floor(m.audioDuration / 60)}:${String(m.audioDuration % 60).padStart(2, '0')}` : '0:05';
        bodyHtml = `
          <div>
              ${quotedReplyHtml}
              <div class="chat-audio-player">
                  <button type="button" onclick="window.toggleChatAudio(this, '${m.mediaUrl}')" class="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-all cursor-pointer shrink-0">
                      <span class="chat-audio-icon text-sm">▶️</span>
                      <audio src="${m.mediaUrl}" preload="none"></audio>
                  </button>
                  <div class="flex-1 flex flex-col justify-center gap-1">
                      <div class="w-full bg-white/15 h-1.5 rounded-full overflow-hidden relative">
                          <div class="chat-audio-progress bg-cyan-300 h-full rounded-full w-0 transition-all duration-100"></div>
                      </div>
                      <div class="flex justify-between items-center text-[10px] opacity-75 font-mono">
                          <span class="chat-audio-time">0:00</span>
                          <span>${durStr}</span>
                      </div>
                  </div>
              </div>
          </div>
        `;
      } else if (m.messageType === 'document' || m.messageType === 'pdf') {
        const safeFileName = escapeHTML(m.fileName || 'Document.pdf');
        const formattedSize = m.fileSize ? formatFileSize(m.fileSize) : 'PDF Document';
        const fileUrl = sanitizeUrl(m.mediaUrl);
        bodyHtml = `
          <div class="space-y-2">
              ${quotedReplyHtml}
              <div class="chat-document-card group/doc">
                  <div class="w-10 h-12 rounded-xl bg-gradient-to-br from-rose-500 to-red-700 flex flex-col items-center justify-center text-white shadow-md shrink-0">
                      <span class="text-[7.5px] font-black tracking-wider uppercase">PDF</span>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                          <polyline points="14 2 14 8 20 8"></polyline>
                      </svg>
                  </div>
                  <div class="flex-1 min-w-0 pr-1">
                      <p class="text-xs sm:text-sm font-semibold truncate text-[var(--text-primary)] group-hover/doc:text-indigo-300 transition-colors" title="${safeFileName}">${safeFileName}</p>
                      <p class="text-[10px] text-[var(--text-secondary)] opacity-85 mt-0.5">${formattedSize}</p>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                      <a href="${fileUrl}" target="_blank" rel="noopener noreferrer" class="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-indigo-300 hover:text-white transition-all cursor-pointer" title="Open PDF in new tab / බලන්න">
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                              <polyline points="15 3 21 3 21 9"></polyline>
                              <line x1="10" y1="14" x2="21" y2="3"></line>
                          </svg>
                      </a>
                      <button type="button" onclick="window.downloadChatPdf('${fileUrl}', '${safeFileName.replace(/'/g, "\\'")}')" class="p-1.5 rounded-lg bg-emerald-600/85 hover:bg-emerald-500 text-white transition-all cursor-pointer shadow" title="Download PDF / බාගත කරන්න">
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                              <polyline points="7 10 12 15 17 10"></polyline>
                              <line x1="12" y1="15" x2="12" y2="3"></line>
                          </svg>
                      </button>
                  </div>
              </div>
              ${m.text ? `<p class="text-xs sm:text-sm whitespace-pre-wrap break-words leading-relaxed">${formatChatText(m.text)}</p>` : ''}
          </div>
        `;
      } else {
        bodyHtml = `
          <div>
              ${quotedReplyHtml}
              <p class="text-xs sm:text-sm whitespace-pre-wrap break-words leading-relaxed">${formatChatText(m.text)}</p>
          </div>
        `;
      }

      return `
        <div id="msg-item-${m.id}" class="flex items-start gap-2.5 sm:gap-3 group transition-all duration-300 ${isMine ? 'flex-row-reverse' : ''}">
            ${avatarHtml}
            <div class="flex flex-col max-w-[85%] sm:max-w-[75%] ${isMine ? 'items-end' : 'items-start'}">
                
                <!-- Sender Header Details & Actions -->
                <div class="flex items-center gap-1.5 mb-1 px-1 flex-wrap">
                    <span class="text-[11px] font-bold text-[var(--text-primary)]">${m.senderName || 'Student'}</span>
                    ${roleBadgeHtml}
                    <span class="text-[10px] text-[var(--text-secondary)] opacity-60 ml-1">${formatChatTime(m.createdAtMs)}</span>
                    
                    <!-- Reply Action Button -->
                    <button onclick="window.handleReplyToMessage('${m.id}', '${encodeURIComponent(m.senderName || 'Student')}', '${encodeURIComponent(replySnippet)}', '${m.messageType}')" class="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-indigo-400 p-1 text-xs cursor-pointer ml-1 rounded-md hover:bg-white/10 flex items-center gap-0.5" title="Reply to message">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
                        <span class="text-[10px] hidden sm:inline">Reply</span>
                    </button>

                    <!-- Delete Button (if permitted) -->
                    ${canDelete ? `
                        <button onclick="window.handleDeleteChatMsg('${m.id}')" class="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-400 p-1 text-xs cursor-pointer rounded-md hover:bg-red-500/10" title="Delete Message">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </button>
                    ` : ''}
                </div>

                <!-- Bubble Container -->
                <div class="p-3 sm:p-3.5 rounded-2xl ${isMine ? 'chat-bubble-mine' : 'chat-bubble-other'}">
                    ${bodyHtml}
                </div>
            </div>
        </div>
      `;
    }).join('');

    // Smooth scroll down if the user was already near bottom or initial load
    if (wasNearBottom || messages.length > 0) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  // Subscribe to real-time chat updates
  chatUnsubscribe = listenCommunityChat((messages) => {
    localStorage.setItem('study_last_chat_viewed_time', Date.now().toString());
    updateUnreadChatBadges(0);
    renderMessagesList(messages);
  }, (err) => {
    if (messagesContainer) {
      messagesContainer.innerHTML = `
        <div class="p-6 text-center text-red-400 space-y-2">
            <p class="font-bold">Error loading messages</p>
            <p class="text-xs text-[var(--text-secondary)]">${err.message || 'Please check your internet connection'}</p>
        </div>
      `;
    }
  });
}




