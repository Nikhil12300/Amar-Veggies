import importlib
import os
import sys
from pathlib import Path

import pytest


@pytest.fixture()
def server_module(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path.as_posix()}")
    monkeypatch.setenv("SECRET_KEY", "test-secret")
    monkeypatch.setenv("SKIP_EXTERNAL_SERVICES", "1")
    monkeypatch.setenv("CORS_ORIGINS", "https://shop.example.com")
    monkeypatch.delenv("REDIS_URL", raising=False)

    sys.modules.pop("server", None)
    module = importlib.import_module("server")
    module.Base.metadata.create_all(bind=module.engine)
    yield module
    sys.modules.pop("server", None)
