# Amar Veggies

Fresh produce storefront with a React/Vite frontend and FastAPI/SQLAlchemy backend.

## Local Setup

1. Create a Python environment and install backend dependencies:

```powershell
pip install -r render-requirements.txt
```

2. Install frontend dependencies:

```powershell
npm.cmd install
```

3. Create `.env` from [.env.example](.env.example) and fill the values you need locally.

4. Run migrations and optional seed data:

```powershell
python scripts\migrate.py
python scripts\seed_data.py
```

5. Start the backend:

```powershell
python server.py
```

6. Start the frontend:

```powershell
npm.cmd run dev
```

## Production Deploy

Backend deploy order:

```powershell
pip install -r render-requirements.txt
python scripts\migrate.py
python scripts\seed_data.py
python server.py
```

Frontend deploy order:

```powershell
npm ci
npm run build
```

Netlify and Cloudflare are configured to publish `dist`.

## Required Production Env

Set these at minimum:

```env
APP_ENV=production
SECRET_KEY=
DATABASE_URL=
ADMIN_EMAIL=
ADMIN_PASSWORD=
SHOW_DEV_OTP=false
CORS_ORIGINS=https://your-frontend-domain.example
VITE_API_BASE_URL=https://your-backend-domain.example
```

Recommended production services:

```env
REDIS_URL=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_ENDPOINT_URL=
OBJECT_STORAGE_ACCESS_KEY_ID=
OBJECT_STORAGE_SECRET_ACCESS_KEY=
OBJECT_STORAGE_PUBLIC_BASE_URL=
BREVO_API_KEY=
OTP_EMAIL_FROM=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_NUMBER=
FIREBASE_CREDENTIALS_JSON=
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_VAPID_KEY=
```

## Operational Endpoints

- `GET /api/health`: lightweight liveness check.
- `GET /api/ready`: database check plus safe configuration status.

Use `/api/ready` for deploy verification after migrations.

## Checks

```powershell
python -m py_compile server.py
python -m pytest tests
npm.cmd run build
```
