"""
Amar Veggies - PostgreSQL/SQLAlchemy Backend API

Production:
    Set DATABASE_URL in Render to your PostgreSQL Internal Database URL.

Run once:
    pip install -r requirements.txt

Start backend:
    python server.py
"""

from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional, List, Any, Dict
from datetime import datetime, timedelta
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import create_engine, String, Integer, Float, Text, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker, Session
from sqlalchemy.exc import IntegrityError
from twilio.rest import Client 
from collections import defaultdict
import uuid
import os
import json
import random
import re
import requests
import razorpay
import hmac
import hashlib
import time
import logging
import importlib

redis: Optional[Any] = None
boto3: Optional[Any] = None
try:
    redis = importlib.import_module("redis")
except ImportError:
    pass
try:
    boto3 = importlib.import_module("boto3")
except ImportError:
    pass

try:
    import firebase_admin  # type: ignore[import-not-found]
    from firebase_admin import credentials, messaging  # type: ignore[import-not-found]
except ImportError:
    firebase_admin = None
    credentials = None
    messaging = None
try:
    from google.oauth2 import id_token  # type: ignore[import-not-found]
    from google.auth.transport import requests as google_requests  # type: ignore[import-not-found]
except ImportError:
    id_token = None
    google_requests = None

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("amar_veggies")

def redact_tail(value: Any, visible: int = 4) -> Optional[str]:
    if value is None:
        return None
    text_value = str(value)
    if not text_value:
        return ""
    if len(text_value) <= visible:
        return "*" * len(text_value)
    return f"{'*' * max(4, len(text_value) - visible)}{text_value[-visible:]}"

def redact_phone(value: Optional[str]) -> Optional[str]:
    digits = re.sub(r"\D", "", value or "")
    if not digits:
        return None
    return redact_tail(digits, visible=4)

def truncate_log_value(value: Any, limit: int = 500) -> str:
    text_value = str(value)
    if len(text_value) <= limit:
        return text_value
    return f"{text_value[:limit]}...<truncated>"

def redact_sensitive_text(value: Any) -> str:
    text_value = str(value)
    text_value = re.sub(
        r"\b(?:whatsapp:\+?)?\d{10,15}\b",
        lambda match: redact_tail(match.group(0), visible=4) or "",
        text_value,
    )
    text_value = re.sub(
        r"\b(?:pay|order|msg|tok)_[A-Za-z0-9_=-]{8,}\b",
        lambda match: redact_tail(match.group(0), visible=4) or "",
        text_value,
    )
    text_value = re.sub(
        r"\b[A-Za-z0-9_-]{32,}\b",
        lambda match: redact_tail(match.group(0), visible=4) or "",
        text_value,
    )
    return text_value

def log_event(level: int, event: str, **fields: Any) -> None:
    payload = {"event": event, **fields}
    logger.log(level, json.dumps(payload, default=str, separators=(",", ":")))

def log_exception_event(event: str, exc: Exception, **fields: Any) -> None:
    log_event(
        logging.ERROR,
        event,
        error_type=type(exc).__name__,
        error=truncate_log_value(redact_sensitive_text(exc)),
        **fields,
    )

# ── Config ────────────────────────────────────────────────────────
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV in {"prod", "production"}
APP_VERSION = os.getenv("APP_VERSION", "local")

def get_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} must be set when APP_ENV=production")
    return value

def get_bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}

def get_csv_env(name: str, default: Optional[List[str]] = None) -> List[str]:
    value = os.getenv(name)
    if value is None:
        return list(default or [])
    return [item.strip() for item in value.split(",") if item.strip()]

SECRET_KEY = (
    get_required_env("SECRET_KEY")
    if IS_PRODUCTION
    else os.getenv("SECRET_KEY", "amar-veggies-local-secret")
)
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24

DATABASE_URL = (
    get_required_env("DATABASE_URL")
    if IS_PRODUCTION
    else os.getenv("DATABASE_URL", "sqlite:///./amar_veggies.db")
)
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace(
        "postgres://",
        "postgresql://",
        1
    )
ADMIN_EMAIL = get_required_env("ADMIN_EMAIL") if IS_PRODUCTION else os.getenv("ADMIN_EMAIL", "")
ADMIN_PASSWORD = get_required_env("ADMIN_PASSWORD") if IS_PRODUCTION else os.getenv("ADMIN_PASSWORD", "")
OTP_EXPIRE_MINUTES = int(os.getenv("OTP_EXPIRE_MINUTES", "10"))
SHOP_LAT = os.getenv("SHOP_LAT", "")
SHOP_LNG = os.getenv("SHOP_LNG", "")
BREVO_API_KEY = os.getenv("BREVO_API_KEY", "")
OTP_EMAIL_FROM = os.getenv("OTP_EMAIL_FROM", "")
OTP_EMAIL_FROM_NAME = os.getenv("OTP_EMAIL_FROM_NAME", "Amar Veggies")
SHOW_DEV_OTP = get_bool_env("SHOW_DEV_OTP", default=not IS_PRODUCTION)
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WHATSAPP_NUMBER = os.getenv("TWILIO_WHATSAPP_NUMBER", "")
ADMIN_WHATSAPP_NUMBER = os.getenv("ADMIN_WHATSAPP_NUMBER", "")
RAZORPAY_KEY_ID = os.getenv("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET", "")
FIREBASE_CREDENTIALS_JSON = os.getenv("FIREBASE_CREDENTIALS_JSON", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
REDIS_URL = os.getenv("REDIS_URL", "")
TRUST_PROXY_HEADERS = get_bool_env("TRUST_PROXY_HEADERS", default=IS_PRODUCTION)
OBJECT_STORAGE_BUCKET = os.getenv("OBJECT_STORAGE_BUCKET", "")
OBJECT_STORAGE_REGION = os.getenv("OBJECT_STORAGE_REGION", "auto")
OBJECT_STORAGE_ENDPOINT_URL = os.getenv("OBJECT_STORAGE_ENDPOINT_URL", "")
OBJECT_STORAGE_ACCESS_KEY_ID = os.getenv("OBJECT_STORAGE_ACCESS_KEY_ID", "")
OBJECT_STORAGE_SECRET_ACCESS_KEY = os.getenv("OBJECT_STORAGE_SECRET_ACCESS_KEY", "")
OBJECT_STORAGE_PUBLIC_BASE_URL = os.getenv("OBJECT_STORAGE_PUBLIC_BASE_URL", "")
PRODUCT_IMAGE_PREFIX = os.getenv("PRODUCT_IMAGE_PREFIX", "products")
DEFAULT_DEV_CORS_ORIGINS = [
    "https://amar.veggies.workers.dev",
    "https://amarveggies.netlify.app",
    "capacitor://localhost",
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5173",
]
CORS_ORIGINS = get_csv_env(
    "CORS_ORIGINS",
    default=[] if IS_PRODUCTION else DEFAULT_DEV_CORS_ORIGINS,
)

if IS_PRODUCTION:
    if SECRET_KEY == "amar-veggies-local-secret":
        raise RuntimeError("SECRET_KEY must not use the local development fallback in production")
    if DATABASE_URL.startswith("sqlite"):
        raise RuntimeError("DATABASE_URL must point to a production database when APP_ENV=production")
    if SHOW_DEV_OTP:
        raise RuntimeError("SHOW_DEV_OTP must be false when APP_ENV=production")
    if not CORS_ORIGINS:
        raise RuntimeError("CORS_ORIGINS must be set when APP_ENV=production")

# ── Database ──────────────────────────────────────────────────────
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    email: Mapped[Optional[str]] = mapped_column(String, unique=True, nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String, unique=True, nullable=True)
    password: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    fcm_token: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_admin: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

class UserFavorite(Base):
    __tablename__ = "user_favorites"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    product_id: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

class DeliveryPartner(Base):
    __tablename__ = "delivery_partners"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    phone: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    password: Mapped[str] = mapped_column(Text, nullable=False)
    active: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

class OTP(Base):
    __tablename__ = "otps"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    otp: Mapped[str] = mapped_column(String, nullable=False)
    purpose: Mapped[str] = mapped_column(String, nullable=False, default="register")
    expires_at: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

class Product(Base):
    __tablename__ = "products"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    emoji: Mapped[str] = mapped_column(String, default="🌿")
    category: Mapped[str] = mapped_column(String, nullable=False)
    price: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str] = mapped_column(String, nullable=False)
    stock: Mapped[float] = mapped_column(Float, nullable=False)
    available: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    featured: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quantity_options: Mapped[str] = mapped_column(Text, nullable=False, default="[100,250,500,1000]")
    purchase_options: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    image_data: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    image_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    image_key: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    total_purchased: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

class Coupon(Base):
    __tablename__ = "coupons"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    code: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    discountType: Mapped[str] = mapped_column(String, nullable=False)
    discountValue: Mapped[float] = mapped_column(Float, nullable=False)
    minOrderAmount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    isActive: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    expiresAt: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

class StockHistory(Base):
    __tablename__ = "stock_history"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    product_id: Mapped[str] = mapped_column(String, nullable=False)
    product_name: Mapped[str] = mapped_column(String, nullable=False)
    change_kg: Mapped[float] = mapped_column(Float, nullable=False)
    stock_after: Mapped[float] = mapped_column(Float, nullable=False)
    reason: Mapped[str] = mapped_column(String, nullable=False)
    order_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

class Order(Base):
    __tablename__ = "orders"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    user_name: Mapped[str] = mapped_column(String, nullable=False)
    user_email: Mapped[str] = mapped_column(String, nullable=False)
    items: Mapped[str] = mapped_column(Text, nullable=False)
    address: Mapped[str] = mapped_column(Text, nullable=False)
    phone: Mapped[str] = mapped_column(String, nullable=False)
    slot: Mapped[str] = mapped_column(String, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="")
    delivery_lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    delivery_lng: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    delivery_live_lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    delivery_live_lng: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    delivery_last_updated: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    delivery_place_id: Mapped[str] = mapped_column(Text, default="")
    delivery_maps_url: Mapped[str] = mapped_column(Text, default="")
    delivery_partner: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    subtotal: Mapped[float] = mapped_column(Float, nullable=False)
    delivery: Mapped[float] = mapped_column(Float, nullable=False)
    total: Mapped[float] = mapped_column(Float, nullable=False)
    payment: Mapped[str] = mapped_column(String, nullable=False, default="Cash on Delivery")
    payment_status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    razorpay_order_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    razorpay_payment_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    timeline: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ── App ───────────────────────────────────────────────────────────
app = FastAPI(title="Amar Veggies API", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    if IS_PRODUCTION:
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains",
        )
    return response

# ── Helpers ───────────────────────────────────────────────────────
class InMemoryRateLimiter:
    def __init__(self):
        self.requests: Dict[str, List[float]] = defaultdict(list)

    def check_rate_limit(self, key: str, limit: int, window: int) -> bool:
        now = time.time()
        self.requests[key] = [t for t in self.requests[key] if now - t < window]
        if len(self.requests[key]) >= limit:
            return False
        self.requests[key].append(now)
        return True

class RedisRateLimiter:
    def __init__(self, url: str):
        if redis is None:
            raise RuntimeError("redis package is not installed")
        self.client = redis.from_url(url, decode_responses=True)

    def check_rate_limit(self, key: str, limit: int, window: int) -> bool:
        redis_key = f"rate-limit:{key}"
        count = int(self.client.incr(redis_key))
        if count == 1:
            self.client.expire(redis_key, window)
        return count <= limit

def create_rate_limiter():
    if REDIS_URL:
        try:
            limiter = RedisRateLimiter(REDIS_URL)
            limiter.client.ping()
            log_event(logging.INFO, "rate_limiter_redis_enabled")
            return limiter
        except Exception as e:
            log_exception_event("rate_limiter_redis_unavailable", e)
            if IS_PRODUCTION:
                raise RuntimeError("Redis rate limiter is required but unavailable in production") from e

    if IS_PRODUCTION:
        log_event(logging.WARNING, "rate_limiter_in_memory_fallback")
    return InMemoryRateLimiter()

rate_limiter = create_rate_limiter()

def get_client_ip(request: Request) -> str:
    if TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip.strip()
    return request.client.host if request.client else "unknown"

def rate_limit(limit: int, window_seconds: int):
    def dependency(request: Request):
        client_ip = get_client_ip(request)
        key = f"{request.url.path}:{client_ip}"
        
        if not rate_limiter.check_rate_limit(key, limit, window_seconds):
            log_event(
                logging.WARNING,
                "rate_limit_exceeded",
                path=request.url.path,
                client_ip=redact_tail(client_ip),
                limit=limit,
                window_seconds=window_seconds,
            )
            raise HTTPException(status_code=429, detail="Too many requests. Please try again later.")
    return dependency

def init_firebase():
    if firebase_admin is None or credentials is None:
        log_event(logging.WARNING, "firebase_admin_missing")
        return

    if firebase_admin._apps:
        return

    if not FIREBASE_CREDENTIALS_JSON:
        log_event(logging.WARNING, "firebase_credentials_missing")
        return

    cred_dict = json.loads(FIREBASE_CREDENTIALS_JSON)
    cred = credentials.Certificate(cred_dict)
    firebase_admin.initialize_app(cred)

if os.getenv("SKIP_EXTERNAL_SERVICES") != "1":
    init_firebase()

def now_iso():
    return datetime.utcnow().isoformat()

def normalize_email(email: Optional[str]):
    if not email:
        return None
    return email.strip().lower()

def normalize_phone(phone: Optional[str]):
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 10:
        return digits
    if len(digits) == 12 and digits.startswith("91"):
        return digits[-10:]
    return digits or None

def normalize_unit(unit: Optional[str]) -> str:
    value = str(unit or "kg").strip().lower()
    aliases = {
        "dz": "dozen",
        "pc": "piece",
        "pcs": "piece",
        "each": "piece",
    }
    return aliases.get(value, value)

def stock_message_unit(unit: Optional[str], amount: float) -> str:
    normalized_unit = normalize_unit(unit)
    if normalized_unit == "kg":
        return "kg"

    singular_plural = {
        "dozen": ("dozen", "dozens"),
        "dozens": ("dozen", "dozens"),
        "piece": ("piece", "pieces"),
        "pieces": ("piece", "pieces"),
        "bunch": ("bunch", "bunches"),
        "bunches": ("bunch", "bunches"),
    }
    singular, plural = singular_plural.get(normalized_unit, (normalized_unit, normalized_unit))
    return singular if float(amount or 0) == 1 else plural

def default_purchase_options(unit: Optional[str], quantity_options: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
    normalized_unit = normalize_unit(unit)
    raw_options = quantity_options if isinstance(quantity_options, list) and quantity_options else None
    values = [
        float(value)
        for value in (raw_options or ([12, 1] if normalized_unit in {"dozen", "dozens"} else [1] if normalized_unit in {"piece", "pieces", "bunch", "bunches"} else [100, 250, 500, 1000]))
        if isinstance(value, (int, float)) and float(value) > 0
    ]

    options: List[Dict[str, Any]] = []
    for value in values:
        display_value: Any = int(value) if value.is_integer() else value
        if normalized_unit in {"dozen", "dozens"}:
            label = "1 dozen" if value == 12 else "1 piece" if value == 1 else f"{display_value} pieces"
            multiplier = value / 12
        elif normalized_unit in {"piece", "pieces"}:
            label = "1 piece" if value == 1 else f"{display_value} pieces"
            multiplier = value
        elif normalized_unit in {"bunch", "bunches"}:
            label = "1 bunch" if value == 1 else f"{display_value} bunches"
            multiplier = value
        else:
            label = "1 kg" if value == 1000 else f"{display_value}g"
            multiplier = value / 1000
        options.append({"value": display_value, "label": label, "multiplier": round(multiplier, 6)})
    return options

def normalize_purchase_options(
    unit: Optional[str],
    purchase_options: Optional[List[Any]] = None,
    quantity_options: Optional[List[Any]] = None,
) -> List[Dict[str, Any]]:
    source_options = purchase_options if isinstance(purchase_options, list) and purchase_options else default_purchase_options(unit, quantity_options)
    normalized: List[Dict[str, Any]] = []
    for option in source_options:
        if not isinstance(option, dict):
            continue
        value = float(option.get("value") or 0)
        multiplier = float(option.get("multiplier") or 0)
        label = str(option.get("label") or "").strip()
        if value <= 0 or multiplier <= 0:
            continue
        normalized.append({
            "value": int(value) if value.is_integer() else value,
            "label": label or str(int(value) if value.is_integer() else value),
            "multiplier": round(multiplier, 6),
        })
    return normalized

def purchase_option_for_value(
    unit: Optional[str],
    selected_value: float,
    purchase_options: Optional[List[Any]] = None,
    quantity_options: Optional[List[Any]] = None,
) -> Optional[Dict[str, Any]]:
    selected_value = float(selected_value or 0)
    for option in normalize_purchase_options(unit, purchase_options, quantity_options):
        if abs(float(option["value"]) - selected_value) < 0.0001:
            return option
    return None

def calculate_order_item_amounts(
    unit: Optional[str],
    selected_value: float,
    quantity: int,
    price: float,
    purchase_options: Optional[List[Any]] = None,
    quantity_options: Optional[List[Any]] = None,
) -> Dict[str, float]:
    selected_value = float(selected_value or 0)
    quantity = int(quantity or 0)
    price = float(price or 0)
    configured_option = purchase_option_for_value(unit, selected_value, purchase_options, quantity_options)

    if configured_option:
        stock_needed = float(configured_option["multiplier"]) * quantity
        return {
            "stock_needed": round(stock_needed, 3),
            "line_total": round(price * stock_needed, 2),
        }

    normalized_unit = normalize_unit(unit)
    if normalized_unit == "kg":
        stock_needed = (selected_value / 1000) * quantity
        line_total = price * stock_needed
    elif normalized_unit in {"dozen", "dozens"}:
        if selected_value == 12:
            stock_needed = quantity
            line_total = price * quantity
        elif selected_value == 1:
            stock_needed = quantity / 12
            line_total = (price / 12) * quantity
        else:
            raise HTTPException(400, "Invalid dozen option")
    elif normalized_unit in {"piece", "pieces"}:
        stock_needed = quantity
        line_total = price * quantity
    elif normalized_unit in {"bunch", "bunches"}:
        stock_needed = quantity
        line_total = price * quantity
    else:
        raise HTTPException(400, f"Unsupported unit: {unit}")

    return {
        "stock_needed": round(stock_needed, 3),
        "line_total": round(line_total, 2),
    }

def make_otp():
    return str(random.randint(100000, 999999))

def build_otp_response(otp: str) -> Dict[str, Any]:
    response: Dict[str, Any] = {
        "ok": True,
        "message": "OTP sent",
        "expires_in_minutes": OTP_EXPIRE_MINUTES,
    }
    if SHOW_DEV_OTP:
        response["dev_otp"] = otp
    return response

def send_push_notification(token: Optional[str], title: str, body: str):
    if not token:
        return False

    if firebase_admin is None or messaging is None:
        log_event(logging.WARNING, "firebase_admin_missing")
        return False

    if not firebase_admin._apps:
        log_event(logging.WARNING, "firebase_not_initialized")
        return False

    try:
        message = messaging.Message(
            notification=messaging.Notification(
                title=title,
                body=body
            ),
            token=token
        )

        response = messaging.send(message)
        log_event(logging.INFO, "push_sent", message_id=redact_tail(response))
        return True

    except Exception as e:
        log_exception_event("push_notification_failed", e)
        return False

def send_email_otp(to_email: str, otp: str, purpose: str = "verification") -> bool:
    if not BREVO_API_KEY or not OTP_EMAIL_FROM:
        log_event(logging.WARNING, "brevo_email_config_missing")
        return False

    subject = f"{otp} is your Amar Veggies OTP"
    html_content = f"""
    <div style="font-family:Arial,sans-serif;padding:20px;line-height:1.5">
        <h2 style="color:#1a3d2b;margin-bottom:8px">Amar Veggies</h2>
        <p>Your OTP for {purpose} is:</p>
        <h1 style="letter-spacing:4px;color:#2d6a4f">{otp}</h1>
        <p>This OTP expires in {OTP_EXPIRE_MINUTES} minutes.</p>
        <p style="color:#666;font-size:13px">If you did not request this OTP, you can ignore this email.</p>
    </div>
    """

    payload = {
        "sender": {"name": OTP_EMAIL_FROM_NAME, "email": OTP_EMAIL_FROM},
        "to": [{"email": to_email}],
        "subject": subject,
        "htmlContent": html_content,
    }
    headers = {
        "accept": "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
    }

    try:
        response = requests.post(
            "https://api.brevo.com/v3/smtp/email",
            json=payload,
            headers=headers,
            timeout=15,
        )
        if response.status_code not in (200, 201, 202):
            log_event(
                logging.WARNING,
                "brevo_email_failed",
                status_code=response.status_code,
                response_body=truncate_log_value(redact_sensitive_text(response.text)),
            )
            return False
        return True
    except Exception as e:
        log_exception_event("email_send_failed", e)
        return False

def send_whatsapp_order_notification(order_data: Dict[str, Any]) -> bool:
    if (
        not TWILIO_ACCOUNT_SID
        or not TWILIO_AUTH_TOKEN
        or not TWILIO_WHATSAPP_NUMBER
        or not ADMIN_WHATSAPP_NUMBER
    ):
        log_event(logging.WARNING, "twilio_whatsapp_config_missing")
        return False

    try:
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

        items_text = ""
        for item in order_data.get("items", []):
            items_text += (
                f"• {item.get('name')} "
                f"({item.get('selected_weight')}g × {item.get('quantity')})\n"
            )

        message_body = f"""
🛒 *NEW ORDER RECEIVED*

👤 Customer: {order_data.get('user_name')}
📞 Phone: {order_data.get('phone')}

📍 Address:
{order_data.get('address')}

🧺 Items:
{items_text}

💰 Total: ₹{order_data.get('total')}

📝 Notes:
{order_data.get('notes') or 'None'}

━━━━━━━━━━━━━━
Amar Veggies
"""

        client.messages.create(
            body=message_body,
            from_=TWILIO_WHATSAPP_NUMBER,
            to=ADMIN_WHATSAPP_NUMBER,
        )

        log_event(logging.INFO, "whatsapp_notification_sent")
        return True

    except Exception as e:
        log_exception_event("whatsapp_send_failed", e)
        return False

def send_whatsapp_customer_status(order, status):
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN or not TWILIO_WHATSAPP_NUMBER:
        log_event(logging.WARNING, "twilio_whatsapp_config_missing")
        return False

    if not order.phone:
        return False

    status_labels = {
        "pending": "placed",
        "confirmed": "confirmed",
        "out_for_delivery": "out for delivery",
        "delivered": "delivered",
        "cancelled": "cancelled",
    }

    status_text = status_labels.get(status, status.replace("_", " "))

    extra_message = ""

    if status == "confirmed":
        extra_message = "\n\n🧺 Your groceries are being prepared."

    elif status == "out_for_delivery":
        partner = order.delivery_partner or "our delivery partner"

        tracking_link = order.delivery_maps_url or ""

        extra_message = f"""

🚚 Your order is on the way with {partner}.

📍 Track location:
    {tracking_link}
    """

    elif status == "delivered":
        extra_message = "\n\n✅ Delivered successfully. Thank you for shopping with Amar Veggies!"

    try:
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

        message = client.messages.create(
            body=f"""🌿 Amar Veggies Update

Your order #{order.id[-8:].upper()} is now {status_text}.{extra_message}

Thank you for ordering!
            """,
            from_=TWILIO_WHATSAPP_NUMBER,
            to=f"whatsapp:+91{normalize_phone(order.phone)}"
        )

        log_event(
            logging.INFO,
            "customer_whatsapp_status_sent",
            message_sid=redact_tail(message.sid),
            message_status=message.status,
            phone=redact_phone(order.phone),
            order_id=redact_tail(order.id),
        )
        return True

    except Exception as e:
        log_exception_event("customer_whatsapp_update_failed", e)
        return False

def log_order_notification_state(order: Order, customer: Optional[User], source: str) -> None:
    log_event(
        logging.INFO,
        "order_notification_state",
        source=source,
        order_id=redact_tail(order.id),
        customer_found=bool(customer),
        phone=redact_phone(order.phone),
        fcm_token_present=bool(customer and customer.fcm_token),
        twilio_account_configured=bool(TWILIO_ACCOUNT_SID),
        twilio_from_configured=bool(TWILIO_WHATSAPP_NUMBER),
        firebase_credentials_configured=bool(FIREBASE_CREDENTIALS_JSON),
    )

def model_to_dict(obj: Any) -> Optional[Dict[str, Any]]:
    if obj is None:
        return None

    table = getattr(obj, "__table__", None)
    if table is None:
        return None

    d: Dict[str, Any] = {c.name: getattr(obj, c.name) for c in table.columns}
    for key in ("items", "timeline", "quantity_options", "purchase_options"):
        value = d.get(key)
        if isinstance(value, str):
            try:
                d[key] = json.loads(value)
            except Exception:
                pass
    if "purchase_options" in d:
        d["purchase_options"] = normalize_purchase_options(
            d.get("unit"),
            d.get("purchase_options") if isinstance(d.get("purchase_options"), list) else None,
            d.get("quantity_options") if isinstance(d.get("quantity_options"), list) else None,
        )

    if "is_admin" in d:
        d["is_admin"] = bool(d["is_admin"])
    if "available" in d:
        d["available"] = bool(d["available"])
    if "featured" in d:
        d["featured"] = bool(d["featured"])
    if "isActive" in d:
        d["isActive"] = bool(d["isActive"])
    return d

def models_to_list(rows: List[Any]) -> List[Dict[str, Any]]:
    return [d for d in (model_to_dict(r) for r in rows) if d is not None]

def normalize_coupon_code(code: str) -> str:
    return re.sub(r"\s+", "", (code or "")).upper()

def parse_optional_iso_datetime(value: Optional[str], field_name: str) -> Optional[str]:
    if value in (None, ""):
        return None
    try:
        datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, f"{field_name} must be a valid ISO date")
    return str(value)

def is_coupon_expired(coupon: Coupon) -> bool:
    if not coupon.expiresAt:
        return False
    try:
        expires_at = datetime.fromisoformat(str(coupon.expiresAt).replace("Z", "+00:00"))
    except ValueError:
        return True
    if expires_at.tzinfo is not None:
        expires_at = expires_at.replace(tzinfo=None)
    return expires_at < datetime.utcnow()

def coupon_discount_for_amount(coupon: Coupon, amount: Optional[float]) -> float:
    if amount is None:
        return 0.0
    base = max(0.0, float(amount or 0))
    if coupon.discountType == "percentage":
        discount = base * float(coupon.discountValue or 0) / 100
    else:
        discount = float(coupon.discountValue or 0)
    return round(min(base, max(0.0, discount)), 2)

def get_valid_coupon_for_amount(db: Session, code: Optional[str], amount: Optional[float] = None) -> Optional[Coupon]:
    normalized = normalize_coupon_code(code or "")
    if not normalized:
        return None
    coupon = db.query(Coupon).filter(Coupon.code == normalized).first()
    if not coupon:
        raise HTTPException(404, "Coupon not found")
    if not coupon.isActive:
        raise HTTPException(400, "Coupon is not active")
    if is_coupon_expired(coupon):
        raise HTTPException(400, "Coupon has expired")
    if amount is not None and coupon.minOrderAmount is not None and float(amount) < float(coupon.minOrderAmount):
        raise HTTPException(400, f"Minimum order amount is ₹{format(float(coupon.minOrderAmount), '.2f')}")
    return coupon

def add_total_purchased(
    db: Session,
    product_dicts: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    return product_dicts

def add_product_total_purchased(
    db: Session,
    product_dict: Optional[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    return product_dict

class ProductImageStorage:
    def __init__(self):
        self.enabled = all([
            OBJECT_STORAGE_BUCKET,
            OBJECT_STORAGE_ACCESS_KEY_ID,
            OBJECT_STORAGE_SECRET_ACCESS_KEY,
            OBJECT_STORAGE_PUBLIC_BASE_URL,
        ])
        self.client: Optional[Any] = None
        if self.enabled:
            if boto3 is None:
                raise RuntimeError("boto3 is required for object storage uploads")
            self.client = boto3.client(
                "s3",
                endpoint_url=OBJECT_STORAGE_ENDPOINT_URL or None,
                region_name=OBJECT_STORAGE_REGION,
                aws_access_key_id=OBJECT_STORAGE_ACCESS_KEY_ID,
                aws_secret_access_key=OBJECT_STORAGE_SECRET_ACCESS_KEY,
            )

    def require_enabled(self):
        if not self.enabled or self.client is None:
            raise HTTPException(
                503,
                "Product image storage is not configured. Set OBJECT_STORAGE_* environment variables."
            )

    def build_key(self, product_id: str, filename: str, content_type: str) -> str:
        extension = ""
        clean_name = re.sub(r"[^A-Za-z0-9_.-]", "-", filename or "")
        if "." in clean_name:
            extension = "." + clean_name.rsplit(".", 1)[-1].lower()
        elif content_type == "image/png":
            extension = ".png"
        elif content_type == "image/webp":
            extension = ".webp"
        else:
            extension = ".jpg"
        return f"{PRODUCT_IMAGE_PREFIX.strip('/')}/{product_id}/{uuid.uuid4()}{extension}"

    def public_url(self, key: str) -> str:
        return f"{OBJECT_STORAGE_PUBLIC_BASE_URL.rstrip('/')}/{key}"

    def upload(self, product_id: str, filename: str, content_type: str, data: bytes) -> Dict[str, str]:
        self.require_enabled()
        client = self.client
        if client is None:
            raise HTTPException(503, "Product image storage client is not available")
        key = self.build_key(product_id, filename, content_type)
        client.put_object(
            Bucket=OBJECT_STORAGE_BUCKET,
            Key=key,
            Body=data,
            ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable",
        )
        return {"image_key": key, "image_url": self.public_url(key)}

    def delete(self, key: Optional[str]) -> None:
        if not key:
            return
        self.require_enabled()
        client = self.client
        if client is None:
            raise HTTPException(503, "Product image storage client is not available")
        client.delete_object(Bucket=OBJECT_STORAGE_BUCKET, Key=key)

product_image_storage = ProductImageStorage()

def record_stock_history(
    db: Session,
    product: Product,
    change_kg: float,
    reason: str,
    order_id: Optional[str] = None,
):
    db.add(StockHistory(
        id=str(uuid.uuid4()),
        product_id=product.id,
        product_name=product.name,
        change_kg=round(float(change_kg), 3),
        stock_after=round(float(product.stock or 0), 3),
        reason=reason,
        order_id=order_id,
        created_at=now_iso(),
    ))

def public_user(user: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    user = user or {}
    data: Dict[str, Any] = {
        "id": user.get("id"),
        "name": user.get("name") or "",
        "email": user.get("email") or "",
        "phone": user.get("phone") or "",
        "is_admin": bool(user.get("is_admin")),
    }
    email = str(data.get("email") or "")
    if email.startswith("phone_") and email.endswith("@mobile.local"):
        data["email"] = ""
    return data

def make_maps_url(lat: Optional[float], lng: Optional[float], address: Optional[str] = None):
    if lat is not None and lng is not None:
        return f"https://www.google.com/maps/search/?api=1&query={lat},{lng}"
    if address:
        from urllib.parse import quote_plus
        return f"https://www.google.com/maps/search/?api=1&query={quote_plus(address)}"
    return ""

def make_directions_url(lat: Optional[float], lng: Optional[float], address: Optional[str] = None):
    destination = f"{lat},{lng}" if lat is not None and lng is not None else (address or "")
    if not destination:
        return ""
    from urllib.parse import quote_plus
    origin = ""
    if SHOP_LAT and SHOP_LNG:
        origin = f"&origin={quote_plus(SHOP_LAT + ',' + SHOP_LNG)}"
    return f"https://www.google.com/maps/dir/?api=1{origin}&destination={quote_plus(destination)}&travelmode=driving"

def split_identifier(identifier: Optional[str] = None, email: Optional[str] = None, phone: Optional[str] = None):
    value = (identifier or "").strip()
    if value and "@" in value:
        email = value
    elif value:
        phone = value
    email = normalize_email(email)
    phone = normalize_phone(phone)
    return email, phone

def get_user_by_email_or_phone(db: Session, email: Optional[str], phone: Optional[str]):
    if email:
        return db.query(User).filter(User.email == email).first()
    if phone:
        return db.query(User).filter(User.phone == phone).first()
    return None

# ── Security ──────────────────────────────────────────────────────
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)
razorpay_client: Optional[Any] = None
if RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET:
    razorpay_client = razorpay.Client(auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET))

def hash_password(p):
    return pwd_ctx.hash(p)

def verify_password(p, h):
    return pwd_ctx.verify(p, h)

def create_token(data: dict):
    exp = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({**data, "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str):
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None

def get_user_by_id(db: Session, user_id: str) -> Optional[Dict[str, Any]]:
    user = db.query(User).filter(User.id == user_id).first()
    return model_to_dict(user)

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(bearer), db: Session = Depends(get_db)) -> Dict[str, Any]:
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(creds.credentials)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user_id = payload.get("sub")
    if not isinstance(user_id, str):
        raise HTTPException(status_code=401, detail="Invalid token")
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

def get_current_delivery_partner(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db)
):
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = decode_token(creds.credentials)

    if not payload or payload.get("role") != "delivery":
        raise HTTPException(status_code=401, detail="Invalid delivery token")

    partner_id = payload.get("sub")

    partner = db.query(DeliveryPartner).filter(
        DeliveryPartner.id == partner_id,
        DeliveryPartner.active == 1
    ).first()

    if not partner:
        raise HTTPException(status_code=401, detail="Delivery partner not found")

    return partner


def require_admin(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

# ── Schemas ───────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    name: str
    email: str
    password: str

class LoginIn(BaseModel):
    identifier: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    password: str

class GoogleLoginIn(BaseModel):
    credential: str

class SendOtpIn(BaseModel):
    name: Optional[str] = ""
    email: Optional[str] = None
    phone: Optional[str] = None

class VerifyOtpRegisterIn(BaseModel):
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    otp: str
    password: str

class SendLoginOtpIn(BaseModel):
    email: Optional[str] = None
    phone: Optional[str] = None

class VerifyOtpLoginIn(BaseModel):
    email: Optional[str] = None
    phone: Optional[str] = None
    otp: str

class ForgotPasswordSendIn(BaseModel):
    identifier: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None

class ForgotPasswordResetIn(BaseModel):
    identifier: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    otp: str
    password: str

class FcmTokenIn(BaseModel):
    token: str

class ProductIn(BaseModel):
    name: str
    description: Optional[str] = ""
    emoji: Optional[str] = "🌿"
    category: str
    price: float
    unit: str
    stock: float
    available: Optional[bool] = True
    featured: Optional[bool] = False
    quantity_options: Optional[List[int]] = [100, 250, 500, 1000]
    purchase_options: Optional[List[Dict[str, Any]]] = None

class CouponIn(BaseModel):
    code: str
    discountType: str
    discountValue: float
    minOrderAmount: Optional[float] = None
    isActive: Optional[bool] = True
    expiresAt: Optional[str] = None

class CouponApplyIn(BaseModel):
    code: str
    orderAmount: Optional[float] = None

class RestockIn(BaseModel):
    amount: float
    reason: Optional[str] = "Manual restock"

class CartItemIn(BaseModel):
    product_id: str
    quantity: int
    selected_weight: int

class OrderIn(BaseModel):
    items: List[CartItemIn]
    address: str
    phone: str
    slot: Optional[str] = ""
    notes: Optional[str] = ""
    delivery_lat: Optional[float] = None
    delivery_lng: Optional[float] = None
    delivery_place_id: Optional[str] = ""
    coupon_code: Optional[str] = None

class CreatePaymentOrderIn(OrderIn):
    pass

class VerifyPaymentIn(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str
    order_id: str

class OrderStatusIn(BaseModel):
    status: str

class AssignDeliveryIn(BaseModel):
    delivery_partner: str

class DeliveryLocationIn(BaseModel):
    order_id: str
    lat: float
    lng: float

class DeliveryLoginIn(BaseModel):
    phone: str
    password: str

# ── Seed Admin ────────────────────────────────────────────────────
def seed_admin():
    if not ADMIN_EMAIL or not ADMIN_PASSWORD:
        log_event(logging.WARNING, "seed_admin_missing_env")
        return
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == normalize_email(ADMIN_EMAIL)).first()
        if not existing:
            db.add(User(
                id=str(uuid.uuid4()),
                name="Admin",
                email=normalize_email(ADMIN_EMAIL),
                phone=None,
                password=hash_password(ADMIN_PASSWORD),
                is_admin=1,
                created_at=now_iso(),
            ))
            log_event(logging.INFO, "seed_admin_created")
        else:
            existing.password = hash_password(ADMIN_PASSWORD)
            existing.is_admin = 1
            log_event(logging.INFO, "seed_admin_updated")
        db.commit()
    finally:
        db.close()

def seed_delivery_partners():
    db = SessionLocal()
    try:
        partners = [
            ("Nikhil", "9999999991", "nikhil123"),
            ("Dhirendra", "9999999992", "dhirendra123"),
            ("Amar", "9999999993", "amar123"),
        ]

        for name, phone, password in partners:
            existing = db.query(DeliveryPartner).filter(DeliveryPartner.phone == phone).first()
            if not existing:
                db.add(DeliveryPartner(
                    id=str(uuid.uuid4()),
                    name=name,
                    phone=phone,
                    password=hash_password(password),
                    active=1,
                    created_at=now_iso(),
                ))
            else:
                existing.name = name
                existing.password = hash_password(password)
                existing.active = 1

        db.commit()
        log_event(logging.INFO, "delivery_partners_seeded", count=len(partners))
    finally:
        db.close()

# ── Delivery Partner Auth ───────────────────────────────────────
@app.post("/api/delivery/login", dependencies=[Depends(rate_limit(limit=5, window_seconds=60))])
def delivery_login(body: DeliveryLoginIn, db: Session = Depends(get_db)):
    phone = normalize_phone(body.phone)
    if not phone:
        raise HTTPException(400, "Enter a valid mobile number")

    partner = db.query(DeliveryPartner).filter(DeliveryPartner.phone == phone).first()

    if not partner or not verify_password(body.password, partner.password) or not partner.active:
        raise HTTPException(401, "Invalid phone or password")

    token = create_token({"sub": partner.id, "role": "delivery"})

    return {
        "token": token,
        "partner": {
            "id": partner.id,
            "name": partner.name,
            "phone": partner.phone,
        }
    }

@app.get("/api/delivery/orders")
def delivery_orders(
    partner: DeliveryPartner = Depends(get_current_delivery_partner),
    db: Session = Depends(get_db)
):
    rows = (
        db.query(Order)
        .filter(Order.delivery_partner == partner.name)
        .filter(Order.status.notin_(["delivered", "cancelled"]))
        .order_by(Order.created_at.desc())
        .all()
    )
    return models_to_list(rows)

@app.post("/api/delivery/location")
def update_delivery_location(
    body: DeliveryLocationIn,
    partner: DeliveryPartner = Depends(get_current_delivery_partner),
    db: Session = Depends(get_db)
):
    order = db.query(Order).filter(Order.id == body.order_id).first()

    if not order:
        raise HTTPException(404, "Order not found")

    if order.delivery_partner != partner.name:
        raise HTTPException(403, "This order is not assigned to you")

    if order.status not in ["out_for_delivery", "confirmed"]:
        raise HTTPException(400, "Live tracking is only available for active deliveries")

    order.delivery_live_lat = body.lat
    order.delivery_live_lng = body.lng
    order.delivery_last_updated = now_iso()

    db.commit()

    return {
        "ok": True,
        "lat": body.lat,
        "lng": body.lng,
        "updated_at": order.delivery_last_updated
    }

@app.put("/api/delivery/orders/{oid}/status")
def delivery_update_order_status(
    oid: str,
    body: OrderStatusIn,
    partner: DeliveryPartner = Depends(get_current_delivery_partner),
    db: Session = Depends(get_db)
):
    log_event(
        logging.INFO,
        "delivery_order_status_update_requested",
        order_id=redact_tail(oid),
        status=body.status,
        partner_id=redact_tail(partner.id),
    )

    allowed_statuses = ["out_for_delivery", "delivered"]
    if body.status not in allowed_statuses:
        raise HTTPException(403, "Delivery partners can only mark orders picked up or delivered")

    order = db.query(Order).filter(Order.id == oid).first()
    if not order:
        raise HTTPException(404, "Order not found")

    if order.delivery_partner != partner.name:
        raise HTTPException(403, "This order is not assigned to you")

    if order.status in ["cancelled", "delivered"]:
        raise HTTPException(400, "This order can no longer be updated")

    if body.status == "out_for_delivery" and order.status not in ["confirmed", "packed"]:
        raise HTTPException(400, "Order must be confirmed before pickup")

    if body.status == "delivered" and order.status != "out_for_delivery":
        raise HTTPException(400, "Order must be out for delivery before marking delivered")

    order_dict = model_to_dict(order) or {}
    timeline = order_dict.get("timeline", [])
    if not isinstance(timeline, list):
        timeline = []
    timeline.append({"status": body.status, "at": now_iso()})

    order.status = body.status
    order.timeline = json.dumps(timeline)
    db.commit()
    db.refresh(order)

    customer = db.query(User).filter(User.id == order.user_id).first()
    log_order_notification_state(order, customer, "delivery_status_update")

    status_text = body.status.replace("_", " ").title()

    log_event(logging.INFO, "push_notification_attempt", order_id=redact_tail(order.id), status=body.status)

    if customer:
        send_push_notification(
            customer.fcm_token,
            "Amar Veggies Order Update",
            f"Your order #{order.id[-8:].upper()} is now {status_text}"
        )

    try:
        send_whatsapp_customer_status(order, body.status)
    except Exception as e:
        log_exception_event("customer_whatsapp_status_error", e)

    return model_to_dict(order)

# ── Auth ──────────────────────────────────────────────────────────
@app.post("/api/auth/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    email = normalize_email(body.email)
    if not email:
        raise HTTPException(400, "Email is required")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(400, "Email already registered")
    user = User(
        id=str(uuid.uuid4()),
        name=body.name.strip(),
        email=email,
        phone=None,
        password=hash_password(body.password),
        is_admin=0,
        created_at=now_iso(),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "Email already registered")
    token = create_token({"sub": user.id})
    return {"token": token, "user": public_user(model_to_dict(user))}

@app.post("/api/auth/send-otp", dependencies=[Depends(rate_limit(limit=3, window_seconds=180))])
def send_otp(body: SendOtpIn, db: Session = Depends(get_db)):
    email = normalize_email(body.email)
    phone = normalize_phone(body.phone)
    if not email and not phone:
        raise HTTPException(400, "Enter an email or mobile number")
    if phone and len(phone) != 10:
        raise HTTPException(400, "Enter a valid 10-digit mobile number")
    if email and db.query(User).filter(User.email == email).first():
        raise HTTPException(400, "Email already registered")
    if phone and db.query(User).filter(User.phone == phone).first():
        raise HTTPException(400, "Mobile number already registered")
    if email:
        db.query(OTP).filter(OTP.email == email, OTP.purpose == "register").delete()
    if phone:
        db.query(OTP).filter(OTP.phone == phone, OTP.purpose == "register").delete()
    otp = make_otp()
    if email:
        sent = send_email_otp(email, otp, "registration")
        if not sent and not SHOW_DEV_OTP:
            raise HTTPException(500, "Could not send OTP email. Please try again later")
    db.add(OTP(
        id=str(uuid.uuid4()),
        email=email,
        phone=phone,
        otp=otp,
        purpose="register",
        expires_at=(datetime.utcnow() + timedelta(minutes=OTP_EXPIRE_MINUTES)).isoformat(),
        created_at=now_iso(),
    ))
    db.commit()
    return build_otp_response(otp)

@app.post("/api/auth/verify-otp-register")
def verify_otp_register(body: VerifyOtpRegisterIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    email = normalize_email(body.email)
    phone = normalize_phone(body.phone)
    otp = body.otp.strip()
    password = body.password.strip()
    if not name:
        raise HTTPException(400, "Full name is required")
    if not email and not phone:
        raise HTTPException(400, "Enter an email or mobile number")
    if phone and len(phone) != 10:
        raise HTTPException(400, "Enter a valid 10-digit mobile number")
    if len(password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    if email and db.query(User).filter(User.email == email).first():
        raise HTTPException(400, "Email already registered")
    if phone and db.query(User).filter(User.phone == phone).first():
        raise HTTPException(400, "Mobile number already registered")

    q = db.query(OTP).filter(OTP.purpose == "register")
    q = q.filter(OTP.email == email) if email else q.filter(OTP.phone == phone)
    otp_row = q.order_by(OTP.created_at.desc()).first()
    if not otp_row:
        raise HTTPException(400, "OTP not found. Please request a new OTP")
    if datetime.fromisoformat(otp_row.expires_at) < datetime.utcnow():
        db.delete(otp_row)
        db.commit()
        raise HTTPException(400, "OTP expired. Please request a new OTP")
    if otp_row.otp != otp:
        raise HTTPException(400, "Invalid OTP")

    stored_email = email or f"phone_{phone}@mobile.local"
    user = User(
        id=str(uuid.uuid4()),
        name=name,
        email=stored_email,
        phone=phone,
        password=hash_password(password),
        is_admin=0,
        created_at=now_iso(),
    )
    db.add(user)
    db.delete(otp_row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "Account already registered")
    token = create_token({"sub": user.id})
    return {"token": token, "user": public_user(model_to_dict(user))}

@app.post("/api/auth/send-login-otp", dependencies=[Depends(rate_limit(limit=3, window_seconds=180))])
def send_login_otp(body: SendLoginOtpIn, db: Session = Depends(get_db)):
    email = normalize_email(body.email)
    phone = normalize_phone(body.phone)
    if not email and not phone:
        raise HTTPException(400, "Enter an email or mobile number")
    if phone and len(phone) != 10:
        raise HTTPException(400, "Enter a valid 10-digit mobile number")
    user_exists = get_user_by_email_or_phone(db, email, phone)
    if not user_exists:
        raise HTTPException(404, "Account not found. Please register first")
    if email:
        db.query(OTP).filter(OTP.email == email, OTP.purpose == "login").delete()
    if phone:
        db.query(OTP).filter(OTP.phone == phone, OTP.purpose == "login").delete()
    otp = make_otp()
    if email:
        sent = send_email_otp(email, otp, "login")
        if not sent and not SHOW_DEV_OTP:
            raise HTTPException(500, "Could not send OTP email. Please try again later")
    db.add(OTP(
        id=str(uuid.uuid4()),
        email=email,
        phone=phone,
        otp=otp,
        purpose="login",
        expires_at=(datetime.utcnow() + timedelta(minutes=OTP_EXPIRE_MINUTES)).isoformat(),
        created_at=now_iso(),
    ))
    db.commit()
    return build_otp_response(otp)

@app.post("/api/auth/verify-otp-login")
def verify_otp_login(body: VerifyOtpLoginIn, db: Session = Depends(get_db)):
    email = normalize_email(body.email)
    phone = normalize_phone(body.phone)
    otp = body.otp.strip()
    if not email and not phone:
        raise HTTPException(400, "Enter an email or mobile number")
    if phone and len(phone) != 10:
        raise HTTPException(400, "Enter a valid 10-digit mobile number")
    user = get_user_by_email_or_phone(db, email, phone)
    q = db.query(OTP).filter(OTP.purpose == "login")
    q = q.filter(OTP.email == email) if email else q.filter(OTP.phone == phone)
    otp_row = q.order_by(OTP.created_at.desc()).first()
    if not user:
        raise HTTPException(404, "Account not found. Please register first")
    if not otp_row:
        raise HTTPException(400, "OTP not found. Please request a new OTP")
    if datetime.fromisoformat(otp_row.expires_at) < datetime.utcnow():
        db.delete(otp_row)
        db.commit()
        raise HTTPException(400, "OTP expired. Please request a new OTP")
    if otp_row.otp != otp:
        raise HTTPException(400, "Invalid OTP")
    db.delete(otp_row)
    db.commit()
    token = create_token({"sub": user.id})
    return {"token": token, "user": public_user(model_to_dict(user))}

@app.post("/api/auth/login", dependencies=[Depends(rate_limit(limit=5, window_seconds=60))])
def login(body: LoginIn, db: Session = Depends(get_db)):
    identifier = (body.identifier or body.email or body.phone or "").strip()
    if not identifier:
        raise HTTPException(400, "Enter your email or mobile number")
    email = normalize_email(identifier) if "@" in identifier else None
    phone = normalize_phone(identifier) if "@" not in identifier else None
    user = get_user_by_email_or_phone(db, email, phone)
    user_dict = model_to_dict(user)
    if not user_dict or not user_dict.get("password") or not verify_password(body.password, str(user_dict["password"])):
        raise HTTPException(401, "Invalid email/mobile number or password")
    token = create_token({"sub": str(user_dict["id"])})
    return {"token": token, "user": public_user(user_dict)}

@app.post("/api/auth/google")
def google_login(body: GoogleLoginIn, db: Session = Depends(get_db)):
    if not GOOGLE_CLIENT_ID or id_token is None or google_requests is None:
        raise HTTPException(500, "Google login is not configured")

    try:
        info = id_token.verify_oauth2_token(
            body.credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID
        )
    except Exception:
        raise HTTPException(401, "Invalid Google token")

    email = normalize_email(info.get("email"))
    google_sub = info.get("sub")
    name = info.get("name") or (email.split("@")[0] if email else "Customer")

    if not email or not google_sub:
        raise HTTPException(401, "Google account did not provide a valid email")

    user = db.query(User).filter(User.email == email).first()

    if not user:
        user = User(
            id=str(uuid.uuid4()),
            name=name,
            email=email,
            phone=None,
            password=None,
            is_admin=0,
            created_at=now_iso(),
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    token = create_token({"sub": user.id})
    return {"token": token, "user": public_user(model_to_dict(user))}

@app.post("/api/auth/forgot-password/send-otp", dependencies=[Depends(rate_limit(limit=3, window_seconds=180))])
def forgot_password_send_otp(body: ForgotPasswordSendIn, db: Session = Depends(get_db)):
    email, phone = split_identifier(body.identifier, body.email, body.phone)
    if not email and not phone:
        raise HTTPException(400, "Enter your email or mobile number")
    if phone and len(phone) != 10:
        raise HTTPException(400, "Enter a valid 10-digit mobile number")
    user = get_user_by_email_or_phone(db, email, phone)
    if not user:
        raise HTTPException(404, "Account not found")
    if email:
        db.query(OTP).filter(OTP.email == email, OTP.purpose == "reset_password").delete()
    if phone:
        db.query(OTP).filter(OTP.phone == phone, OTP.purpose == "reset_password").delete()
    otp = make_otp()
    if email:
        sent = send_email_otp(email, otp, "password reset")
        if not sent and not SHOW_DEV_OTP:
            raise HTTPException(500, "Could not send OTP email. Please try again later")
    db.add(OTP(
        id=str(uuid.uuid4()),
        email=email,
        phone=phone,
        otp=otp,
        purpose="reset_password",
        expires_at=(datetime.utcnow() + timedelta(minutes=OTP_EXPIRE_MINUTES)).isoformat(),
        created_at=now_iso(),
    ))
    db.commit()
    return build_otp_response(otp)

@app.post("/api/auth/forgot-password/reset")
def forgot_password_reset(body: ForgotPasswordResetIn, db: Session = Depends(get_db)):
    email, phone = split_identifier(body.identifier, body.email, body.phone)
    otp = body.otp.strip()
    password = body.password.strip()
    if not email and not phone:
        raise HTTPException(400, "Enter your email or mobile number")
    if phone and len(phone) != 10:
        raise HTTPException(400, "Enter a valid 10-digit mobile number")
    if len(password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    user = get_user_by_email_or_phone(db, email, phone)
    if not user:
        raise HTTPException(404, "Account not found")
    q = db.query(OTP).filter(OTP.purpose == "reset_password")
    q = q.filter(OTP.email == email) if email else q.filter(OTP.phone == phone)
    otp_row = q.order_by(OTP.created_at.desc()).first()
    if not otp_row:
        raise HTTPException(400, "OTP not found. Please request a new OTP")
    if datetime.fromisoformat(otp_row.expires_at) < datetime.utcnow():
        db.delete(otp_row)
        db.commit()
        raise HTTPException(400, "OTP expired. Please request a new OTP")
    if otp_row.otp != otp:
        raise HTTPException(400, "Invalid OTP")
    user.password = hash_password(password)
    db.delete(otp_row)
    db.commit()
    return {"ok": True, "message": "Password reset successful"}

@app.get("/api/auth/me")
def me(user: Dict[str, Any] = Depends(get_current_user)):
    return public_user(user)

@app.post("/api/notifications/token")
def save_fcm_token(
    body: FcmTokenIn,
    user: Dict[str, Any] = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    u = db.query(User).filter(User.id == user["id"]).first()

    if not u:
        raise HTTPException(404, "User not found")

    u.fcm_token = body.token
    db.commit()

    return {"ok": True}

# Coupons
@app.post("/api/coupons", dependencies=[Depends(require_admin)])
def create_coupon(body: CouponIn, db: Session = Depends(get_db)):
    code = normalize_coupon_code(body.code)
    if not code:
        raise HTTPException(400, "Coupon code is required")
    if body.discountType not in ("percentage", "flat"):
        raise HTTPException(400, "discountType must be percentage or flat")
    if body.discountValue <= 0:
        raise HTTPException(400, "discountValue must be greater than 0")
    if body.discountType == "percentage" and body.discountValue > 100:
        raise HTTPException(400, "Percentage discount cannot exceed 100")
    if body.minOrderAmount is not None and body.minOrderAmount < 0:
        raise HTTPException(400, "minOrderAmount cannot be negative")

    coupon = Coupon(
        id=str(uuid.uuid4()),
        code=code,
        discountType=body.discountType,
        discountValue=float(body.discountValue),
        minOrderAmount=float(body.minOrderAmount) if body.minOrderAmount is not None else None,
        isActive=1 if body.isActive else 0,
        expiresAt=parse_optional_iso_datetime(body.expiresAt, "expiresAt"),
        created_at=now_iso(),
    )
    db.add(coupon)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "Coupon code already exists")
    db.refresh(coupon)
    return model_to_dict(coupon)

@app.get("/api/coupons", dependencies=[Depends(require_admin)])
def list_coupons(db: Session = Depends(get_db)):
    rows = db.query(Coupon).order_by(Coupon.created_at.desc()).all()
    return models_to_list(rows)

@app.put("/api/coupons/{coupon_id}", dependencies=[Depends(require_admin)])
def update_coupon(coupon_id: str, body: CouponIn, db: Session = Depends(get_db)):
    coupon = db.query(Coupon).filter(Coupon.id == coupon_id).first()
    if not coupon:
        raise HTTPException(404, "Coupon not found")

    code = normalize_coupon_code(body.code)
    if not code:
        raise HTTPException(400, "Coupon code is required")
    if body.discountType not in ("percentage", "flat"):
        raise HTTPException(400, "discountType must be percentage or flat")
    if body.discountValue <= 0:
        raise HTTPException(400, "discountValue must be greater than 0")
    if body.discountType == "percentage" and body.discountValue > 100:
        raise HTTPException(400, "Percentage discount cannot exceed 100")
    if body.minOrderAmount is not None and body.minOrderAmount < 0:
        raise HTTPException(400, "minOrderAmount cannot be negative")

    duplicate = db.query(Coupon).filter(Coupon.code == code, Coupon.id != coupon_id).first()
    if duplicate:
        raise HTTPException(400, "Coupon code already exists")

    coupon.code = code
    coupon.discountType = body.discountType
    coupon.discountValue = float(body.discountValue)
    coupon.minOrderAmount = float(body.minOrderAmount) if body.minOrderAmount is not None else None
    coupon.isActive = 1 if body.isActive else 0
    coupon.expiresAt = parse_optional_iso_datetime(body.expiresAt, "expiresAt")

    db.commit()
    db.refresh(coupon)
    return model_to_dict(coupon)

@app.delete("/api/coupons/{coupon_id}", dependencies=[Depends(require_admin)])
def delete_coupon(coupon_id: str, db: Session = Depends(get_db)):
    coupon = db.query(Coupon).filter(Coupon.id == coupon_id).first()
    if not coupon:
        raise HTTPException(404, "Coupon not found")
    db.delete(coupon)
    db.commit()
    return {"ok": True}

@app.get("/api/coupons/code/{code}")
def get_coupon_by_code(code: str, db: Session = Depends(get_db)):
    normalized = normalize_coupon_code(code)
    if not normalized:
        raise HTTPException(400, "Coupon code is required")

    coupon = db.query(Coupon).filter(Coupon.code == normalized).first()
    if not coupon:
        raise HTTPException(404, "Coupon not found")
    if not coupon.isActive:
        raise HTTPException(400, "Coupon is not active")
    if is_coupon_expired(coupon):
        raise HTTPException(400, "Coupon has expired")

    data = model_to_dict(coupon) or {}
    data["discountAmount"] = 0
    return data

@app.post("/api/coupons/apply")
def apply_coupon(body: CouponApplyIn, db: Session = Depends(get_db)):
    code = normalize_coupon_code(body.code)
    if not code:
        raise HTTPException(400, "Coupon code is required")

    coupon = get_valid_coupon_for_amount(db, code, body.orderAmount)

    data = model_to_dict(coupon) or {}
    data["discountAmount"] = coupon_discount_for_amount(coupon, body.orderAmount)
    return data

# ── Products ──────────────────────────────────────────────────────
@app.get("/api/products")
def list_products(category: Optional[str] = None, search: Optional[str] = None, featured: Optional[bool] = None, db: Session = Depends(get_db)):
    q = db.query(Product)
    if category and category != "All":
        q = q.filter(Product.category == category)
    if search:
        q = q.filter(Product.name.ilike(f"%{search}%"))
    if featured is not None:
        q = q.filter(Product.featured == (1 if featured else 0))
    products = models_to_list(q.order_by(Product.created_at.desc()).all())
    return products

@app.get("/api/products/{pid}")
def get_product(pid: str, db: Session = Depends(get_db)):
    p = db.query(Product).filter(Product.id == pid).first()
    if not p:
        raise HTTPException(404, "Product not found")
    return model_to_dict(p)

@app.post("/api/products", dependencies=[Depends(require_admin)])
def create_product(body: ProductIn, db: Session = Depends(get_db)):
    p = body.dict()
    quantity_options = p.get("quantity_options") or [100, 250, 500, 1000]
    purchase_options = normalize_purchase_options(p["unit"], p.get("purchase_options"), quantity_options)
    product = Product(
        id=str(uuid.uuid4()),
        name=p["name"],
        description=p.get("description", ""),
        emoji=p.get("emoji", "🌿"),
        category=p["category"],
        price=p["price"],
        unit=p["unit"],
        stock=float(p["stock"]),
        available=1 if p.get("available") else 0,
        featured=1 if p.get("featured") else 0,
        quantity_options=json.dumps(quantity_options),
        purchase_options=json.dumps(purchase_options),
        image_data=None,
        image_url=None,
        image_key=None,
        total_purchased=0,
        created_at=now_iso(),
    )
    db.add(product)
    db.commit()
    db.refresh(product)
    return model_to_dict(product)

@app.put("/api/products/{pid}", dependencies=[Depends(require_admin)])
def update_product(pid: str, body: ProductIn, db: Session = Depends(get_db)):
    product = db.query(Product).filter(Product.id == pid).first()
    if not product:
        raise HTTPException(404, "Product not found")
    p = body.dict()
    quantity_options = p.get("quantity_options") or [100, 250, 500, 1000]
    purchase_options = normalize_purchase_options(p["unit"], p.get("purchase_options"), quantity_options)
    product.name = p["name"]
    product.description = p.get("description", "")
    product.emoji = p.get("emoji", "🌿")
    product.category = p["category"]
    product.price = p["price"]
    product.unit = p["unit"]
    product.stock = float(p["stock"])
    product.available = 1 if p.get("available") else 0
    product.featured = 1 if p.get("featured") else 0
    product.quantity_options = json.dumps(quantity_options)
    product.purchase_options = json.dumps(purchase_options)
    db.commit()
    db.refresh(product)
    return model_to_dict(product)

@app.delete("/api/products/{pid}", dependencies=[Depends(require_admin)])
def delete_product(pid: str, db: Session = Depends(get_db)):
    product = db.query(Product).filter(Product.id == pid).first()
    if not product:
        raise HTTPException(404, "Product not found")
    db.delete(product)
    db.commit()
    return {"ok": True}

@app.post("/api/products/{pid}/restock", dependencies=[Depends(require_admin)])
def restock_product(pid: str, body: RestockIn, db: Session = Depends(get_db)):
    if body.amount <= 0:
        raise HTTPException(400, "Restock amount must be greater than 0")

    product = db.query(Product).filter(Product.id == pid).first()
    if not product:
        raise HTTPException(404, "Product not found")

    product.stock = round(float(product.stock or 0) + float(body.amount), 3)
    if product.stock > 0:
        product.available = 1

    record_stock_history(db, product, body.amount, body.reason or "Manual restock")

    db.commit()
    db.refresh(product)
    return model_to_dict(product)

@app.get("/api/admin/low-stock", dependencies=[Depends(require_admin)])
def low_stock_products(limit: float = 2, db: Session = Depends(get_db)):
    rows = (
        db.query(Product)
        .filter(Product.stock <= limit)
        .order_by(Product.stock.asc(), Product.name.asc())
        .all()
    )
    return models_to_list(rows)

@app.get("/api/admin/stock-history", dependencies=[Depends(require_admin)])
def stock_history(limit: int = 50, db: Session = Depends(get_db)):
    rows = (
        db.query(StockHistory)
        .order_by(StockHistory.created_at.desc())
        .limit(min(max(limit, 1), 200))
        .all()
    )
    return models_to_list(rows)

@app.post("/api/create-payment-order")
def create_payment_order(
    body: CreatePaymentOrderIn,
    user: Dict[str, Any] = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if razorpay_client is None:
        raise HTTPException(503, "Razorpay credentials are not configured")

    order = create_order_record(
        body=body,
        user=user,
        db=db,
        payment="Online",
        payment_status="payment_pending",
        notify_admin=False,
    )
    amount_paise = int(round(float(order.total) * 100))

    try:
        payment_order = razorpay_client.order.create({
            "amount": amount_paise,
            "currency": "INR",
            "payment_capture": 1,
            "receipt": order.id,
            "notes": {
                "order_id": order.id,
                "user_id": user["id"],
            }
        })
    except Exception as e:
        cancel_pending_payment_order(order, db, "Payment initialization failed")
        log_exception_event("razorpay_order_creation_failed", e, order_id=redact_tail(order.id))
        raise HTTPException(502, "Payment initialization failed. Please try again.")
    order.razorpay_order_id = payment_order["id"]
    db.commit()
    db.refresh(order)

    return {
        "id": payment_order["id"],
        "amount": payment_order["amount"],
        "currency": payment_order["currency"],
        "key": RAZORPAY_KEY_ID,
        "order": model_to_dict(order),
    }

@app.post("/api/verify-payment")
def verify_payment(
    body: VerifyPaymentIn,
    user: Dict[str, Any] = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not RAZORPAY_KEY_SECRET:
        raise HTTPException(503, "Razorpay credentials are not configured")

    generated_signature = hmac.new(
        bytes(RAZORPAY_KEY_SECRET, "utf-8"),
        bytes(
            f"{body.razorpay_order_id}|{body.razorpay_payment_id}",
            "utf-8"
        ),
        hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(generated_signature, body.razorpay_signature):
        raise HTTPException(400, "Payment verification failed")

    order = db.query(Order).filter(
        Order.id == body.order_id,
        Order.user_id == user["id"],
    ).first()

    if not order:
        raise HTTPException(404, "Order not found")
    if order.razorpay_order_id != body.razorpay_order_id:
        raise HTTPException(400, "Payment order does not match this order")
    if order.payment_status not in ("payment_pending", "paid"):
        raise HTTPException(400, "This order is not awaiting online payment")
    if order.payment_status == "paid":
        return {
            "ok": True,
            "message": "Payment already verified",
            "order": model_to_dict(order),
        }

    order.payment_status = "paid"
    order.razorpay_payment_id = body.razorpay_payment_id
    order.payment = "Online"
    order.status = "confirmed"
    timeline = json.loads(order.timeline or "[]")
    timeline.append({
        "status": "confirmed",
        "at": now_iso()
    })
    order.timeline = json.dumps(timeline)

    db.commit()
    db.refresh(order)

    try:
        send_whatsapp_order_notification({
            "user_name": order.user_name,
            "phone": order.phone,
            "address": order.address,
            "items": json.loads(order.items or "[]"),
            "total": order.total,
            "notes": order.notes or "",
        })
    except Exception as e:
        log_exception_event("whatsapp_notification_error", e)

    return {
        "ok": True,
        "message": "Payment verified",
        "order": model_to_dict(order),
    }

# ── Orders ────────────────────────────────────────────────────────
ORDER_STATUSES = ["pending", "confirmed", "out_for_delivery", "delivered", "cancelled"]

def cancel_pending_payment_order(order: Order, db: Session, reason: str) -> None:
    if order.payment_status != "payment_pending":
        return

    try:
        items = json.loads(order.items or "[]")
    except Exception:
        items = []

    for item in items:
        product_id = item.get("product_id") if isinstance(item, dict) else None
        if not product_id:
            continue
        product = db.query(Product).filter(Product.id == product_id).first()
        if not product:
            continue
        restored_kg = float(item.get("stock_deducted_kg") or 0)
        if restored_kg <= 0:
            continue
        product.stock = round(float(product.stock or 0) + restored_kg, 3)
        product.available = 1
        product.total_purchased = max(
            0,
            int(product.total_purchased or 0) - int(item.get("quantity") or 0)
        )
        record_stock_history(db, product, restored_kg, reason, order.id)

    order.status = "cancelled"
    order.payment_status = "payment_cancelled"
    timeline = json.loads(order.timeline or "[]")
    timeline.append({
        "status": "cancelled",
        "at": now_iso(),
        "reason": reason,
    })
    order.timeline = json.dumps(timeline)
    db.commit()

def create_order_record(
    body: OrderIn,
    user: Dict[str, Any],
    db: Session,
    payment: str = "Cash on Delivery",
    payment_status: str = "cod_pending",
    notify_admin: bool = True,
) -> Order:
    items_detail = []
    subtotal = 0
    stock_changes = []
    for ci in body.items:
        product = db.query(Product).filter(Product.id == ci.product_id).first()
        if product is None:
            raise HTTPException(400, f"Product {ci.product_id} not found")
        p = model_to_dict(product)
        if not p:
            raise HTTPException(400, f"Product {ci.product_id} not found")
        if not p.get("available"):
            raise HTTPException(400, f"{p['name']} is unavailable")
        if ci.quantity <= 0:
            raise HTTPException(400, f"Invalid quantity for {p['name']}")
        purchase_option = purchase_option_for_value(
            p["unit"],
            ci.selected_weight,
            p.get("purchase_options"),
            p.get("quantity_options", [100, 250, 500, 1000]),
        )
        if not purchase_option:
            raise HTTPException(400, f"Invalid purchase option for {p['name']}")

        selected_value = ci.selected_weight or 1000
        amounts = calculate_order_item_amounts(
            p["unit"],
            selected_value,
            ci.quantity,
            p["price"],
            p.get("purchase_options"),
            p.get("quantity_options"),
        )
        stock_needed = amounts["stock_needed"]
        current_stock = float(product.stock or 0)

        if current_stock < stock_needed:
            raise HTTPException(
                400,
                f"Only {current_stock:g} {stock_message_unit(p['unit'], current_stock)} stock available for {p['name']}"
            )

        line_total = amounts["line_total"]
        subtotal += line_total
        items_detail.append({
            "product_id": ci.product_id,
            "name": p["name"],
            "emoji": p.get("emoji", "🌿"),
            "price": p["price"],
            "unit": p["unit"],
            "quantity": ci.quantity,
            "original_line_total": line_total,
            "line_total": line_total,
            "selected_weight": ci.selected_weight,
            "purchase_label": purchase_option["label"],
            "purchase_multiplier": purchase_option["multiplier"],
            "stock_deducted_kg": stock_needed,
        })

        product.stock = round(current_stock - stock_needed, 3)
        if product.stock <= 0:
            product.stock = 0
            product.available = 0
        product.total_purchased = (product.total_purchased or 0) + ci.quantity
        stock_changes.append((product, -stock_needed))

    original_subtotal = round(subtotal, 2)
    coupon = get_valid_coupon_for_amount(db, body.coupon_code, original_subtotal)
    if coupon:
        subtotal = 0
        for item in items_detail:
            original_line_total = float(item["original_line_total"])
            quantity = int(item["quantity"] or 1)
            if coupon.discountType == "percentage":
                line_total = original_line_total - (original_line_total * float(coupon.discountValue) / 100)
            else:
                selected_unit_price = original_line_total / max(1, quantity)
                line_total = max(0.0, selected_unit_price - float(coupon.discountValue)) * quantity
            item["line_total"] = round(max(0.0, line_total), 2)
            item["coupon_code"] = coupon.code
            item["coupon_discount_type"] = coupon.discountType
            item["coupon_discount_value"] = coupon.discountValue
            subtotal += item["line_total"]

    delivery = 0 if subtotal >= 300 else 40
    timeline = [{"status": "pending", "at": now_iso()}]
    order = Order(
        id=str(uuid.uuid4()),
        user_id=user["id"],
        user_name=user["name"],
        user_email=public_user(user).get("email", ""),
        items=json.dumps(items_detail),
        address=body.address,
        phone=body.phone,
        slot=body.slot or "",
        notes=body.notes or "",
        delivery_lat=body.delivery_lat,
        delivery_lng=body.delivery_lng,
        delivery_place_id=body.delivery_place_id or "",
        delivery_maps_url=make_maps_url(body.delivery_lat, body.delivery_lng, body.address),
        subtotal=round(subtotal, 2),
        delivery=delivery,
        total=round(subtotal + delivery, 2),
        payment=payment,
        payment_status=payment_status,
        status="pending",
        timeline=json.dumps(timeline),
        created_at=now_iso(),
    )
    db.add(order)
    for product, change_kg in stock_changes:
        record_stock_history(db, product, change_kg, "Order placed", order.id)
    db.commit()
    db.refresh(order)
    if notify_admin:
        try:
            send_whatsapp_order_notification({
                "user_name": user["name"],
                "phone": body.phone,
                "address": body.address,
                "items": items_detail,
                "total": round(subtotal + delivery, 2),
                "notes": body.notes or "",
            })
        except Exception as e:
            log_exception_event("whatsapp_notification_error", e)
    return order

@app.post("/api/orders", dependencies=[Depends(rate_limit(limit=5, window_seconds=60))])
def create_order(body: OrderIn, user: Dict[str, Any] = Depends(get_current_user), db: Session = Depends(get_db)):
    order = create_order_record(body=body, user=user, db=db)
    result = model_to_dict(order) or {}
    result["delivery_directions_url"] = make_directions_url(body.delivery_lat, body.delivery_lng, body.address)
    return result

@app.post("/api/orders/{oid}/cancel-payment")
def cancel_payment_order(
    oid: str,
    user: Dict[str, Any] = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    order = db.query(Order).filter(
        Order.id == oid,
        Order.user_id == user["id"],
    ).first()
    if not order:
        raise HTTPException(404, "Order not found")
    if order.payment_status != "payment_pending":
        return {"ok": True, "order": model_to_dict(order)}
    cancel_pending_payment_order(order, db, "Payment cancelled")
    db.refresh(order)
    return {"ok": True, "order": model_to_dict(order)}

@app.get("/api/orders")
def list_orders(user: Dict[str, Any] = Depends(get_current_user), db: Session = Depends(get_db)):
    if user.get("is_admin"):
        rows = db.query(Order).order_by(Order.created_at.desc()).all()
    else:
        rows = db.query(Order).filter(Order.user_id == user["id"]).order_by(Order.created_at.desc()).all()
    return models_to_list(rows)


@app.get("/api/orders/repeat-last")
def repeat_last_order(user: Dict[str, Any] = Depends(get_current_user), db: Session = Depends(get_db)):
    row = (
        db.query(Order)
        .filter(Order.user_id == user["id"])
        .filter(Order.status != "cancelled")
        .order_by(Order.created_at.desc())
        .first()
    )
    if not row:
        return {"items": [], "message": "No previous order found"}

    order_dict = model_to_dict(row) or {}
    available_items = []
    for item in order_dict.get("items", []):
        product = db.query(Product).filter(Product.id == item.get("product_id")).first()
        if product is None:
            continue
        product_dict = model_to_dict(product)
        if product_dict is None or not product_dict.get("available"):
            continue
        selected_weight = int(item.get("selected_weight") or 1000)
        quantity = int(item.get("quantity") or 1)
        stock_needed = calculate_order_item_amounts(
            product_dict.get("unit"),
            selected_weight,
            quantity,
            float(product_dict.get("price") or 0),
            product_dict.get("purchase_options"),
            product_dict.get("quantity_options"),
        )["stock_needed"]
        if float(product.stock or 0) < stock_needed:
            continue
        available_items.append({
            "product_id": item.get("product_id"),
            "selected_weight": selected_weight,
            "quantity": quantity,
            "name": product_dict.get("name"),
        })

    return {
        "source_order_id": row.id,
        "items": available_items,
        "skipped_count": max(0, len(order_dict.get("items", [])) - len(available_items)),
    }

@app.get("/api/orders/buy-again")
def buy_again_products(user: Dict[str, Any] = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(Order)
        .filter(Order.user_id == user["id"])
        .filter(Order.status != "cancelled")
        .order_by(Order.created_at.desc())
        .limit(12)
        .all()
    )
    scores: Dict[str, int] = {}
    last_seen: Dict[str, str] = {}
    for order in rows:
        order_dict = model_to_dict(order) or {}
        for item in order_dict.get("items", []):
            pid = item.get("product_id")
            if not pid:
                continue
            scores[pid] = scores.get(pid, 0) + int(item.get("quantity") or 1)
            last_seen[pid] = order.created_at

    ordered_ids = sorted(scores.keys(), key=lambda pid: (scores[pid], last_seen.get(pid, "")), reverse=True)
    products = []
    for pid in ordered_ids[:8]:
        product = db.query(Product).filter(Product.id == pid).first()
        product_dict = model_to_dict(product)
        if product_dict and product_dict.get("available"):
            product_dict["buy_again_count"] = scores[pid]
            products.append(product_dict)
    return products

@app.get("/api/favorites")
def list_favorites(user: Dict[str, Any] = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(UserFavorite).filter(UserFavorite.user_id == user["id"]).order_by(UserFavorite.created_at.desc()).all()
    product_ids = [r.product_id for r in rows]
    products = []
    for pid in product_ids:
        product = db.query(Product).filter(Product.id == pid).first()
        product_dict = model_to_dict(product)
        if product_dict:
            products.append(product_dict)
    return {"product_ids": product_ids, "products": products}

@app.post("/api/favorites/{pid}")
def add_favorite(pid: str, user: Dict[str, Any] = Depends(get_current_user), db: Session = Depends(get_db)):
    product = db.query(Product).filter(Product.id == pid).first()
    if not product:
        raise HTTPException(404, "Product not found")
    existing = db.query(UserFavorite).filter(UserFavorite.user_id == user["id"], UserFavorite.product_id == pid).first()
    if not existing:
        db.add(UserFavorite(id=str(uuid.uuid4()), user_id=user["id"], product_id=pid, created_at=now_iso()))
        db.commit()
    return {"ok": True, "favorite": True}

@app.delete("/api/favorites/{pid}")
def remove_favorite(pid: str, user: Dict[str, Any] = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(UserFavorite).filter(UserFavorite.user_id == user["id"], UserFavorite.product_id == pid).delete()
    db.commit()
    return {"ok": True, "favorite": False}

@app.get("/api/orders/{oid}")
def get_order(oid: str, user: Dict[str, Any] = Depends(get_current_user), db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == oid).first()
    order_dict = model_to_dict(order)
    if not order_dict:
        raise HTTPException(404, "Order not found")
    if not user.get("is_admin") and order_dict.get("user_id") != user.get("id"):
        raise HTTPException(403, "Access denied")
    return order_dict

@app.get("/api/orders/{oid}/tracking")
def get_order_tracking(
    oid: str,
    user: Dict[str, Any] = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    order = db.query(Order).filter(Order.id == oid).first()

    if order is None:
        raise HTTPException(404, "Order not found")

    order_dict = model_to_dict(order) or {}

    if not user.get("is_admin") and order_dict.get("user_id") != user.get("id"):
        raise HTTPException(403, "Access denied")

    partner_phone = None
    if order.delivery_partner:
        partner = db.query(DeliveryPartner).filter(DeliveryPartner.name == order.delivery_partner).first()
        partner_phone = partner.phone if partner else None

    return {
        "order_id": order.id,
        "status": order.status,
        "delivery_partner": order.delivery_partner,
        "delivery_partner_phone": partner_phone,
        "delivery_live_lat": order.delivery_live_lat,
        "delivery_live_lng": order.delivery_live_lng,
        "delivery_last_updated": order.delivery_last_updated,
        "delivery_address": order.address,
        "delivery_lat": order.delivery_lat,
        "delivery_lng": order.delivery_lng,
        "delivery_maps_url": order.delivery_maps_url,
    }

@app.put("/api/orders/{oid}/status", dependencies=[Depends(require_admin)])
def update_order_status(oid: str, body: OrderStatusIn, db: Session = Depends(get_db)):
    log_event(
        logging.INFO,
        "admin_order_status_update_requested",
        order_id=redact_tail(oid),
        status=body.status,
    )

    if body.status not in ORDER_STATUSES:
        raise HTTPException(400, f"Invalid status. Valid: {ORDER_STATUSES}")

    order = db.query(Order).filter(Order.id == oid).first()
    if not order:
        raise HTTPException(404, "Order not found")

    old_status = str(order.status or "")
    order_dict = model_to_dict(order) or {}

    # If an order is cancelled after stock was deducted, restore that stock once.
    # This block is protected by old_status != "cancelled" to prevent double restore.
    if body.status == "cancelled" and old_status != "cancelled":
        order_items = order_dict.get("items", [])
        if isinstance(order_items, list):
            for item in order_items:
                if not isinstance(item, dict):
                    continue

                product_id = item.get("product_id")
                if not product_id:
                    continue

                product = db.query(Product).filter(Product.id == str(product_id)).first()
                if not product:
                    continue

                restored_stock = item.get("stock_deducted_kg")
                if restored_stock is None:
                    selected_weight = float(item.get("selected_weight") or 1000)
                    quantity = int(item.get("quantity") or 0)
                    restored_stock = calculate_order_item_amounts(
                        item.get("unit"),
                        selected_weight,
                        quantity,
                        float(item.get("price") or 0),
                    )["stock_needed"]

                product.stock = round(float(product.stock or 0) + float(restored_stock), 3)
                if float(product.stock or 0) > 0:
                    product.available = 1

    timeline = order_dict.get("timeline", [])
    if not isinstance(timeline, list):
        timeline = []
    timeline.append({"status": body.status, "at": now_iso()})

    order.status = body.status
    order.timeline = json.dumps(timeline)
    db.commit()
    db.refresh(order)

    customer = db.query(User).filter(User.id == order.user_id).first()
    log_order_notification_state(order, customer, "admin_status_update")

    status_text = body.status.replace("_", " ").title()

    log_event(logging.INFO, "push_notification_attempt", order_id=redact_tail(order.id), status=body.status)

    if customer:
        send_push_notification(
            customer.fcm_token,
            "Amar Veggies Order Update",
            f"Your order #{order.id[-8:].upper()} is now {status_text}"
        )

    try:
        send_whatsapp_customer_status(order, body.status)
    except Exception as e:
        log_exception_event("customer_whatsapp_status_error", e)

    return model_to_dict(order)

@app.put("/api/orders/{oid}/assign", dependencies=[Depends(require_admin)])
def assign_delivery_partner(
    oid: str,
    body: AssignDeliveryIn,
    db: Session = Depends(get_db)
):
    order = db.query(Order).filter(Order.id == oid).first()

    if not order:
        raise HTTPException(404, "Order not found")

    partner = body.delivery_partner.strip()

    if not partner:
        raise HTTPException(400, "Delivery partner is required")

    delivery_partner = db.query(DeliveryPartner).filter(
        DeliveryPartner.name == partner,
        DeliveryPartner.active == 1
    ).first()

    if not delivery_partner:
        raise HTTPException(404, "Delivery partner not found or inactive")

    order.delivery_partner = delivery_partner.name

    db.commit()
    db.refresh(order)

    return model_to_dict(order)

# ── Admin stats ───────────────────────────────────────────────────
@app.get("/api/admin/stats", dependencies=[Depends(require_admin)])
def admin_stats(db: Session = Depends(get_db)):
    total_orders = db.query(Order).count()
    pending_orders = db.query(Order).filter(Order.status == "pending").count()
    confirmed_orders = db.query(Order).filter(Order.status.in_(["confirmed", "packed"])).count()
    active_delivery_orders = db.query(Order).filter(Order.status == "out_for_delivery").count()
    delivered_orders = db.query(Order).filter(Order.status == "delivered").count()
    cancelled_orders = db.query(Order).filter(Order.status == "cancelled").count()
    total_products = db.query(Product).count()
    avail_products = db.query(Product).filter(Product.available == 1).count()
    total_users = db.query(User).filter(User.is_admin == 0).count()
    low_stock_products = db.query(Product).filter(Product.stock > 0, Product.stock <= 2).count()
    out_of_stock_products = db.query(Product).filter(Product.stock <= 0).count()

    non_cancelled_orders = db.query(Order).filter(Order.status != "cancelled").all()
    revenue = sum([o.total or 0 for o in non_cancelled_orders])

    today_prefix = datetime.utcnow().date().isoformat()
    today_orders_rows = [o for o in non_cancelled_orders if str(o.created_at or "").startswith(today_prefix)]
    today_revenue = sum([o.total or 0 for o in today_orders_rows])

    return {
        "total_orders": total_orders,
        "pending_orders": pending_orders,
        "confirmed_orders": confirmed_orders,
        "active_delivery_orders": active_delivery_orders,
        "delivered_orders": delivered_orders,
        "cancelled_orders": cancelled_orders,
        "total_products": total_products,
        "available_products": avail_products,
        "revenue": round(revenue or 0, 2),
        "today_revenue": round(today_revenue or 0, 2),
        "today_orders": len(today_orders_rows),
        "total_users": total_users,
        "low_stock_products": low_stock_products,
        "out_of_stock_products": out_of_stock_products,
    }

@app.get("/api/admin/analytics/top-products", dependencies=[Depends(require_admin)])
def top_products(limit: int = 10, db: Session = Depends(get_db)):
    product_totals = {}

    orders = db.query(Order).filter(Order.status != "cancelled").all()

    for order in orders:
        order_dict = model_to_dict(order) or {}
        for item in order_dict.get("items", []):
            name = item.get("name", "Unknown")
            qty = int(item.get("quantity") or 0)
            amount = float(item.get("line_total") or 0)

            if name not in product_totals:
                product_totals[name] = {
                    "name": name,
                    "quantity": 0,
                    "revenue": 0
                }

            product_totals[name]["quantity"] += qty
            product_totals[name]["revenue"] += amount

    result = sorted(
        product_totals.values(),
        key=lambda x: x["revenue"],
        reverse=True
    )[:limit]

    return result

# ── Analytics ─────────────────────────────────────────────────────
@app.get("/api/admin/analytics/payment-split", dependencies=[Depends(require_admin)])
def payment_split(db: Session = Depends(get_db)):
    orders = db.query(Order).all()

    cod = 0
    online = 0
    pending = 0

    for order in orders:
        payment = (order.payment or "").lower()
        payment_status = (order.payment_status or "").lower()

        if payment == "online" and payment_status == "paid":
            online += 1
        elif payment == "cash on delivery":
            cod += 1
        else:
            pending += 1

    return {
        "cod": cod,
        "online": online,
        "pending": pending
    }

@app.get("/api/admin/analytics/revenue-chart", dependencies=[Depends(require_admin)])
def revenue_chart(days: int = 7, db: Session = Depends(get_db)):
    today = datetime.utcnow().date()

    result = []

    for i in range(days - 1, -1, -1):
        day = today - timedelta(days=i)

        total = 0

        orders = db.query(Order).filter(Order.status != "cancelled").all()

        for order in orders:
            try:
                created = datetime.fromisoformat(order.created_at).date()

                if created == day:
                    total += float(order.total or 0)

            except Exception:
                pass

        result.append({
            "date": day.strftime("%d %b"),
            "revenue": round(total, 2)
        })

    return result

# ── Health ────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "Amar Veggies API",
        "version": APP_VERSION,
        "environment": APP_ENV,
    }

@app.get("/api/ready")
def ready(db: Session = Depends(get_db)):
    db_type = "postgresql" if DATABASE_URL.startswith("postgres") else "sqlite"
    checks: Dict[str, Any] = {
        "database": False,
        "cors_origins_configured": bool(CORS_ORIGINS),
        "redis_rate_limiter_configured": bool(REDIS_URL),
        "object_storage_configured": bool(product_image_storage.enabled),
        "razorpay_configured": bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET),
        "email_otp_configured": bool(BREVO_API_KEY and OTP_EMAIL_FROM),
        "twilio_whatsapp_configured": bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_NUMBER),
        "firebase_push_configured": bool(FIREBASE_CREDENTIALS_JSON),
        "google_login_configured": bool(GOOGLE_CLIENT_ID),
        "shop_location_configured": bool(SHOP_LAT and SHOP_LNG),
    }
    try:
        db.execute(text("SELECT 1"))
        checks["database"] = True
    except Exception as e:
        log_exception_event("readiness_database_check_failed", e)
        raise HTTPException(503, {"status": "not_ready", "checks": checks})

    return {
        "status": "ok",
        "service": "Amar Veggies SQLAlchemy API",
        "version": APP_VERSION,
        "environment": APP_ENV,
        "database": db_type,
        "checks": checks,
    }

# ── Product images ────────────────────────────────────────────────
@app.post("/api/products/{pid}/image", dependencies=[Depends(require_admin)])
async def upload_product_image(pid: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    product = db.query(Product).filter(Product.id == pid).first()
    if not product:
        raise HTTPException(404, "Product not found")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image (jpg, png, webp, etc.)")
    contents = await file.read()
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(400, "Image must be under 5MB")

    old_key = product.image_key
    uploaded = product_image_storage.upload(
        product.id,
        file.filename or f"{product.id}.jpg",
        file.content_type,
        contents,
    )
    product.image_url = uploaded["image_url"]
    product.image_key = uploaded["image_key"]
    product.image_data = None
    db.commit()

    if old_key and old_key != product.image_key:
        try:
            product_image_storage.delete(old_key)
        except Exception as e:
            log_exception_event("product_old_image_delete_failed", e, product_id=redact_tail(product.id))

    return {
        "ok": True,
        "image_url": product.image_url,
        "image_key": product.image_key,
    }

@app.delete("/api/products/{pid}/image", dependencies=[Depends(require_admin)])
def delete_product_image(pid: str, db: Session = Depends(get_db)):
    product = db.query(Product).filter(Product.id == pid).first()
    if not product:
        raise HTTPException(404, "Product not found")
    old_key = product.image_key
    if old_key:
        product_image_storage.delete(old_key)
    product.image_url = None
    product.image_key = None
    product.image_data = None
    db.commit()
    return {"ok": True}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)

