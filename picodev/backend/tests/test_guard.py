"""Tests for the Picodev backend overlay (picodev/backend/pro).

Run from the repository root:
    PYTHONPATH=picodev/backend python -m pytest picodev/backend/tests -q
"""
import importlib
import pathlib

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

EXAMPLE = pathlib.Path(__file__).parents[2] / "config" / "lab.example.toml"


def _client(monkeypatch, config: str | None):
    """A stub Velxio app behind the guard, loaded with this deployment file."""
    # The overlay hands this one to Velxio through the environment.
    monkeypatch.delenv("VELXIO_ARTIFACT_CACHE_HOURS", raising=False)
    if config is None:
        monkeypatch.delenv("PICODEV_CONFIG", raising=False)
    else:
        monkeypatch.setenv("PICODEV_CONFIG", config)
    import pro  # picodev/backend/pro, imported under its directory name

    importlib.reload(pro)
    app = FastAPI()
    seen = {}

    @app.post("/api/compile/")
    async def compile_(payload: dict):
        seen["compile"] = payload
        return {"success": True}

    @app.post("/api/libraries/install")
    async def install(payload: dict):
        return {"success": True, "name": payload.get("name")}

    @app.post("/api/flash/upload")
    async def flash():
        return {"success": True}

    @app.get("/api/intellisense/ping")
    async def ping():
        return {"ok": True}

    @app.websocket("/api/simulation/ws/{cid}")
    async def ws(websocket: WebSocket, cid: str):
        await websocket.accept()
        await websocket.send_text("hello")

    pro.register_pro(app)
    c = TestClient(app)
    c.seen = seen
    return c


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """The example deployment (Picodev Lab), with a rate low enough to test."""
    cfg = tmp_path / "lab.toml"
    cfg.write_text(EXAMPLE.read_text().replace("compiles_per_minute = 6", "compiles_per_minute = 2"))
    return _client(monkeypatch, str(cfg))


@pytest.fixture()
def stock(monkeypatch):
    """No deployment file: nothing is enforced."""
    return _client(monkeypatch, None)


def test_blocked_routes_are_refused(client):
    assert client.post("/api/flash/upload").status_code == 404
    assert client.post("/api/libraries/uninstall", json={"name": "Servo"}).status_code == 404
    assert client.get("/api/intellisense/ping").status_code == 200


def test_blocked_websocket_is_closed(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/api/simulation/ws/abc") as ws:
            ws.receive_text()


def test_compile_allowed_board_reaches_route_with_body_intact(client):
    body = {"board_fqbn": "arduino:avr:nano", "files": [{"name": "a.ino", "content": "void setup(){}"}]}
    r = client.post("/api/compile/", json=body)
    assert r.status_code == 200
    assert client.seen["compile"] == body


def test_compile_old_bootloader_variant_allowed(client):
    r = client.post("/api/compile/", json={"board_fqbn": "arduino:avr:nano:cpu=atmega328old", "code": "x"})
    assert r.status_code == 200


def test_compile_other_board_refused(client):
    r = client.post("/api/compile/", json={"board_fqbn": "esp32:esp32:esp32", "code": "x"})
    assert r.status_code == 422
    assert r.json()["success"] is False


def test_compile_too_big_refused(client):
    r = client.post("/api/compile/", json={"board_fqbn": "arduino:avr:uno", "code": "x" * (70 * 1024)})
    assert r.status_code == 422


def test_compile_rate_limited_per_client(client):
    body = {"board_fqbn": "arduino:avr:uno", "code": "x"}
    headers = {"X-Forwarded-For": "203.0.113.7"}
    assert client.post("/api/compile/", json=body, headers=headers).status_code == 200
    assert client.post("/api/compile/", json=body, headers=headers).status_code == 200
    assert client.post("/api/compile/", json=body, headers=headers).status_code == 429
    # Another client is not affected.
    assert client.post("/api/compile/", json=body, headers={"X-Forwarded-For": "198.51.100.1"}).status_code == 200


def test_library_allowlist(client):
    assert client.post("/api/libraries/install", json={"name": "Servo"}).status_code == 200
    r = client.post("/api/libraries/install", json={"name": "WiFiManager"})
    assert r.status_code == 403
    assert r.json()["success"] is False


def test_no_file_means_stock_velxio(stock):
    assert stock.post("/api/flash/upload").status_code == 200
    with stock.websocket_connect("/api/simulation/ws/abc") as ws:
        assert ws.receive_text() == "hello"
    body = {"board_fqbn": "esp32:esp32:esp32", "code": "x" * (70 * 1024)}
    for _ in range(10):
        assert stock.post("/api/compile/", json=body).status_code == 200
    assert stock.post("/api/libraries/install", json={"name": "WiFiManager"}).status_code == 200


def test_named_file_must_exist(monkeypatch, tmp_path):
    # A restricted instance must not start open because its file is not mounted.
    with pytest.raises(FileNotFoundError):
        _client(monkeypatch, str(tmp_path / "absent.toml"))


def test_refusals_name_the_configured_brand(client):
    r = client.post("/api/compile/", json={"board_fqbn": "esp32:esp32:esp32", "code": "x"})
    assert "Picodev Lab" in r.json()["error"]


def test_artifact_cache_hours_reaches_velxio(client, stock, monkeypatch, tmp_path):
    import os

    _client(monkeypatch, str(EXAMPLE))
    assert os.environ["VELXIO_ARTIFACT_CACHE_HOURS"] == "24"
    cfg = tmp_path / "lab.toml"
    cfg.write_text("[limits]\nartifact_cache_hours = 0\n")
    _client(monkeypatch, str(cfg))
    assert os.environ["VELXIO_ARTIFACT_CACHE_HOURS"] == "0"
    _client(monkeypatch, None)  # no file: Velxio's own cache
    assert "VELXIO_ARTIFACT_CACHE_HOURS" not in os.environ
    for bad in ("-1", '"24"', "1.5", "true"):
        cfg.write_text(f"[limits]\nartifact_cache_hours = {bad}\n")
        with pytest.raises(ValueError):
            _client(monkeypatch, str(cfg))
