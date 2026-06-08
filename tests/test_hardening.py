from fastapi.testclient import TestClient


def test_security_headers_are_set(server_module):
    client = TestClient(server_module.app)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "geolocation=()" in response.headers["permissions-policy"]


def test_cors_uses_env_origins(server_module):
    client = TestClient(server_module.app)

    allowed = client.options(
        "/api/health",
        headers={
            "Origin": "https://shop.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    denied = client.options(
        "/api/health",
        headers={
            "Origin": "https://unknown.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "https://shop.example.com"
    assert "access-control-allow-origin" not in denied.headers


def test_rate_limiter_blocks_after_limit(server_module):
    request = type(
        "Request",
        (),
        {
            "client": type("Client", (), {"host": "203.0.113.10"})(),
            "headers": {},
            "url": type("Url", (), {"path": "/limited"})(),
        },
    )()
    dependency = server_module.rate_limit(limit=2, window_seconds=60)

    dependency(request)
    dependency(request)

    try:
        dependency(request)
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 429
    else:
        raise AssertionError("rate limiter did not reject the third request")
