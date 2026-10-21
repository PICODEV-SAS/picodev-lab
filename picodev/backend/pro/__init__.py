"""Picodev Lab overlay (backend).

Velxio imports ``app.pro`` at startup when the package exists and calls
``register_pro(app)`` (see backend/app/main.py). The Picodev image copies this
directory to ``backend/app/pro`` (picodev/docker/Dockerfile).

What it does: let a deployment turn a stock, fully open Velxio backend into a
public instance that can only be used for its purpose (for Picodev Lab:
compiling small sketches for the lab's AVR boards). Everything is enforced in
one ASGI middleware, so it does not depend on which hooks a given Velxio
version exposes:

* routes the demo does not need are refused (server-side flashing, IoT proxy,
  QEMU simulation, custom chip and ROM compilers, core installs, MicroPython
  fetches, news feed, library uninstall);
* compile requests are checked before they reach the queue: allowed boards,
  number and size of files, per-client rate;
* library installs are limited to an allowlist that is pre-installed in the
  image.

Nothing about a particular deployment is written here: every rule comes from
one TOML file (``PICODEV_CONFIG``, see picodev/config/lab.example.toml). A rule
that the file does not set is not enforced, so with no file at all the backend
behaves as stock Velxio.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import tomllib
from collections import defaultdict, deque
from typing import Awaitable, Callable

logger = logging.getLogger("picodev")

Scope = dict
Receive = Callable[[], Awaitable[dict]]
Send = Callable[[dict], Awaitable[None]]


DEFAULT_CONFIG_PATH = "/etc/velxio/lab.toml"


def load_config(path: str | None = None) -> dict:
    """Read the deployment file. No file at the default path means "no rule".

    A path given explicitly (``PICODEV_CONFIG``) must exist and parse: an
    instance that was meant to be restricted must not start wide open because
    its file was not mounted.
    """
    explicit = path or os.environ.get("PICODEV_CONFIG")
    target = explicit or DEFAULT_CONFIG_PATH
    try:
        with open(target, "rb") as fh:
            return tomllib.load(fh)
    except FileNotFoundError:
        if explicit:
            raise
        return {}


def library_names(specs: list[str]) -> frozenset[str]:
    """``["Servo@1.2.2"]`` -> ``{"servo"}`` (what the image has installed)."""
    return frozenset(str(s).split("@", 1)[0].strip().lower() for s in specs)


_CFG = load_config()
_BOARDS = _CFG.get("boards", {})
_LIMITS = _CFG.get("limits", {})

BRAND: str = _CFG.get("brand", {}).get("name") or "Velxio"
# Path prefixes refused outright (HTTP and WebSocket).
BLOCKED_PREFIXES: tuple[str, ...] = tuple(_CFG.get("routes", {}).get("blocked", ()))
# None = any board / any library; a list (even empty) is enforced.
ALLOWED_FQBNS: tuple[str, ...] | None = (
    tuple(_BOARDS["fqbns"]) if "fqbns" in _BOARDS else None
)
# The allowlist is the list of libraries built into the image, so the two
# cannot drift apart.
_TOOLCHAIN = _CFG.get("toolchain", {})
ALLOWED_LIBRARIES: frozenset[str] | None = (
    library_names(_TOOLCHAIN["libraries"]) if "libraries" in _TOOLCHAIN else None
)
# 0 = no limit.
MAX_FILES = int(_LIMITS.get("max_files", 0))
MAX_SOURCE_BYTES = int(_LIMITS.get("max_source_bytes", 0))
MAX_BODY_BYTES = int(_LIMITS.get("max_body_bytes", 0))
COMPILES_PER_MINUTE = int(_LIMITS.get("compiles_per_minute", 0))

# Velxio reads this one from the environment at each build.
if _LIMITS.get("compile_timeout"):
    os.environ["VELXIO_COMPILE_TIMEOUT"] = str(int(_LIMITS["compile_timeout"]))
# Life of a compiled program in Velxio's disk cache, from when it was built;
# 0 = no disk cache. Absent: Velxio's own (14 days since the last hit).
if "artifact_cache_hours" in _LIMITS:
    _hours = _LIMITS["artifact_cache_hours"]
    if type(_hours) is not int or _hours < 0:
        raise ValueError(f"limits.artifact_cache_hours: {_hours!r} is not accepted")
    os.environ["VELXIO_ARTIFACT_CACHE_HOURS"] = str(_hours)

COMPILE_CHECKED = bool(
    ALLOWED_FQBNS is not None or MAX_FILES or MAX_SOURCE_BYTES or COMPILES_PER_MINUTE
)

COMPILE_PATHS = ("/api/compile", "/api/compile/", "/api/compile/start")
LIBRARY_INSTALL_PATH = "/api/libraries/install"


def _fqbn_allowed(fqbn: str) -> bool:
    # "arduino:avr:nano:cpu=atmega328old" is the Nano with the old bootloader.
    if ALLOWED_FQBNS is None:
        return True
    return any(fqbn == f or fqbn.startswith(f + ":") for f in ALLOWED_FQBNS)


def check_compile(payload: dict) -> str | None:
    """Return a refusal message for a compile request, or None when it is fine."""
    fqbn = str(payload.get("board_fqbn") or "arduino:avr:uno")
    if not _fqbn_allowed(fqbn):
        return f"Carte non disponible sur {BRAND} : {fqbn}."
    files = payload.get("files")
    if files is None:
        files = [{"name": "sketch.ino", "content": payload.get("code") or ""}]
    if not isinstance(files, list):
        return "Liste de fichiers invalide."
    if MAX_FILES and len(files) > MAX_FILES:
        return f"Trop de fichiers (maximum {MAX_FILES})."
    size = sum(len(str(f.get("content", "")).encode()) for f in files if isinstance(f, dict))
    if MAX_SOURCE_BYTES and size > MAX_SOURCE_BYTES:
        return f"Code trop volumineux (maximum {MAX_SOURCE_BYTES // 1024} Ko)."
    return None


def check_library(payload: dict) -> str | None:
    """Return a refusal message for a library install, or None when allowed."""
    if ALLOWED_LIBRARIES is None:
        return None
    name = str(payload.get("name") or "").strip().lower()
    if name not in ALLOWED_LIBRARIES:
        allowed = ", ".join(sorted(ALLOWED_LIBRARIES)) or "aucune"
        return f"Bibliothèque non disponible sur {BRAND} (disponibles : {allowed})."
    return None


class RateLimiter:
    """Sliding one-minute window per client key, in memory (single process)."""

    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self.hits: dict[str, deque] = defaultdict(deque)

    def allow(self, key: str, now: float | None = None) -> bool:
        if self.per_minute <= 0:
            return True
        now = time.monotonic() if now is None else now
        q = self.hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.per_minute:
            return False
        q.append(now)
        return True


def client_key(scope: Scope) -> str:
    """First address of X-Forwarded-For (set by the front proxy), else the peer."""
    for name, value in scope.get("headers", []):
        if name == b"x-forwarded-for":
            return value.decode("latin-1").split(",")[0].strip()
    peer = scope.get("client") or ("unknown", 0)
    return str(peer[0])


async def _json_response(send: Send, status: int, body: dict) -> None:
    data = json.dumps(body, ensure_ascii=False).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json; charset=utf-8"),
                            (b"content-length", str(len(data)).encode())]})
    await send({"type": "http.response.body", "body": data})


class PicodevGuard:
    """ASGI middleware enforcing the demo's limits in front of every route."""

    def __init__(self, app) -> None:
        self.app = app
        self.compile_limiter = RateLimiter(COMPILES_PER_MINUTE)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path: str = scope.get("path", "")

        if any(path == p or path.startswith(p.rstrip("/") + "/") for p in BLOCKED_PREFIXES):
            logger.info("picodev: refused %s %s", scope["type"], path)
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
                return
            return await _json_response(send, 404, {"detail": f"Not available on {BRAND}."})

        checked = scope["type"] == "http" and scope.get("method") == "POST" and (
            (path in COMPILE_PATHS and COMPILE_CHECKED)
            or (path == LIBRARY_INSTALL_PATH and ALLOWED_LIBRARIES is not None)
        )
        if not checked:
            return await self.app(scope, receive, send)

        # Buffer the body (bounded), check it, then replay it to the route.
        chunks, total, more = [], 0, True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            total += len(body)
            if MAX_BODY_BYTES and total > MAX_BODY_BYTES:
                return await _json_response(send, 413, {"success": False, "error": "Requête trop volumineuse."})
            chunks.append(body)
            more = message.get("more_body", False)
        raw = b"".join(chunks)
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            return await _json_response(send, 400, {"success": False, "error": "JSON invalide."})
        if not isinstance(payload, dict):
            return await _json_response(send, 400, {"success": False, "error": "JSON invalide."})

        if path == LIBRARY_INSTALL_PATH:
            refusal = check_library(payload)
            if refusal:
                return await _json_response(send, 403, {"success": False, "error": refusal})
        else:
            refusal = check_compile(payload)
            if refusal:
                return await _json_response(send, 422, {"success": False, "error": refusal, "stderr": ""})
            if not self.compile_limiter.allow(client_key(scope)):
                await send({"type": "http.response.start", "status": 429,
                            "headers": [(b"content-type", b"application/json; charset=utf-8"),
                                        (b"retry-after", b"30")]})
                await send({"type": "http.response.body", "body": json.dumps(
                    {"success": False, "error": "Trop de compilations, réessayez dans une minute.",
                     "stderr": ""}, ensure_ascii=False).encode()})
                return

        replayed = False

        async def replay() -> dict:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": raw, "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)


# ponytail: polling, so a result is held at most JOB_TTL_S + PURGE_INTERVAL_S.
PURGE_INTERVAL_S = 1


async def _purge_compile_results() -> None:
    """Velxio drops a finished compile result JOB_TTL_S (30 min) after the
    build, but only when the next compile is submitted. Purge on time."""
    from app.api.routes import compile as velxio_compile

    while True:
        await asyncio.sleep(PURGE_INTERVAL_S)
        try:
            velxio_compile._purge_expired_jobs()
        except Exception:
            logger.exception("picodev: compile result purge failed")


_purge_task: asyncio.Task | None = None


async def _start_purge() -> None:
    global _purge_task
    _purge_task = asyncio.get_running_loop().create_task(_purge_compile_results())


def register_pro(app) -> None:
    """Entry point called by Velxio's main.py when this package is present."""
    app.add_middleware(PicodevGuard)
    try:
        from app.core.hooks import register_lifespan_startup
    except ImportError:  # outside Velxio (tests): no compile results to purge
        pass
    else:
        register_lifespan_startup(_start_purge)
