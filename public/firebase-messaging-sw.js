self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const firebaseConfig = {
  "apiKey": "",
  "authDomain": "",
  "projectId": "",
  "storageBucket": "",
  "messagingSenderId": "",
  "appId": ""
};
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
