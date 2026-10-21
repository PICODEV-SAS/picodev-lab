"""
EXAMPLE RELAY, NOT FOR PRODUCTION.

A minimal server for the live-sharing protocol of the bench
(picodev/docs/live-protocol.adoc): sessions, spectators and an HTTP push for
scripts and agents. One process, everything in memory: a restart forgets every
session. No rate limit per address, no TLS, no persistence, setups not checked.

    uvicorn relay:app --port 8765     # serves under /hub: set [hub] url = "/hub"
"""

import asyncio
import contextlib
import hmac
import json
import re
import secrets
import time

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

MAX_MESSAGE = 64 * 1024  # bytes, a WebSocket message or an HTTP body
MAX_VIEWERS = 20  # per session
MAX_SESSIONS = 200  # open at the same time
MAX_FILES = 8
SESSION_TTL = 4 * 3600  # seconds, whatever happens
OWNER_IDLE = 10 * 60  # seconds without an owner connected
VISIBILITIES = ("private", "link", "public")
FILE_NAME = re.compile(r"^[\w.-]{1,64}$")

sessions: dict[str, "Session"] = {}


def token() -> str:
    return secrets.token_urlsafe(16)  # 128 bits


def same(given: object, expected: str) -> bool:
    return isinstance(given, str) and bool(given) and hmac.compare_digest(given.encode(), expected.encode())


class Session:
    def __init__(self, setup: str, mode: str):
        self.id = secrets.token_urlsafe(9)
        self.setup, self.mode = setup, mode
        self.owner, self.agent, self.viewer = token(), token(), token()
        self.visibility = "link"
        self.started = time.time()
        self.owner_seen = self.started  # last time an owner was connected
        self.owner_ws: WebSocket | None = None
        self.viewers: set[WebSocket] = set()
        self.state: dict | None = None  # the last `state`, for late joiners

    def public_viewer(self) -> str | None:
        return None if self.visibility == "private" else self.viewer

    async def to_owner(self, msg: dict) -> bool:
        if not self.owner_ws:
            return False
        with contextlib.suppress(Exception):
            await self.owner_ws.send_json(msg)
            return True
        return False

    async def to_viewers(self, msg: dict) -> None:
        # ponytail: sequential sends, a slow spectator slows the others; per-viewer queues if that matters.
        for ws in list(self.viewers):
            try:
                await ws.send_json(msg)
            except Exception:
                self.viewers.discard(ws)

    async def drop_viewers(self, reason: str) -> None:
        viewers, self.viewers = self.viewers, set()
        for ws in viewers:
            with contextlib.suppress(Exception):
                await ws.send_json({"type": "closed", "reason": reason})
                await ws.close(1000)

    async def count_viewers(self) -> None:
        await self.to_owner({"type": "viewers", "count": len(self.viewers)})


def error(status: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status)


async def body(request: Request) -> dict | JSONResponse:
    raw = await request.body()  # ponytail: read before checking; a front proxy should cap the body too
    if len(raw) > MAX_MESSAGE:
        return error(413, "body too large")
    try:
        data = json.loads(raw)
    except ValueError:
        return error(400, "invalid JSON")
    return data if isinstance(data, dict) else error(400, "expected an object")


def bearer(request: Request) -> str | None:
    kind, _, value = request.headers.get("authorization", "").partition(" ")
    return value.strip() if kind.lower() == "bearer" else None


def find(request: Request, role: str) -> "Session | JSONResponse":
    s = sessions.get(request.path_params["id"])
    if not s:
        return error(404, "no such session")
    if not same(bearer(request), getattr(s, role)):
        return error(403, "bad token")
    return s


# ── HTTP ────────────────────────────────────────────────────────────────────


async def create(request: Request):
    data = await body(request)
    if isinstance(data, JSONResponse):
        return data
    setup, mode = data.get("setup"), data.get("mode")
    # ponytail: any setup name is accepted; a real server checks it against its setup index.
    if not isinstance(setup, str) or not FILE_NAME.match(setup) or mode not in ("free", "challenge"):
        return error(400, "setup or mode invalid")
    if len(sessions) >= MAX_SESSIONS:
        return error(503, "too many sessions")
    s = Session(setup, mode)
    sessions[s.id] = s
    return JSONResponse({"session": s.id, "owner": s.owner, "viewer": s.viewer, "agent": s.agent, "visibility": s.visibility})


async def read(request: Request):
    s = find(request, "owner")
    if isinstance(s, JSONResponse):
        return s
    return JSONResponse(
        {"session": s.id, "setup": s.setup, "mode": s.mode, "visibility": s.visibility, "viewer": s.public_viewer(), "viewers": len(s.viewers)}
    )


async def visibility(request: Request):
    s = find(request, "owner")
    if isinstance(s, JSONResponse):
        return s
    data = await body(request)
    if isinstance(data, JSONResponse):
        return data
    v = data.get("visibility")
    if v not in VISIBILITIES:
        return error(400, "visibility invalid")
    if v != s.visibility:
        # A new viewer token: the spectators holding the old link are cut off.
        s.visibility, s.viewer = v, token()
        await s.drop_viewers("visibility")
        await s.count_viewers()
    return JSONResponse({"visibility": s.visibility, "viewer": s.public_viewer()})


async def public(request: Request):
    out = []
    for s in sessions.values():
        if s.visibility != "public":
            continue
        item = {"session": s.id, "viewer": s.viewer, "setup": s.setup, "mode": s.mode, "started_at": int(s.started), "viewers": len(s.viewers)}
        if s.mode == "challenge" and s.state and isinstance(s.state.get("level"), int):
            item["level"] = s.state["level"]
        out.append(item)
    return JSONResponse(out)


async def push(request: Request):
    s = find(request, "agent")
    if isinstance(s, JSONResponse):
        return s
    data = await body(request)
    if isinstance(data, JSONResponse):
        return data
    files, run = data.get("files"), data.get("run", True)
    ok = (
        isinstance(files, list)
        and 0 < len(files) <= MAX_FILES
        and all(isinstance(f, dict) and isinstance(f.get("name"), str) and FILE_NAME.match(f["name"]) and isinstance(f.get("content"), str) for f in files)
        and isinstance(run, bool)
    )
    if not ok:
        return error(400, "files or run invalid")
    files = [{"name": f["name"], "content": f["content"]} for f in files]
    if not await s.to_owner({"type": "push", "files": files, "run": run}):
        return error(409, "no owner connected")
    names = ", ".join(f["name"] for f in files)
    await s.to_owner({"type": "agent", "tool": "push", "summary": f"{names}{' (run)' if run else ''}"})
    return JSONResponse({"ok": True})


# ── Live channel ────────────────────────────────────────────────────────────


async def receive(ws: WebSocket) -> dict | None:
    """The next JSON object; closes with 1009 when the message is too large."""
    while True:
        m = await ws.receive()
        if m["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(m.get("code", 1000))
        raw = m.get("text") if m.get("text") is not None else m.get("bytes") or b""
        size = len(raw.encode()) if isinstance(raw, str) else len(raw)
        if size > MAX_MESSAGE:
            await ws.close(1009)
            raise WebSocketDisconnect(1009)
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        if isinstance(msg, dict):
            return msg


async def live(ws: WebSocket):
    await ws.accept()
    s = sessions.get(ws.path_params["id"])
    try:
        hello = await asyncio.wait_for(receive(ws), 10)
    except WebSocketDisconnect:
        return
    except TimeoutError:
        await ws.close(1008)
        return
    role = hello.get("role")
    if (
        not s
        or hello.get("type") != "hello"
        or role not in ("owner", "viewer")
        or not same(hello.get("token"), getattr(s, role))
        or (role == "viewer" and s.visibility == "private")
    ):
        await ws.close(1008)
        return
    if role == "viewer":
        if len(s.viewers) >= MAX_VIEWERS:
            await ws.close(1013)
            return
        s.viewers.add(ws)
        if s.state:
            await ws.send_json(s.state)
        await s.count_viewers()
        try:
            while ws in s.viewers:
                await receive(ws)  # spectators are read-only: anything they send is ignored
        except WebSocketDisconnect:
            pass
        finally:
            if ws in s.viewers:
                s.viewers.discard(ws)
                await s.count_viewers()
        return

    # Owner: the newest connection wins; the previous one is refused for good.
    if s.owner_ws:
        with contextlib.suppress(Exception):
            await s.owner_ws.close(1008)
    s.owner_ws = ws
    await s.count_viewers()
    try:
        while True:
            msg = await receive(ws)
            if msg.get("type") == "state":
                s.state = msg
            if msg.get("type") in ("state", "events", "compile"):
                await s.to_viewers(msg)
    except WebSocketDisconnect:
        pass
    finally:
        if s.owner_ws is ws:
            s.owner_ws = None
            s.owner_seen = time.time()


# ── End of sessions ─────────────────────────────────────────────────────────


async def end(s: Session) -> None:
    sessions.pop(s.id, None)
    await s.drop_viewers("ended")
    if s.owner_ws:
        with contextlib.suppress(Exception):
            await s.owner_ws.close(1008)


async def sweep() -> None:
    now = time.time()
    for s in list(sessions.values()):
        if now - s.started > SESSION_TTL or (not s.owner_ws and now - s.owner_seen > OWNER_IDLE):
            await end(s)


@contextlib.asynccontextmanager
async def lifespan(app):
    async def loop():
        while True:
            await asyncio.sleep(30)
            await sweep()

    task = asyncio.create_task(loop())
    yield
    task.cancel()


app = Starlette(
    routes=[
        Mount(
            "/hub",
            routes=[
                Route("/sessions", create, methods=["POST"]),
                Route("/sessions/public", public, methods=["GET"]),
                Route("/sessions/{id}", read, methods=["GET"]),
                Route("/sessions/{id}/visibility", visibility, methods=["PUT"]),
                Route("/sessions/{id}/push", push, methods=["POST"]),
                WebSocketRoute("/sessions/{id}/live", live),
            ],
        )
    ],
    lifespan=lifespan,
)
