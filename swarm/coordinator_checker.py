"""Pinned RSI source transport, shared by adapters; no role or lifecycle policy."""

from coordinator_io import path, pinned, require


def checker_sources(spec):
    require(isinstance(spec, dict) and set(spec) == {"root", "files"}, "invalid_checker_pin")
    root = path(spec["root"], directory=True)
    files = spec["files"]
    require(isinstance(files, dict) and "rsi/progress.py" in files and "rsi/__init__.py" in files,
            "checker_manifest_required")
    actual = {str(p.relative_to(root)) for p in (root / "rsi").rglob("*.py")}
    require(set(files) == actual, "checker_file_set_changed")
    return {name: pinned({"path": str(root / name), "sha256": sha}).decode("utf-8")
            for name, sha in files.items()}


# Execute verified bytes, not later disk imports or unpinned .pyc files. Each
# caller appends only its own fixed entry point, never code from a checkpoint.
LOADER = '''import importlib.abc, importlib.util, json, sys
request = json.load(sys.stdin)
class Loader(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != "rsi" and not fullname.startswith("rsi."): return None
        stem = fullname.replace(".", "/")
        package = stem + "/__init__.py" in request["sources"]
        filename = stem + ("/__init__.py" if package else ".py")
        if filename not in request["sources"]: raise ImportError("unpinned_checker_module")
        return importlib.util.spec_from_loader(fullname, self, origin=filename, is_package=package)
    def create_module(self, spec): return None
    def exec_module(self, module):
        module.__file__ = module.__spec__.origin
        exec(compile(request["sources"][module.__file__], module.__file__, "exec"), module.__dict__)
sys.meta_path.insert(0, Loader())
'''
