import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getStorage
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDYhulc8Qz_xGfIeb1g9A6BGO2wwbrz82M",
  authDomain: "study-9c374.firebaseapp.com",
  projectId: "study-9c374",
  storageBucket: "study-9c374.appspot.com",
  messagingSenderId: "82946998504",
  appId: "1:82946998504:web:290cd36a2559846891095d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

export const ADMIN_UID = "m1rddMA36WbVunFW3B0BzuqOwyI2";
export const NILANTHA_MODERATORS = ["vn9a2rNQgbbYPyHRS2c28XwlMRJ3", "2M8JB3hF4GQdBIwHfzp2grjBVCJ3"];
export const RAVINDU_MODERATORS = ["lk9bKS8oxKNt8HcslZrMgLmHOb43"];

