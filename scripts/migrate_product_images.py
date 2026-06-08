import base64
import re

from server import Product, SessionLocal, log_event, logging, product_image_storage


DATA_URL_RE = re.compile(r"^data:(?P<content_type>image/[^;]+);base64,(?P<data>.+)$", re.DOTALL)


def decode_image_data(image_data: str):
    match = DATA_URL_RE.match(image_data or "")
    if not match:
        return None
    return (
        match.group("content_type"),
        base64.b64decode(match.group("data")),
    )


def main():
    product_image_storage.require_enabled()
    db = SessionLocal()
    migrated = 0
    skipped = 0
    try:
        products = (
            db.query(Product)
            .filter(Product.image_data.isnot(None))
            .filter(Product.image_url.is_(None))
            .all()
        )
        for product in products:
            decoded = decode_image_data(product.image_data or "")
            if not decoded:
                skipped += 1
                continue

            content_type, data = decoded
            uploaded = product_image_storage.upload(
                product.id,
                f"{product.id}",
                content_type,
                data,
            )
            product.image_url = uploaded["image_url"]
            product.image_key = uploaded["image_key"]
            product.image_data = None
            migrated += 1

        db.commit()
        log_event(logging.INFO, "product_images_migrated", migrated=migrated, skipped=skipped)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
