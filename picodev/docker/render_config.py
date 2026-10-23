#!/usr/bin/env python3
"""Render the deployment file for the two parts that cannot read TOML.

    render_config.py <config.toml or ""> <config.js> <nginx http include> <nginx server include> \
        [<studio config.js> <studio server conf>]

* ``config.js`` sets ``window.__LAB_CONFIG__`` for the editor (public keys
  only; frontend/src/lib/deploymentConfig.ts reads it).
* the nginx includes carry the landing redirect, the refused routes, the
  request size and the rate limits.
* with a ``[studio]`` section, the second server (the setup studio, on its
  own port) and the ``config.js`` it serves; without one, an empty server
  file, so nginx runs the public server only.

Run by the container entrypoint before nginx starts. With no file, both
outputs describe a stock Velxio. Values that end up in the nginx
configuration are checked against strict patterns first.
"""
from __future__ import annotations

import html
import json
import re
import sys
import tomllib

# A path of this origin: "//host/..." would be another site.
PATH_RE = re.compile(r"^/(?!/)[A-Za-z0-9/_.\-]*$")
PAGE_RE = re.compile(r"^[a-z0-9\-]+$")
RATE_RE = re.compile(r"^[0-9]+r/[sm]$")
# An upstream of the studio server: scheme, host and port only, no path.
UPSTREAM_RE = re.compile(r"^https?://[A-Za-z0-9.\-]+(:[0-9]{1,5})?$")
# The image of a shared link: crawlers want an absolute URL.
IMAGE_RE = re.compile(r"^https://[A-Za-z0-9.\-]+(:[0-9]{1,5})?/[A-Za-z0-9/_.\-]*$")
# A name server of /etc/resolv.conf (IPv4 or IPv6 literal).
RESOLVER_RE = re.compile(r"^[0-9A-Fa-f.:]+$")
# The only back-office requests the studio server relays (architecture v0.18).
STUDIO_ADMIN = ("setup-check", "setup-zip", "setup-try")
# The language prefix of a Velxio page: "fr/", "pt-br/", "zh-cn/", "en/" (which the
# editor redirects), in any case, since React Router matches paths case-insensitively.
# ponytail: any xx or xx-yy, not frontend/src/i18n/config.ts's list, so a new locale is covered.
# No braces: nginx would need the regex quoted.
LOCALE_PREFIX = "([a-z][a-z](-[a-z][a-z])?/)?"

PROXY = """        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
"""


def _checked(value: object, pattern: re.Pattern, what: str) -> str:
    if not isinstance(value, str) or not pattern.match(value):
        raise ValueError(f"{what}: {value!r} is not accepted")
    return value


def studio_section(cfg: dict) -> dict | None:
    """The checked [studio] section, or None when the file has none."""
    if "studio" not in cfg:
        return None
    st = cfg["studio"]
    if not isinstance(st, dict):
        raise ValueError("studio: a table is expected")
    listen = st.get("listen")
    if not isinstance(listen, int) or isinstance(listen, bool) or not 1 <= listen <= 65535 or listen == 80:
        raise ValueError(f"studio.listen: {listen!r} is not accepted (a port, not 80)")
    out = {"listen": listen, "hub_admin": _checked(st.get("hub_admin"), UPSTREAM_RE, "studio.hub_admin")}
    if "setups" in st:
        out["setups"] = _checked(st["setups"], UPSTREAM_RE, "studio.setups")
    return out


def frontend_config(cfg: dict, studio: bool = False) -> str:
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
    # Served by the studio server only: the editor registers /studio.
    if studio:
        public["studio"] = True
    data = json.dumps({k: v for k, v in public.items() if v}, ensure_ascii=False)
    # The file is a script: a "</script>" inside a value must not end it.
    return "window.__LAB_CONFIG__ = " + data.replace("</", "<\\/") + ";\n"


def _text(value: object, what: str) -> str:
    """Text for an HTML attribute inside an nginx single-quoted string: no quote,
    no `$` (an nginx variable) nor backslash left, no control character."""
    if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
        raise ValueError(f"{what}: {value!r} is not accepted")
    return html.escape(value.strip(), quote=True).replace("$", "&#36;").replace("\\", "&#92;")


def share_filters(cfg: dict) -> str:
    """With [brand] name: Velxio's Open Graph and Twitter tags (velxio.dev's title
    and image, on every page) set aside, the instance's added before </head>.
    Without it, nothing: the pages keep Velxio's."""
    brand = cfg.get("brand", {})
    if not brand.get("name"):
        return ""
    name = _text(brand["name"], "brand.name")
    desc = _text(brand["share_description"], "brand.share_description") if "share_description" in brand else None
    image = _checked(brand["share_image"], IMAGE_RE, "brand.share_image") if "share_image" in brand else None
    tags = [("property", "og:type", "website"), ("property", "og:site_name", name), ("property", "og:title", name),
            ("property", "og:description", desc), ("property", "og:image", image),
            ("name", "twitter:card", "summary_large_image" if image else "summary"), ("name", "twitter:title", name),
            ("name", "twitter:description", desc), ("name", "twitter:image", image)]
    meta = "".join(f'<meta {attr}="{key}" content="{value}" />' for attr, key, value in tags if value)
    return (
        # Renamed, not removed (sub_filter replaces fixed strings): crawlers ignore a data- attribute.
        "    sub_filter '<meta property=\"og:' '<meta data-velxio-property=\"og:';\n"
        "    sub_filter '<meta name=\"twitter:' '<meta data-velxio-name=\"twitter:';\n"
        f"    sub_filter '</head>' '{meta}</head>';\n"
    )


def nginx_http(cfg: dict) -> str:
    limits = cfg.get("limits", {})
    out = []
    for key, zone in (("api_rate", "lab_api"), ("compile_rate", "lab_compile")):
        if key in limits:
            rate = _checked(limits[key], RATE_RE, f"limits.{key}")
            out.append(f"limit_req_zone $binary_remote_addr zone={zone}:10m rate={rate};\n")
    return "".join(out)


def nginx_server(cfg: dict, studio: bool = False) -> str:
    """The locations of the public server, or with ``studio`` those of the studio server:
    no landing, no hidden page; the refused routes and /api/ the same."""
    limits, routes = cfg.get("limits", {}), cfg.get("routes", {})
    landing = cfg.get("brand", {}).get("landing")
    out = []

    body = int(limits.get("max_body_bytes", 0))
    # nginx's own default (1m) is too small for a stock instance.
    out.append(f"    client_max_body_size {body if body else '50m'};\n")
    out.append(share_filters(cfg))

    if studio:
        out.append("    location = / { return 302 /studio; }\n")
    elif studio_section(cfg):
        # The studio is a page of the studio server only.
        out.append(f"    location ~* ^/{LOCALE_PREFIX}studio(/|$) {{ return 404; }}\n")
    if landing and not studio:
        landing = _checked(landing, PATH_RE, "brand.landing")
        out.append(f"    location = / {{ return 302 {landing}; }}\n")
    pages = [_checked(p, PAGE_RE, "routes.hidden_pages") for p in routes.get("hidden_pages", [])]
    if pages and not studio:
        out.append(
            f"    location ~* ^/{LOCALE_PREFIX}({'|'.join(pages)})(/|$) "
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


def nginx_studio(cfg: dict, resolver: str | None = None) -> str:
    """The second server, a complete ``server`` block, or "" without [studio].

    ``resolver``: the name server nginx asks for the upstream names at request
    time, so that the lab starts even while the hub is not up yet.
    """
    st = studio_section(cfg)
    if st is None:
        return ""
    out = [
        "# The setup studio (render_config.py, [studio]): the same editor, its own config.js.\n",
        "server {\n",
        f"    listen {st['listen']};\n",
        "    server_name _;\n",
        "    root /usr/share/nginx/html;\n",
        "    index index.html;\n",
        "    absolute_redirect off;\n",
        "    server_tokens off;\n",
        "    access_log off;\n",
        "    error_log /var/log/nginx/error.log crit;\n",
        "    log_not_found off;\n",
        "    limit_req_log_level warn;\n",
    ]
    if resolver:
        resolver = _checked(resolver, RESOLVER_RE, "resolver")
        out.append(f"    resolver {f'[{resolver}]' if ':' in resolver else resolver} valid=30s ipv6=off;\n")
    out.append(f"    set $studio_hub {st['hub_admin']};\n")
    out.append("    location = /config.js {\n        alias /etc/nginx/lab/studio-config.js;\n"
               "        add_header Cache-Control \"no-cache\";\n    }\n")
    for name in STUDIO_ADMIN:
        # The hub's back-office checks Host and Origin against the tunnel: both go through as the browser sent them.
        out.append(f"    location = /admin/api/{name} {{\n"
                   "        client_max_body_size 4m;\n"
                   "        proxy_pass $studio_hub;\n"
                   "        proxy_set_header Host $http_host;\n"
                   "        proxy_read_timeout 120s;\n    }\n")
    out.append("    location ^~ /admin/ { return 404; }\n")
    if "setups" in st:
        out.append(f"    set $studio_setups {st['setups']};\n")
        out.append("    location ^~ /setups/ {\n        proxy_pass $studio_setups;\n    }\n")
    else:
        out.append("    location ^~ /setups/ { return 404; }\n")
    out.append(nginx_server(cfg, studio=True))
    out.append("    include /etc/nginx/lab-app.conf;\n}\n")
    return "".join(out)


def resolv_conf_nameserver(path: str = "/etc/resolv.conf") -> str | None:
    """The first name server of the container, as Docker set it."""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "nameserver" and RESOLVER_RE.match(parts[1]):
                    return parts[1]
    except OSError:
        pass
    return None


def main(argv: list[str]) -> int:
    config_path, js_path, http_path, server_path = argv[1:5]
    studio_js_path, studio_conf_path = (argv[5:7] + [None, None])[:2]
    cfg: dict = {}
    if config_path:
        with open(config_path, "rb") as fh:
            cfg = tomllib.load(fh)
    outputs = [
        (js_path, frontend_config(cfg)),
        (http_path, nginx_http(cfg)),
        (server_path, nginx_server(cfg)),
    ]
    if studio_conf_path:
        studio = studio_section(cfg) is not None
        outputs.append((studio_conf_path, nginx_studio(cfg, resolv_conf_nameserver()) if studio else ""))
        if studio and studio_js_path:
            outputs.append((studio_js_path, frontend_config(cfg, studio=True)))
    for path, text in outputs:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
