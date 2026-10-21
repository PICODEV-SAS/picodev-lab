#!/usr/bin/env python3
"""Render the deployment file for the two parts that cannot read TOML.

    render_config.py <config.toml or ""> <config.js> <nginx http include> <nginx server include>

* ``config.js`` sets ``window.__LAB_CONFIG__`` for the editor (public keys
  only; frontend/src/lib/deploymentConfig.ts reads it).
* the nginx includes carry the landing redirect, the refused routes, the
  request size and the rate limits.

Run by the container entrypoint before nginx starts. With no file, both
outputs describe a stock Velxio. Values that end up in the nginx
configuration are checked against strict patterns first.
"""
from __future__ import annotations

import json
import re
import sys
import tomllib

# A path of this origin: "//host/..." would be another site.
PATH_RE = re.compile(r"^/(?!/)[A-Za-z0-9/_.\-]*$")
PAGE_RE = re.compile(r"^[a-z0-9\-]+$")
RATE_RE = re.compile(r"^[0-9]+r/[sm]$")

PROXY = """        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
"""


def _checked(value: object, pattern: re.Pattern, what: str) -> str:
    if not isinstance(value, str) or not pattern.match(value):
        raise ValueError(f"{what}: {value!r} is not accepted")
    return value


def frontend_config(cfg: dict) -> str:
    brand, boards, bench, hub = (cfg.get(k, {}) for k in ("brand", "boards", "bench", "hub"))
    public = {
        "brandName": brand.get("name"),
        "sourceUrl": brand.get("source_url"),
        "allowedBoards": boards.get("allowed"),
        "defaultBoard": boards.get("default"),
    }
    # The logo of the bench workspace: a path of the same origin, served by
    # the deployment (the image ships none).
    if "logo_url" in brand:
        public["logoUrl"] = _checked(brand["logo_url"], PATH_RE, "brand.logo_url")
    # Where the bench workspace loads its sheets and sends the visitor: paths
    # of the same origin only, so a value can never be a script URL.
    for key, name in (("setups_url", "setupsUrl"), ("exit_url", "exitUrl"), ("home_url", "homeUrl")):
        if key in bench:
            public[name] = _checked(bench[key], PATH_RE, f"bench.{key}")
    # Where the bench joins the hub (sessions, spectators). Absent: no hub.
    if "url" in hub:
        public["hubUrl"] = _checked(hub["url"], PATH_RE, "hub.url")
    data = json.dumps({k: v for k, v in public.items() if v}, ensure_ascii=False)
    # The file is a script: a "</script>" inside a value must not end it.
    return "window.__LAB_CONFIG__ = " + data.replace("</", "<\\/") + ";\n"


def nginx_http(cfg: dict) -> str:
    limits = cfg.get("limits", {})
    out = []
    for key, zone in (("api_rate", "lab_api"), ("compile_rate", "lab_compile")):
        if key in limits:
            rate = _checked(limits[key], RATE_RE, f"limits.{key}")
            out.append(f"limit_req_zone $binary_remote_addr zone={zone}:10m rate={rate};\n")
    return "".join(out)


def nginx_server(cfg: dict) -> str:
    limits, routes = cfg.get("limits", {}), cfg.get("routes", {})
    landing = cfg.get("brand", {}).get("landing")
    out = []

    body = int(limits.get("max_body_bytes", 0))
    # nginx's own default (1m) is too small for a stock instance.
    out.append(f"    client_max_body_size {body if body else '50m'};\n")

    if landing:
        landing = _checked(landing, PATH_RE, "brand.landing")
        out.append(f"    location = / {{ return 302 {landing}; }}\n")
    pages = [_checked(p, PAGE_RE, "routes.hidden_pages") for p in routes.get("hidden_pages", [])]
    if pages:
        out.append(
            f"    location ~ ^/([a-z][a-z]/)?({'|'.join(pages)})(/|$) "
            f"{{ return 302 {landing or '/'}; }}\n"
        )
    for prefix in routes.get("blocked", []):
        prefix = _checked(prefix, PATH_RE, "routes.blocked")
        out.append(f"    location ^~ {prefix} {{ return 404; }}\n")

    for prefix, key, zone, burst, timeout in (
        ("/api/compile", "compile_rate", "lab_compile", 6, 120),
        ("/api/", "api_rate", "lab_api", 40, 60),
    ):
        out.append(f"    location ^~ {prefix} {{\n")
        if key in limits:
            out.append(f"        limit_req zone={zone} burst={burst} nodelay;\n")
            out.append("        limit_req_status 429;\n")
        out.append(PROXY)
        out.append(f"        proxy_read_timeout {timeout}s;\n    }}\n")
    return "".join(out)


def main(argv: list[str]) -> int:
    config_path, js_path, http_path, server_path = argv[1:5]
    cfg: dict = {}
    if config_path:
        with open(config_path, "rb") as fh:
            cfg = tomllib.load(fh)
    for path, text in (
        (js_path, frontend_config(cfg)),
        (http_path, nginx_http(cfg)),
        (server_path, nginx_server(cfg)),
    ):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
