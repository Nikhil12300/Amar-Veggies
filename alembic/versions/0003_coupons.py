"""add coupons table

Revision ID: 0003_coupons
Revises: 0002_product_images
Create Date: 2026-06-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0003_coupons"
down_revision = "0002_product_images"
branch_labels = None
depends_on = None


def table_exists(bind, table_name):
    return table_name in inspect(bind).get_table_names()


def upgrade():
    bind = op.get_bind()
    if not table_exists(bind, "coupons"):
        op.create_table(
            "coupons",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("code", sa.String(), nullable=False, unique=True),
            sa.Column("discountType", sa.String(), nullable=False),
            sa.Column("discountValue", sa.Float(), nullable=False),
            sa.Column("minOrderAmount", sa.Float(), nullable=True),
            sa.Column("isActive", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("expiresAt", sa.String(), nullable=True),
            sa.Column("created_at", sa.String(), nullable=False),
        )


def downgrade():
    bind = op.get_bind()
    if table_exists(bind, "coupons"):
        op.drop_table("coupons")
