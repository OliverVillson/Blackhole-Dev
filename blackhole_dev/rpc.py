"""The BlackHole-Dev app's Python helper: JSON-RPC 2.0 over stdio.

    <python> -m blackhole_dev.rpc            (cwd = the workspace)

One JSON object per line on stdin/stdout, UTF-8; logs and anything a recipe prints go to
stderr. Requests run one at a time in a worker thread; `$/cancel {id}` cancels a request
that has not started yet (and long ones at their next progress point). Methods take one
named-params object. Shapes are the I1 contract in
/mnt/project-files/blackhole-dev-app/interfaces/ws1-shell.md (with WS2's additions):

  initialize  shutdown
  recipe.lint recipe.compile recipe.steps recipe.plan recipe.devices recipe.bundle
  recipe.fromToml recipe.fromPreset recipe.presets recipe.presetFiles recipe.copyPreset
  anatomy.open anatomy.summary anatomy.children anatomy.get
  functions.list functions.source functions.fork
  analysis.list analysis.source analysis.fork analysis.estimate analysis.run
  model.list model.forkPlan model.fork model.lineage
  lang.catalog lang.complete lang.signatures lang.hover   (the last three beside the queue, see serve)

Errors: -32001 recipe (data.problems), -32002 model not found, -32003 cancelled,
-32004 read budget (data.used, data.wanted, data.budget: run again with a bigger budget once
the user agrees), -32601 unknown method, -32602 bad params, -32000 anything else (data.traceback).
"""

from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import traceback
from pathlib import Path
from typing import Any, Callable

import blackhole_dev

RECIPE_ERROR, MODEL_NOT_FOUND, CANCELLED, READ_BUDGET = -32001, -32002, -32003, -32004
FAST = {"lang.complete", "lang.signatures", "lang.hover"}


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code, self.data = code, data


class Cancelled(Exception):
    pass


class Helper:
    def __init__(self, out=None):
        self.out = out or sys.stdout
        self.lock = threading.Lock()
        self.ws: dict = {"workspace": os.getcwd()}
        self.model = None
        self.amodel: tuple[str, Any] | None = None     # (path, model) a run named, kept for the next run
        self.cancelled: set = set()
        self.current = None
        self.methods: dict[str, Callable[[dict], Any]] = {
            "initialize": self.initialize, "shutdown": self.shutdown,
            "recipe.lint": self.recipe_lint, "recipe.compile": self.recipe_compile, "recipe.steps": self.recipe_steps,
            "recipe.plan": self.recipe_plan, "recipe.devices": self.recipe_devices, "recipe.bundle": self.recipe_bundle,
            "recipe.fromToml": self.recipe_from_toml, "recipe.fromPreset": self.recipe_from_preset,
            "recipe.presets": self.recipe_presets, "recipe.presetFiles": self.recipe_preset_files,
            "recipe.copyPreset": self.recipe_copy_preset,
            "anatomy.open": self.anatomy_open, "anatomy.summary": self.anatomy_summary,
            "anatomy.children": self.anatomy_children, "anatomy.get": self.anatomy_get,
            "functions.list": self.functions_list, "functions.source": self.functions_source,
            "functions.fork": self.functions_fork,
            "analysis.list": self.analysis_list, "analysis.source": self.analysis_source,
            "analysis.fork": self.analysis_fork, "analysis.estimate": self.analysis_estimate,
            "analysis.run": self.analysis_run,
            "model.list": self.model_list, "model.forkPlan": self.model_fork_plan, "model.fork": self.model_fork,
            "model.lineage": self.model_lineage,
            "lang.catalog": self.lang_catalog, "lang.complete": self.lang_complete,
            "lang.signatures": self.lang_signatures, "lang.hover": self.lang_hover,
        }
        self.stop = False

    # ------------------------------------------------------------------ transport
    def send(self, msg: dict) -> None:
        line = json.dumps(msg, default=_jsonable, ensure_ascii=False)
        with self.lock:
            self.out.write(line + "\n")
            self.out.flush()

    def notify(self, method: str, params: dict) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def log(self, message: str, level: str = "info") -> None:
        self.notify("log", {"level": level, "message": message})

    def progress(self, message: str, fraction: float | None = None) -> None:
        if self.current is not None and self.current in self.cancelled:
            raise Cancelled()
        p = {"requestId": self.current, "message": message}
        if fraction is not None:
            p["fraction"] = fraction
        self.notify("progress", p)

    def handle(self, msg: dict) -> dict | None:
        """One request -> its response (None for notifications)."""
        mid, method = msg.get("id"), msg.get("method")
        params = msg.get("params") or {}
        if mid is None:
            return None
        if mid in self.cancelled:
            self.cancelled.discard(mid)
            return _err(mid, CANCELLED, "cancelled")
        fn = self.methods.get(method)
        if fn is None:
            return _err(mid, -32601, f"unknown method {method!r}")
        if not isinstance(params, dict):
            return _err(mid, -32602, "params must be one object of named values")
        self.current = mid
        real_stdout = sys.stdout
        sys.stdout = sys.stderr            # a print() in a recipe must not corrupt the protocol
        try:
            return {"jsonrpc": "2.0", "id": mid, "result": fn(params)}
        except RpcError as e:
            return _err(mid, e.code, str(e), e.data)
        except Cancelled:
            return _err(mid, CANCELLED, "cancelled")
        except Exception as e:  # noqa: BLE001
            from blackhole_dev.analysis import ReadBudgetExceeded
            from blackhole_dev.recipe.core import RecipeError
            if isinstance(e, ReadBudgetExceeded):
                return _err(mid, READ_BUDGET, str(e), {"used": e.used, "wanted": e.wanted, "budget": e.budget})
            if isinstance(e, RecipeError):
                return _err(mid, RECIPE_ERROR, str(e), {"problems": e.problems})
            if isinstance(e, KeyError) and e.args and isinstance(e.args[0], str) and " " in e.args[0]:
                return _err(mid, -32602, e.args[0])
            return _err(mid, -32000, f"{type(e).__name__}: {e}", {"traceback": traceback.format_exc()})
        finally:
            sys.stdout = real_stdout
            self.current = None
            self.cancelled.discard(mid)

    def handle_lang(self, msg: dict) -> dict | None:
        """handle() for FAST methods on the second worker: no stdout swap, no `current` request."""
        mid, method = msg.get("id"), msg.get("method")
        if mid is None:
            return None
        if mid in self.cancelled:
            self.cancelled.discard(mid)
            return _err(mid, CANCELLED, "cancelled")
        params = msg.get("params") or {}
        if not isinstance(params, dict):
            return _err(mid, -32602, "params must be one object of named values")
        try:
            return {"jsonrpc": "2.0", "id": mid, "result": self.methods[method](params)}
        except KeyError as e:
            if method not in self.methods:
                return _err(mid, -32601, f"unknown method {method!r}")
            return _err(mid, -32602, f"missing param {e}")
        except Exception as e:  # noqa: BLE001
            return _err(mid, -32000, f"{type(e).__name__}: {e}", {"traceback": traceback.format_exc()})

    def serve(self, inp=None) -> int:
        inp = inp or sys.stdin
        work: queue.Queue = queue.Queue()
        # editor completions get their own worker so typing never waits behind a plan or an
        # anatomy read; they only parse the text they are sent and never print.
        fast: queue.Queue = queue.Queue()

        def worker(q: queue.Queue, handle: Callable[[dict], dict | None]):
            while True:
                msg = q.get()
                if msg is None:
                    return
                resp = handle(msg)
                if resp is not None:
                    self.send(resp)
                if msg.get("method") == "shutdown":
                    self.stop = True

        t = threading.Thread(target=worker, args=(work, self.handle), daemon=True)
        t.start()
        tf = threading.Thread(target=worker, args=(fast, self.handle_lang), daemon=True)
        tf.start()
        for line in inp:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                self.send(_err(None, -32700, f"parse error: {e}"))
                continue
            if not isinstance(msg, dict):
                self.send(_err(None, -32600, "one JSON object per line"))
                continue
            if msg.get("method") == "$/cancel":
                cid = (msg.get("params") or {}).get("id")
                if cid is not None:
                    self.cancelled.add(cid)
                continue
            if msg.get("method") == "exit":
                break
            (fast if msg.get("method") in FAST else work).put(msg)
            if msg.get("method") == "shutdown":
                break
        work.put(None)
        fast.put(None)
        t.join()
        tf.join()
        return 0

    # ------------------------------------------------------------------ lifecycle
    def initialize(self, p: dict) -> dict:
        self.ws.update({k: v for k, v in p.items() if v is not None})
        loaded, failed = self._load_user_functions()
        from blackhole_dev import analysis as an
        an.set_workspace(self.ws.get("workspace"))
        from blackhole_dev.recipe import pipeline as pl
        return {"version": blackhole_dev.__version__, "python": sys.version.split()[0],
                "methods": sorted(self.methods), "pipeline": pl.HAVE_PIPELINE,
                "functions": {"loaded": loaded, "failed": failed}}

    def shutdown(self, p: dict) -> dict:
        return {}

    def _load_user_functions(self) -> tuple[list[str], list[dict]]:
        """The user's functions folder: WS3's registry takes the folders when it can, else each
        .py file is loaded here (a same-named function then fails to load and is reported)."""
        from blackhole_dev import functions as fns
        dirs = [d for d in (self.ws.get("functionsDir"),) if d]
        if hasattr(fns, "set_user_dirs"):
            fns.set_user_dirs(dirs)
            if hasattr(fns, "add_workspace") and self.ws.get("workspace"):
                fns.add_workspace(self.ws["workspace"])
            probs = fns.refresh() if hasattr(fns, "refresh") else []
            return [], [{"error": str(x)} for x in probs or []]
        loaded, failed = [], []
        for d in dirs:
            for f in fns.python_files(Path(d).expanduser()) if hasattr(fns, "python_files") else []:
                try:
                    fns.load(str(f))
                    loaded.append(str(f))
                except Exception as e:  # noqa: BLE001
                    failed.append({"file": str(f), "error": f"{type(e).__name__}: {e}"})
                    self.log(f"functions: {f.name}: {type(e).__name__}: {e}", "warning")
        return loaded, failed

    def _path(self, p: dict, key: str = "path") -> Path:
        if not p.get(key):
            raise RpcError(-32602, f"{key} is required")
        q = Path(p[key]).expanduser()
        return q if q.is_absolute() else Path(self.ws.get("workspace") or ".") / q

    def _load(self, p: dict):
        from blackhole_dev.recipe.loader import load
        return load(self._path(p), p.get("text"))

    # ------------------------------------------------------------------ recipes
    def recipe_lint(self, p: dict) -> dict:
        from blackhole_dev.recipe.lint import lint
        path = self._path(p)
        _r, probs = lint(path, p.get("text"), bool(p.get("publish")))
        return {"problems": [_problem(x, path) for x in probs]}

    def recipe_compile(self, p: dict) -> dict:
        from blackhole_dev.recipe.lint import lint_recipe
        path = self._path(p)
        r = self._load(p)
        return {"raw": r.to_raw(), "meta": r.meta, "runner": r.runner,
                "problems": [_problem(x, path) for x in lint_recipe(r)]}

    def recipe_steps(self, p: dict) -> dict:
        r = self._load(p)
        user = self._user_functions()
        steps = [{"name": st.id, "fn": st.fn or st.op, "kind": _kind(st), "detail": _detail(st), "line": st.line,
                  "user": any(n in user for n in st.functions())} for st in r.steps]
        return {"id": r.id, "version": r.version, "title": r.fields.get("title") or r.name,
                "base": r.fields.get("base"), "target": r.meta.get("target"), "doc": r.fields.get("description") or "",
                "runner": r.runner, "inputs": r.input_specs, "steps": steps}

    def recipe_plan(self, p: dict) -> dict:
        from blackhole_dev.recipe.plan import plan
        path = self._path(p)
        r = self._load(p)
        self.progress("opening the base model", 0.1)
        out = plan(r, device=p.get("device") or "mac16", model=p.get("model"), inputs=p.get("inputs"))
        out["problems"] = [_problem(x, path) for x in out["problems"]]
        return out

    def recipe_devices(self, p: dict) -> dict:
        from blackhole_dev.recipe.plan import devices
        return {"devices": devices()}

    def recipe_bundle(self, p: dict) -> dict:
        from blackhole_dev.recipe.bundle import bundle
        out = p.get("out")
        return bundle(self._path(p), out=self._path(p, "out") if out else None, inputs=p.get("inputs"),
                      model=p.get("model"), target=p.get("target"), text=p.get("text"))

    def _out_for(self, p: dict, stem: str) -> Path:
        if p.get("out"):
            return self._path(p, "out")
        d = Path(self.ws.get("recipesDir") or Path(self.ws.get("workspace") or ".") / "recipes").expanduser()
        d.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r"[^A-Za-z0-9_]", "_", stem)
        dst, n = d / f"{stem}.py", 2
        while dst.exists():
            dst, n = d / f"{stem}_{n}.py", n + 1
        return dst

    def recipe_from_toml(self, p: dict) -> dict:
        from blackhole_dev.recipe.convert import from_toml
        src_path = self._path(p)
        dst = self._out_for(p, src_path.stem)
        text = from_toml(src_path, dst)
        return {"path": str(dst), "text": text}

    def recipe_from_preset(self, p: dict) -> dict:
        from blackhole_dev.recipe.convert import from_preset
        if not p.get("id"):
            raise RpcError(-32602, "id is required")
        dst = self._out_for(p, p["id"])
        text = from_preset(p["id"], dst)
        return {"path": str(dst), "text": text}

    def recipe_presets(self, p: dict) -> dict:
        try:
            from blackhole_tui.catalog import SCHEMAS
        except ImportError:
            return {"presets": []}
        return {"presets": [{"id": s.id, "name": s.name, "author": s.author, "summary": s.summary,
                             "pipeline": bool(s.stage_list), "tags": list(s.tags)} for s in SCHEMAS]}

    def recipe_preset_files(self, p: dict) -> dict:
        from blackhole_dev.recipe import presets
        return {"presets": presets.files()}

    def recipe_copy_preset(self, p: dict) -> dict:
        from blackhole_dev.recipe import presets
        src = self._path(p, "file")
        dst = self._out_for({}, src.stem)
        try:
            text = presets.copy(src, dst)
        except ValueError as e:
            raise RpcError(-32602, str(e)) from None
        return {"path": str(dst), "text": text}

    # ------------------------------------------------------------------ anatomy
    def anatomy_open(self, p: dict) -> dict:
        from blackhole_dev.model import AnatomyError
        model = p.get("model")
        if not model:
            raise RpcError(-32602, "model is required")
        q = Path(model).expanduser()
        if not q.is_absolute() and (Path(self.ws.get("modelsDir") or "") / model).is_dir():
            q = Path(self.ws["modelsDir"]) / model
        self.progress(f"opening {model}", 0.1)
        try:
            self.model = blackhole_dev.open(q if q.is_dir() else model)
        except (AnatomyError, FileNotFoundError, OSError) as e:
            raise RpcError(MODEL_NOT_FOUND, f"cannot open {model}: {e}") from None
        except Exception as e:  # noqa: BLE001  hub errors and friends
            raise RpcError(MODEL_NOT_FOUND, f"cannot open {model}: {type(e).__name__}: {e}") from None
        m = self.model
        return {"id": m.id, "name": m.id.rstrip("/").split("/")[-1], "layers": len(m.layers),
                "kind": "moe" if m.info.experts else "dense", "summary": m.summary()}

    def _m(self):
        if self.model is None:
            raise RpcError(MODEL_NOT_FOUND, "no model open (anatomy.open first)")
        return self.model

    def anatomy_summary(self, p: dict) -> dict:
        m = self._m()
        i = m.info
        scores = []
        for L in m.layers:
            if L.moe is not None:
                sc = [e.attrs.get("score") for e in L.moe.experts]
                scores.append(sum(sc) / len(sc) if sc and all(s is not None for s in sc) else None)
        tree = [_node(x) for x in (m.embed,) if x is not None]
        tree += [_node(L) for L in m.layers]
        tree += [_node(x) for x in (m.norm, m.head) if x is not None]
        return {"name": m.id, "kind": "moe" if i.experts else "dense", "layers": len(m.layers),
                "expertsPerLayer": i.experts or None, "topK": i.top_k or None, "params": m.params,
                "layerScores": scores if any(s is not None for s in scores) else None, "tree": tree}

    def anatomy_children(self, p: dict) -> dict:
        part = self._part(p.get("path") or "")
        return {"nodes": [_node(c) for c in _children(part)]}

    def _part(self, path: str):
        m = self._m()
        sel = m.select(to_query(path))
        if len(sel) != 1:
            raise RpcError(-32602, f"{path!r} matches {len(sel)} parts; give one part's path")
        return sel[0]

    def anatomy_get(self, p: dict) -> dict:
        m = self._m()
        q = to_query(p.get("query") or p.get("path") or "")
        sel = m.select(q)
        insert = f'm["{q}"]'
        if len(sel) == 1:
            part = sel[0]
            info = part.info()
            rows = [("kind", info["kind"]), ("params", f"{info['params']:,}"), ("bytes", f"{info['bytes']:,}")]
            rows += [(k, _short(v)) for k, v in info.items()
                     if k not in ("path", "kind", "params", "bytes", "tensors") and not isinstance(v, (list, dict))]
            rows += [(t["name"].split(".")[-2] if "." in t["name"] else t["name"],
                      f"{t['dtype']} {t['shape']}" + (f" [{t['index']}]" if t.get("index") else ""))
                     for t in info["tensors"][:12]]
            return {"path": part.path, "query": q, "kind": info["kind"], "rows": rows, "insert": insert}
        params = sum(x.params for x in sel)
        kinds = sorted({x.kind for x in sel})
        return {"path": q, "query": q, "kind": "selection", "rows": [("parts", str(len(sel))),
                                                                    ("kinds", ", ".join(kinds)),
                                                                    ("params", f"{params:,}")],
                "insert": insert}

    # ------------------------------------------------------------------ functions (WS3's API when present)
    def _user_functions(self) -> set[str]:
        try:
            rows = self.functions_list({})
        except Exception:  # noqa: BLE001
            return set()
        return {r["name"] for r in rows if r.get("origin") in ("user", "override")}

    def functions_list(self, p: dict) -> list[dict]:
        from blackhole_dev import functions as fns
        if callable(getattr(fns, "rows", None)):
            if hasattr(fns, "refresh"):
                fns.refresh()                     # pick up saves in the user / workspace folders
            rows = fns.rows()
            out = []
            for r in rows:
                r = dict(r)
                r.setdefault("origin", "builtin" if r.get("builtin") else ("override" if r.get("overrides") else "user"))
                out.append(r)
            return out
        pkg = Path(blackhole_dev.__file__).resolve().parent
        out = []
        for name, f in fns.registry().items():
            src = Path(f.source) if str(f.source).endswith(".py") else None
            builtin = src is None or pkg in src.resolve().parents
            out.append({"name": name, "per": f.per, "doc": f.doc, "params": f.params,
                        "origin": "builtin" if builtin else "user", "path": str(src) if src else f.source,
                        "sha256": f.sha256})
        return out

    def functions_source(self, p: dict) -> dict:
        from blackhole_dev import functions as fns
        if callable(getattr(fns, "source", None)):
            r = dict(fns.source(p["name"]))
            r.setdefault("readonly", bool(r.get("builtin")))
            return r
        import inspect
        f = fns.get(p["name"])
        path = inspect.getsourcefile(f.fn) or ""
        pkg = Path(blackhole_dev.__file__).resolve().parent
        return {"name": f.name, "path": path, "text": Path(path).read_text() if path else inspect.getsource(f.fn),
                "readonly": bool(path) and pkg in Path(path).resolve().parents}

    def functions_fork(self, p: dict) -> dict:
        from blackhole_dev import functions as fns
        if callable(getattr(fns, "fork", None)):
            kw = {k: p[k] for k in ("dest", "new_name", "overwrite") if p.get(k)}
            if not kw.get("dest") and self.ws.get("functionsDir"):
                kw["dest"] = self.ws["functionsDir"]
            return dict(fns.fork(p["name"], **kw))
        raise RpcError(-32000, "fork arrives with the functions library (WS3); not in this blackhole_dev yet")


    # ------------------------------------------------------------------ analysis (plots and stats) and forks
    def analysis_list(self, p: dict) -> dict:
        from blackhole_dev import analysis as an
        probs = an.refresh()
        d = an.analysis_dir()
        return {"analyses": an.rows(), "problems": probs, "dir": str(d) if d else None,
                "model": self._model_brief(self.model)}

    def analysis_source(self, p: dict) -> dict:
        from blackhole_dev import analysis as an
        an.refresh()
        return an.source(p["name"])

    def analysis_fork(self, p: dict) -> dict:
        from blackhole_dev import analysis as an
        an.refresh()
        return an.fork(p["name"], new_name=p.get("newName") or None, overwrite=bool(p.get("overwrite")))

    def _analysis_model(self, p: dict):
        """The model a run is about: params.model (a folder or Hub id, kept open for the next
        run), else the one anatomy.open opened."""
        want = p.get("model")
        if not want:
            return self.model
        q = Path(want).expanduser()
        key = str(q)
        if self.amodel and self.amodel[0] == key:
            return self.amodel[1]
        from blackhole_dev.model import AnatomyError
        self.progress(f"opening {want}", 0.05)
        try:
            m = blackhole_dev.open(q if q.is_dir() else want)
        except (AnatomyError, FileNotFoundError, OSError) as e:
            raise RpcError(MODEL_NOT_FOUND, f"cannot open {want}: {e}") from None
        self.amodel = (key, m)
        return m

    def _analysis(self, p: dict):
        from blackhole_dev import analysis as an
        an.refresh()
        if p.get("name"):
            return an.get(p["name"])
        raise RpcError(-32602, "name or path is required")

    def analysis_estimate(self, p: dict) -> dict:
        from blackhole_dev import analysis as an
        m = self._analysis_model(p)
        if p.get("path") and not p.get("name"):
            return {"bytes": None, "known": False, "remote": an._remote(m), "seconds": None, "needs": "weights",
                    "model": self._model_brief(m)}
        a = self._analysis(p)
        if a.needs != "none" and m is None:
            raise RpcError(MODEL_NOT_FOUND, "open a model first (Analysis > Model, or anatomy.open)")
        est = an.estimate(a, m, p.get("params") or {})
        return {**est, "needs": a.needs, "model": self._model_brief(m)}

    def analysis_run(self, p: dict) -> dict:
        from blackhole_dev import analysis as an
        m = self._analysis_model(p)
        budget = p.get("budget")
        budget = None if budget is None else int(budget)
        self.progress("running", 0.1)
        if p.get("path") and not p.get("name"):
            an.refresh()
            return an.run_file(self._path(p), m, p.get("params") or {}, budget=budget, text=p.get("text"),
                               name=p.get("analysis"), progress=self.progress)
        a = self._analysis(p)
        if a.needs != "none" and m is None:
            raise RpcError(MODEL_NOT_FOUND, "open a model first (Analysis > Model, or anatomy.open)")
        return an.run(a, m, p.get("params") or {}, budget=budget, progress=self.progress)

    # ------------------------------------------------------------------ editor language support
    def lang_catalog(self, p: dict) -> dict:
        from blackhole_dev import lang
        out = lang.catalog(self._models_dirs(p))
        threading.Thread(target=lang.warm, daemon=True).start()
        return out

    def _lang_args(self, p: dict) -> tuple:
        return p.get("text") or "", int(p["line"]), int(p["col"]), str(self._path(p)) if p.get("path") else None

    def lang_complete(self, p: dict) -> dict:
        from blackhole_dev import lang
        return lang.complete(*self._lang_args(p))

    def lang_signatures(self, p: dict) -> dict:
        from blackhole_dev import lang
        return lang.signatures(*self._lang_args(p))

    def lang_hover(self, p: dict) -> dict:
        from blackhole_dev import lang
        return lang.hover(*self._lang_args(p))

    def _model_brief(self, m) -> dict | None:
        if m is None:
            return None
        return {"id": m.id, "path": str(m.root) if m.root else None, "name": str(m.id).rstrip("/").split("/")[-1],
                "layers": len(m.layers), "kind": "moe" if m.info.experts else "dense"}

    def _models_dirs(self, p: dict) -> list[str]:
        return [d for d in [*(p.get("dirs") or []), self.ws.get("modelsDir")] if d]

    def model_list(self, p: dict) -> dict:
        from blackhole_dev.fork import models
        return {"models": models(self._models_dirs(p))}

    def model_fork_plan(self, p: dict) -> dict:
        from blackhole_dev.fork import fork_plan
        return fork_plan(self._path(p, "src"), p.get("mode") or "link")

    def model_fork(self, p: dict) -> dict:
        from blackhole_dev.fork import fork
        out = fork(self._path(p, "src"), name=p.get("name") or None, dst=p.get("dst") or None,
                   mode=p.get("mode") or "link", note=p.get("note") or "")
        return out

    def model_lineage(self, p: dict) -> dict:
        from blackhole_dev.fork import lineage
        return {"lineage": lineage(self._path(p))}


# ---------------------------------------------------------------------- helpers


def to_query(path: str) -> str:
    """A part's path (layers.1.moe.experts.2) as a query (layers[1].moe.experts[2])."""
    return re.sub(r"\.(\d+)(?=\.|$)", r"[\1]", path.strip())


def _children(part) -> list:
    out = []
    for name in getattr(part, "children_names", ()):
        if name == "ffn":                       # an alias of mlp or moe
            continue
        c = getattr(part, name, None)
        if c is None:
            continue
        if isinstance(c, (list, tuple)):
            out += [x for x in c if x is not None and hasattr(x, "path")]
        elif isinstance(c, dict):
            out += [x for x in c.values() if hasattr(x, "path")]
        elif hasattr(c, "path"):
            out.append(c)
    return out


def _node(part) -> dict:
    label = part.path.split(".")[-1]
    if label.isdigit():
        label = ".".join(part.path.split(".")[-2:])
    extra = part.attrs.get("kind") if part.kind == "layer" else None
    n = {"path": part.path, "label": label + (f" · {extra}" if extra else ""), "kind": part.kind,
         "params": part.params}
    if getattr(part, "children_names", ()):
        n["lazy"] = True
    return n


def _kind(st) -> str:
    return {"pipeline": "pipeline", "job": "job"}.get(st.family, "function" if st.op == "model.edit" else "op")


def _detail(st) -> str:
    from blackhole_dev.recipe.plan import _detail as d
    from blackhole.core import schema as sch
    return d(st, {k: v for k, v in st.to_raw().items() if k not in sch.RESERVED})


def _short(v):
    return f"{v:.4g}" if isinstance(v, float) else str(v)


def _problem(x: dict, path: Path) -> dict:
    d = dict(x)
    d.setdefault("file", str(path))
    d.setdefault("line", 1)
    d.setdefault("severity", "error")
    return d


def _err(mid, code: int, message: str, data: Any = None) -> dict:
    e = {"code": code, "message": message}
    if data is not None:
        e["data"] = data
    return {"jsonrpc": "2.0", "id": mid, "error": e}


def _jsonable(o):
    if isinstance(o, Path):
        return str(o)
    if isinstance(o, (set, tuple)):
        return list(o)
    try:
        import numpy as np
        if isinstance(o, np.generic):
            return o.item()
    except ImportError:
        pass
    return str(o)


def main() -> int:
    sys.stdin.reconfigure(encoding="utf-8")
    out = sys.stdout
    out.reconfigure(encoding="utf-8")
    return Helper(out).serve(sys.stdin)


if __name__ == "__main__":
    sys.exit(main())
