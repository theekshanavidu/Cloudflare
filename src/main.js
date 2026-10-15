import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db, ADMIN_UID } from "./firebase.js";
import * as UI from "./ui.js";
import { initParticles } from "./particles.js";
import { initGlobalInputProtection } from "./security.js";

// Initialize global real-time input sanitization & XSS protection
initGlobalInputProtection();

let currentUser = null;

// --- Router System ---
function navigateTo(path) {
    if (window.location.pathname === path) return;
    window.history.pushState({}, '', path);
    try {
        if (path && path !== '/' && path !== '/welcome' && path !== '/login' && path !== '/register' && path !== '/reset-password') {
            sessionStorage.setItem('study_last_active_path', path);
        }
    } catch (e) {}
    router();
}

async function router() {
    const path = window.location.pathname === '/' ? '/home' : window.location.pathname;
    try {
        if (path && path !== '/' && path !== '/welcome' && path !== '/login' && path !== '/register' && path !== '/reset-password') {
            sessionStorage.setItem('study_last_active_path', path);
        }
    } catch (e) {}
    console.log(`Navigating to: ${path}`);
    
    // Clean up chemistry game if we're navigating away
    if (path !== '/organicgame' && window.unmountChemistryGame) {
        window.unmountChemistryGame();
    }

    // Clean up countdown intervals when navigating away
    if (path !== '/login' && path !== '/register' && path !== '/reset-password' && window.authCountdownInterval) {
        clearInterval(window.authCountdownInterval);
        window.authCountdownInterval = null;
    }
    if (path !== '/home' && window.examCountdownInterval) {
        clearInterval(window.examCountdownInterval);
        window.examCountdownInterval = null;
    }


    // Toggle auth background mode (removes periodic table canvas on login/register/reset)
    if (path === '/login' || path === '/register' || path === '/' || path === '/welcome' || path === '/reset-password') {
        document.body.classList.add('auth-page-mode');
    } else {
        document.body.classList.remove('auth-page-mode');
    }

    // Handle chat fullscreen mode & unread tracking
    if (path === '/chat') {
        localStorage.setItem('study_last_chat_viewed_time', Date.now().toString());
        sessionStorage.setItem('study_was_in_chat', 'true');
        if (UI.updateUnreadChatBadges) UI.updateUnreadChatBadges(0);
    } else {
        document.body.classList.remove('chat-fullscreen-mode');
        if (sessionStorage.getItem('study_was_in_chat') === 'true') {
            sessionStorage.removeItem('study_was_in_chat');
            localStorage.setItem('study_last_chat_viewed_time', Date.now().toString());
            if (UI.updateUnreadChatBadges) UI.updateUnreadChatBadges(0);
        }
    }

    // Add smooth transition effect without blank screen
    const container = document.getElementById('app-container');
    if (container && (!container.innerHTML.trim() || container.innerHTML.includes('route-loading-indicator'))) {
        container.innerHTML = `
            <div id="route-loading-indicator" class="flex flex-col items-center justify-center min-h-[45vh] gap-3">
                <div class="w-9 h-9 border-3 border-indigo-500/30 border-t-indigo-400 rounded-full animate-spin"></div>
                <p class="text-xs text-[var(--text-secondary)] font-medium tracking-wide">Loading content...</p>
            </div>
        `;
        container.style.opacity = '1';
    }

    setTimeout(async () => {
        // Update Header safely
        try {
            await UI.renderHeader(currentUser, navigateTo, signOut);
        } catch (e) {
            console.warn("renderHeader fallback:", e);
        }

        // Public Routes
        if (path === '/' || path === '/welcome') {
            UI.renderWelcome(navigateTo);
            animatePageIn();
            return;
        }
        if (path === '/login') {
            UI.renderLogin(navigateTo);
            animatePageIn();
            return;
        }
        if (path === '/register') {
            UI.renderRegister(navigateTo);
            animatePageIn();
            return;
        }
        if (path === '/reset-password') {
            UI.renderResetPassword(navigateTo);
            animatePageIn();
            return;
        } else if (path === '/simulation') {
            UI.renderSimulation(navigateTo);
            animatePageIn();
            return;
        } else if (path === '/contact') {
            UI.renderContact(navigateTo, currentUser);
            animatePageIn();
            return;
        } else if (path === '/resources') {
            UI.renderResources(navigateTo);
            animatePageIn();
            return;
        }

        // Protected Routes
        if (!currentUser) {
            navigateTo('/welcome');
            return;
        }

        // Profile check using fast local cache so navigation never stalls on slow network
        if (path !== '/profile') {
            if (currentUser.uid !== ADMIN_UID) {
                try {
                    const d = await UI.getUserProfile(currentUser.uid);
                    if (d) {
                        if (!d.phone || !d.birthday || !d.firstName || !d.lastName || !d.examYear || !d.email) {
                            alert("Please complete your profile details to continue.\nකරුණාකර ඉදිරියට යාමට පෙර ඔබගේ ගිණුමේ විස්තර සම්පූර්ණ කරන්න.");
                            navigateTo('/profile');
                            return;
                        }
                    }
                } catch(e) {
                    console.error("Profile check error:", e);
                }
            }
        }

        if (path === '/home') {
            await UI.renderHome(currentUser);
            /* ========================================================================= */
            /* ===== EXAM TIMETABLE POPUP CODE - DISABLED ============================== */
            /* ========================================================================= */
            // UI.checkExamTimetablePopup(currentUser);
            /* ========================================================================= */
        } else if (path === '/organicgame') {
            await UI.renderOrganicGame();
        } else if (path === '/profile') {
            await UI.renderProfile(currentUser);
        } else if (path === '/timetable') {
            await UI.renderTimetable(currentUser);
        } else if (path === '/recordings') {
            const hasAccess = await UI.checkLectureHallAccess(currentUser, navigateTo);
            if (hasAccess) {
                UI.renderSubjects(navigateTo);
            } else {
                return;
            }
        } else if (path === '/live') {
            await UI.renderLiveClasses(currentUser, navigateTo);
        } else if (path === '/chat') {
            await UI.renderCommunityChat(currentUser, navigateTo);
        } else if (path === '/adminpanel') {
            if (currentUser.uid === ADMIN_UID) {
                await UI.renderAdmin(currentUser);
            } else {
                alert("Access Denied");
                navigateTo('/home');
            }
        }
        // Dynamic Routes for Recordings
        else if (path.startsWith('/recording/')) {
            const hasAccess = await UI.checkLectureHallAccess(currentUser, navigateTo);
            if (!hasAccess) {
                return;
            }
            const parts = path.split('/');
            const subject = parts[2];
            const type = parts[3];
            const lesson = parts[4];

            if (subject && type && lesson) {
                const day = lesson.replace('lesson', '');
                await UI.openLessonPage(subject, type, day, currentUser);
            } else if (subject && type) {
                await UI.renderLessons(subject, type, navigateTo, currentUser);
            } else if (subject) {
                UI.renderType(subject, navigateTo);
            }
        }

        animatePageIn();
        UI.updateMobileNav(path);
    }, 150);
}

function animatePageIn() {
    const container = document.getElementById('app-container');
    container.style.opacity = '0';
    container.style.transform = 'translateY(20px)';

    setTimeout(() => {
        container.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
        container.style.opacity = '1';
        container.style.transform = 'translateY(0)';
    }, 50);
}

// --- Service Worker & Push Permissions ---
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('SW Registered', reg))
            .catch(err => console.error('SW Register Fallback:', err));
    }
}

async function requestNotificationPermission() {
    if ('Notification' in window) {
        const permission = await Notification.requestPermission();
        console.log('Notification permission:', permission);
        return permission;
    }
    return 'denied';
}

// Function to get a cookie value
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
}

// Function to set a cookie value
function setCookie(name, value, days = 365) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    const expires = "; expires=" + date.toUTCString();
    document.cookie = name + "=" + (value || "")  + expires + "; path=/; SameSite=Lax";
}

// Function to remove a cookie
function removeCookie(name) {
    document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax';
}

// --- Fast App Initialization (Runs immediately without waiting for heavy external scripts) ---
function initApp() {
    initParticles();
    registerServiceWorker();
    UI.startLiveClassesListener();

    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (currentUser && currentUser.uid === ADMIN_UID) {
            currentUser.displayName = "Admin";
        }

        // Track user activity and notifications (Unlimited simultaneous devices allowed)
        if (currentUser) {
            UI.trackUserActivity(currentUser.uid);
            UI.listenForNotifications(currentUser);
            UI.listenForUnreadChat(currentUser);
            UI.checkNewYearPopup(currentUser);
            if (window.checkAndDisplayGlobalNotification) window.checkAndDisplayGlobalNotification(currentUser);
            requestNotificationPermission().catch(() => {});
        } else {
            UI.listenForNotifications(null);
            UI.listenForUnreadChat(null);
        }

        // Redirect if on root or welcome and logged in
        if ((!window.location.pathname || window.location.pathname === '/' || window.location.pathname === '/welcome') && currentUser) {
            let targetPath = '/home';
            try {
                const savedPath = sessionStorage.getItem('study_last_active_path');
                if (savedPath && savedPath !== '/' && savedPath !== '/welcome' && savedPath !== '/login' && savedPath !== '/register' && savedPath !== '/reset-password') {
                    targetPath = savedPath;
                }
            } catch (e) {}
            navigateTo(targetPath);
        } else {
            router();
        }
    });
}

window.addEventListener('popstate', router);
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// Expose navigateTo to window if needed for inline onclicks
window.navigateTo = navigateTo;
