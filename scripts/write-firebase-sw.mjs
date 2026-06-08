import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function loadEnvFile(fileName) {
  const filePath = path.join(root, fileName);
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;

    const [rawKey, ...rawValueParts] = trimmed.split('=');
    const key = rawKey.trim();
    if (process.env[key] !== undefined) continue;

    let value = rawValueParts.join('=').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile('.env');
loadEnvFile('.env.local');

const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY || '',
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.VITE_FIREBASE_APP_ID || '',
};

const content = `self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const firebaseConfig = ${JSON.stringify(firebaseConfig, null, 2)};
const firebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.projectId &&
  firebaseConfig.messagingSenderId &&
  firebaseConfig.appId
);

if (firebaseConfigured) {
  importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

  firebase.initializeApp(firebaseConfig);

  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const notificationTitle =
      payload?.notification?.title || "Amar Veggies";

    const notificationOptions = {
      body:
        payload?.notification?.body ||
        "Your order status has been updated.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "amar-veggies-notification",
      renotify: true
    };

    self.registration.showNotification(
      notificationTitle,
      notificationOptions
    );
  });
}
`;

fs.mkdirSync(path.join(root, 'public'), {recursive: true});
fs.writeFileSync(path.join(root, 'public', 'firebase-messaging-sw.js'), content);
