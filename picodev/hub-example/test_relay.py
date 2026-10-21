"""Tests of the example relay: python -m pytest picodev/hub-example -q"""

import asyncio
import contextlib

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import relay


@pytest.fixture
def client():
    relay.sessions.clear()
    with TestClient(relay.app) as c, contextlib.ExitStack() as sockets:
        c.sockets = sockets  # every live channel opened by the test, closed before the client
        yield c


def new_session(client):
    r = client.post("/hub/sessions", json={"setup": "setup-a", "mode": "challenge"})
    assert r.status_code == 200
    return r.json()


def join(client, s, role, token=None):
    ws = client.sockets.enter_context(client.websocket_connect(f"/hub/sessions/{s['session']}/live"))
    ws.send_json({"type": "hello", "role": role, "token": token or s[role]})
    return ws


def test_create_read_and_tokens(client):
    s = new_session(client)
    assert set(s) == {"session", "owner", "viewer", "agent", "visibility"}
    assert s["visibility"] == "link" and len({s["owner"], s["viewer"], s["agent"]}) == 3
    url = f"/hub/sessions/{s['session']}"
    assert client.get(url).status_code == 403
    assert client.get(url, headers={"Authorization": f"Bearer {s['viewer']}"}).status_code == 403
    r = client.get(url, headers={"Authorization": f"Bearer {s['owner']}"}).json()
    assert r == {"session": s["session"], "setup": "setup-a", "mode": "challenge", "visibility": "link", "viewer": s["viewer"], "viewers": 0}
    assert client.get("/hub/sessions/nope", headers={"Authorization": "Bearer x"}).status_code == 404
    assert client.post("/hub/sessions", json={"setup": "a", "mode": "other"}).status_code == 400


def test_bad_hello_is_refused_with_1008(client):
    s = new_session(client)
    ws = join(client, s, "viewer", token=s["owner"])
    with pytest.raises(WebSocketDisconnect) as e:
        ws.receive_json()
    assert e.value.code == 1008


def test_owner_to_viewer_with_late_joiner_state(client):
    s = new_session(client)
    owner = join(client, s, "owner")
    assert owner.receive_json() == {"type": "viewers", "count": 0}
    state = {"type": "state", "setup": "setup-a", "mode": "challenge", "files": [{"name": "a.ino", "content": "x"}], "level": 1, "running": True, "results": []}
    owner.send_json(state)
    viewer = join(client, s, "viewer")
    assert viewer.receive_json() == state  # the late joiner gets the last state
    assert owner.receive_json() == {"type": "viewers", "count": 1}
    events = {"type": "events", "events": [{"t": 0.1, "k": "pin", "pin": 13, "v": 1}]}
    owner.send_json(events)
    assert viewer.receive_json() == events
    owner.send_json({"type": "compile", "ok": True, "log": ""})
    assert viewer.receive_json()["type"] == "compile"
    public = client.get("/hub/sessions/public").json()
    assert public == []
    client.put(f"/hub/sessions/{s['session']}/visibility", json={"visibility": "public"}, headers={"Authorization": f"Bearer {s['owner']}"})
    [item] = client.get("/hub/sessions/public").json()
    assert item["session"] == s["session"] and item["level"] == 1


def test_visibility_change_closes_viewers(client):
    s = new_session(client)
    owner = join(client, s, "owner")
    owner.receive_json()
    viewer = join(client, s, "viewer")
    owner.receive_json()
    r = client.put(f"/hub/sessions/{s['session']}/visibility", json={"visibility": "private"}, headers={"Authorization": f"Bearer {s['owner']}"})
    assert r.json() == {"visibility": "private", "viewer": None}
    assert viewer.receive_json() == {"type": "closed", "reason": "visibility"}
    assert owner.receive_json() == {"type": "viewers", "count": 0}
    # The old link no longer works, and a private session takes no spectator.
    late = join(client, s, "viewer")
    with pytest.raises(WebSocketDisconnect) as e:
        late.receive_json()
    assert e.value.code == 1008


def test_push_reaches_owner(client):
    s = new_session(client)
    url = f"/hub/sessions/{s['session']}/push"
    files = [{"name": "sketch.ino", "content": "void setup(){}\nvoid loop(){}\n"}]
    agent = {"Authorization": f"Bearer {s['agent']}"}
    assert client.post(url, json={"files": files}, headers=agent).status_code == 409  # no owner yet
    assert client.post(url, json={"files": files}, headers={"Authorization": f"Bearer {s['owner']}"}).status_code == 403
    assert client.post(url, json={"files": [{"name": "../x", "content": ""}]}, headers=agent).status_code == 400
    owner = join(client, s, "owner")
    owner.receive_json()
    assert client.post(url, json={"files": files, "run": False}, headers=agent).json() == {"ok": True}
    assert owner.receive_json() == {"type": "push", "files": files, "run": False}
    assert owner.receive_json()["type"] == "agent"


def test_oversized_message_closes_with_1009(client):
    s = new_session(client)
    owner = join(client, s, "owner")
    owner.receive_json()
    owner.send_text('{"type":"compile","ok":true,"log":"' + "x" * relay.MAX_MESSAGE + '"}')
    with pytest.raises(WebSocketDisconnect) as e:
        owner.receive_json()
    assert e.value.code == 1009


def test_too_many_viewers_closes_with_1013(client, monkeypatch):
    monkeypatch.setattr(relay, "MAX_VIEWERS", 1)
    s = new_session(client)
    join(client, s, "viewer")
    second = join(client, s, "viewer")
    with pytest.raises(WebSocketDisconnect) as e:
        second.receive_json()
    assert e.value.code == 1013


def test_sweep_ends_old_sessions(client, monkeypatch):
    s = new_session(client)
    monkeypatch.setattr(relay, "OWNER_IDLE", -1)
    asyncio.run(relay.sweep())
    assert s["session"] not in relay.sessions
