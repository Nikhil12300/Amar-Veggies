"""baseline schema

Revision ID: 0001_baseline_schema
Revises:
Create Date: 2026-06-08
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect, text

revision = "0001_baseline_schema"
down_revision = None
branch_labels = None
depends_on = None


def table_exists(inspector, table_name):
    return table_name in inspector.get_table_names()


def column_names(bind, table_name):
    inspector = inspect(bind)
    if not table_exists(inspector, table_name):
        return set()
    return {column["name"] for column in inspector.get_columns(table_name)}


def add_column_if_missing(bind, table_name, column):
    if column.name not in column_names(bind, table_name):
        op.add_column(table_name, column)


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)

    if not table_exists(inspector, "users"):
        op.create_table(
            "users",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("email", sa.String(), nullable=True, unique=True),
            sa.Column("phone", sa.String(), nullable=True, unique=True),
            sa.Column("password", sa.Text(), nullable=True),
            sa.Column("fcm_token", sa.Text(), nullable=True),
            sa.Column("is_admin", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.String(), nullable=False),
        )
    else:
        add_column_if_missing(bind, "users", sa.Column("fcm_token", sa.Text(), nullable=True))

    if not table_exists(inspector, "user_favorites"):
        op.create_table(
            "user_favorites",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("user_id", sa.String(), nullable=False),
            sa.Column("product_id", sa.String(), nullable=False),
            sa.Column("created_at", sa.String(), nullable=False),
        )

    if not table_exists(inspector, "delivery_partners"):
        op.create_table(
            "delivery_partners",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("phone", sa.String(), nullable=False, unique=True),
            sa.Column("password", sa.Text(), nullable=False),
            sa.Column("active", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("created_at", sa.String(), nullable=False),
        )

    if not table_exists(inspector, "otps"):
        op.create_table(
            "otps",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("email", sa.String(), nullable=True),
            sa.Column("phone", sa.String(), nullable=True),
            sa.Column("otp", sa.String(), nullable=False),
            sa.Column("purpose", sa.String(), nullable=False, server_default="register"),
            sa.Column("expires_at", sa.String(), nullable=False),
            sa.Column("created_at", sa.String(), nullable=False),
        )

    if not table_exists(inspector, "products"):
        op.create_table(
            "products",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("emoji", sa.String(), nullable=True),
            sa.Column("category", sa.String(), nullable=False),
            sa.Column("price", sa.Float(), nullable=False),
            sa.Column("unit", sa.String(), nullable=False),
            sa.Column("stock", sa.Float(), nullable=False),
            sa.Column("available", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("featured", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("quantity_options", sa.Text(), nullable=False, server_default="[100,250,500,1000]"),
            sa.Column("image_data", sa.Text(), nullable=True),
            sa.Column("image_url", sa.Text(), nullable=True),
            sa.Column("image_key", sa.String(), nullable=True),
            sa.Column("total_purchased", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.String(), nullable=False),
        )
    else:
        add_column_if_missing(bind, "products", sa.Column("image_url", sa.Text(), nullable=True))
        add_column_if_missing(bind, "products", sa.Column("image_key", sa.String(), nullable=True))
        add_column_if_missing(bind, "products", sa.Column("total_purchased", sa.Integer(), nullable=False, server_default="0"))
        if bind.dialect.name == "postgresql":
            op.execute("ALTER TABLE products ALTER COLUMN stock TYPE DOUBLE PRECISION USING stock::double precision")

    if not table_exists(inspector, "stock_history"):
        op.create_table(
            "stock_history",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("product_id", sa.String(), nullable=False),
            sa.Column("product_name", sa.String(), nullable=False),
            sa.Column("change_kg", sa.Float(), nullable=False),
            sa.Column("stock_after", sa.Float(), nullable=False),
            sa.Column("reason", sa.String(), nullable=False),
            sa.Column("order_id", sa.String(), nullable=True),
            sa.Column("created_at", sa.String(), nullable=False),
        )

    if not table_exists(inspector, "orders"):
        op.create_table(
            "orders",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("user_id", sa.String(), nullable=False),
            sa.Column("user_name", sa.String(), nullable=False),
            sa.Column("user_email", sa.String(), nullable=False),
            sa.Column("items", sa.Text(), nullable=False),
            sa.Column("address", sa.Text(), nullable=False),
            sa.Column("phone", sa.String(), nullable=False),
            sa.Column("slot", sa.String(), nullable=False),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("delivery_lat", sa.Float(), nullable=True),
            sa.Column("delivery_lng", sa.Float(), nullable=True),
            sa.Column("delivery_live_lat", sa.Float(), nullable=True),
            sa.Column("delivery_live_lng", sa.Float(), nullable=True),
            sa.Column("delivery_last_updated", sa.String(), nullable=True),
            sa.Column("delivery_place_id", sa.Text(), nullable=True, server_default=""),
            sa.Column("delivery_maps_url", sa.Text(), nullable=True, server_default=""),
            sa.Column("delivery_partner", sa.String(), nullable=True),
            sa.Column("subtotal", sa.Float(), nullable=False),
            sa.Column("delivery", sa.Float(), nullable=False),
            sa.Column("total", sa.Float(), nullable=False),
            sa.Column("payment", sa.String(), nullable=False, server_default="Cash on Delivery"),
            sa.Column("payment_status", sa.String(), nullable=False, server_default="pending"),
            sa.Column("razorpay_order_id", sa.String(), nullable=True),
            sa.Column("razorpay_payment_id", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False, server_default="pending"),
            sa.Column("timeline", sa.Text(), nullable=False),
            sa.Column("created_at", sa.String(), nullable=False),
        )
    else:
        add_column_if_missing(bind, "orders", sa.Column("payment_status", sa.String(), nullable=False, server_default="pending"))
        add_column_if_missing(bind, "orders", sa.Column("razorpay_order_id", sa.String(), nullable=True))
        add_column_if_missing(bind, "orders", sa.Column("razorpay_payment_id", sa.String(), nullable=True))
        add_column_if_missing(bind, "orders", sa.Column("delivery_partner", sa.String(), nullable=True))
        add_column_if_missing(bind, "orders", sa.Column("delivery_live_lat", sa.Float(), nullable=True))
        add_column_if_missing(bind, "orders", sa.Column("delivery_live_lng", sa.Float(), nullable=True))
        add_column_if_missing(bind, "orders", sa.Column("delivery_last_updated", sa.String(), nullable=True))
        add_column_if_missing(bind, "orders", sa.Column("delivery_place_id", sa.Text(), nullable=True, server_default=""))
        add_column_if_missing(bind, "orders", sa.Column("delivery_maps_url", sa.Text(), nullable=True, server_default=""))

    if table_exists(inspector, "products") and table_exists(inspector, "orders"):
        if bind.dialect.name == "sqlite":
            bind.execute(text("""
                UPDATE products
                SET total_purchased = COALESCE((
                    SELECT SUM(CAST(json_extract(value, '$.quantity') AS INTEGER))
                    FROM orders, json_each(orders.items)
                    WHERE orders.status != 'cancelled'
                      AND json_extract(value, '$.product_id') = products.id
                ), 0)
            """))
        elif bind.dialect.name == "postgresql":
            bind.execute(text("""
                UPDATE products
                SET total_purchased = COALESCE((
                    SELECT SUM(CAST(item->>'quantity' AS INTEGER))
                    FROM orders
                    CROSS JOIN LATERAL jsonb_array_elements(orders.items::jsonb) AS item
                    WHERE orders.status != 'cancelled'
                      AND item->>'product_id' = products.id
                ), 0)
            """))


def downgrade():
    op.drop_table("orders")
    op.drop_table("stock_history")
    op.drop_table("products")
    op.drop_table("otps")
    op.drop_table("delivery_partners")
    op.drop_table("user_favorites")
    op.drop_table("users")
