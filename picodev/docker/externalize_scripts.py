#!/usr/bin/env python3
"""Move the inline scripts of the built pages into files served from this origin.

    externalize_scripts.py <dist directory>

Run once on the editor's build when the image is made. Every inline script of
every page (Velxio's index.html and its prerendered copies: analytics stub,
theme bootstrap, desktop splash) becomes ``<script src="/assets/inline-<hash>.js">``
in the same place, so it still runs at the same moment, and a Content-Security-Policy
of ``script-src 'self'`` needs no hash, whatever upstream changes in them.
Data blocks (``type="application/ld+json"``) are not scripts and stay.
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import sys

SCRIPT_RE = re.compile(r"<script(\s[^>]*)?>(.*?)</script>", re.S | re.I)
TYPE_RE = re.compile(r"""\btype\s*=\s*["']?([^"'\s>]+)""", re.I)
JS_TYPES = {"", "text/javascript", "application/javascript", "module"}


def externalize(html: str, assets: pathlib.Path) -> str:
    def move(m: re.Match) -> str:
        attrs, body = m.group(1) or "", m.group(2)
        kind = TYPE_RE.search(attrs)
        if re.search(r"\bsrc\s*=", attrs, re.I) or (kind and kind.group(1).lower() not in JS_TYPES) or not body.strip():
            return m.group(0)
        name = f"inline-{hashlib.sha256(body.encode()).hexdigest()[:16]}.js"
        (assets / name).write_text(body, encoding="utf-8")
        return f'<script{attrs} src="/assets/{name}"></script>'

    return SCRIPT_RE.sub(move, html)


def main(argv: list[str]) -> int:
    dist = pathlib.Path(argv[1])
    assets = dist / "assets"
    assets.mkdir(exist_ok=True)
    for page in dist.rglob("*.html"):
        text = page.read_text(encoding="utf-8")
        new = externalize(text, assets)
        if new != text:
            page.write_text(new, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
