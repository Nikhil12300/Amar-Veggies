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
python -m scripts.seed_data
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
python scripts/migrate.py
python -m scripts.seed_data
python server.py
```

Frontend deploy order:

```powershell
npm ci
npm run build
```

Netlify and Cloudflare are configured to publish `dist`.

## Android / Google Play release

The Android project is in `android/` and uses the application ID
`com.amarveggies.app`. This ID becomes permanent after the first Play Console
upload, so change it in `capacitor.config.json` before publishing if it is not
the desired final ID.

1. Deploy the backend over HTTPS and set its allowed CORS origin to the
   frontend domain. Confirm `GET /api/ready` works from the public internet.
2. Set the production backend URL for the Android build. Do not use localhost:

```powershell
$env:VITE_API_BASE_URL = 'https://api.example.com'
npm.cmd run android:bundle
```

3. Before the first Play upload, create and securely back up an upload key.
   Copy `android/keystore.properties.example` to `android/keystore.properties`,
   choose a strong password, and create the key:

```powershell
cd android
keytool -genkeypair -v -keystore amar-veggies-upload.jks -alias amar-veggies-upload -keyalg RSA -keysize 2048 -validity 10000
cd ..
```

   Re-run the bundle command after creating the key. The keystore and its
   properties file are excluded from Git; keep a secure backup.

4. Upload the generated bundle at
   `android/app/build/outputs/bundle/release/app-release.aab` to a Play Console
   internal-testing release first. Android Studio will prompt to create or use
   an upload key if the release build has not yet been signed.

For subsequent builds, increment `versionCode` and `versionName` in
`android/app/build.gradle` before running the bundle command again.

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
