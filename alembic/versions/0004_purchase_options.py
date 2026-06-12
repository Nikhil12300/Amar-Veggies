"""add product purchase options

Revision ID: 0004_purchase_options
Revises: 0003_coupons
Create Date: 2026-06-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0004_purchase_options"
down_revision = "0003_coupons"
branch_labels = None
depends_on = None


def column_exists(bind, table_name, column_name):
    return column_name in {column["name"] for column in inspect(bind).get_columns(table_name)}


def upgrade():
    bind = op.get_bind()
    if not column_exists(bind, "products", "purchase_options"):
        op.add_column(
            "products",
            sa.Column("purchase_options", sa.Text(), nullable=False, server_default="[]"),
        )


def downgrade():
    bind = op.get_bind()
    if column_exists(bind, "products", "purchase_options"):
        op.drop_column("products", "purchase_options")
