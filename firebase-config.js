// firebase-config.js
// Exports `firebaseApp`, which app.js imports.
//
// HOW TO FILL THIS IN:
// Firebase Console -> Project settings (gear icon) -> General -> "Your apps"
// -> Web app (</>) -> copy the values from the `firebaseConfig` object.
//
// NOTE: These values are NOT secrets. They only identify your project.
// Real security comes from firestore.rules and storage.rules.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";

const firebaseConfig = {
  apiKey: "AIzaSyDQ1yJjnuyJUlVYJt39WQgdTHa3sz7IJXY",
  authDomain: "splitease-amey.firebaseapp.com",
  projectId: "splitease-amey",
  storageBucket: "splitease-amey.firebasestorage.app", // older projects: YOUR_PROJECT_ID.appspot.com
  messagingSenderId: "522014720971",
  appId: "1:522014720971:web:59d94b1aec5cb3f39eac4e"
};

export const firebaseApp = initializeApp(firebaseConfig);
