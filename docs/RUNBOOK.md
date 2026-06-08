# Operations Runbook

## Release Checklist

1. Confirm CI is green.
2. Set or verify production env vars.
3. Run database migrations:

```powershell
python scripts\migrate.py
```

4. Run seed data only when admin or delivery partner bootstrap should be refreshed:

```powershell
python scripts\seed_data.py
```

5. Deploy backend.
6. Deploy frontend build.
7. Verify:

```powershell
curl https://your-backend.example.com/api/health
curl https://your-backend.example.com/api/ready
```

## Product Image Migration

After configuring object storage, migrate old base64 product images:

```powershell
python scripts\migrate_product_images.py
```

The app reads `image_url` first and keeps `image_data` as fallback during migration.

## Monitoring Signals

Watch logs for these structured events:

- `rate_limit_exceeded`
- `readiness_database_check_failed`
- `razorpay_order_creation_failed`
- `brevo_email_failed`
- `whatsapp_send_failed`
- `push_notification_failed`
- `product_old_image_delete_failed`

Alert-worthy symptoms:

- `/api/ready` returns `503`.
- Failed payment order creation spikes.
- OTP delivery failures spike.
- WhatsApp/push notification failures spike.
- Low-stock counts stay non-zero for extended periods.

## Rollback

1. Revert application deploy to the previous known-good version.
2. Avoid rolling back database migrations unless a migration is confirmed destructive.
3. For non-destructive migrations, leave schema forward-compatible and redeploy the previous app version if possible.

## Secret Rotation

Rotate immediately if exposed:

- `SECRET_KEY`
- `DATABASE_URL`
- `RAZORPAY_KEY_SECRET`
- `FIREBASE_CREDENTIALS_JSON`
- `TWILIO_AUTH_TOKEN`
- object storage secret access key

After rotating `SECRET_KEY`, existing JWT sessions become invalid.
