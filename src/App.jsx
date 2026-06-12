import React, {useState, useEffect, useContext, createContext, useCallback, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import {
  API,
  API_BASE,
  FIREBASE_CONFIG,
  FIREBASE_VAPID_KEY,
  GOOGLE_CLIENT_ID,
  isFirebaseConfigured,
  isGoogleSignInConfigured,
} from './config';

/* ═══════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════
   API HELPERS
═══════════════════════════════════════════════════════════ */
async function apiFetch(path, opts = {}) {
  const token = localStorage.getItem("hv_token");
  const headers = {"Content-Type": "application/json", ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(opts.headers || {})};
  const res = await fetch(`${API}${path}`, {...opts, headers});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Request failed");
  return data;
}

async function deliveryApiFetch(path, opts = {}) {
  const token = localStorage.getItem("delivery_token");

  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers || {})
  };

  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(data.detail || "Request failed");

  return data;
}

function canUseNotifications() {
  return "Notification" in window;
}

async function requestNotificationPermission(toast) {
  if (!canUseNotifications()) {
    toast("Notifications are not supported on this device", "error");
    return false;
  }

  const permission = await Notification.requestPermission();

  if (permission === "granted") {
    toast("Notifications enabled ✓");
    return true;
  }

  toast("Notifications were not enabled", "error");
  return false;
}

function showOrderNotification(title, body) {
  // Disabled on mobile browsers: page-level new Notification() can crash/blank the tab.
  // Background push notifications are handled safely by firebase-messaging-sw.js.
  console.log("Order notification skipped in foreground:", title, body);
}


let firebaseMessaging = null;

function initFirebaseMessaging() {
  if (!isFirebaseConfigured()) return null;
  if (!("firebase" in window)) return null;

  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }

  firebaseMessaging = firebase.messaging();

  return firebaseMessaging;
}

async function registerFcmToken(toast) {
  console.log("step0: registerFcmToken started");

  try {
    if (!("Notification" in window)) {
      return false;
    }

    if (!("serviceWorker" in navigator)) {
      return false;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("Notifications were not enabled", "error");
      return false;
    }

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      updateViaCache: 'none'
    });
    const messaging = initFirebaseMessaging();

    if (!messaging) {
      return false;
    }

    const token = await messaging.getToken({
      vapidKey: FIREBASE_VAPID_KEY,
      serviceWorkerRegistration: registration
    });

    console.log("FCM TOKEN:", token);

    if (!token) {
      return false;
    }

    await apiFetch("/notifications/token", {
      method: "POST",
      body: JSON.stringify({ token })
    });

    toast("Push notifications enabled ✓");
    return true;
  } catch (e) {
    console.error("FCM ERROR:", e);
    toast(e.message || "Could not enable push notifications", "error");
    return false;
  }
}

async function setupPushNotifications() {
  try {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      return;
    }

    console.log("step1: starting notification setup");

    const permission = await Notification.requestPermission();

    console.log("step2: permission =", permission);

    if (permission !== "granted") {
      console.log("Notifications were not enabled");
      return;
    }

    const messaging = initFirebaseMessaging();

    if (!messaging) return;

    const token = await messaging.getToken({
      vapidKey: FIREBASE_VAPID_KEY
    });

    console.log("step3: token =", token);

    if (!token) return;

    await fetch(`${API_BASE}/api/notifications/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${localStorage.getItem("hv_token")}`
      },
      body: JSON.stringify({
        token
      })
    });

    console.log("step4: token saved");

  } catch (err) {
    console.error("Push setup failed:", err);
  }
}

async function getPreviousCheckoutDetails() {
  const orders = await apiFetch("/orders");
  if (!Array.isArray(orders) || orders.length === 0) return null;

  const latest = orders.find(o =>
    o &&
    o.address &&
    o.phone &&
    o.status !== "cancelled"
  );

  if (!latest) return null;

  return {
    address: latest.address || "",
    phone: latest.phone || "",
    notes: latest.notes || ""
  };
}


function getLocalFavoriteIds() {
  try {
    return JSON.parse(localStorage.getItem("amarveggies_favorites") || "[]");
  } catch {
    return [];
  }
}

function setLocalFavoriteIds(ids) {
  localStorage.setItem("amarveggies_favorites", JSON.stringify([...new Set(ids)]));
}

async function syncFavoritesFromServer() {
  const token = localStorage.getItem("hv_token");
  if (!token) return getLocalFavoriteIds();
  try {
    const data = await apiFetch("/favorites");
    setLocalFavoriteIds(data.product_ids || []);
    return data.product_ids || [];
  } catch {
    return getLocalFavoriteIds();
  }
}

function loadRazorpayScript() {
  return new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

/* ═══════════════════════════════════════════════════════════
   CONTEXTS
═══════════════════════════════════════════════════════════ */
const AuthCtx = createContext();
const CartCtx = createContext();
const ToastCtx = createContext();
const RouterCtx = createContext();

/* ═══════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════ */
function ToastProvider({children}) {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((msg, type = "success") => {
    const id = Date.now();
    setToasts(t => [...t, {id, msg, type}]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  }, []);
  return (
    <ToastCtx.Provider value={add}>
      {children}
      <div className="toast-wrap">
        {toasts.map(t => <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* ═══════════════════════════════════════════════════════════
   AUTH PROVIDER
═══════════════════════════════════════════════════════════ */
function AuthProvider({children}) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("hv_token");
    if (token) {
      apiFetch("/auth/me").then(u => setUser(u)).catch(() => localStorage.removeItem("hv_token")).finally(() => setLoading(false));
    } else setLoading(false);
  }, []);

  const login = async (identifier, password) => {
    const d = await apiFetch("/auth/login", {method: "POST", body: JSON.stringify({identifier, password})});
    localStorage.setItem("hv_token", d.token);
    await setupPushNotifications();
    setUser(d.user);
    return d.user;
  };

  const googleLogin = async (credential) => {
    const d = await apiFetch("/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential })
    });
    localStorage.setItem("hv_token", d.token);
    await setupPushNotifications();
    setUser(d.user);
    return d.user;
  };

  const sendRegisterOtp = async (name, email, phone) => {
    return await apiFetch("/auth/send-otp", {
      method: "POST",
      body: JSON.stringify({name, email, phone})
    });
  };

  const verifyOtpRegister = async (name, email, phone, otp, password) => {
    const d = await apiFetch("/auth/verify-otp-register", {
      method: "POST",
      body: JSON.stringify({name, email, phone, otp, password})
    });
    localStorage.setItem("hv_token", d.token);
    await setupPushNotifications();
    setUser(d.user);
    return d.user;
  };

  const sendLoginOtp = async (email, phone) => {
    return await apiFetch("/auth/send-login-otp", {
      method: "POST",
      body: JSON.stringify({email, phone})
    });
  };

  const verifyOtpLogin = async (email, phone, otp) => {
    const d = await apiFetch("/auth/verify-otp-login", {
      method: "POST",
      body: JSON.stringify({email, phone, otp})
    });
    localStorage.setItem("hv_token", d.token);
    await setupPushNotifications();
    setUser(d.user);
    return d.user;
  };

  const sendForgotPasswordOtp = async (identifier) => {
    return await apiFetch("/auth/forgot-password/send-otp", {method:"POST", body: JSON.stringify({identifier})});
  };

  const resetPassword = async (identifier, otp, password) => {
    return await apiFetch("/auth/forgot-password/reset", {method:"POST", body: JSON.stringify({identifier, otp, password})});
  };

  const logout = () => { localStorage.removeItem("hv_token"); setUser(null); };

  if (loading) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"'Cormorant Garamond',serif",fontSize:"1.5rem",color:"var(--leaf)"}}>🌿 Loading…</div>;
  return (
    <AuthCtx.Provider value={{
      user,
      login,
      googleLogin,
      sendRegisterOtp,
      verifyOtpRegister,
      sendLoginOtp,
      verifyOtpLogin,
      sendForgotPasswordOtp,
      resetPassword,
      logout
    }}>
      {children}
    </AuthCtx.Provider>
  );
}

/* ═══════════════════════════════════════════════════════════
   CART PROVIDER
═══════════════════════════════════════════════════════════ */
function CartProvider({children}) {

  // LOAD CART FROM LOCAL STORAGE
  const [cart, setCart] = useState(() => {
    try {
      const saved = localStorage.getItem("amarveggies_cart");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [products, setProducts] = useState([]);
  const [activeCoupon, setActiveCoupon] = useState(() => {
    try {
      const saved = localStorage.getItem("amarveggies_coupon");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // SAVE CART TO LOCAL STORAGE ON EVERY CHANGE
  useEffect(() => {
    localStorage.setItem("amarveggies_cart", JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    if (activeCoupon) localStorage.setItem("amarveggies_coupon", JSON.stringify(activeCoupon));
    else localStorage.removeItem("amarveggies_coupon");
  }, [activeCoupon]);

  const add = (id, weight = 1000) => {
    const key = `${id}_${weight}`;

    setCart(prev => ({
      ...prev,
      [key]: {
        id,
        weight,
        quantity: (prev[key]?.quantity || 0) + 1
      }
    }));
  };

  const set = (key, qty) => {
    setCart(prev => {
      if (!prev[key]) return prev;

      if (qty <= 0) {
        const copy = {...prev};
        delete copy[key];
        return copy;
      }

      return {
        ...prev,
        [key]: {
          ...prev[key],
          quantity: qty
        }
      };
    });
  };

  const remove = (key) => {
    setCart(prev => {
      const copy = {...prev};
      delete copy[key];
      return copy;
    });
  };

  const addMany = (newItems = []) => {
    setCart(prev => {
      const next = {...prev};
      newItems.forEach(item => {
        const id = item.product_id || item.id;
        const weight = Number(item.selected_weight || item.weight || 1000);
        const quantity = Number(item.quantity || 1);
        if (!id || quantity <= 0) return;
        const key = `${id}_${weight}`;
        next[key] = {
          id,
          weight,
          quantity: (next[key]?.quantity || 0) + quantity
        };
      });
      return next;
    });
  };

  const clear = () => {
    setCart({});
    localStorage.removeItem("amarveggies_cart");
  };

  const applyCoupon = async (code, orderAmount = subtotalBeforeCoupon) => {
    const data = await apiFetch("/coupons/apply", {
      method: "POST",
      body: JSON.stringify({code, orderAmount})
    });
    const coupon = {
      code: data.code,
      discountType: data.discountType,
      discountValue: Number(data.discountValue || 0),
      minOrderAmount: data.minOrderAmount ?? null,
      expiresAt: data.expiresAt || null,
      discountAmount: Number(data.discountAmount || 0)
    };
    setActiveCoupon(coupon);
    return coupon;
  };

  const clearCoupon = () => setActiveCoupon(null);

  const count = Object.values(cart).reduce((s, ci) => s + ci.quantity, 0);

  const items = Object.entries(cart).map(([key, ci]) => {
    const p = products.find(x => x.id === ci.id);

    if (!p) return null;

    const weight = Number(ci.weight) || 1000;

    return {
      ...p,
      cartKey: key,
      weight,
      quantity: ci.quantity,
      originalLineTotal: getLineTotal(p, weight, ci.quantity),
      lineTotal: getDiscountedLineTotal(p, weight, ci.quantity, activeCoupon)
    };
  }).filter(Boolean);

  const subtotalBeforeCoupon = items.reduce((s, i) => s + i.originalLineTotal, 0);
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const couponDiscount = Math.max(0, Number((subtotalBeforeCoupon - subtotal).toFixed(2)));
  const delivery = subtotal > 0 ? (subtotal >= 300 ? 0 : 40) : 0;
  const total = subtotal + delivery;

  return (
    <CartCtx.Provider value={{
      cart,
      set,
      add,
      addMany,
      remove,
      clear,
      count,
      items,
      subtotal,
      subtotalBeforeCoupon,
      couponDiscount,
      delivery,
      total,
      products,
      setProducts,
      activeCoupon,
      applyCoupon,
      clearCoupon,
      getDiscountedAmount
    }}>
      {children}
    </CartCtx.Provider>
  );
}

/* ═══════════════════════════════════════════════════════════
   ROUTER
═══════════════════════════════════════════════════ */
function RouterProvider({children}) {
  const [page, setPage] = useState("home");
  const [params, setParams] = useState({});
  const nav = (p, prms = {}) => { setPage(p); setParams(prms); window.scrollTo(0,0); };
  return <RouterCtx.Provider value={{page, params, nav}}>{children}</RouterCtx.Provider>;
}

/* ═══════════════════════════════════════════════════════════
   COMPONENTS
═══════════════════════════════════════════════════════════ */
function normalizeOrderStatus(status) {
  return status === "packed" ? "confirmed" : status;
}

function StatusBadge({status}) {
  const displayStatus = normalizeOrderStatus(status);
  const labels = {pending:"Pending",confirmed:"Confirmed",out_for_delivery:"Out for Delivery",delivered:"Delivered",cancelled:"Cancelled"};
  return <span className={`status-badge status-${displayStatus}`}>{labels[displayStatus] || displayStatus}</span>;
}

function Toggle({on, onChange}) {
  return (
    <div className={`toggle-track ${on?"on":""}`} onClick={() => onChange(!on)} style={{cursor:"pointer"}}>
      <div className="toggle-thumb"/>
    </div>
  );
}

function QtyControl({qty, onInc, onDec}) {
  return (
    <div className="qty-row">
      <button className="qty-btn" style={{background:"var(--rust)"}} onClick={onDec}>−</button>
      <span className="qty-num">{qty}</span>
      <button className="qty-btn" onClick={onInc}>+</button>
    </div>
  );
}


function quantityOptionsToText(options) {
  if (!Array.isArray(options) || options.length === 0) return "";
  return options.map(v => String(Number(v))).join(", ");
}

function quantityOptionsFromText(text) {
  return String(text || "")
    .split(/[,\n]/)
    .map(v => Number(String(v).trim()))
    .filter(v => Number.isFinite(v) && v > 0);
}

function purchaseOptionsToText(options) {
  if (!Array.isArray(options) || options.length === 0) return "";
  return JSON.stringify(options, null, 2);
}

function purchaseOptionsFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Purchase options must be a JSON array");
  return parsed
    .map(option => ({
      value: Number(option?.value),
      label: String(option?.label || "").trim(),
      multiplier: Number(option?.multiplier)
    }))
    .filter(option => Number.isFinite(option.value) && option.value > 0 && option.label && Number.isFinite(option.multiplier) && option.multiplier > 0);
}

function defaultQuantityOptionsForUnit(unit) {
  if (isDozenUnit(unit)) return [12, 1];
  if (isBunchUnit(unit)) return [1];
  if (isPieceUnit(unit)) return [1];
  return [100, 250, 500, 1000];
}

function normalizeUnit(unit = "kg") {
  return String(unit || "kg").trim().toLowerCase();
}

function isDozenUnit(unit) {
  return ["dozen", "dozens", "dz"].includes(normalizeUnit(unit));
}

function isBunchUnit(unit) {
  return ["bunch", "bunches"].includes(normalizeUnit(unit));
}

function isPieceUnit(unit) {
  return ["piece", "pieces", "pc", "pcs"].includes(normalizeUnit(unit));
}

function getUnitBaseLabel(unit) {
  if (isDozenUnit(unit)) return "dozen";
  if (isBunchUnit(unit)) return "bunch";
  if (isPieceUnit(unit)) return "piece";
  return "kg";
}

function getSelectionOptions(product) {
  const unit = product?.unit || "kg";
  const configuredOptions = Array.isArray(product?.purchase_options) && product.purchase_options.length
    ? product.purchase_options
        .map(option => {
          const value = Number(option?.value);
          const multiplier = Number(option?.multiplier);
          const label = String(option?.label || "").trim();
          if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(multiplier) || multiplier <= 0 || !label) return null;
          return {
            value,
            label,
            shortLabel: label,
            priceMultiplier: multiplier
          };
        })
        .filter(Boolean)
    : [];
  if (configuredOptions.length) return configuredOptions;

  const rawOptions = Array.isArray(product?.quantity_options) && product.quantity_options.length
    ? product.quantity_options
    : defaultQuantityOptionsForUnit(unit);

  const options = rawOptions
    .map(v => Number(v))
    .filter(v => Number.isFinite(v) && v > 0);

  if (isDozenUnit(unit)) {
    return (options.length ? options : [12, 1]).map(v => ({
      value: v,
      label: v === 12 ? "1 dozen" : v === 1 ? "1 piece" : `${v} pieces`,
      shortLabel: v === 12 ? "dozen" : v === 1 ? "piece" : `${v} pcs`,
      priceMultiplier: v / 12
    }));
  }

  if (isBunchUnit(unit)) {
    return (options.length ? options : [1]).map(v => ({
      value: v,
      label: v === 1 ? "1 bunch" : `${v} bunches`,
      shortLabel: v === 1 ? "bunch" : `${v} bunches`,
      priceMultiplier: v
    }));
  }

  if (isPieceUnit(unit)) {
    return (options.length ? options : [1]).map(v => ({
      value: v,
      label: v === 1 ? "1 piece" : `${v} pieces`,
      shortLabel: v === 1 ? "piece" : `${v} pcs`,
      priceMultiplier: v
    }));
  }

  return (options.length ? options : [100, 250, 500, 1000]).map(w => ({
    value: Number(w),
    label: Number(w) === 1000 ? "1 kg" : `${Number(w)}g`,
    shortLabel: Number(w) === 1000 ? "1kg" : `${Number(w)}g`,
    priceMultiplier: Number(w) / 1000
  }));
}

function getDefaultSelection(product) {
  return getSelectionOptions(product)[0]?.value || 1000;
}

function getSelectionOption(product, selectedValue) {
  const selected = Number(selectedValue) || 1000;
  return getSelectionOptions(product).find(o => Math.abs(Number(o.value) - selected) < 0.0001) || getSelectionOptions(product)[0];
}

function getSelectionLabel(product, selectedValue, compact = false) {
  const option = getSelectionOption(product, selectedValue);
  return compact ? option.shortLabel : option.label;
}

function getLineTotal(product, selectedValue, quantity = 1) {
  const option = getSelectionOption(product, selectedValue);
  return Number((Number(product.price || 0) * option.priceMultiplier * Number(quantity || 1)).toFixed(2));
}

function getDiscountedAmount(amount, coupon) {
  const original = Number(amount || 0);
  if (!coupon) return original;
  const value = Number(coupon.discountValue || 0);
  const discounted = coupon.discountType === "percentage"
    ? original - (original * value / 100)
    : original - value;
  return Number(Math.max(0, discounted).toFixed(2));
}

function getDiscountedLineTotal(product, selectedValue, quantity = 1, coupon = null) {
  return Number((getDiscountedAmount(getLineTotal(product, selectedValue, 1), coupon) * Number(quantity || 1)).toFixed(2));
}

function formatMoney(amount) {
  const rounded = Number(amount || 0);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function formatProductPrice(product, selectedValue) {
  return `₹${formatMoney(getLineTotal(product, selectedValue, 1))} (${getSelectionLabel(product, selectedValue)})`;
}


function RepeatLastOrderButton({compact = false}) {
  const {user} = useContext(AuthCtx);
  const {addMany} = useContext(CartCtx);
  const {nav} = useContext(RouterCtx);
  const toast = useContext(ToastCtx);
  const [loading, setLoading] = useState(false);

  if (!user) return null;

  const repeatLastOrder = async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/orders/repeat-last");
      const items = data.items || [];
      if (!items.length) {
        toast(data.message || "No available items from your last order", "error");
        return;
      }
      addMany(items);
      toast(data.skipped_count ? `Added available items. ${data.skipped_count} unavailable item skipped.` : "Last order added to cart ✓");
      nav("cart");
    } catch (e) {
      toast(e.message || "Could not repeat last order", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button className={compact ? "btn btn-ghost" : "btn-hero btn-hero-outline"} onClick={repeatLastOrder} disabled={loading}>
      {loading ? "Adding…" : "🔁 Repeat Last Order"}
    </button>
  );
}

function BuyAgainSection() {
  const {user} = useContext(AuthCtx);
  const {nav} = useContext(RouterCtx);
  const {setProducts} = useContext(CartCtx);
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!user) return;
    apiFetch("/orders/buy-again").then(d => {
      setItems(Array.isArray(d) ? d : []);
      setProducts(prev => {
        const m = {};
        prev.forEach(x => m[x.id] = x);
        (Array.isArray(d) ? d : []).forEach(x => m[x.id] = x);
        return Object.values(m);
      });
    }).catch(() => {});
  }, [user]);

  if (!user || items.length === 0) return null;

  return (
    <div style={{marginTop:"3rem"}}>
      <div className="section-hd">
        <h2 className="section-title">Buy Again 🔁</h2>
        <RepeatLastOrderButton compact />
      </div>
      <div className="grid">
        {items.map(p => <ProductCard key={p.id} product={p} onDetail={pr => nav("product", {product: pr})} />)}
      </div>
    </div>
  );
}

function productImageSrc(product) {
  return product?.image_url || product?.image_data || "";
}

function ProductCard({product, onDetail}) {
  const {user} = useContext(AuthCtx);
  const {cart, add, set, activeCoupon} = useContext(CartCtx);
  const toast = useContext(ToastCtx);
  const [weight, setWeight] = useState(getDefaultSelection(product));
  const cartKey = `${product.id}_${weight}`;
  const qty = cart[cartKey]?.quantity || 0;
  const displayWeight = Number(weight) || 1000;
  const selectionOptions = getSelectionOptions(product);
  const showQuantityDropdown = selectionOptions.length > 1;
  const displayPrice = formatProductPrice(product, displayWeight);
  const originalUnitPrice = getLineTotal(product, displayWeight, 1);
  const discountedUnitPrice = getDiscountedAmount(originalUnitPrice, activeCoupon);
  const hasCouponPrice = Boolean(activeCoupon) && discountedUnitPrice < originalUnitPrice;
  const imageSrc = productImageSrc(product);
  const [favorite, setFavorite] = useState(() => getLocalFavoriteIds().includes(product.id));

  const toggleFavorite = async (e) => {
    e.stopPropagation();
    if (!user) {
      toast("Sign in to save favorites", "error");
      return;
    }
    const nextFavorite = !favorite;
    setFavorite(nextFavorite);
    const ids = getLocalFavoriteIds();
    setLocalFavoriteIds(nextFavorite ? [...ids, product.id] : ids.filter(id => id !== product.id));
    try {
      await apiFetch(`/favorites/${product.id}`, {method: nextFavorite ? "POST" : "DELETE"});
      toast(nextFavorite ? "Saved to favorites ♥" : "Removed from favorites");
    } catch (err) {
      setFavorite(!nextFavorite);
      toast(err.message || "Could not update favorite", "error");
    }
  };
  return (
    <div className={`card ${!product.available?"unavail":""}`}>
      <div className="card-thumb" onClick={() => product.available && onDetail && onDetail(product)}>
        <button onClick={toggleFavorite} title={favorite ? "Remove from favorites" : "Save favorite"} style={{position:"absolute",top:8,right:8,zIndex:2,width:34,height:34,borderRadius:"50%",border:"1px solid rgba(255,255,255,.7)",background:"rgba(255,255,255,.92)",boxShadow:"0 2px 10px rgba(0,0,0,.12)",cursor:"pointer",fontSize:"1rem"}}>{favorite ? "♥" : "♡"}</button>
        {imageSrc
          ? <img src={imageSrc} alt={product.name}/>
          : <span style={{fontSize:"3rem"}}>{product.emoji || "🌿"}</span>}
        {product.featured && <span className="card-feat-badge">⭐ Featured</span>}
        {!product.available && <span className="card-out-badge">Out of Stock</span>}
      </div>
      <div className="card-body" onClick={() => product.available && onDetail && onDetail(product)}>
        <div className="card-cat">{product.category}</div>
        <div className="card-name">{product.name}</div>
        <div className="card-price">
          {hasCouponPrice ? (
            <span className="price-with-coupon">
              <span className="price-original">₹{formatMoney(originalUnitPrice)}</span>
              <span className="price-discounted">₹{formatMoney(discountedUnitPrice)}</span>
              <span className="card-unit">({getSelectionLabel(product, displayWeight)})</span>
            </span>
          ) : displayPrice}
        </div>
        {product.description && (
          <div
            className="text-muted text-sm mt-1"
            style={{
              lineHeight: 1.4,
              whiteSpace: "pre-line",
              WebkitLineClamp: 3,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitBoxOrient: "vertical"
            }}
          >
            {product.description}
          </div>
        )}
      </div>
      {product.available && (
        <div className="card-actions">
          {showQuantityDropdown && (
            <div style={{marginBottom:"8px"}}>
              <select value={weight} onChange={(e)=>setWeight(Number(e.target.value))}>
                {selectionOptions.map(opt => (
                  <option key={opt.label} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {qty === 0
            ? <button className="btn-add" onClick={() => { add(product.id, weight); toast("Added to cart 🛒"); }}>+ Add to Cart</button>
            : <QtyControl qty={qty} onInc={() => add(product.id, weight)} onDec={() => set(cartKey, qty-1)} />}
        </div>
      )}
    </div>
  );
}

function CouponBox() {
  const {activeCoupon, applyCoupon, clearCoupon, subtotalBeforeCoupon, couponDiscount} = useContext(CartCtx);
  const toast = useContext(ToastCtx);
  const [code, setCode] = useState(activeCoupon?.code || "");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setCode(activeCoupon?.code || "");
  }, [activeCoupon]);

  const submit = async () => {
    if (!code.trim()) {
      toast("Enter a coupon code", "error");
      return;
    }
    setLoading(true);
    try {
      const coupon = await applyCoupon(code, subtotalBeforeCoupon);
      toast(`Coupon ${coupon.code} applied`);
    } catch (e) {
      toast(e.message || "Coupon could not be applied", "error");
    } finally {
      setLoading(false);
    }
  };

  if (activeCoupon) {
    return (
      <div className="coupon-applied">
        <div>
          <div className="coupon-code">{activeCoupon.code}</div>
          <div className="text-xs text-muted">Discount ₹{formatMoney(couponDiscount)}</div>
        </div>
        <button className="coupon-remove" onClick={clearCoupon} title="Remove coupon">×</button>
      </div>
    );
  }

  return (
    <div className="coupon-box">
      <input
        value={code}
        onChange={e => setCode(e.target.value.toUpperCase())}
        onKeyDown={e => e.key === "Enter" && submit()}
        placeholder="Coupon code"
      />
      <button className="btn btn-ghost" onClick={submit} disabled={loading}>
        {loading ? "Applying..." : "Apply"}
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   NAVBAR
═══════════════════════════════════════════════════════════ */
function Navbar() {
  const {user, logout} = useContext(AuthCtx);
  const {count} = useContext(CartCtx);
  const {nav, page} = useContext(RouterCtx);
  return (
    <>
      {/* ── Top nav bar ── */}
      <nav>
        <div className="nav-inner">
          <div className="nav-logo" onClick={() => nav("home")}>
            <span className="nav-logo-icon">🌿</span>
            <div className="nav-logo-text">Amar Veggies<span className="nav-logo-sub">Farm to Doorstep</span></div>
          </div>

          {/* Mobile: just a cart pill in top-right */}
          <button className="nav-cart-mobile" onClick={() => nav("cart")}>
            🧺 {count > 0 && <span className="nav-badge">{count}</span>}
          </button>

          {/* Desktop: full link row */}
          <div className="nav-links">
            <button className={`nav-btn ${page==="shop"?"active":""}`} onClick={() => nav("shop")}>Shop</button>
            {user && <button className={`nav-btn ${page==="orders"?"active":""}`} onClick={() => nav("orders")}>My Orders</button>}
            {user?.is_admin && <button className={`nav-btn ${page==="admin"?"active":""}`} onClick={() => nav("admin")}>Admin</button>}
            {!user && <button className={`nav-btn ${page==="delivery"?"active":""}`} onClick={() => nav("delivery")}>Delivery Partner Login</button>}
            {user
              ? <div className="nav-user" onClick={() => { logout(); nav("home"); }}>
                  <span className="nav-user-avatar">{user.name[0].toUpperCase()}</span>
                  <span className="nav-user-text text-xs" style={{color:"rgba(255,255,255,.6)"}}>log out</span>
                </div>
              : <>
                  <button className="nav-btn" onClick={() => nav("login")}>Sign in</button>
                  <button className="nav-btn" style={{background:"rgba(255,255,255,.12)",color:"#fff"}} onClick={() => nav("register")}>Register</button>
                </>}
            <button className="nav-cart" onClick={() => nav("cart")}>
              🧺 Cart {count > 0 && <span className="nav-badge">{count}</span>}
            </button>
          </div>
        </div>
      </nav>

      {/* ── Mobile bottom tab bar ── */}
      <div className="bottom-nav">
        <button className={`bottom-nav-btn ${page==="home"?"active":""}`} onClick={() => nav("home")}>
          <span className="bnb-icon">🏠</span>Home
        </button>
        <button className={`bottom-nav-btn ${page==="shop"?"active":""}`} onClick={() => nav("shop")}>
          <span className="bnb-icon">🛍️</span>Shop
        </button>
        <button className={`bottom-nav-btn ${page==="cart"?"active":""}`} onClick={() => nav("cart")}>
          <span className="bnb-icon">🧺</span>Cart
          {count > 0 && <span className="bnb-badge">{count}</span>}
        </button>
        {user
          ? <button className={`bottom-nav-btn ${page==="orders"?"active":""}`} onClick={() => nav("orders")}>
              <span className="bnb-icon">📦</span>Orders
            </button>
          : <button className={`bottom-nav-btn ${page==="login"?"active":""}`} onClick={() => nav("login")}>
              <span className="bnb-icon">👤</span>Sign in
            </button>}
        {user?.is_admin
          ? <button className={`bottom-nav-btn ${page==="admin"?"active":""}`} onClick={() => nav("admin")}>
              <span className="bnb-icon">⚙️</span>Admin
            </button>
          : user
          ? <button className="bottom-nav-btn" onClick={() => { logout(); nav("home"); }}>
              <span className="bnb-icon">🚪</span>Log out
            </button>
          : <button className={`bottom-nav-btn ${page==="delivery"?"active":""}`} onClick={() => nav("delivery")}>
              <span className="bnb-icon">🚚</span>Delivery
            </button>}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   HOME PAGE
═══════════════════════════════════════════════════════════ */
function HomePage() {
  const {nav} = useContext(RouterCtx);
  const {user} = useContext(AuthCtx);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    canUseNotifications() && Notification.permission === "granted"
  );
  const toast = useContext(ToastCtx);
  const {setProducts} = useContext(CartCtx);
  const [featured, setFeatured] = useState([]);
  const [categories, setCategories] = useState([]);
  const [stats, setStats] = useState({products:0, orders:0});

  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };

    window.addEventListener("beforeinstallprompt", handler);

    if (window.matchMedia("(display-mode: standalone)").matches) {
      setIsInstalled(true);
    }

    window.addEventListener("appinstalled", () => {
      setIsInstalled(true);
      setInstallPrompt(null);
    });

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  const installApp = async () => {
    if (!installPrompt) return;

    installPrompt.prompt();
    await installPrompt.userChoice;

    setInstallPrompt(null);
  };

  const enableNotifications = async () => {
    console.log("step1: enable notification button clicked");

    const ok = await registerFcmToken(toast);

    console.log("step2: registerFcmToken result =", ok);

    setNotificationsEnabled(ok);
  };

  useEffect(() => {
    apiFetch("/products?featured=true").then(d => { setFeatured(d); setProducts(p => { const m = {}; p.forEach(x => m[x.id]=x); d.forEach(x => m[x.id]=x); return Object.values(m); }); }).catch(()=>{});
    apiFetch("/products").then(d => {
      setProducts(d);
      const cats = [...new Set(d.map(p => p.category))];
      setCategories(cats);
      setStats({products: d.filter(x=>x.available).length, orders: "100+"});
    }).catch(()=>{});
  }, []);

  return (
    <div className="page">
      {/* Hero */}
      <div className="hero">
        <div className="hero-bg"/>
        <div className="hero-content">
          <div className="hero-tag">🚲 Same-day delivery available</div>
          <h1>Fresh from the Farm,<br/><em>Right to Your Door</em></h1>
          <p className="hero-sub">Handpicked seasonal fruits and vegetables delivered with care. No middlemen, just pure freshness.</p>
          <div className="hero-actions">
            <button className="btn-hero btn-hero-primary" onClick={() => nav("shop")}>Shop Now →</button>
            <RepeatLastOrderButton />
            {installPrompt && !isInstalled && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && (
              <button className="btn-hero btn-hero-outline" onClick={installApp}>
                📲 Install App
              </button>
            )}
            {user && canUseNotifications() && !notificationsEnabled && (
              <button className="btn-hero btn-hero-outline" onClick={enableNotifications}>
                🔔 Enable Notifications
              </button>
            )}
          </div>
          <div className="hero-stats">
            <div><div className="hero-stat-val">{stats.products}+</div><div className="hero-stat-label">Fresh Items</div></div>
            <div><div className="hero-stat-val">₹0</div><div className="hero-stat-label">Delivery above ₹300</div></div>
            <div><div className="hero-stat-val">Today</div><div className="hero-stat-label">Same-day Slots</div></div>
          </div>
        </div>
      </div>

      {/* Categories strip */}
      {categories.length > 0 && (
        <div style={{background:"var(--white)",borderBottom:"1px solid var(--border)",padding:"1.25rem 2rem"}}>
          <div className="container">
            <div className="cat-strip">
              {categories.map(c => (
                <button key={c} className="cat-pill" onClick={() => nav("shop", {category: c})}>
                  {c === "Fruit" ? "🍎" : c === "Vegetable" ? "🥦" : "🌿"} {c}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Featured products */}
      <div className="container" style={{paddingTop:"3rem"}}>
        {featured.length > 0 && (
          <>
            <div className="section-hd">
              <h2 className="section-title">Featured Picks ⭐</h2>
              <button className="section-link btn" onClick={() => nav("shop")}>View all →</button>
            </div>
            <div className="grid">
              {featured.map(p => <ProductCard key={p.id} product={p} onDetail={pr => nav("product", {product: pr})} />)}
            </div>
          </>
        )}

        <BuyAgainSection />

        {/* Why us */}
        <div style={{margin:"4rem 0 1rem"}}>
          <h2 className="section-title mb-3">Why Amar Veggies?</h2>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"1.25rem"}}>
            {[["🌱","Farm Fresh","Directly sourced from local farms with no cold-chain cuts"],
              ["⚡","Same-day Delivery","Order before noon, receive by evening"],
              ["💚","No Wastage","We pack only what's in season and ripe"],
              ["🔄","Easy Returns","Got something wilted? We'll make it right"],
            ].map(([icon,title,desc]) => (
              <div key={title} style={{background:"var(--white)",borderRadius:"var(--r)",border:"1.5px solid var(--border)",padding:"1.5rem"}}>
                <div style={{fontSize:"2rem",marginBottom:".75rem"}}>{icon}</div>
                <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.1rem",fontWeight:700,marginBottom:".4rem"}}>{title}</div>
                <div style={{color:"var(--muted)",fontSize:".82rem",lineHeight:1.5}}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SHOP PAGE
═══════════════════════════════════════════════════════════ */
function ShopPage() {
  const {user} = useContext(AuthCtx);
  const {nav, params} = useContext(RouterCtx);
  const {setProducts} = useContext(CartCtx);
  const [products, setLocal] = useState([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(params.category || "All");
  const [loading, setLoading] = useState(true);
  const [favoriteIds, setFavoriteIds] = useState([]);
  const cats = ["All", ...(user ? ["Favorites"] : []), ...new Set(products.map(p => p.category))];

  useEffect(() => {
    setLoading(true);
    apiFetch("/products").then(d => {
      console.log("Products ranking check:", d);
      setLocal(d);
      setProducts(d);
    }).catch(()=>{}).finally(()=>setLoading(false));
    if (user) syncFavoritesFromServer().then(setFavoriteIds);
  }, [user]);

  const sortedProducts = [...products].sort((a, b) => {
    return Number(b.total_purchased || 0) - Number(a.total_purchased || 0);
  });

  const filtered = sortedProducts.filter(p => {
    const matchCat = category === "All" || (category === "Favorites" ? favoriteIds.includes(p.id) : p.category === category);
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.description?.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  return (
    <div className="page container" style={{paddingTop:"2rem"}}>
      <div className="mb-3">
        <h1 className="page-title">Fresh Produce</h1>
        <p className="page-sub" style={{marginBottom:".75rem"}}>{filtered.length} items available</p>
        <div className="search-wrap">
          <span className="search-icon">🔍</span>
          <input className="search-input" placeholder="Search fruits, vegetables…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>
      <div className="cat-strip mb-3">
        {cats.map(c => <button key={c} className={`cat-pill ${category===c?"active":""}`} onClick={() => setCategory(c)}>{c === "Fruit" ? "🍎 " : c === "Vegetable" ? "🥦 " : c==="All"?"🌿 ":""}{c}</button>)}
      </div>
      {loading
        ? <div className="empty-state"><div className="empty-state-icon">⏳</div><p>Loading fresh produce…</p></div>
        : filtered.length === 0
        ? <div className="empty-state"><div className="empty-state-icon">🔍</div><h3>Nothing found</h3><p>Try a different search or category</p></div>
        : <div className="grid">{filtered.map(p => <ProductCard key={p.id} product={p} onDetail={pr => nav("product",{product:pr})} />)}</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   PRODUCT DETAIL PAGE
═══════════════════════════════════════════════════════════ */
function ProductPage() {
  const {params, nav} = useContext(RouterCtx);
  const {cart, add, set} = useContext(CartCtx);
  const toast = useContext(ToastCtx);
  const p = params.product;
  if (!p) { nav("shop"); return null; }
  const detailWeight = getDefaultSelection(p);
  const detailKey = `${p.id}_${detailWeight}`;
  const qty = cart[detailKey]?.quantity || 0;
  return (
    <div className="page container" style={{paddingTop:"2rem",maxWidth:720}}>
      <button className="btn btn-ghost mb-3" onClick={() => nav("shop")}>← Back to Shop</button>
      <div style={{background:"var(--white)",borderRadius:20,border:"1.5px solid var(--border)",overflow:"hidden"}}>
        <div style={{height:260,background:"linear-gradient(135deg,#e8f5ee,#d8f3dc)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"5rem",overflow:"hidden",position:"relative"}}>
          {productImageSrc(p)
            ? <img src={productImageSrc(p)} alt={p.name} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            : <span>{p.emoji || "🌿"}</span>}
        </div>
        <div style={{padding:"2rem"}}>
          <div className="chip mb-2">{p.category}</div>
          <h1 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"2.2rem",fontWeight:700,marginBottom:".5rem"}}>{p.name}</h1>
          <div style={{fontSize:"1.5rem",color:"var(--leaf)",fontWeight:700,marginBottom:"1rem"}}>₹{formatMoney(p.price)} <span style={{color:"var(--muted)",fontSize:".9rem",fontWeight:400}}>/ {getUnitBaseLabel(p.unit)}</span></div>
          {p.description && (
            <div
              style={{
                color: "var(--muted)",
                lineHeight: 1.7,
                marginBottom: "1.5rem",
                whiteSpace: "pre-line"
              }}
            >
              {p.description}
            </div>
          )}
          <div className="flex gap-2 items-center flex-wrap">
            <span className={`pill ${p.available?"pill-green":"pill-red"}`}>{p.available?"✓ In Stock":"✗ Out of Stock"}</span>
            {p.featured && <span className="pill" style={{background:"#fef9c3",color:"#92400e"}}>⭐ Featured</span>}
          </div>
          {p.available && (
            <div className="mt-4">
              {qty === 0
                ? <button className="btn btn-primary btn-lg" onClick={() => { add(p.id, detailWeight); toast("Added to cart 🛒"); }}>+ Add to Cart</button>
                : <div style={{display:"flex",alignItems:"center",gap:"1rem",flexWrap:"wrap"}}>
                    <QtyControl qty={qty} onInc={() => add(p.id, detailWeight)} onDec={() => set(detailKey, qty-1)} />
                    <button className="btn btn-gold" onClick={() => nav("cart")}>Go to Cart →</button>
                  </div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   CART PAGE
═══════════════════════════════════════════════════════════ */
function CartPage() {
  const {items, subtotal, subtotalBeforeCoupon, couponDiscount, delivery, total, set, remove, count, activeCoupon} = useContext(CartCtx);
  const {user} = useContext(AuthCtx);
  const {nav} = useContext(RouterCtx);
  if (count === 0) return (
    <div className="page">
      <div className="empty-state">
        <div className="empty-state-icon">🧺</div>
        <h3>Your basket is empty</h3>
        <p className="mb-3">Add some fresh produce to get started</p>
        <div className="flex gap-2 justify-center flex-wrap">
          <button className="btn btn-primary" onClick={() => nav("shop")}>Browse Shop</button>
          <RepeatLastOrderButton compact />
        </div>
      </div>
    </div>
  );
  return (
    <div className="page container" style={{paddingTop:"2rem"}}>
      <h1 className="page-title">Your Basket 🧺</h1>
      <p className="page-sub">{count} items</p>
      <div className="cart-layout">
        <div>
          {items.map(item => (
            <div key={item.cartKey} className="cart-item">
              <div className="cart-item-img">{productImageSrc(item) ? <img src={productImageSrc(item)} alt={item.name}/> : (item.emoji || "🌿")}</div>
              <div className="cart-item-info">
                <div className="cart-item-name">{item.name} ({getSelectionLabel(item, item.weight, true)}) × {item.quantity}</div>
                <div className="cart-item-meta">₹{formatMoney(item.price)} / {getUnitBaseLabel(item.unit)}</div>
                <div className="mt-1"><QtyControl qty={item.quantity} onInc={() => set(item.cartKey, item.quantity+1)} onDec={() => { if(item.quantity===1) remove(item.cartKey); else set(item.cartKey, item.quantity-1); }} /></div>
              </div>
              <div style={{textAlign:"right"}}>
                {activeCoupon && item.originalLineTotal > item.lineTotal && <div className="price-original">₹{formatMoney(item.originalLineTotal)}</div>}
                <div className="cart-item-price">₹{formatMoney(item.lineTotal)}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="cart-summary-box">
          <h3 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.4rem",fontWeight:700,marginBottom:"1.25rem"}}>Order Summary</h3>
          <CouponBox />
          <div className="flex justify-between mb-2"><span className="text-muted">Subtotal</span><span className="fw-700">₹{formatMoney(activeCoupon ? subtotalBeforeCoupon : subtotal)}</span></div>
          {activeCoupon && <div className="flex justify-between mb-2"><span className="text-muted">Coupon</span><span className="fw-700 text-leaf">-₹{formatMoney(couponDiscount)}</span></div>}
          <div className="flex justify-between mb-2">
            <span className="text-muted">Delivery</span>
            <span className="fw-700" style={{color:delivery===0?"var(--leaf)":"inherit"}}>{delivery===0?"FREE 🎉":`₹${delivery}`}</span>
          </div>
          {delivery > 0 && <div style={{background:"var(--cream)",borderRadius:10,padding:".6rem .85rem",fontSize:".78rem",color:"var(--muted)",marginBottom:"1rem"}}>Add ₹{300-subtotal} more for free delivery</div>}
          <hr className="divider"/>
          <div className="flex justify-between mb-3" style={{alignItems:"center"}}>
            <span style={{fontWeight:700}}>Total</span>
            <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.5rem",fontWeight:700,color:"var(--leaf)"}}>₹{formatMoney(total)}</span>
          </div>
          <div style={{background:"var(--cream)",borderRadius:10,padding:".65rem .85rem",fontSize:".78rem",color:"var(--muted)",marginBottom:"1.25rem",textAlign:"center"}}>💵 Cash on Delivery</div>
          <button className="btn btn-primary btn-full btn-lg" onClick={() => user ? nav("checkout") : nav("login", {redirect:"checkout"})}>
            {user ? "Proceed to Checkout →" : "Sign in to Checkout →"}
          </button>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   LEAFLET LOCATION PICKER
═══════════════════════════════════════════════════════════ */
async function reverseGeocode(lat, lng, fallback = "") {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
  const res = await fetch(url, {headers: {"Accept": "application/json"}});
  if (!res.ok) throw new Error("Could not find address for this pin");
  const data = await res.json();
  return data.display_name || fallback;
}

async function searchAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {headers: {"Accept": "application/json"}});
  if (!res.ok) throw new Error("Address search failed");
  const results = await res.json();
  if (!results?.length) throw new Error("No matching location found");
  return results[0];
}

function LocationPicker({value, onChange}) {
  const toast = useContext(ToastCtx);
  const mapRef = useRef(null);
  const inputRef = useRef(null);
  const mapObj = useRef(null);
  const markerObj = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapErr, setMapErr] = useState("");
  const defaultCenter = {lat: 23.0225, lng: 72.5714}; // Ahmedabad fallback for local testing

  const setPickedLocation = (lat, lng, address = value.address || "", placeId = "") => {
    onChange({lat, lng, address, placeId});
  };

  const movePin = (lat, lng) => {
    if (!mapObj.current || !markerObj.current) return;
    const pos = [Number(lat), Number(lng)];
    markerObj.current.setLatLng(pos);
    mapObj.current.setView(pos, 16);
  };

  useEffect(() => {
    if (!mapRef.current) return;
    if (!window.L) {
      setMapErr("Leaflet failed to load");
      return;
    }
    const center = value.lat && value.lng ? [Number(value.lat), Number(value.lng)] : [defaultCenter.lat, defaultCenter.lng];
    const map = L.map(mapRef.current, {scrollWheelZoom:false}).setView(center, value.lat && value.lng ? 16 : 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    const marker = L.marker(center, {draggable:true}).addTo(map);

    const pickFromLatLng = async (lat, lng) => {
      marker.setLatLng([lat, lng]);
      try {
        const address = await reverseGeocode(lat, lng, value.address);
        setPickedLocation(lat, lng, address, "");
      } catch {
        setPickedLocation(lat, lng, value.address, "");
      }
    };

    map.on("click", (e) => pickFromLatLng(e.latlng.lat, e.latlng.lng));
    marker.on("dragend", (e) => {
      const pos = e.target.getLatLng();
      pickFromLatLng(pos.lat, pos.lng);
    });
    mapObj.current = map;
    markerObj.current = marker;
    setMapReady(true);
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapObj.current = null;
      markerObj.current = null;
    };
  }, []);

  useEffect(() => {
    if (mapReady && value.lat && value.lng) {
      movePin(value.lat, value.lng);
    }
  }, [value.lat, value.lng, mapReady]);
  useEffect(() => {
    if (inputRef.current && value.address && inputRef.current.value !== value.address) {
      inputRef.current.value = value.address;
    }
  }, [value.address]);


  const findAddress = async () => {
    const query = inputRef.current?.value?.trim();
    if (!query) return;
    try {
      const result = await searchAddress(query);
      const lat = Number(result.lat);
      const lng = Number(result.lon);
      movePin(lat, lng);
      setPickedLocation(lat, lng, result.display_name || query, "");
      toast("Location found ✓");
    } catch (e) {
      toast(e.message || "Could not find that address", "error");
    }
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) { toast("Location is not supported on this device", "error"); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      movePin(lat, lng);
      let address = value.address;
      try { address = await reverseGeocode(lat, lng, value.address); } catch {}
      setPickedLocation(lat, lng, address, "");
      toast("Location pinned ✓");
    }, () => toast("Could not access location. Allow location permission or search manually.", "error"), {enableHighAccuracy:true, timeout:10000});
  };

  return (
    <div className="location-box">
      <div className="field" style={{marginBottom:0}}>
        <label>Pin your delivery location</label>
        <input ref={inputRef} placeholder="Search your building, society, landmark or area" defaultValue={value.address || ""} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); findAddress(); } }}/>
      </div>
      <div className="location-actions">
        <button className="btn btn-primary" type="button" onClick={useCurrentLocation}>📍 Use my current location</button>
        <button className="btn btn-ghost" type="button" onClick={findAddress}>Find on map</button>
        {value.lat && value.lng && <a className="btn btn-ghost" target="_blank" href={`https://www.google.com/maps/search/?api=1&query=${value.lat},${value.lng}`}>Open pin</a>}
      </div>
      <div id="checkoutMap" ref={mapRef} className="map-canvas checkout-map map-container">
        {mapErr && <div className="map-placeholder">{mapErr}. You can still type the address manually.</div>}
      </div>
      {value.lat && value.lng && <div className="location-pill">✓ Exact location saved</div>}
      <div className="location-help">Tip: search your address, then drag the marker exactly to your gate/building entrance for smoother delivery.</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   CHECKOUT PAGE
═══════════════════════════════════════════════════════════ */
function CheckoutPage() {
  const {items, subtotal, subtotalBeforeCoupon, couponDiscount, delivery, total, clear, cart, activeCoupon} = useContext(CartCtx);
  const {user} = useContext(AuthCtx);
  const {nav} = useContext(RouterCtx);
  const toast = useContext(ToastCtx);
  const [form, setForm] = useState({address:"",phone:"",notes:"",delivery_lat:null,delivery_lng:null,delivery_place_id:""});
  const [paymentMethod, setPaymentMethod] = useState("cod");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [previousLoaded, setPreviousLoaded] = useState(false);
  const notePresets = ["Call before delivery", "Leave at door", "No plastic bag", "Ring the bell"];

  useEffect(() => {
    let cancelled = false;

    const loadPreviousCheckout = async () => {
      if (!user || previousLoaded) return;

      try {
        const previous = await getPreviousCheckoutDetails();
        if (cancelled || !previous) {
          if (!cancelled) setPreviousLoaded(true);
          return;
        }

        setForm(prev => ({
          ...prev,
          address: prev.address || previous.address,
          phone: prev.phone || previous.phone || user.phone || "",
          notes: prev.notes || previous.notes
        }));
        setPreviousLoaded(true);
        toast("Previous checkout details loaded ✓");
      } catch (e) {
        if (!cancelled) setPreviousLoaded(true);
      }
    };

    loadPreviousCheckout();
    return () => { cancelled = true; };
  }, [user, previousLoaded, toast]);

  if (!user) { nav("login"); return null; }
  if (items.length === 0) { nav("cart"); return null; }

  const orderPayload = () => {
    const orderItems = items.map(i => ({
      product_id: i.id,
      quantity: i.quantity,
      selected_weight: Number(i.weight) || 1000
    }));

    return {
      items: orderItems,
      address: form.address,
      phone: form.phone,
      notes: form.notes,
      delivery_lat: form.delivery_lat,
      delivery_lng: form.delivery_lng,
      delivery_place_id: form.delivery_place_id,
      coupon_code: activeCoupon?.code || null
    };
  };

  const placeCodOrder = async () => {
    const order = await apiFetch("/orders", {
      method:"POST",
      body: JSON.stringify(orderPayload())
    });
    clear();
    nav("order-success", {order});
  };

  const placeOnlineOrder = async () => {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;

    if (isMobile || isStandalone) {
      alert("Online payment is currently supported only in browser mode. Please use Cash on Delivery.");
      setPaymentMethod("cod");
      return;
    }

    const razorpayLoaded = await loadRazorpayScript();

    if (!razorpayLoaded || !window.Razorpay) {
      alert("Payment service failed to load. Please use Cash on Delivery.");
      return;
    }

    const paymentOrder = await apiFetch("/create-payment-order", {
      method: "POST",
      body: JSON.stringify(orderPayload())
    });

    const pendingOrder = paymentOrder?.order;

    if (!paymentOrder?.id || !paymentOrder?.key || !pendingOrder?.id) {
      alert("Payment initialization failed.");
      return;
    }

    const cancelPendingPaymentOrder = () => {
      apiFetch(`/orders/${pendingOrder.id}/cancel-payment`, {
        method: "POST"
      }).catch(() => {});
    };

    return await new Promise((resolve, reject) => {

      const options = {
        key: paymentOrder.key,
        amount: paymentOrder.amount,
        currency: paymentOrder.currency || "INR",
        name: "Amar Veggies",
        description: "Fresh fruits and vegetables",
        order_id: paymentOrder.id,

        prefill: {
          name: user.name || "",
          email: user.email || "",
          contact: form.phone || user.phone || ""
        },

        theme: {
          color: "#2d6a4f"
        },

        handler: async function (response) {

          try {
            const verified = await apiFetch("/verify-payment", {
              method: "POST",
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                order_id: pendingOrder.id
              })
            });

            clear();

            resolve(verified.order || {
              ...pendingOrder,
              payment: "Online",
              payment_status: "paid"
            });

          } catch (e) {
            reject(e);
          }
        },

        modal: {
          ondismiss: function () {
            cancelPendingPaymentOrder();
            reject(new Error("Payment cancelled"));
          }
        }
      };

      const rz = new window.Razorpay(options);

      rz.on("payment.failed", function (response) {
        cancelPendingPaymentOrder();
        reject(
          new Error(
            response.error?.description ||
            "Payment failed. Please try again."
          )
        );
      });

      rz.open();
    });
  };

  const submit = async () => {
    if (!form.address || !form.phone) { setErr("Please fill in all required fields"); return; }
    setLoading(true); setErr("");
    try {
      if (paymentMethod === "online") {
        const order = await placeOnlineOrder();
        if (!order) return;
        toast("Payment successful ✓");
        nav("order-success", {order});
      } else {
        await placeCodOrder();
      }
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div className="page container" style={{paddingTop:"2rem",maxWidth:860}}>
      <h1 className="page-title">Checkout</h1>
      <p className="page-sub">Review your order and enter delivery details</p>
      <div style={{display:"grid",gridTemplateColumns:"min(100%,1fr)",gap:"1.5rem",alignItems:"start"}} className="checkout-grid">
        <div>
          <div style={{background:"var(--white)",borderRadius:"var(--r)",border:"1.5px solid var(--border)",padding:"1.5rem",marginBottom:"1.5rem"}}>
            <h3 className="section-title mb-2" style={{fontSize:"1.3rem"}}>Delivery Details</h3>
            <div className="field"><label>Phone Number *</label><input placeholder="e.g. 98765 43210" value={form.phone} onChange={e => setForm(f=>({...f,phone:e.target.value}))}/></div>
            <div className="field"><label>Delivery Address *</label><textarea placeholder="House no., Street, Area, Pincode" rows={3} value={form.address} onChange={e => setForm(f=>({...f,address:e.target.value}))}/></div>
            <LocationPicker value={{lat:form.delivery_lat,lng:form.delivery_lng,address:form.address,placeId:form.delivery_place_id}} onChange={(loc)=>setForm(f=>({...f,address:loc.address || f.address,delivery_lat:loc.lat,delivery_lng:loc.lng,delivery_place_id:loc.placeId || ""}))}/>
            <div className="field"><label>Special Instructions (optional)</label>
              <div className="flex gap-1 flex-wrap" style={{marginBottom:".6rem"}}>
                {notePresets.map(note => (
                  <button key={note} type="button" className="chip" onClick={() => setForm(f => ({...f, notes: f.notes?.includes(note) ? f.notes : `${f.notes ? f.notes + "; " : ""}${note}`}))}>{note}</button>
                ))}
              </div>
              <textarea placeholder="E.g. Leave at door, no plastic bags" rows={2} value={form.notes} onChange={e => setForm(f=>({...f,notes:e.target.value}))}/>
            </div>
          </div>
        </div>

        <div className="place-order-section" style={{background:"var(--white)",borderRadius:20,border:"1.5px solid var(--border)",padding:"1.5rem",position:"relative"}}>
          <h3 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.3rem",fontWeight:700,marginBottom:"1.1rem"}}>Order Summary</h3>
          {err && <div className="form-err">{err}</div>}
          {items.map(i => (
            <div key={i.id} className="flex justify-between mb-1" style={{fontSize:".83rem",paddingBottom:".5rem",borderBottom:"1px solid var(--border)"}}>
              <span>{i.emoji} {i.name} × {i.quantity} {getSelectionLabel(i, i.weight, true)}</span>
              <span className="fw-700">
                {activeCoupon && i.originalLineTotal > i.lineTotal && <span className="price-original" style={{marginRight:6}}>₹{formatMoney(i.originalLineTotal)}</span>}
                ₹{formatMoney(i.lineTotal)}
              </span>
            </div>
          ))}
          <hr className="divider"/>
          <CouponBox />
          <div className="flex justify-between mb-1 text-sm"><span className="text-muted">Subtotal</span><span>₹{formatMoney(activeCoupon ? subtotalBeforeCoupon : subtotal)}</span></div>
          {activeCoupon && <div className="flex justify-between mb-1 text-sm"><span className="text-muted">Coupon</span><span className="text-leaf">-₹{formatMoney(couponDiscount)}</span></div>}
          <div className="flex justify-between mb-2 text-sm"><span className="text-muted">Delivery</span><span style={{color:delivery===0?"var(--leaf)":"inherit"}}>{delivery===0?"FREE":"₹"+delivery}</span></div>
          <div className="flex justify-between" style={{fontWeight:700,fontSize:"1.1rem",marginBottom:"1.25rem"}}>
            <span>Total</span><span style={{color:"var(--leaf)",fontFamily:"'Cormorant Garamond',serif",fontSize:"1.4rem"}}>₹{formatMoney(total)}</span>
          </div>
          <div style={{borderTop:"1px solid var(--border)",borderBottom:"1px solid var(--border)",padding:"1rem 0",marginBottom:"1.25rem",fontSize:".82rem",color:"var(--muted)"}}>
            <div style={{fontWeight:700,color:"var(--ink)",marginBottom:".75rem"}}>Choose Payment Method</div>
            <label style={{display:"flex",alignItems:"center",gap:".6rem",marginBottom:".65rem",cursor:"pointer"}}>
              <input type="radio" name="payment" value="cod" checked={paymentMethod === "cod"} onChange={() => setPaymentMethod("cod")}/>
              <span>💵 Cash on Delivery</span>
            </label>
            <label style={{display:"flex",alignItems:"center",gap:".6rem",cursor:"pointer"}}>
              <input type="radio" name="payment" value="online" checked={paymentMethod === "online"} onChange={() => setPaymentMethod("online")}/>
              <span>💳 Pay Online with Razorpay / UPI</span>
            </label>
          </div>
          <button className="btn btn-primary btn-full btn-lg checkout-actions checkout-buttons" onClick={submit} disabled={loading}>
            {loading ? (paymentMethod === "online" ? "Opening Payment…" : "Placing Order…") : (paymentMethod === "online" ? `Pay ₹${formatMoney(total)}` : `Place Order ₹${formatMoney(total)}`)}
          </button>
          <p className="text-xs text-muted mt-2" style={{textAlign:"center"}}>
            {paymentMethod === "online" ? "Secure payment powered by Razorpay" : "You'll pay in cash upon delivery"}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ORDER SUCCESS
═══════════════════════════════════════════════════════════ */
function OrderSuccessPage() {
  const {params, nav} = useContext(RouterCtx);
  const order = params.order;
  if (!order) { nav("orders"); return null; }
  return (
    <div className="page" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"calc(100vh - 68px)"}}>
      <div style={{background:"var(--white)",borderRadius:24,border:"1.5px solid var(--border)",padding:"3rem 2.5rem",maxWidth:480,width:"100%",textAlign:"center",margin:"2rem",boxShadow:"var(--shadow)"}}>
        <div style={{fontSize:"4rem",marginBottom:"1rem"}}>🎉</div>
        <h1 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"2.2rem",fontWeight:700,color:"var(--leaf)",marginBottom:".5rem"}}>Order Placed!</h1>
        <p className="text-muted mb-3">Your fresh produce is being prepared and will arrive soon.</p>
        <div style={{background:"var(--cream)",borderRadius:12,padding:".75rem 1.25rem",marginBottom:"1.5rem",display:"inline-block"}}>
          <span className="text-sm text-muted">Order ID: </span>
          <span style={{fontFamily:"monospace",fontWeight:700,color:"var(--leaf)"}}>{order.id.slice(-8).toUpperCase()}</span>
        </div>
        <div style={{background:"var(--paper)",borderRadius:12,padding:"1rem",marginBottom:"2rem",textAlign:"left"}}>
          {order.items?.map(i => (
            <div key={i.product_id} className="flex justify-between text-sm mb-1">
              <span>{i.emoji} {i.name} × {i.quantity}</span><span>₹{i.line_total}</span>
            </div>
          ))}
          <hr className="divider"/>
          <div className="flex justify-between fw-700"><span>Total</span><span style={{color:"var(--leaf)"}}>₹{formatMoney(order.total)}</span></div>
        </div>
        <div style={{background:"#fef9c3",borderRadius:10,padding:".65rem",fontSize:".8rem",color:"#92400e",marginBottom:"1.5rem"}}>
          💳 Payment: {order.payment_status === "paid" ? "Paid Online" : "Cash on Delivery"}
          {order.delivery_maps_url && <><br/><a href={order.delivery_maps_url} target="_blank" style={{color:"#92400e",fontWeight:700}}>View pinned location</a></>}
        </div>
        <div className="flex gap-2 justify-center flex-wrap">
          <button className="btn btn-primary" onClick={() => nav("orders")}>Track Order</button>
          <button className="btn btn-ghost" onClick={() => nav("shop")}>Continue Shopping</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ORDERS PAGE
═══════════════════════════════════════════════════════════ */
function OrdersPage() {
  const {user} = useContext(AuthCtx);
  const {nav} = useContext(RouterCtx);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [tracking, setTracking] = useState(null);
  const [lastStatuses, setLastStatuses] = useState({});

  useEffect(() => {
    if (!user) { nav("login"); return; }

    let intervalId;

    const loadOrders = async () => {
      try {
        const data = await apiFetch("/orders");

        setOrders(prevOrders => {
          const previousMap = {};
          prevOrders.forEach(o => previousMap[o.id] = o.status);

          data.forEach(o => {
            if (
              previousMap[o.id] &&
              previousMap[o.id] !== o.status &&
              Notification.permission === "granted"
            ) {
              showOrderNotification(
                "Amar Veggies Order Update",
                `Order #${o.id.slice(-8).toUpperCase()} is now ${o.status.replace(/_/g, " ")}`
              );
            }
          });

          return data;
        });
      } catch (e) {}

      setLoading(false);
    };

    loadOrders();
    intervalId = setInterval(loadOrders, 15000);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!selected) return;

    let intervalId;
    setTracking(null);

    const loadTracking = async () => {
      try {
        const data = await apiFetch(`/orders/${selected.id}/tracking`);
        setTracking(data);
      } catch (e) {}
    };

    loadTracking();
    intervalId = setInterval(loadTracking, 10000);

    return () => clearInterval(intervalId);
  }, [selected]);

  const ALL_STATUSES = ["pending","confirmed","out_for_delivery","delivered"];
  const statusLabel = {pending:"Order Placed",confirmed:"Confirmed",out_for_delivery:"Out for Delivery",delivered:"Delivered"};

  if (loading) return <div className="empty-state"><div className="empty-state-icon">⏳</div><p>Loading orders…</p></div>;
  if (orders.length === 0) return (
    <div className="page">
      <div className="empty-state">
        <div className="empty-state-icon">📦</div>
        <h3>No orders yet</h3>
        <p className="mb-3">Your order history will appear here</p>
        <button className="btn btn-primary" onClick={() => nav("shop")}>Start Shopping</button>
      </div>
    </div>
  );

  return (
    <div className="page container" style={{paddingTop:"2rem",maxWidth:820}}>
      <h1 className="page-title">My Orders</h1>
      <p className="page-sub">{orders.length} order{orders.length!==1?"s":""}</p>
      {orders.map(o => (
        <div key={o.id} className="order-card" onClick={() => setSelected(o)}>
          <div className="order-hd">
            <div>
              <div className="order-id-text">Order #{o.id.slice(-8).toUpperCase()}</div>
              <div className="order-meta">{new Date(o.created_at).toLocaleDateString("en-IN", {day:"numeric",month:"short",year:"numeric"})} · {o.items?.length} item{o.items?.length!==1?"s":""} · ₹{o.total}</div>
            </div>
            <StatusBadge status={o.status}/>
          </div>
          <div className="flex gap-1 flex-wrap">
            {o.items?.slice(0,4).map(i => <span key={i.product_id} className="chip">{i.emoji} {i.name}</span>)}
            {o.items?.length > 4 && <span className="chip">+{o.items.length-4} more</span>}
          </div>
        </div>
      ))}

      {selected && (
        <div className="overlay" onClick={e => e.target===e.currentTarget && setSelected(null)}>
          <div className="modal" style={{maxWidth:580}}>
            <div className="flex justify-between items-center mb-2">
              <h2 className="modal-title" style={{margin:0}}>Order Details</h2>
              <StatusBadge status={selected.status}/>
            </div>
            <p className="text-sm text-muted mb-2">#{selected.id.slice(-8).toUpperCase()} · {new Date(selected.created_at).toLocaleDateString("en-IN",{day:"numeric",month:"long",year:"numeric"})}</p>

            <div className="timeline">
              {ALL_STATUSES.map((s, i) => {
                const selectedStatus = normalizeOrderStatus(selected.status);
                const done = ALL_STATUSES.indexOf(selectedStatus) >= i || selected.status === "cancelled";
                const entry = selected.timeline?.find(t => t.status === s);
                return (
                  <div key={s} className="timeline-item">
                    <div className={`timeline-dot ${done?"done":""}`}/>
                    <div>
                      <div className={`timeline-text ${done?"done":""}`}>{statusLabel[s] || s}</div>
                      {entry && <div className="text-xs text-muted">{new Date(entry.at).toLocaleString("en-IN",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</div>}
                    </div>
                  </div>
                );
              })}
            </div>

            {selected.items?.map(i => (
              <div key={i.product_id} className="flex justify-between text-sm mb-1 pb-1" style={{borderBottom:"1px solid var(--border)"}}>
                <span>{i.emoji} {i.name} × {i.quantity} {i.unit}</span><span className="fw-700">₹{i.line_total}</span>
              </div>
            ))}
            <div className="flex justify-between fw-700 mt-2"><span>Total</span><span style={{color:"var(--leaf)"}}>₹{selected.total}</span></div>
            <p className="text-sm text-muted mt-2">📍 {selected.address} · 📞 {selected.phone}</p>
            {selected.delivery_maps_url && <p className="text-sm mt-1"><a href={selected.delivery_maps_url} target="_blank" style={{color:"var(--leaf)",fontWeight:700}}>Open pinned location</a></p>}
            {tracking?.delivery_partner && (
              <div style={{
                background: "var(--cream)",
                borderRadius: 12,
                padding: "1rem",
                marginTop: "1rem"
              }}>
                <div className="fw-700 mb-1">🚚 Delivery Tracking</div>

                <p className="text-sm text-muted mb-1">
                  Partner: {tracking.delivery_partner}
                </p>

                {tracking.delivery_partner_phone && (
                  <p className="text-sm text-muted mb-1">
                    Phone: {tracking.delivery_partner_phone}
                  </p>
                )}

                {tracking.delivery_live_lat && tracking.delivery_live_lng ? (
                  <>
                    <p className="text-xs text-muted mb-2">
                      Last updated time: {tracking.delivery_last_updated
                        ? new Date(tracking.delivery_last_updated).toLocaleTimeString("en-IN")
                        : "Just now"}
                    </p>

                    <div className="text-xs fw-700 text-muted mt-2">Live location map</div>
                    <iframe
                      width="100%"
                      height="260"
                      style={{border:0, borderRadius:12, marginTop:".75rem"}}
                      loading="lazy"
                      allowFullScreen
                      src={`https://www.google.com/maps?q=${tracking.delivery_live_lat},${tracking.delivery_live_lng}&z=16&output=embed`}
                    ></iframe>

                    <div className="flex gap-1 flex-wrap mt-2">
                      <a className="btn btn-primary" target="_blank" href={`https://www.google.com/maps/search/?api=1&query=${tracking.delivery_live_lat},${tracking.delivery_live_lng}`}>
                        Open live location
                      </a>
                      {tracking.delivery_partner_phone && (
                        <a
                          className="btn btn-ghost"
                          href={`tel:${tracking.delivery_partner_phone}`}
                        >
                          📞 Call Partner
                        </a>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-muted mb-2">
                      Last updated time: {tracking.delivery_last_updated
                        ? new Date(tracking.delivery_last_updated).toLocaleTimeString("en-IN")
                        : "Not available yet"}
                    </p>
                    <p className="text-sm text-muted">
                      Live location map will appear here once your delivery partner starts sharing it.
                    </p>
                    {tracking.delivery_partner_phone && (
                      <div className="flex gap-1 flex-wrap mt-2">
                        <a
                          className="btn btn-ghost"
                          href={`tel:${tracking.delivery_partner_phone}`}
                        >
                          📞 Call Partner
                        </a>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="modal-footer"><button className="btn btn-ghost" onClick={() => setSelected(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   AUTH PAGES
═══════════════════════════════════════════════════════════ */
function ForgotPasswordModal({onClose}) {
  const {sendForgotPasswordOtp, resetPassword} = useContext(AuthCtx);
  const toast = useContext(ToastCtx);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({identifier:"", otp:"", password:"", confirm:""});
  const [devOtp, setDevOtp] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const requestOtp = async () => {
    if (!form.identifier.trim()) { setErr("Enter your email or mobile number"); return; }
    setLoading(true); setErr("");
    try {
      const d = await sendForgotPasswordOtp(form.identifier.trim());
      setDevOtp(d.dev_otp || "");
      setStep(2);
      toast("Password reset OTP sent");
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const reset = async () => {
    if (form.password.length < 6) { setErr("Password must be at least 6 characters"); return; }
    if (form.password !== form.confirm) { setErr("Passwords don't match"); return; }
    setLoading(true); setErr("");
    try {
      await resetPassword(form.identifier.trim(), form.otp.trim(), form.password);
      toast("Password changed. Please sign in.");
      onClose();
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div className="overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="modal auth-modal" style={{maxWidth:460}}>
        <h2 className="modal-title">Forgot password?</h2>
        <p className="text-sm" style={{color:"var(--muted)",marginBottom:"1rem"}}>Enter your registered email or mobile number. We'll verify it with a one-time password.</p>
        {err && <div className="form-err">{err}</div>}
        {devOtp && <div className="auth-dev-otp">Testing OTP: <strong>{devOtp}</strong></div>}
        <div className="field"><label>Email or Mobile Number</label><input disabled={step===2} placeholder="you@example.com or 9876543210" value={form.identifier} onChange={e=>setForm(f=>({...f,identifier:e.target.value}))}/></div>
        {step === 2 && <>
          <div className="field"><label>OTP</label><input placeholder="6-digit OTP" value={form.otp} onChange={e=>setForm(f=>({...f,otp:e.target.value}))}/></div>
          <div className="field"><label>New Password</label><input type="password" placeholder="Create new password" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))}/></div>
          <div className="field"><label>Confirm Password</label><input type="password" placeholder="Confirm new password" value={form.confirm} onChange={e=>setForm(f=>({...f,confirm:e.target.value}))}/></div>
        </>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {step === 1
            ? <button className="btn btn-primary" onClick={requestOtp} disabled={loading}>{loading?"Sending…":"Send OTP"}</button>
            : <button className="btn btn-primary" onClick={reset} disabled={loading}>{loading?"Saving…":"Reset Password"}</button>}
        </div>
      </div>
    </div>
  );
}

function LoginPage() {
  const {login, googleLogin} = useContext(AuthCtx);
  const {nav, params} = useContext(RouterCtx);
  const toast = useContext(ToastCtx);
  const [form, setForm] = useState({identifier:"",password:"",remember:false});
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  const submit = async () => {
    if (!form.identifier || !form.password) { setErr("Please enter your email/mobile number and password"); return; }
    setLoading(true); setErr("");
    try {
      const u = await login(form.identifier, form.password);
      toast(`Welcome back, ${u.name}! 🌿`);
      nav(params.redirect || (u.is_admin ? "admin" : "shop"));
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const googleSignIn = () => {
    if (!isGoogleSignInConfigured()) {
      toast("Google sign-in is not configured", "error");
      return;
    }

    if (!window.google?.accounts?.id) {
      toast("Google sign-in failed to load. Refresh and try again.", "error");
      return;
    }

    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        try {
          const u = await googleLogin(response.credential);
          toast(`Welcome, ${u.name}! 🌿`);
          nav(params.redirect || (u.is_admin ? "admin" : "shop"));
        } catch (e) {
          setErr(e.message || "Google sign-in failed");
        }
      }
    });

    window.google.accounts.id.prompt();
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand"><div className="auth-brand-inner"><div className="auth-logo">Amar Veggies <span>⌁</span></div><div className="auth-tagline">Farm to Doorstep</div><div className="auth-leaf-line">🌿</div><div className="auth-headline">Fresh. Natural.<br/>Delivered with care.</div><p className="auth-copy">From our farm to your home — pure, healthy, and affordable veggies delivered to your doorstep.</p></div><div className="auth-basket">🥬🧺🥕</div></div>
        <div className="auth-panel">
          <h1>Welcome back</h1><p className="auth-panel-sub">Sign in to your account to continue</p>{err && <div className="form-err">{err}</div>}
          <div className="auth-field"><label>Email address or Mobile number</label><div className="auth-input-wrap"><span className="auth-input-icon">👤</span><input placeholder="Enter your email or mobile number" value={form.identifier} onChange={e=>setForm(f=>({...f,identifier:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&submit()}/></div></div>
          <div className="auth-field"><label>Password</label><div className="auth-input-wrap"><span className="auth-input-icon">🔒</span><input type="password" placeholder="Enter your password" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&submit()}/></div></div>
          <div className="auth-row"><label className="auth-check"><input type="checkbox" checked={form.remember} onChange={e=>setForm(f=>({...f,remember:e.target.checked}))}/>Remember Me</label><button className="auth-link" onClick={()=>setForgotOpen(true)}>Forgot Password?</button></div>
          <button className="auth-submit" onClick={submit} disabled={loading}>{loading?"Signing in…":"Sign in"}</button><div className="auth-or">OR</div><button className="google-btn" onClick={googleSignIn}><span className="google-g">G</span>Continue with Google</button>
          <div className="auth-switch">New here? <button onClick={() => nav("register")}>Create an account</button></div>
        </div>
      </div>
      {forgotOpen && <ForgotPasswordModal onClose={()=>setForgotOpen(false)}/>} 
    </div>
  );
}

function RegisterPage() {
  const {sendRegisterOtp, verifyOtpRegister} = useContext(AuthCtx);
  const {nav} = useContext(RouterCtx);
  const toast = useContext(ToastCtx);
  const [mode, setMode] = useState("email");
  const [step, setStep] = useState("details");
  const [form, setForm] = useState({name:"",email:"",phone:"",otp:"",password:"",confirm:""});
  const [devOtp, setDevOtp] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const cleanPhone = (phone) => phone.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");

  const sendOtp = async () => {
    const name = form.name.trim();
    const email = mode === "email" ? form.email.trim().toLowerCase() : "";
    const phone = mode === "phone" ? cleanPhone(form.phone) : "";

    if (!name) { setErr("Please enter your full name"); return; }
    if (mode === "email" && !email) { setErr("Please enter your Gmail/email address"); return; }
    if (mode === "phone" && phone.length !== 10) { setErr("Please enter a valid 10-digit mobile number"); return; }

    setLoading(true); setErr(""); setDevOtp("");
    try {
      const d = await sendRegisterOtp(name, email || null, phone || null);
      setStep("otp");
      setDevOtp(d.dev_otp || "");
      toast("OTP sent ✓");
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const verifyOtp = async () => {
    const name = form.name.trim();
    const email = mode === "email" ? form.email.trim().toLowerCase() : "";
    const phone = mode === "phone" ? cleanPhone(form.phone) : "";
    const otp = form.otp.trim();

    if (otp.length !== 6) { setErr("Please enter the 6-digit OTP"); return; }
    if (form.password.length < 6) { setErr("Password must be at least 6 characters"); return; }
    if (form.password !== form.confirm) { setErr("Passwords don't match"); return; }

    setLoading(true); setErr("");
    try {
      const u = await verifyOtpRegister(name, email || null, phone || null, otp, form.password);
      toast(`Welcome, ${u.name}! 🌿`);
      nav("shop");
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-inner">
            <div className="auth-logo">Amar Veggies <span>⌁</span></div>
            <div className="auth-tagline">Farm to Doorstep</div>
            <div className="auth-leaf-line">🌿</div>
            <div className="auth-headline">Create once.<br/>Order fresh forever.</div>
            <p className="auth-copy">Verify your email or mobile number only during signup. After that, use your password for quick future logins.</p>
          </div>
          <div className="auth-basket">🥦🧺🍅</div>
        </div>

        <div className="auth-panel">
          <h1>Create account</h1>
          <p className="auth-panel-sub">Verify once with OTP, then create your password</p>

          {err && <div className="form-err">{err}</div>}
          {devOtp && <div className="auth-dev-otp">Local testing OTP: <strong>{devOtp}</strong></div>}

          <div className="auth-field">
            <label>Register with</label>
            <div className="flex gap-1" style={{flexWrap:"wrap"}}>
              <button className={`btn ${mode === "email" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setMode("email"); setStep("details"); setErr(""); setDevOtp(""); }}>Gmail / Email</button>
              <button className={`btn ${mode === "phone" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setMode("phone"); setStep("details"); setErr(""); setDevOtp(""); }}>Mobile Number</button>
            </div>
          </div>

          <div className="auth-field">
            <label>Full Name</label>
            <div className="auth-input-wrap">
              <span className="auth-input-icon">👤</span>
              <input placeholder="Priya Sharma" value={form.name} disabled={step === "otp"} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/>
            </div>
          </div>

          {mode === "email" ? (
            <div className="auth-field">
              <label>Gmail / Email</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon">✉️</span>
                <input type="email" placeholder="you@gmail.com" value={form.email} disabled={step === "otp"} onChange={e=>setForm(f=>({...f,email:e.target.value}))}/>
              </div>
            </div>
          ) : (
            <div className="auth-field">
              <label>Mobile Number</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon">📱</span>
                <input inputMode="numeric" placeholder="9876543210" value={form.phone} disabled={step === "otp"} onChange={e=>setForm(f=>({...f,phone:e.target.value}))}/>
              </div>
            </div>
          )}

          {step === "otp" && (
            <>
              <div className="auth-field">
                <label>One Time Password</label>
                <div className="auth-input-wrap">
                  <span className="auth-input-icon">🔐</span>
                  <input inputMode="numeric" maxLength="6" placeholder="Enter 6-digit OTP" value={form.otp} onChange={e=>setForm(f=>({...f,otp:e.target.value.replace(/\D/g, "")}))}/>
                </div>
              </div>

              <div className="field-row">
                <div className="auth-field">
                  <label>Create Password</label>
                  <div className="auth-input-wrap">
                    <span className="auth-input-icon">🔒</span>
                    <input type="password" placeholder="Create password" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))}/>
                  </div>
                </div>
                <div className="auth-field">
                  <label>Confirm Password</label>
                  <div className="auth-input-wrap">
                    <span className="auth-input-icon">✅</span>
                    <input type="password" placeholder="Confirm password" value={form.confirm} onChange={e=>setForm(f=>({...f,confirm:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&verifyOtp()}/>
                  </div>
                </div>
              </div>
            </>
          )}

          {step === "details" ? (
            <button className="auth-submit" onClick={sendOtp} disabled={loading}>{loading?"Sending OTP…":"Send OTP"}</button>
          ) : (
            <>
              <button className="auth-submit" onClick={verifyOtp} disabled={loading}>{loading?"Creating account…":"Verify OTP & Create Password"}</button>
              <div className="auth-row" style={{marginTop:"1rem",marginBottom:0}}>
                <button className="auth-link" onClick={() => { setStep("details"); setForm(f=>({...f,otp:"",password:"",confirm:""})); setDevOtp(""); }}>Change details</button>
                <button className="auth-link" onClick={sendOtp} disabled={loading}>Resend OTP</button>
              </div>
            </>
          )}

          <div className="auth-switch">Already have an account? <button onClick={() => nav("login")}>Sign in</button></div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ADMIN — PRODUCT FORM MODAL
═══════════════════════════════════════════════════════════ */
function ProductFormModal({product, onClose, onSaved}) {
  const toast = useContext(ToastCtx);
  const [form, setForm] = useState(product || {name:"",description:"",emoji:"🌿",category:"Vegetable",price:"",unit:"kg",stock:"",available:true,featured:false,quantity_options:[100,250,500,1000],purchase_options:[]});
  const [quantityOptionsText, setQuantityOptionsText] = useState(quantityOptionsToText(product?.quantity_options || defaultQuantityOptionsForUnit(product?.unit || "kg")));
  const [purchaseOptionsText, setPurchaseOptionsText] = useState(purchaseOptionsToText(product?.purchase_options || []));
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [imgPreview, setImgPreview] = useState(productImageSrc(product) || null);
  const [imgFile, setImgFile] = useState(null);
  const [imgUploading, setImgUploading] = useState(false);
  const fileRef = useRef(null);
  const f = (k) => (v) => setForm(p=>({...p,[k]:v}));

  const handleImgPick = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("Please select an image file", "error"); return; }
    if (file.size > 5 * 1024 * 1024) { toast("Image must be under 5MB", "error"); return; }
    setImgFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImgPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const removeImg = () => { setImgFile(null); setImgPreview(null); if (fileRef.current) fileRef.current.value = ""; };

  const save = async () => {
    if (!form.name || !form.price || !form.unit || form.stock === "") { setErr("Name, price, unit and stock are required"); return; }
    setLoading(true); setErr("");
    try {
      const purchaseOptions = purchaseOptionsFromText(purchaseOptionsText);
      const quantityOptions = quantityOptionsFromText(quantityOptionsText);
      const body = {
        ...form,
        price: parseFloat(form.price),
        stock: parseFloat(form.stock),
        quantity_options: quantityOptions,
        purchase_options: purchaseOptions
      };
      let savedProduct;
      if (product) {
        savedProduct = await apiFetch(`/products/${product.id}`, {method:"PUT", body:JSON.stringify(body)});
      } else {
        savedProduct = await apiFetch("/products", {method:"POST", body:JSON.stringify(body)});
      }
      // Upload image if a new one was selected
      if (imgFile && savedProduct?.id) {
        setImgUploading(true);
        const fd = new FormData();
        fd.append("file", imgFile);
        const token = localStorage.getItem("hv_token");
        await fetch(`${API}/products/${savedProduct.id}/image`, {
          method: "POST",
          headers: token ? {Authorization: `Bearer ${token}`} : {},
          body: fd
        }).then(async res => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || "Image upload failed");
          return data;
        });
        setImgUploading(false);
      } else if (!imgPreview && productImageSrc(product)) {
        // Image was removed — delete it
        await apiFetch(`/products/${product.id}/image`, {method:"DELETE"});
      }
      toast(product ? "Product updated ✓" : "Product created ✓");
      onSaved();
    } catch(e) { setErr(e.message); }
    setImgUploading(false);
    setLoading(false);
  };

  return (
    <div className="overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="modal">
        <h2 className="modal-title">{product ? "Edit Product" : "New Product"}</h2>
        {err && <div className="form-err">{err}</div>}

        {/* Image uploader */}
        <div className="field">
          <label>Product Image</label>
          <div style={{display:"flex",gap:"1rem",alignItems:"flex-start",flexWrap:"wrap"}}>
            <div onClick={() => fileRef.current?.click()} style={{width:110,height:110,borderRadius:14,border:`2px dashed ${imgPreview?"var(--sage)":"var(--border)"}`,background:imgPreview?"transparent":"var(--paper)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",overflow:"hidden",flexShrink:0,transition:"border-color .2s",position:"relative"}}>
              {imgPreview
                ? <img src={imgPreview} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                : <div style={{textAlign:"center",color:"var(--muted)"}}>
                    <div style={{fontSize:"1.8rem",marginBottom:4}}>📷</div>
                    <div style={{fontSize:".68rem",fontWeight:600}}>Click to upload</div>
                  </div>}
            </div>
            <div style={{flex:1,minWidth:120}}>
              <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleImgPick}/>
              <button className="btn btn-ghost" style={{marginBottom:".5rem",fontSize:".8rem",padding:".4rem .9rem"}} onClick={() => fileRef.current?.click()}>
                {imgPreview ? "Change Image" : "Upload Image"}
              </button>
              {imgPreview && <button className="btn btn-danger" style={{fontSize:".8rem",padding:".4rem .9rem",marginLeft:".5rem"}} onClick={removeImg}>Remove</button>}
              <p style={{fontSize:".72rem",color:"var(--muted)",marginTop:".4rem",lineHeight:1.4}}>JPG, PNG, WebP · Max 5MB<br/>If no image, the emoji will show instead.</p>
            </div>
          </div>
        </div>

        <div className="field-row">
          <div className="field" style={{gridColumn:"1/-1"}}><label>Product Name *</label><input placeholder="e.g. Alphonso Mangoes" value={form.name} onChange={e=>f("name")(e.target.value)}/></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Emoji (fallback)</label><input placeholder="🌿" value={form.emoji} onChange={e=>f("emoji")(e.target.value)}/></div>
          <div className="field"><label>Category *</label><select id="productCategory" required value={form.category} onChange={e=>f("category")(e.target.value)}>
            <option value="">Select category</option>
            <option value="fruit">Fruit</option>
            <option value="vegetable">Vegetable</option>
          </select></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Price (₹ per kg/dozen/bunch) *</label><input type="number" min="0" placeholder="0.00" value={form.price} onChange={e=>f("price")(e.target.value)}/></div>
          <div className="field"><label>Unit *</label><input placeholder="kg, bunch, dozen…" value={form.unit} onChange={e=>f("unit")(e.target.value)}/></div>
        </div>
        <div className="field"><label>Stock *</label><input type="number" min="0" step="0.01" value={form.stock} onChange={e=>f("stock")(e.target.value)}/></div>
        <div className="field">
          <label>Shop dropdown options</label>
          <input
            placeholder={isDozenUnit(form.unit) ? "12, 1" : isBunchUnit(form.unit) ? "1" : "100, 250, 500, 1000"}
            value={quantityOptionsText}
            onChange={e => setQuantityOptionsText(e.target.value)}
          />
          <div className="text-xs text-muted mt-1">
            Use comma-separated values. Kg uses grams (100, 250, 500, 1000). Dozen uses pieces (12 = 1 dozen, 1 = 1 piece). Bunch can be left as 1 to hide the dropdown.
          </div>
        </div>
        <div className="field">
          <label>Purchase options</label>
          <textarea
            placeholder='[{"value":12,"label":"1 dozen","multiplier":1},{"value":1,"label":"1 piece","multiplier":0.083333}]'
            value={purchaseOptionsText}
            onChange={e => setPurchaseOptionsText(e.target.value)}
          />
          <div className="text-xs text-muted mt-1">
            Leave blank to derive from the dropdown values. Multiplier is the stock unit consumed per item.
          </div>
        </div>
        <div className="field"><label>Description</label><textarea placeholder="Short description of the product…" value={form.description} onChange={e=>f("description")(e.target.value)}/></div>
        <div className="flex gap-3 mt-1">
          <label className="toggle-label"><Toggle on={form.available} onChange={f("available")}/> Available</label>
          <label className="toggle-label"><Toggle on={form.featured} onChange={f("featured")}/> Featured</label>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={loading||imgUploading}>
            {imgUploading?"Uploading image…":loading?"Saving…":"Save Product"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ADMIN PAGE
═══════════════════════════════════════════════════════════ */
function DeliveryPartnerPage() {
  const toast = useContext(ToastCtx);
  const [partner, setPartner] = useState(() => {
    try { return JSON.parse(localStorage.getItem("delivery_partner") || "null"); }
    catch { return null; }
  });
  const [form, setForm] = useState({ phone: "", password: "" });
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [trackingOrderId, setTrackingOrderId] = useState(null);
  const [lastLocationUpdate, setLastLocationUpdate] = useState(null);
  const watchIdRef = useRef(null);

  const loginDelivery = async () => {
    if (!form.phone || !form.password) {
      toast("Enter phone and password", "error");
      return;
    }

    setLoginLoading(true);
    try {
      const data = await deliveryApiFetch("/delivery/login", {
        method: "POST",
        body: JSON.stringify(form)
      });

      localStorage.setItem("delivery_token", data.token);
      localStorage.setItem("delivery_partner", JSON.stringify(data.partner));
      setPartner(data.partner);
      toast(`Welcome, ${data.partner.name} ✓`);
      loadOrders(data.partner);
    } catch (e) {
      toast(e.message, "error");
    }
    setLoginLoading(false);
  };

  const logoutDelivery = () => {
    if (watchIdRef.current) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    localStorage.removeItem("delivery_token");
    localStorage.removeItem("delivery_partner");
    setPartner(null);
    setTrackingOrderId(null);
    setLastLocationUpdate(null);
    setOrders([]);
  };

  const loadOrders = async (loggedPartner = partner) => {
    if (!loggedPartner) return;
    setLoading(true);
    try {
      const assigned = await deliveryApiFetch("/delivery/orders");
      setOrders(assigned);
    } catch (e) {
      toast(e.message, "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    if (partner) loadOrders(partner);
  }, []);

  useEffect(() => {
    return () => {
      if (watchIdRef.current) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  const restockProduct = async (product) => {
    const raw = prompt(`How many kg do you want to add to ${product.name}?`, "5");
    if (raw === null) return;
    const amount = Number(raw);
    if (!amount || amount <= 0) { toast("Enter a valid restock amount", "error"); return; }
    try {
      await apiFetch(`/products/${product.id}/restock`, {
        method:"POST",
        body: JSON.stringify({amount, reason:"Manual restock from admin panel"})
      });
      toast(`${product.name} restocked by ${amount} kg ✓`);
      loadProducts(); loadStats(); loadLowStock();
    } catch(e) { toast(e.message, "error"); }
  };

  const stockBadge = (p) => {
    const stock = Number(p.stock || 0);
    if (stock <= 0) return <span className="pill pill-red">Out of stock</span>;
    if (stock <= 2) return <span className="pill" style={{background:"#fef9c3",color:"#92400e"}}>Low stock</span>;
    return <span className="pill pill-green">In stock</span>;
  };

  const updateStatus = async (oid, status) => {
    try {
      await deliveryApiFetch(`/delivery/orders/${oid}/status`, {
        method: "PUT",
        body: JSON.stringify({ status })
      });
      toast("Order updated ✓");
      loadOrders(partner);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const startLiveTracking = (orderId) => {
    if (!navigator.geolocation) {
      toast("Location is not supported on this device", "error");
      return;
    }

    if (watchIdRef.current) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }

    setTrackingOrderId(orderId);

    watchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        try {
          const result = await deliveryApiFetch("/delivery/location", {
            method: "POST",
            body: JSON.stringify({
              order_id: orderId,
              lat: pos.coords.latitude,
              lng: pos.coords.longitude
            })
          });
          setLastLocationUpdate(result.updated_at || new Date().toISOString());
        } catch (e) {
          toast(e.message, "error");
        }
      },
      () => {
        toast("Location permission denied", "error");
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000
      }
    );

    toast("Live tracking started ✓");
  };

  const stopLiveTracking = () => {
    if (watchIdRef.current) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    setTrackingOrderId(null);
    setLastLocationUpdate(null);
    toast("Live tracking stopped");
  };

  if (!partner) {
    return (
      <div className="page container" style={{paddingTop:"2rem",maxWidth:480}}>
        <h1 className="page-title">Delivery Partner Login</h1>
        <p className="page-sub">Separate access for delivery partners. This is not the admin panel.</p>

        <div className="form-card" style={{margin:"1rem 0"}}>
          <div className="field">
            <label>Phone Number</label>
            <input
              placeholder="9999999991"
              value={form.phone}
              onChange={e => setForm(f => ({...f, phone:e.target.value}))}
            />
          </div>

          <div className="field">
            <label>Password</label>
            <input
              type="password"
              placeholder="Enter password"
              value={form.password}
              onChange={e => setForm(f => ({...f, password:e.target.value}))}
              onKeyDown={e => e.key === "Enter" && loginDelivery()}
            />
          </div>

          <button className="btn btn-primary btn-full" onClick={loginDelivery} disabled={loginLoading}>
            {loginLoading ? "Logging in…" : "Login"}
          </button>

          <p className="text-xs text-muted mt-2">
            Test: 9999999991 / nikhil123
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page container" style={{paddingTop:"2rem",maxWidth:900}}>
      <div className="flex justify-between items-center mb-2 flex-wrap gap-1">
        <div>
          <h1 className="page-title">Delivery Partner Panel</h1>
          <p className="page-sub">Logged in as {partner.name}</p>
        </div>
        <button className="btn btn-ghost" onClick={logoutDelivery}>Logout</button>
      </div>

      <button className="btn btn-primary mb-2" onClick={() => loadOrders(partner)}>
        Refresh Orders
      </button>

      {loading && <p>Loading assigned orders…</p>}

      {!loading && orders.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🚚</div>
          <h3>No assigned orders</h3>
        </div>
      )}

      {orders.map(o => (
        <div key={o.id} className="order-card">
          <div className="order-hd">
            <div>
              <div className="order-id-text">Order #{o.id.slice(-8).toUpperCase()}</div>
              <div className="order-meta">{o.user_name} · ₹{o.total}</div>
            </div>
            <StatusBadge status={o.status}/>
          </div>

          <p className="text-sm mb-1">📍 {o.address}</p>
          <p className="text-sm mb-1">📞 {o.phone}</p>

          {o.notes && (
            <div style={{background:"var(--cream)",borderRadius:10,padding:".6rem .75rem",fontSize:".8rem",marginBottom:".75rem"}}>
              📝 {o.notes}
            </div>
          )}

          <div className="flex gap-1 flex-wrap mb-2">
            {o.items?.slice(0,5).map(i => (
              <span key={i.product_id} className="chip">
                {i.emoji} {i.name} × {i.quantity} {i.selected_weight ? getSelectionLabel(i, i.selected_weight, true) : getUnitBaseLabel(i.unit)}
              </span>
            ))}
            {o.items?.length > 5 && <span className="chip">+{o.items.length - 5} more</span>}
          </div>

          {trackingOrderId === o.id && (
            <div style={{background:"#ecfdf5",border:"1px solid #86efac",borderRadius:12,padding:".7rem .85rem",marginBottom:".75rem",fontSize:".82rem",color:"#15803d"}}>
              📡 Live location sharing is ON
              {lastLocationUpdate && <div className="text-xs" style={{marginTop:".2rem"}}>Last sent: {new Date(lastLocationUpdate).toLocaleTimeString("en-IN")}</div>}
            </div>
          )}

          <div className="flex gap-1 flex-wrap">
            {o.phone && (
              <a className="btn btn-ghost" href={`tel:${o.phone}`}>
                Call Customer
              </a>
            )}

            {o.delivery_maps_url && (
              <a className="btn btn-ghost" target="_blank" href={o.delivery_maps_url}>
                Open Pin
              </a>
            )}

            {o.delivery_lat && o.delivery_lng && (
              <a
                className="btn btn-primary"
                target="_blank"
                href={`https://www.google.com/maps/dir/?api=1&destination=${o.delivery_lat},${o.delivery_lng}&travelmode=driving`}
              >
                Start Route
              </a>
            )}

            {o.status === "confirmed" && (
              <button className="btn btn-primary" onClick={() => updateStatus(o.id, "out_for_delivery")}>
                Start Delivery
              </button>
            )}

            {o.status === "out_for_delivery" && (
              <button className="btn btn-primary" onClick={() => updateStatus(o.id, "delivered")}>
                Mark Delivered
              </button>
            )}

            {trackingOrderId === o.id ? (
              <button className="btn btn-danger" onClick={stopLiveTracking}>
                Stop Live Tracking
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => startLiveTracking(o.id)}>
                Share Live Location
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CouponAdminForm() {
  const toast = useContext(ToastCtx);
  const [form, setForm] = useState({
    code: "",
    discountType: "percentage",
    discountValue: "",
    minOrderAmount: "",
    expiresAt: "",
    isActive: true
  });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const setField = key => value => setForm(prev => ({...prev, [key]: value}));

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (!form.code.trim() || !form.discountValue) {
      setErr("Code and discount value are required");
      return;
    }
    setLoading(true);
    try {
      await apiFetch("/coupons", {
        method: "POST",
        body: JSON.stringify({
          code: form.code,
          discountType: form.discountType,
          discountValue: Number(form.discountValue),
          minOrderAmount: form.minOrderAmount === "" ? null : Number(form.minOrderAmount),
          expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59`).toISOString() : null,
          isActive: form.isActive
        })
      });
      toast("Coupon created");
      setForm({code:"", discountType:"percentage", discountValue:"", minOrderAmount:"", expiresAt:"", isActive:true});
    } catch (e) {
      setErr(e.message || "Could not create coupon");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="admin-form-panel" onSubmit={submit}>
      <div>
        <h1 className="page-title">Coupons</h1>
        <p className="text-muted text-sm">Create discounts customers can apply in cart or checkout.</p>
      </div>
      {err && <div className="form-err">{err}</div>}
      <div className="field-row">
        <div className="field">
          <label>Code *</label>
          <input value={form.code} onChange={e => setField("code")(e.target.value.toUpperCase())} placeholder="FRESH10" />
        </div>
        <div className="field">
          <label>Discount Type</label>
          <select value={form.discountType} onChange={e => setField("discountType")(e.target.value)}>
            <option value="percentage">Percentage</option>
            <option value="flat">Flat</option>
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Discount Value *</label>
          <input type="number" min="0" step="0.01" value={form.discountValue} onChange={e => setField("discountValue")(e.target.value)} placeholder={form.discountType === "percentage" ? "10" : "50"} />
        </div>
        <div className="field">
          <label>Minimum Order Amount</label>
          <input type="number" min="0" step="0.01" value={form.minOrderAmount} onChange={e => setField("minOrderAmount")(e.target.value)} placeholder="300" />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Expiry Date</label>
          <input type="date" value={form.expiresAt} onChange={e => setField("expiresAt")(e.target.value)} />
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={form.isActive} onChange={e => setField("isActive")(e.target.checked)} />
          <span>Active coupon</span>
        </label>
      </div>
      <button className="btn btn-primary" type="submit" disabled={loading}>
        {loading ? "Creating..." : "Create Coupon"}
      </button>
    </form>
  );
}

function AdminPage() {
  const {user} = useContext(AuthCtx);
  const {nav} = useContext(RouterCtx);
  const toast = useContext(ToastCtx);
  const [tab, setTab] = useState("dashboard");
  const [stats, setStats] = useState({});
  const [topProducts, setTopProducts] = useState([]);
  const [revenueChart, setRevenueChart] = useState([]);
  const [paymentSplit, setPaymentSplit] = useState({
    cod: 0,
    online: 0,
    pending: 0
  });
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [editProduct, setEditProduct] = useState(null); // null=closed, false=new, obj=edit
  const [loadingP, setLoadingP] = useState(false);
  const [loadingO, setLoadingO] = useState(false);
  const [selOrder, setSelOrder] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [orderStatusFilter, setOrderStatusFilter] = useState("active");
  const knownOrderIdsRef = useRef(new Set());
  const initialOrdersLoadedRef = useRef(false);
  const audioCtxRef = useRef(null);
  const { logout } = useContext(AuthCtx);

  useEffect(() => { if (!user?.is_admin) nav("home"); }, [user]);

  const playNewOrderAlert = () => {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = audioCtxRef.current || new AudioCtx();
      audioCtxRef.current = ctx;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.38);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.42);
    } catch (e) {}
  };

  const enableSoundAlerts = async () => {
    setSoundEnabled(true);
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx && !audioCtxRef.current) audioCtxRef.current = new AudioCtx();
      if (audioCtxRef.current?.state === "suspended") await audioCtxRef.current.resume();
    } catch (e) {}
    toast("New order sound alerts enabled ✓");
  };

  const loadStats = () => {
    apiFetch("/admin/stats").then(setStats).catch(()=>{});
    apiFetch("/admin/analytics/top-products")
      .then(setTopProducts)
      .catch(() => {});
    apiFetch("/admin/analytics/revenue-chart")
      .then(setRevenueChart)
      .catch(() => {});
    apiFetch("/admin/analytics/payment-split")
      .then(setPaymentSplit)
      .catch(() => {});
  };
  const loadLowStock = () => apiFetch("/admin/low-stock?limit=2").then(setLowStock).catch(()=>{});
  const loadProducts = () => { setLoadingP(true); apiFetch("/products").then(setProducts).catch(e => {
    console.error("PRODUCT LOAD ERROR:", e);
    alert("PRODUCT ERROR: " + e.message);
  }).finally(()=>setLoadingP(false)); };
  const loadOrders = ({background = false} = {}) => {
    if (!background) setLoadingO(true);
    return apiFetch("/orders")
      .then(data => {
        const incomingIds = new Set(data.map(o => o.id));
        const newOrders = data.filter(o => !knownOrderIdsRef.current.has(o.id));

        if (initialOrdersLoadedRef.current && newOrders.length > 0) {
          toast(`${newOrders.length} new order${newOrders.length > 1 ? "s" : ""} received 🛒`);
          playNewOrderAlert();
        }

        knownOrderIdsRef.current = incomingIds;
        initialOrdersLoadedRef.current = true;
        setOrders(data);
      })
      .catch(()=>{})
      .finally(()=>{ if (!background) setLoadingO(false); });
  };

  useEffect(() => { loadStats(); loadProducts(); loadOrders(); loadLowStock(); }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      loadStats();
      loadOrders({background:true});
      loadLowStock();
    }, 12000);
    return () => clearInterval(id);
  }, [autoRefresh, soundEnabled]);

  const deleteProduct = async (id) => {
    if (!confirm("Delete this product?")) return;
    try { await apiFetch(`/products/${id}`, {method:"DELETE"}); toast("Product deleted"); loadProducts(); loadStats(); }
    catch(e) { toast(e.message, "error"); }
  };

  const restockProduct = async (product) => {
    const raw = prompt(`How many kg do you want to add to ${product.name}?`, "5");
    if (raw === null) return;
    const amount = Number(raw);
    if (!amount || amount <= 0) { toast("Enter a valid restock amount", "error"); return; }
    try {
      await apiFetch(`/products/${product.id}/restock`, {
        method:"POST",
        body: JSON.stringify({amount, reason:"Manual restock from admin panel"})
      });
      toast(`${product.name} restocked by ${amount} kg ✓`);
      loadProducts(); loadStats(); loadLowStock();
    } catch(e) { toast(e.message, "error"); }
  };

  const stockBadge = (p) => {
    const stock = Number(p.stock || 0);
    if (stock <= 0) return <span className="pill pill-red">Out of stock</span>;
    if (stock <= 2) return <span className="pill" style={{background:"#fef9c3",color:"#92400e"}}>Low stock</span>;
    return <span className="pill pill-green">In stock</span>;
  };

  const updateStatus = async (oid, status) => {
    try { const o = await apiFetch(`/orders/${oid}/status`, {method:"PUT", body:JSON.stringify({status})}); setOrders(prev => prev.map(x => x.id===oid ? o : x)); setSelOrder(o); toast("Status updated ✓"); }
    catch(e) { toast(e.message, "error"); }
  };

  const assignDeliveryPartner = async (oid, delivery_partner) => {
    try {
      const o = await apiFetch(`/orders/${oid}/assign`, {
        method:"PUT",
        body:JSON.stringify({delivery_partner})
      });
      setOrders(prev => prev.map(x => x.id===oid ? o : x));
      setSelOrder(o);
      toast("Delivery partner assigned ✓");
    } catch(e) {
      toast(e.message, "error");
    }
  };

  const navItems = [
    ["dashboard", "D", "Dashboard"],
    ["products", "P", "Products"],
    ["orders", "O", "Orders"],
    ["coupons", "%", "Coupons"]
  ];
  const ORDER_STATUSES = ["pending","confirmed","out_for_delivery","delivered","cancelled"];
  const DELIVERY_PARTNERS = ["", "Amar", "Nikhil", "Dhirendra"];

  return (
    <div className="admin-layout">
      <div className="admin-sidebar">
        <div className="admin-sidebar-title">Admin Panel</div>
        <div className="admin-sidebar-inner">
          {navItems.map(([id, icon, label]) => (
            <button key={id} className={`admin-nav-btn ${tab===id?"active":""}`} onClick={() => setTab(id)}>
              <span>{icon}</span> {label}
            </button>
          ))}
          <button className="admin-nav-btn" onClick={() => nav("shop")}><span>S</span> Shop</button>
          <button className="admin-nav-btn" onClick={() => { logout(); nav("home"); }}>
            Logout
          </button>
        </div>
      </div>

      <div className="admin-content">
        {/* DASHBOARD */}
        {tab === "dashboard" && (
          <>
            <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
              <div>
                <h1 className="page-title mb-1">Live Dashboard</h1>
                <p className="page-sub" style={{marginBottom:0}}>Auto-refreshes every 12 seconds while enabled</p>
              </div>
              <div className="flex gap-1 flex-wrap">
                <button className="btn btn-ghost" onClick={() => { loadStats(); loadOrders(); }}>Refresh now</button>
                <button className={`btn ${autoRefresh ? "btn-primary" : "btn-ghost"}`} onClick={() => setAutoRefresh(v => !v)}>
                  {autoRefresh ? "Live ON" : "Live OFF"}
                </button>
                <button className={`btn ${soundEnabled ? "btn-gold" : "btn-ghost"}`} onClick={enableSoundAlerts}>
                  {soundEnabled ? "Sound ON" : "Enable sound"}
                </button>
              </div>
            </div>

            <div className="stat-grid">
              {[
                ["Orders", stats.total_orders, "Total Orders"],
                ["Today", stats.today_orders, "Today Orders"],
                ["Pending", stats.pending_orders, "Pending"],
                ["Delivery", stats.active_delivery_orders, "Active Deliveries"],
                ["Done", stats.delivered_orders, "Delivered"],
                ["Rs", stats.revenue, "Total Revenue"],
                ["Rs", stats.today_revenue, "Today Revenue"],
                ["Items", stats.available_products, "Available Items"],
                ["Low", stats.low_stock_products, "Low Stock"],
                ["Out", stats.out_of_stock_products, "Out of Stock"],
                ["Users", stats.total_users, "Customers"]
              ].map(([icon,val,label]) => (
                <div key={label} className="stat-card">
                  <div className="stat-icon">{icon}</div>
                  <div className="stat-val">{val ?? "..."}</div>
                  <div className="stat-label">{label}</div>
                </div>
              ))}
            </div>

            <div className="table-wrap mt-3" style={{padding:"1rem"}}>
              <h3 className="mb-2">Revenue Trend</h3>

              {revenueChart.map(day => (
                <div key={day.date} style={{marginBottom:".75rem"}}>
                  <div className="flex justify-between text-sm mb-1">
                    <span>{day.date}</span>
                    <span>&#8377;{day.revenue}</span>
                  </div>
                  <div style={{height:10,background:"var(--cream)",borderRadius:999,overflow:"hidden"}}>
                    <div
                      style={{
                        height:"100%",
                        width:`${Math.min(100, Number(day.revenue || 0) / 10)}%`,
                        background:"var(--leaf)"
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="grid-3 mt-3">
              <div className="card">
                <div className="muted">Cash on Delivery</div>
                <h2>{paymentSplit.cod}</h2>
              </div>

              <div className="card">
                <div className="muted">Online Paid</div>
                <h2>{paymentSplit.online}</h2>
              </div>

              <div className="card">
                <div className="muted">Pending Payments</div>
                <h2>{paymentSplit.pending}</h2>
              </div>
            </div>

            <div className="table-wrap mt-3">
              <table className="table">
                <thead>
                  <tr>
                    <th>Top Product</th>
                    <th>Qty Sold</th>
                    <th>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {topProducts.map(p => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td>{p.quantity}</td>
                      <td>Rs {p.revenue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:"1rem",marginTop:"1rem"}}>
              <div style={{background:"var(--white)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"1rem"}}>
                <div className="flex justify-between items-center mb-2">
                  <h3 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.35rem"}}>Recent Orders</h3>
                  <button className="section-link" onClick={() => setTab("orders")}>View all →</button>
                </div>
                {orders.slice(0,5).map(o => (
                  <div key={o.id} className="flex justify-between items-center" style={{padding:".65rem 0",borderBottom:"1px solid var(--border)",gap:".75rem"}}>
                    <div>
                      <div className="fw-700">#{o.id.slice(-8).toUpperCase()} · ₹{o.total}</div>
                      <div className="text-xs text-muted">{o.user_name} · {o.items?.length || 0} item{o.items?.length===1?"":"s"}</div>
                    </div>
                    <StatusBadge status={o.status}/>
                  </div>
                ))}
                {orders.length === 0 && <p className="text-sm text-muted">No orders yet.</p>}
              </div>

              <div style={{background:"var(--white)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"1rem"}}>
                <div className="flex justify-between items-center mb-2">
                  <h3 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.35rem"}}>Active Deliveries</h3>
                  <span className="chip">{orders.filter(o => o.status === "out_for_delivery").length} live</span>
                </div>
                {orders.filter(o => o.status === "out_for_delivery").slice(0,5).map(o => (
                  <div key={o.id} style={{padding:".65rem 0",borderBottom:"1px solid var(--border)"}}>
                    <div className="fw-700">🚚 {o.delivery_partner || "Unassigned"}</div>
                    <div className="text-xs text-muted">#{o.id.slice(-8).toUpperCase()} · {o.user_name}</div>
                    {o.delivery_last_updated && <div className="text-xs text-muted">Last update: {new Date(o.delivery_last_updated).toLocaleTimeString("en-IN")}</div>}
                  </div>
                ))}
                {orders.filter(o => o.status === "out_for_delivery").length === 0 && <p className="text-sm text-muted">No active deliveries right now.</p>}
              </div>

              <div style={{background:"var(--white)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"1rem"}}>
                <div className="flex justify-between items-center mb-2">
                  <h3 style={{fontFamily:"'Cormorant Garamond',serif",fontSize:"1.35rem"}}>Low Stock Items</h3>
                  <button className="section-link" onClick={() => setTab("products")}>Manage →</button>
                </div>
                {lowStock.slice(0,6).map(p => (
                  <div key={p.id} className="flex justify-between items-center" style={{padding:".65rem 0",borderBottom:"1px solid var(--border)",gap:".75rem"}}>
                    <div>
                      <div className="fw-700">{p.emoji || "🌿"} {p.name}</div>
                      <div className="text-xs text-muted">Stock: {Number(p.stock || 0).toFixed(2)} {getUnitBaseLabel(p.unit)}</div>
                    </div>
                    <button className="btn btn-ghost" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={() => restockProduct(p)}>Restock</button>
                  </div>
                ))}
                {lowStock.length === 0 && <p className="text-sm text-muted">All products have enough stock.</p>}
              </div>
            </div>

            <div className="flex gap-2 flex-wrap mt-3">
              <button className="btn btn-primary" onClick={() => { setEditProduct(false); }}>+ Add Product</button>
              <button className="btn btn-ghost" onClick={() => setTab("orders")}>Manage Orders →</button>
            </div>
          </>
        )}

        {/* PRODUCTS */}
        {tab === "products" && (
          <>
            <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
              <div><h1 className="page-title">Products</h1><p className="text-muted text-sm">{products.length} total</p></div>
              <button className="btn btn-primary" onClick={() => setEditProduct(false)}>+ New Product</button>
            </div>
            {loadingP ? <div className="empty-state"><p>Loading…</p></div> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {products.map(p => (
                      <tr key={p.id}>
                        <td><div className="flex items-center gap-1">
  {productImageSrc(p)
    ? <img src={productImageSrc(p)} alt={p.name} style={{width:36,height:36,borderRadius:8,objectFit:"cover",flexShrink:0}}/>
    : <span style={{fontSize:"1.3rem",width:36,textAlign:"center",flexShrink:0}}>{p.emoji}</span>}
  <div><div style={{fontWeight:600}}>{p.name}</div><div className="text-xs text-muted">{p.description?.slice(0,40)}{p.description?.length>40?"…":""}</div></div>
</div></td>
                        <td><span className="chip">{p.category}</span></td>
                        <td className="fw-700 text-leaf">₹{p.price}/{p.unit}</td>
                        <td>
                          <div className="fw-700">{Number(p.stock || 0).toFixed(2)} {getUnitBaseLabel(p.unit)}</div>
                          <div className="mt-1">{stockBadge(p)}</div>
                        </td>
                        <td>
                          <span className={`pill ${p.available?"pill-green":"pill-red"}`}>{p.available?"Active":"Off"}</span>
                          {p.featured && <span className="pill" style={{background:"#fef9c3",color:"#92400e",marginLeft:4}}>⭐</span>}
                        </td>
                        <td>
                          <div className="flex gap-1">
                            <button className="btn btn-ghost" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={() => restockProduct(p)}>Restock</button>
                            <button className="btn btn-ghost" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={() => setEditProduct(p)}>Edit</button>
                            <button className="btn btn-danger" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={() => deleteProduct(p.id)}>Del</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {products.length === 0 && <tr><td colSpan={6} style={{textAlign:"center",color:"var(--muted)",padding:"3rem"}}>No products yet. Add your first product!</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* COUPONS */}
        {tab === "coupons" && <CouponAdminForm />}

        {/* ORDERS */}
        {tab === "orders" && (
          <>
            <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
              <div><h1 className="page-title">Orders</h1><p className="text-muted text-sm">{orders.length} total</p></div>
              <div className="flex gap-1 flex-wrap">
                {["active","pending","confirmed","out_for_delivery","delivered","cancelled","all"].map(f => (
                  <button key={f} className={`btn ${orderStatusFilter===f?"btn-primary":"btn-ghost"}`} style={{padding:".45rem .75rem",fontSize:".76rem"}} onClick={() => setOrderStatusFilter(f)}>
                    {f === "active" ? "Active" : f.replace(/_/g," ")}
                  </button>
                ))}
              </div>
            </div>
            {loadingO ? <div className="empty-state"><p>Loading…</p></div> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Delivery</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>
                    {orders.filter(o => orderStatusFilter === "all" ? true : orderStatusFilter === "active" ? !["delivered","cancelled"].includes(o.status) : normalizeOrderStatus(o.status) === orderStatusFilter).map(o => (
                      <tr key={o.id} style={{cursor:"pointer"}} onClick={() => setSelOrder(o)}>
                        <td style={{fontFamily:"monospace",fontWeight:700}}>#{o.id.slice(-8).toUpperCase()}</td>
                        <td><div style={{fontWeight:600}}>{o.user_name}</div><div className="text-xs text-muted">{o.user_email}</div></td>
                        <td>{o.items?.length} item{o.items?.length!==1?"s":""}</td>
                        <td className="fw-700 text-leaf">₹{o.total}</td>
                        <td>
                          <div className="fw-700">{o.payment_status === "paid" ? "Paid" : "Pending"}</div>
                          <div className="text-xs text-muted">{o.payment || "—"}</div>
                          {o.razorpay_payment_id && <div className="text-xs text-muted" style={{fontFamily:"monospace"}}>{o.razorpay_payment_id}</div>}
                        </td>
                        <td onClick={e=>e.stopPropagation()}>
                          <select
                            value={o.delivery_partner || ""}
                            onChange={e => assignDeliveryPartner(o.id, e.target.value)}
                            style={{padding:".35rem .5rem",borderRadius:8,border:"1px solid var(--border)",background:"var(--paper)",fontSize:".75rem"}}
                          >
                            {DELIVERY_PARTNERS.map(p => <option key={p || "none"} value={p}>{p || "Assign"}</option>)}
                          </select>
                        </td>
                        <td onClick={e=>e.stopPropagation()}>
                          <div className="flex gap-1 flex-wrap">
                            {o.status === "pending" && (
                              <button className="btn btn-primary" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={() => updateStatus(o.id, "confirmed")}>
                                Confirm
                              </button>
                            )}

                            {(o.status === "confirmed" || o.status === "packed") && (
                              <button className="btn btn-primary" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={() => updateStatus(o.id, "out_for_delivery")}>
                                Out
                              </button>
                            )}

                            {o.status === "out_for_delivery" && (
                              <button className="btn btn-primary" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={() => updateStatus(o.id, "delivered")}>
                                Delivered
                              </button>
                            )}

                            {o.status !== "cancelled" && o.status !== "delivered" && (
                              <button className="btn btn-danger" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={() => updateStatus(o.id, "cancelled")}>
                                Cancel
                              </button>
                            )}

                            {(o.status === "delivered" || o.status === "cancelled") && (
                              <span className="text-xs text-muted">No action</span>
                            )}
                          </div>
                        </td>
                        <td><button className="btn btn-ghost" style={{padding:".3rem .7rem",fontSize:".75rem"}} onClick={e=>{e.stopPropagation();setSelOrder(o);}}>View</button></td>
                      </tr>
                    ))}
                    {orders.filter(o => orderStatusFilter === "all" ? true : orderStatusFilter === "active" ? !["delivered","cancelled"].includes(o.status) : normalizeOrderStatus(o.status) === orderStatusFilter).length === 0 && <tr><td colSpan={9} style={{textAlign:"center",color:"var(--muted)",padding:"3rem"}}>No orders in this filter.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Product form modal */}
      {editProduct !== null && (
        <ProductFormModal
          product={editProduct || null}
          onClose={() => setEditProduct(null)}
          onSaved={() => { setEditProduct(null); loadProducts(); loadStats(); loadLowStock(); }}
        />
      )}

      {/* Order detail modal */}
      {selOrder && (
        <div className="overlay" onClick={e => e.target===e.currentTarget && setSelOrder(null)}>
          <div className="modal" style={{maxWidth:560}}>
            <div className="flex justify-between items-center mb-2">
              <h2 className="modal-title" style={{margin:0}}>Order #{selOrder.id.slice(-8).toUpperCase()}</h2>
              <StatusBadge status={selOrder.status}/>
            </div>
            <p className="text-sm text-muted mb-2">{selOrder.user_name} · {selOrder.user_email}</p>
            <div style={{background:"var(--cream)",borderRadius:10,padding:".65rem",fontSize:".82rem",marginBottom:"1rem"}}>
              💳 Payment: <strong>{selOrder.payment_status === "paid" ? "Paid Online" : "Pending / COD"}</strong>
              {selOrder.razorpay_payment_id && <><br/>Payment ID: <span style={{fontFamily:"monospace"}}>{selOrder.razorpay_payment_id}</span></>}
            </div>
            <p className="text-sm mb-2">📍 {selOrder.address}</p>
            {selOrder.delivery_maps_url && <div className="flex gap-1 flex-wrap mb-2">
              <a className="btn btn-ghost" target="_blank" href={selOrder.delivery_maps_url}>Open pin</a>
              <a className="btn btn-primary" target="_blank" href={`https://www.google.com/maps/dir/?api=1&destination=${selOrder.delivery_lat},${selOrder.delivery_lng}&travelmode=driving`}>Start delivery route</a>
            </div>}
            <p className="text-sm mb-2">📞 {selOrder.phone}</p>
            <div className="field mb-3">
              <label>Assign Delivery Partner</label>
              <select
                value={selOrder.delivery_partner || ""}
                onChange={e => assignDeliveryPartner(selOrder.id, e.target.value)}
              >
                {DELIVERY_PARTNERS.map(p => <option key={p || "none-modal"} value={p}>{p || "Select delivery partner"}</option>)}
              </select>
            </div>
            {selOrder.notes && <div style={{background:"var(--cream)",borderRadius:10,padding:".65rem",fontSize:".82rem",marginBottom:"1rem"}}>📝 {selOrder.notes}</div>}
            {selOrder.items?.map(i => (
              <div key={i.product_id} className="flex justify-between text-sm mb-1 pb-1" style={{borderBottom:"1px solid var(--border)"}}>
                <span>{i.emoji} {i.name} × {i.quantity} {i.unit}</span><span className="fw-700">₹{i.line_total}</span>
              </div>
            ))}
            <div className="flex justify-between fw-700 mt-2"><span>Total</span><span style={{color:"var(--leaf)"}}>₹{selOrder.total}</span></div>
            <div className="field mt-3"><label>Update Status</label>
              <select className="form-input" value={normalizeOrderStatus(selOrder.status)} onChange={e => updateStatus(selOrder.id, e.target.value)}>
                {ORDER_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g," ")}</option>)}
              </select>
            </div>
            <div className="modal-footer"><button className="btn btn-ghost" onClick={() => setSelOrder(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   APP SHELL
═══════════════════════════════════════════════════════════ */
// Expose CSS var values for inline use in JSX
const var_r = "var(--r)";
const var_ink = "var(--ink)";

function App() {
  return (
    <RouterProvider>
      <ToastProvider>
        <AuthProvider>
          <CartProvider>
            <AppInner/>
          </CartProvider>
        </AuthProvider>
      </ToastProvider>
    </RouterProvider>
  );
}

function AppInner() {
  const {page} = useContext(RouterCtx);

  const pages = {
    home: <HomePage/>,
    shop: <ShopPage/>,
    product: <ProductPage/>,
    cart: <CartPage/>,
    checkout: <CheckoutPage/>,
    "order-success": <OrderSuccessPage/>,
    orders: <OrdersPage/>,
    login: <LoginPage/>,
    register: <RegisterPage/>,
    admin: <AdminPage/>,
    delivery: <DeliveryPartnerPage/>,
  };

  return (
    <div>
      <Navbar/>
      {pages[page] || <HomePage/>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App/>);






