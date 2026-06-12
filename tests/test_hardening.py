from fastapi.testclient import TestClient
import pytest


def test_security_headers_are_set(server_module):
    client = TestClient(server_module.app)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "geolocation=()" in response.headers["permissions-policy"]


def test_readiness_checks_database_and_safe_config(server_module):
    client = TestClient(server_module.app)

    response = client.get("/api/ready")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["checks"]["database"] is True
    assert data["checks"]["cors_origins_configured"] is True
    assert "SECRET_KEY" not in str(data)


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


def test_order_creation_uses_product_units_for_stock_and_totals(server_module):
    db = server_module.SessionLocal()
    try:
        product_specs = [
            ("kg-1", "Tomato", 20, "kg", 10, [250], 250, 2, 0.5, 9.5, 10),
            ("dozen-12", "Egg Tray", 120, "dozen", 5, [12], 12, 2, 2, 3, 240),
            ("dozen-1", "Loose Egg", 120, "dozen", 1, [1], 1, 6, 0.5, 0.5, 60),
            ("piece-1", "Lime", 5, "piece", 20, [1], 1, 3, 3, 17, 15),
            ("bunch-1", "Coriander", 10, "bunch", 10, [1], 1, 2, 2, 8, 20),
        ]
        for pid, name, price, unit, stock, options, *_ in product_specs:
            db.add(server_module.Product(
                id=pid,
                name=name,
                description="",
                emoji="",
                category="Test",
                price=price,
                unit=unit,
                stock=stock,
                available=1,
                featured=0,
                quantity_options=server_module.json.dumps(options),
                total_purchased=0,
                created_at=server_module.now_iso(),
            ))
        db.commit()

        body = server_module.OrderIn(
            items=[
                server_module.CartItemIn(product_id=pid, selected_weight=selected, quantity=quantity)
                for pid, _, _, _, _, _, selected, quantity, _, _, _ in product_specs
            ],
            address="Test address",
            phone="9999999999",
            slot="Morning",
        )
        order = server_module.create_order_record(
            body=body,
            user={"id": "user-1", "name": "Test User", "email": "test@example.com"},
            db=db,
            notify_admin=False,
        )

        order_dict = server_module.model_to_dict(order)
        items_by_id = {item["product_id"]: item for item in order_dict["items"]}

        assert order_dict["subtotal"] == 345
        assert order_dict["delivery"] == 0
        assert order_dict["total"] == 345
        for pid, _, _, _, _, _, _, _, expected_deducted, expected_stock, expected_total in product_specs:
            product = db.get(server_module.Product, pid)
            assert product.stock == expected_stock
            assert items_by_id[pid]["stock_deducted_kg"] == expected_deducted
            assert items_by_id[pid]["line_total"] == expected_total
    finally:
        db.close()


def test_stock_error_message_uses_product_unit(server_module):
    db = server_module.SessionLocal()
    try:
        product_specs = [
            ("kg-low", "Tomato", "kg", 0.25, [500], 500, 1, "Only 0.25 kg stock available"),
            ("dozen-low", "Eggs", "dozen", 1, [12], 12, 2, "Only 1 dozen stock available"),
            ("piece-low", "Lime", "piece", 2, [1], 1, 3, "Only 2 pieces stock available"),
            ("bunch-low", "Coriander", "bunch", 2, [1], 1, 3, "Only 2 bunches stock available"),
        ]
        for pid, name, unit, stock, options, *_ in product_specs:
            db.add(server_module.Product(
                id=pid,
                name=name,
                description="",
                emoji="",
                category="Test",
                price=10,
                unit=unit,
                stock=stock,
                available=1,
                featured=0,
                quantity_options=server_module.json.dumps(options),
                total_purchased=0,
                created_at=server_module.now_iso(),
            ))
        db.commit()

        for pid, _, _, _, _, selected, quantity, expected_message in product_specs:
            body = server_module.OrderIn(
                items=[server_module.CartItemIn(product_id=pid, selected_weight=selected, quantity=quantity)],
                address="Test address",
                phone="9999999999",
                slot="Morning",
            )
            with pytest.raises(server_module.HTTPException) as exc_info:
                server_module.create_order_record(
                    body=body,
                    user={"id": "user-1", "name": "Test User", "email": "test@example.com"},
                    db=db,
                    notify_admin=False,
                )
            assert expected_message in exc_info.value.detail
    finally:
        db.close()


def test_order_creation_uses_configured_purchase_options(server_module):
    db = server_module.SessionLocal()
    try:
        purchase_options = [
            {"value": 12, "label": "1 dozen", "multiplier": 1},
            {"value": 1, "label": "1 piece", "multiplier": 0.083333},
        ]
        db.add(server_module.Product(
            id="eggs",
            name="Eggs",
            description="",
            emoji="",
            category="Test",
            price=120,
            unit="dozen",
            stock=2,
            available=1,
            featured=0,
            quantity_options=server_module.json.dumps([12, 1]),
            purchase_options=server_module.json.dumps(purchase_options),
            total_purchased=0,
            created_at=server_module.now_iso(),
        ))
        db.commit()

        body = server_module.OrderIn(
            items=[server_module.CartItemIn(product_id="eggs", selected_weight=1, quantity=6)],
            address="Test address",
            phone="9999999999",
            slot="Morning",
        )
        order = server_module.create_order_record(
            body=body,
            user={"id": "user-1", "name": "Test User", "email": "test@example.com"},
            db=db,
            notify_admin=False,
        )

        order_dict = server_module.model_to_dict(order)
        item = order_dict["items"][0]
        product = db.get(server_module.Product, "eggs")

        assert product.stock == 1.5
        assert item["purchase_label"] == "1 piece"
        assert item["purchase_multiplier"] == 0.083333
        assert item["stock_deducted_kg"] == 0.5
        assert item["line_total"] == 60
    finally:
        db.close()
