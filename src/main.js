import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db, ADMIN_UID } from "./firebase.js";
import * as UI from "./ui.js";
import { initParticles } from "./particles.js";

let currentUser = null;

// --- Router System ---
function navigateTo(path) {
    if (window.location.pathname === path) return;
    window.history.pushState({}, '', path);
    router();
}

async function router() {
    const path = window.location.pathname === '/' ? '/home' : window.location.pathname;
    console.log(`Navigating to: ${path}`);

    // Add smooth transition effect
    const container = document.getElementById('app-container');
    container.style.opacity = '0';

    setTimeout(async () => {
        // Update Header
        await UI.renderHeader(currentUser, navigateTo, signOut);

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
        if (path === '/contact') {
            UI.renderContact(navigateTo, currentUser);
            animatePageIn();
            return;
        }

        // Protected Routes
        if (!currentUser) {
            navigateTo('/welcome');
            return;
        }

        if (path !== '/profile') {
            if (currentUser.uid !== ADMIN_UID) {
                try {
                    const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
                    if (userDoc.exists()) {
                        const d = userDoc.data();
                        if (!d.phone || !d.school || !d.birthday || !d.firstName || !d.lastName || !d.examYear || !d.email) {
                            alert("Please complete your profile details to continue.\nකරුණාකර ඉදිරියට යාමට පෙර ඔබගේ ගිණුමේ විස්තර සම්පූර්ණ කරන්න.");
                            navigateTo('/profile');
                            return;
                        }
                    } else {
                        alert("Please complete your profile details to continue.\nකරුණාකර ඉදිරියට යාමට පෙර ඔබගේ ගිණුමේ විස්තර සම්පූර්ණ කරන්න.");
                        navigateTo('/profile');
                        return;
                    }
                } catch(e) {
                    console.error("Profile check error:", e);
                }
            }
        }

        if (path === '/home') {
            await UI.renderHome(currentUser);
        } else if (path === '/profile') {
            await UI.renderProfile(currentUser);
        } else if (path === '/timetable') {
            await UI.renderTimetable(currentUser);
        } else if (path === '/recordings') {
            UI.renderSubjects(navigateTo);
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

// --- Initialization ---
window.addEventListener('popstate', router);
window.addEventListener('load', () => {
    initParticles();
    registerServiceWorker();

    let sessionUnsubscribe = null;

    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (currentUser && currentUser.uid === ADMIN_UID) {
            currentUser.displayName = "Admin";
        }

        // Track user activity and manage session
        if (currentUser) {
            // Session Management
            let localSessionId = localStorage.getItem('studyTrackerSessionId');
            const pendingSessionId = localStorage.getItem('pendingSessionId');

            if (pendingSessionId) {
                localSessionId = pendingSessionId;
                localStorage.setItem('studyTrackerSessionId', localSessionId);
                localStorage.removeItem('pendingSessionId');
                // Update Firestore immediately
                updateDoc(doc(db, 'users', currentUser.uid), { sessionId: localSessionId }).catch(e=>console.log('Session update err:', e));
            }

            if (!localSessionId) {
                localSessionId = Date.now().toString() + Math.random().toString();
                localStorage.setItem('studyTrackerSessionId', localSessionId);
            }

            if (sessionUnsubscribe) sessionUnsubscribe();
            sessionUnsubscribe = onSnapshot(doc(db, 'users', currentUser.uid), (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    if (data.sessionId && data.sessionId !== localSessionId) {
                        alert("You have been logged out because your account was accessed from another device.\nඔබගේ ගිණුමට වෙනත් උපාංගයකින් පිවිස ඇති බැවින් ඔබව ඉවත් කරන ලදී.");
                        signOut(auth);
                    } else if (!data.sessionId) {
                        updateDoc(doc(db, 'users', currentUser.uid), { sessionId: localSessionId }).catch(e=>console.log(e));
                    }
                }
            });

            UI.trackUserActivity(currentUser.uid);
            UI.listenForNotifications(currentUser);
            UI.checkNewYearPopup(currentUser);
            await requestNotificationPermission();
        } else {
            if (sessionUnsubscribe) {
                sessionUnsubscribe();
                sessionUnsubscribe = null;
            }
            localStorage.removeItem('studyTrackerSessionId');
            localStorage.removeItem('pendingSessionId');
            UI.listenForNotifications(null);
        }

        // Redirect if on root or welcome and logged in
        if ((!window.location.pathname || window.location.pathname === '/' || window.location.pathname === '/welcome') && currentUser) {
            navigateTo('/home');
        } else {
            router();
        }
    });
});

// Expose navigateTo to window if needed for inline onclicks
window.navigateTo = navigateTo;
