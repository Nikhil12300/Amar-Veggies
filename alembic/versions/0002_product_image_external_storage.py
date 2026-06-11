"""add external product image columns

Revision ID: 0002_product_image_external_storage
Revises: 0001_baseline_schema
Create Date: 2026-06-08
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0002_product_images"
down_revision = "0001_baseline_schema"
branch_labels = None
depends_on = None


def column_names(bind, table_name):
    inspector = inspect(bind)
    if table_name not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table_name)}


def upgrade():
    bind = op.get_bind()
    columns = column_names(bind, "products")
    if "image_url" not in columns:
        op.add_column("products", sa.Column("image_url", sa.Text(), nullable=True))
    if "image_key" not in columns:
        op.add_column("products", sa.Column("image_key", sa.String(), nullable=True))


def downgrade():
    columns = column_names(op.get_bind(), "products")
    if "image_key" in columns:
        op.drop_column("products", "image_key")
    if "image_url" in columns:
        op.drop_column("products", "image_url")
