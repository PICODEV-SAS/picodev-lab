"""Tests for picodev/docker/render_config.py (deployment file -> editor and nginx).

Run from the repository root:
    python -m pytest picodev/backend/tests -q
"""
import importlib.util
import json
import re
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


def _location_regex(server: str, name: str) -> re.Pattern:
    """The regex of the `location ~*` naming ``name``, as nginx matches it (case-insensitive)."""
    line = next(l for l in server.splitlines() if l.startswith("    location ~* ") and name in l)
    assert "{" not in line.split()[2], "nginx needs a regex with braces quoted"
    return re.compile(line.split()[2], re.I)


def test_hidden_pages_match_every_language_prefix():
    cfg = {"routes": {"hidden_pages": ["editor", "examples", "example"]}, "studio": STUDIO}
    server = rc.nginx_server(cfg)
    for name in ("editor", "studio"):
        rx = _location_regex(server, name)
        for path in (f"/{name}", f"/{name}/", f"/fr/{name}", f"/en/{name}", f"/pt-br/{name}",
                     f"/zh-cn/{name}/x", f"/PT-BR/{name}", f"/{name.upper()}"):
            assert rx.search(path), path
        for path in (f"/{name}s-of-mine", f"/bench/{name}", f"/fra/{name}", f"/pt-brx/{name}"):
            assert not rx.search(path), path
    rx = _location_regex(server, "examples")
    for path in ("/zh-cn/example/blink", "/pt-br/examples", "/example/blink", "/ja/examples/x"):
        assert rx.search(path), path
    assert not rx.search("/bench/setup-a")


def test_share_tags_follow_the_brand():
    # No name: Velxio's tags stay.
    assert "sub_filter" not in rc.nginx_server({}) and rc.share_filters({"brand": {"share_image": "x"}}) == ""
    assert rc.share_filters({"brand": {"name": ""}}) == ""
    server = rc.nginx_server(EXAMPLE)
    assert "sub_filter '<meta property=\"og:' '<meta data-velxio-property=\"og:';" in server
    assert "sub_filter '<meta name=\"twitter:' '<meta data-velxio-name=\"twitter:';" in server
    head = next(l for l in server.splitlines() if "'</head>'" in l)
    assert '<meta property="og:title" content="Picodev Lab" />' in head
    assert '<meta property="og:image" content="https://lab.example.org/site/img/share.png" />' in head
    assert '<meta name="twitter:card" content="summary_large_image" />' in head
    assert "velxio" not in head.lower()
    # Text is escaped for HTML and for the nginx string; no image: a small card.
    bare = rc.share_filters({"brand": {"name": "A'b \"c\" $host <x> \\"}})
    assert "A&#x27;b &quot;c&quot; &#36;host &lt;x&gt; &#92;" in bare
    assert 'twitter:card" content="summary"' in bare and "og:image" not in bare and "og:description" not in bare
    assert rc.share_filters({"brand": {"name": "x"}}) == rc.share_filters({"brand": {"name": " x "}})


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
    {"brand": {"name": "x", "share_image": "/site/img/share.png"}},
    {"brand": {"name": "x", "share_image": "https://x.example/a.png'; return 200"}},
    {"brand": {"name": "x", "share_description": "line\nbreak"}},
])
def test_values_that_would_break_out_of_nginx_syntax_are_refused(cfg):
    with pytest.raises(ValueError):
        rc.frontend_config(cfg)
        rc.nginx_http(cfg)
        rc.nginx_server(cfg)


STUDIO = {"listen": 8082, "hub_admin": "http://hub:8081", "setups": "http://setups"}


def test_no_studio_section_changes_nothing():
    cfg = {k: v for k, v in EXAMPLE.items() if k != "studio"}
    assert rc.studio_section({}) is None and rc.studio_section(cfg) is None
    assert rc.nginx_studio({}) == "" and rc.nginx_studio(cfg) == ""
    assert "studio" not in rc.nginx_server(cfg)
    assert "studio" not in rc.frontend_config(cfg)


def test_studio_server(tmp_path):
    cfg = {**EXAMPLE, "studio": STUDIO}
    # The public server refuses the studio page; its config.js does not name it.
    public = rc.nginx_server(cfg)
    assert "studio(/|$) { return 404; }" in public
    assert '"studio"' not in rc.frontend_config(cfg)
    # The studio's config.js: the same values, and the flag that registers /studio.
    data = json.loads(rc.frontend_config(cfg, studio=True).removeprefix("window.__LAB_CONFIG__ = ").rstrip(";\n"))
    assert data["studio"] is True and data["allowedBoards"] == ["arduino-nano", "arduino-uno"]

    server = rc.nginx_studio(cfg, "127.0.0.11")
    assert server.startswith("# The setup studio") and server.rstrip().endswith("}")
    assert "listen 8082;" in server and "resolver 127.0.0.11 valid=30s ipv6=off;" in server
    assert "alias /etc/nginx/lab/studio-config.js;" in server
    # No hidden page, no landing: / goes to the studio. The refused routes and /api/ as on the public server.
    assert "pricing" not in server and "/example/picodev-setup-a" not in server
    assert "location = / { return 302 /studio; }" in server
    assert "location ^~ /api/flash { return 404; }" in server
    assert "limit_req zone=lab_compile burst=6 nodelay;" in server
    # The three back-office requests, nothing else of /admin/.
    for name in ("setup-check", "setup-zip", "setup-try"):
        assert f"location = /admin/api/{name} {{" in server
    assert "location ^~ /admin/ { return 404; }" in server
    assert "set $studio_hub http://hub:8081;" in server and "proxy_set_header Host $http_host;" in server
    assert "set $studio_setups http://setups;" in server and "location ^~ /setups/ {" in server
    assert "studio(/|$) { return 404; }" not in server
    assert server.count("include /etc/nginx/lab-app.conf;") == 1

    # Without `setups`, the studio server serves no sheet; without a name server, no resolver line.
    bare = rc.nginx_studio({"studio": {"listen": 9000, "hub_admin": "http://127.0.0.1:8081"}})
    assert "location ^~ /setups/ { return 404; }" in bare and "resolver" not in bare


def test_main_writes_the_studio_files(tmp_path):
    conf = tmp_path / "lab.toml"
    conf.write_text('[studio]\nlisten = 8082\nhub_admin = "http://hub:8081"\n')
    out = [tmp_path / n for n in ("config.js", "zones.conf", "server.inc", "studio-config.js", "studio.conf")]
    assert rc.main(["x", str(conf), *map(str, out)]) == 0
    assert '"studio": true' in out[3].read_text() and "listen 8082;" in out[4].read_text()
    # No section: an empty studio server file, no studio config.js.
    conf.write_text("")
    out[3].unlink()
    assert rc.main(["x", str(conf), *map(str, out)]) == 0
    assert out[4].read_text() == "" and not out[3].exists()
    # Four arguments, as before: no studio file at all.
    assert rc.main(["x", "", *map(str, out[:3])]) == 0


def test_resolver_is_read_from_resolv_conf(tmp_path):
    f = tmp_path / "resolv.conf"
    f.write_text("search lan\nnameserver 127.0.0.11\nnameserver 1.1.1.1\n")
    assert rc.resolv_conf_nameserver(str(f)) == "127.0.0.11"
    f.write_text("nameserver ; evil\n")
    assert rc.resolv_conf_nameserver(str(f)) is None
    assert rc.resolv_conf_nameserver(str(tmp_path / "none")) is None
    assert "resolver [fd00::1] valid" in rc.nginx_studio({"studio": STUDIO}, "fd00::1")


@pytest.mark.parametrize("studio", [
    "8082",
    {"listen": 80, "hub_admin": "http://hub:8081"},
    {"listen": "8082", "hub_admin": "http://hub:8081"},
    {"listen": True, "hub_admin": "http://hub:8081"},
    {"listen": 70000, "hub_admin": "http://hub:8081"},
    {"listen": 8082},
    {"listen": 8082, "hub_admin": "http://hub:8081/admin"},
    {"listen": 8082, "hub_admin": "http://hub:8081; return 200"},
    {"listen": 8082, "hub_admin": "ftp://hub"},
    {"listen": 8082, "hub_admin": "http://hub:8081", "setups": "http://setups/setups"},
    {"listen": 8082, "hub_admin": "http://hub:8081", "setups": 3},
])
def test_studio_values_that_would_break_nginx_are_refused(studio):
    with pytest.raises(ValueError):
        rc.nginx_studio({"studio": studio})
