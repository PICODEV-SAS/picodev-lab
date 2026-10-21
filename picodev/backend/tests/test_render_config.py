"""Tests for picodev/docker/render_config.py (deployment file -> editor and nginx).

Run from the repository root:
    python -m pytest picodev/backend/tests -q
"""
import importlib.util
import json
import pathlib
import tomllib

import pytest

ROOT = pathlib.Path(__file__).parents[2]
_spec = importlib.util.spec_from_file_location("render_config", ROOT / "docker" / "render_config.py")
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)

EXAMPLE = tomllib.loads((ROOT / "config" / "lab.example.toml").read_text())


def test_no_config_is_stock():
    assert rc.frontend_config({}) == "window.__LAB_CONFIG__ = {};\n"
    assert rc.nginx_http({}) == ""
    server = rc.nginx_server({})
    assert "return" not in server and "limit_req" not in server
    assert "location ^~ /api/ {" in server


def test_example_reaches_the_editor_and_nginx():
    js = rc.frontend_config(EXAMPLE)
    data = json.loads(js.removeprefix("window.__LAB_CONFIG__ = ").rstrip(";\n"))
    assert data == {
        "brandName": "Picodev Lab",
        "sourceUrl": "https://github.com/PICODEV-SAS/picodev-lab",
        "allowedBoards": ["arduino-nano", "arduino-uno"],
        "defaultBoard": "arduino-nano",
        "logoUrl": "/site/img/logo-couleur.png",
        "setupsUrl": "/setups",
        "exitUrl": "/fin",
        "homeUrl": "/",
        "hubUrl": "/hub",
    }
    assert "zone=lab_compile:10m rate=12r/m;" in rc.nginx_http(EXAMPLE)
    server = rc.nginx_server(EXAMPLE)
    assert "location = / { return 302 /example/picodev-setup-a; }" in server
    assert "location ^~ /api/flash { return 404; }" in server
    assert "(pricing|classroom|about|account|docs|blog)" in server
    assert "client_max_body_size 262144;" in server
    assert "limit_req zone=lab_compile burst=6 nodelay;" in server


def test_script_end_tag_cannot_close_the_config_script():
    js = rc.frontend_config({"brand": {"name": "</script><script>alert(1)"}})
    assert "</script>" not in js


@pytest.mark.parametrize("cfg", [
    {"routes": {"blocked": ["/api/x { return 200; } location /"]}},
    {"routes": {"hidden_pages": ["a|.*"]}},
    {"brand": {"landing": "/x; return 200"}},
    {"limits": {"api_rate": "10r/s; }"}},
    {"bench": {"exit_url": "javascript:alert(1)"}},
    {"bench": {"setups_url": "https://elsewhere.example/setups"}},
    {"bench": {"home_url": 3}},
    {"hub": {"url": "wss://elsewhere.example/hub"}},
    {"hub": {"url": "//elsewhere.example/hub"}},
    {"brand": {"logo_url": "https://elsewhere.example/logo.png"}},
])
def test_values_that_would_break_out_of_nginx_syntax_are_refused(cfg):
    with pytest.raises(ValueError):
        rc.frontend_config(cfg)
        rc.nginx_http(cfg)
        rc.nginx_server(cfg)
