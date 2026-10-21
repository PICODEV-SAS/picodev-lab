"""Velxio's compile cache under VELXIO_ARTIFACT_CACHE_HOURS (patch in
backend/app/api/routes/compile.py). Needs the backend's requirements; skipped
without them."""
import os
import pathlib
import sys
import time

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parents[3] / "backend"))
compile_ = pytest.importorskip("app.api.routes.compile")

OK = {"success": True, "stdout": "log"}


@pytest.fixture()
def cache(monkeypatch, tmp_path):
    monkeypatch.setattr(compile_, "ARTIFACT_CACHE_DIR", tmp_path)
    return tmp_path


def _age(path, hours):
    t = time.time() - hours * 3600
    os.utime(path, (t, t))


def test_age_counts_from_the_build(cache, monkeypatch):
    monkeypatch.setenv("VELXIO_ARTIFACT_CACHE_HOURS", "24")
    compile_._artifact_store("a", OK)
    _age(cache / "a.json", 23)
    assert compile_._artifact_load("a")["success"]
    assert time.time() - (cache / "a.json").stat().st_mtime > 22 * 3600  # a hit does not extend it
    _age(cache / "a.json", 25)
    assert compile_._artifact_load("a") is None
    assert not (cache / "a.json").exists()


def test_expired_entries_go_at_write(cache, monkeypatch):
    monkeypatch.setenv("VELXIO_ARTIFACT_CACHE_HOURS", "24")
    compile_._artifact_store("old", OK)
    _age(cache / "old.json", 25)
    compile_._artifact_store("new", OK)
    assert sorted(p.name for p in cache.iterdir()) == ["new.json"]


def test_zero_means_no_cache(cache, monkeypatch):
    monkeypatch.setenv("VELXIO_ARTIFACT_CACHE_HOURS", "0")
    compile_._artifact_store("a", OK)
    assert list(cache.iterdir()) == []


def test_unset_is_velxio_stock(cache, monkeypatch):
    monkeypatch.delenv("VELXIO_ARTIFACT_CACHE_HOURS", raising=False)
    compile_._artifact_store("a", OK)
    _age(cache / "a.json", 13 * 24)
    assert compile_._artifact_load("a")["success"]
    assert time.time() - (cache / "a.json").stat().st_mtime < 60  # LRU touch on read
    _age(cache / "a.json", 15 * 24)
    assert compile_._artifact_load("a") is None
