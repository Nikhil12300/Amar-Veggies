self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyD-NLbMzqg9lLQoSIslDMHsufyOtTE_gOs",
  authDomain: "amar-veggies-a3f2a.firebaseapp.com",
  projectId: "amar-veggies-a3f2a",
  storageBucket: "amar-veggies-a3f2a.appspot.com",
  messagingSenderId: "522883626327",
  appId: "1:522883626327:web:c53a7ce54701ebbadafa12"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("Background message received:", payload);

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
