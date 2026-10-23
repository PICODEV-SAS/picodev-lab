"""Tests for picodev/docker/externalize_scripts.py (no inline script left in the built pages)."""
import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).parents[2]
_spec = importlib.util.spec_from_file_location("externalize_scripts", ROOT / "docker" / "externalize_scripts.py")
ex = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ex)

PAGE = """<html><head><script src="/config.js"></script>
<script>
  window.a = 1;
</script>
<script type="application/ld+json">{"@type": "WebApplication"}</script>
<script type="module" crossorigin src="/assets/index-x.js"></script>
</head><script>window.b = 2;</script><body><SCRIPT TYPE="module">import "/m.js";</SCRIPT></body></html>"""


def test_inline_scripts_move_to_files_in_place(tmp_path):
    dist = tmp_path / "dist"
    (dist / "examples" / "a").mkdir(parents=True)
    for page in (dist / "index.html", dist / "examples" / "a" / "index.html"):
        page.write_text(PAGE)
    assert ex.main(["x", str(dist)]) == 0

    out = (dist / "index.html").read_text()
    assert out == (dist / "examples" / "a" / "index.html").read_text()
    files = sorted((dist / "assets").iterdir())
    assert len(files) == 3  # the same script on two pages is one file
    assert {f.read_text() for f in files} == {"\n  window.a = 1;\n", "window.b = 2;", 'import "/m.js";'}
    # Each takes the place of its inline script, so the order of execution is kept.
    names = [f"/assets/{f.name}" for f in files]
    srcs = [out.index(f'src="{n}"') for n in names]
    assert out.index("/config.js") < min(srcs) and out.index('src="/assets/index-x.js"') < max(srcs)
    assert '<script TYPE="module" src="/assets/inline-' in out
    # Data blocks and scripts with a src stay as they are.
    assert '<script type="application/ld+json">{"@type": "WebApplication"}</script>' in out
    assert '<script type="module" crossorigin src="/assets/index-x.js"></script>' in out
    assert "window.a" not in out and "window.b" not in out

    # A second run changes nothing.
    ex.main(["x", str(dist)])
    assert (dist / "index.html").read_text() == out and len(list((dist / "assets").iterdir())) == 3
