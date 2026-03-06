"""
ELBE UI - Backend API
Wraps 'elbe' CLI commands to provide a REST interface for managing
the ELBE initvm and build projects.
"""

import asyncio
import datetime
import json
import os
import re
import signal
import shutil
import subprocess
import pathlib
import threading
import time
import uuid
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, FileResponse
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Configuration – persisted in a JSON file, editable via /api/settings
# ---------------------------------------------------------------------------

SETTINGS_FILE = pathlib.Path(__file__).parent / "settings.json"
SETTINGS_DEFAULT_FILE = pathlib.Path(__file__).parent / "settings_default.json"

VM_CONFIG_FILE = ".vm_config.json"
SOAP_PORT_BASE = 7587

DEFAULT_SETTINGS = {
    "elbe_bin": "elbe",
    "vms_base_dir": "/workspace/.elbe/vms",
    "initvm_dir": "/workspace/.elbe/vms/initvm",
    "soap_host": "localhost",
    "soap_port": "7587",
    "workspace_dir": "/workspace",
    "projects_dir": "/workspace/projects",
    "upload_dir": "/workspace/uploads",
    "output_dir": "/workspace",
    "builds_dir": "",
    "sources_dir": "/workspace/sources",
    "packages_dir": "/workspace/packages",
    "qemu_bin": "qemu-system-x86_64",
    "qemu_memory": "1024",
    "qemu_extra_args": "",
    "max_concurrent_submits": 1,
    "maintainer": {
        "name": "",
        "email": "elbe-demo@local",
        "organization": "ELBE Demo Project",
    },
    "apt_repos": [
        {
            "label": "ELBE Demo Local",
            "type": "deb",
            "uri": "http://10.0.2.2:8080/repo/0",
            "suite": "./",
            "components": "",
            "arch": "",
            "signed_by": "",
            "trusted": True,
            "enabled": True,
            "local_dir": "/workspace/tools/elbe-demo-apt-repository",
        }
    ],
}


def _load_default_settings() -> dict:
    """Load settings_default.json, falling back to hardcoded defaults."""
    if SETTINGS_DEFAULT_FILE.exists():
        try:
            with open(SETTINGS_DEFAULT_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)


def _load_settings() -> dict:
    """Load settings from disk, merging defaults with user overrides."""
    s = _load_default_settings()
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE) as f:
                s.update(json.load(f))
        except Exception:
            pass
    return s


def _save_settings(s: dict):
    with open(SETTINGS_FILE, "w") as f:
        json.dump(s, f, indent=2)


def S(key: str) -> str:
    """Shortcut: get a single setting value."""
    return _load_settings().get(key, DEFAULT_SETTINGS.get(key, ""))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(args: list[str], timeout: int = 300) -> dict:
    """Execute a command and return stdout / stderr / returncode."""
    cmd_str = " ".join(args)
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
        )
        return {
            "command": cmd_str,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except subprocess.TimeoutExpired:
        return {"command": cmd_str, "returncode": -1, "stdout": "", "stderr": "Command timed out"}
    except FileNotFoundError:
        return {"command": cmd_str, "returncode": -1, "stdout": "", "stderr": f"Command not found: {args[0]}"}


def _elbe(*args: str, timeout: int = 300) -> dict:
    return _run([S("elbe_bin"), *args], timeout=timeout)


def _elbe_control(*args: str, timeout: int = 120) -> dict:
    return _run(
        [S("elbe_bin"), "control",
         "--host", S("soap_host"),
         "--port", S("soap_port"),
         *args],
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="ELBE UI", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve the SPA
spa_dir = pathlib.Path(__file__).parent / "spa"
if spa_dir.is_dir():
    app.mount("/spa", StaticFiles(directory=str(spa_dir), html=True), name="spa")


# Serve local APT repo directories as static files under /repo/<index>/
# The repos are mounted lazily at startup from settings.
def _mount_repo_dirs():
    """Mount each local APT repo's repo/ directory as a static file route."""
    settings = _load_settings()
    repos = settings.get("apt_repos", [])
    for i, r in enumerate(repos):
        ld = r.get("local_dir", "")
        if not ld:
            continue
        repo_dir = pathlib.Path(ld) / "repo"
        if repo_dir.is_dir():
            route = f"/repo/{i}"
            try:
                app.mount(route, StaticFiles(directory=str(repo_dir)), name=f"apt-repo-{i}")
            except Exception:
                pass

_mount_repo_dirs()


@app.get("/")
def root():
    return RedirectResponse(url="/spa/index.html")


# ===========================================================================
# SETTINGS
# ===========================================================================

@app.get("/api/settings")
def get_settings():
    return _load_settings()


@app.put("/api/settings")
async def update_settings(request: Request):
    body = await request.json()
    s = _load_settings()
    s.update(body)
    _save_settings(s)
    return s


# ===========================================================================
# MAINTAINER
# ===========================================================================

GNUPG_HOME = pathlib.Path(__file__).parent / ".gnupg"


def _maintainer() -> dict:
    """Return the maintainer dict from settings."""
    return _load_settings().get("maintainer", DEFAULT_SETTINGS["maintainer"])


def _maintainer_formatted() -> str:
    """Return 'Name <email>' for use in debian/control etc."""
    m = _maintainer()
    if m.get("name") and m.get("email"):
        return f"{m['name']} <{m['email']}>"
    return m.get("email", "elbe-demo@local")


@app.get("/api/maintainer")
def get_maintainer():
    return _maintainer()


@app.put("/api/maintainer")
async def update_maintainer(request: Request):
    body = await request.json()
    s = _load_settings()
    m = s.get("maintainer", dict(DEFAULT_SETTINGS["maintainer"]))
    m.update(body)
    s["maintainer"] = m
    _save_settings(s)
    return m


@app.get("/api/maintainer/gpg-keys")
def list_gpg_keys():
    """List GPG keys in the maintainer keyring."""
    GNUPG_HOME.mkdir(parents=True, exist_ok=True)
    result = _run([
        "gpg", "--homedir", str(GNUPG_HOME), "--batch",
        "--list-keys", "--with-colons", "--keyid-format", "long",
    ], timeout=30)
    keys = []
    if result["returncode"] == 0:
        lines = result["stdout"].splitlines()
        current = {}
        for line in lines:
            parts = line.split(":")
            if parts[0] == "pub":
                current = {
                    "algo": parts[3],
                    "keyid": parts[4],
                    "created": parts[5],
                    "expires": parts[6] or "never",
                    "expired": parts[1] == "e",
                }
                keys.append(current)
            elif parts[0] == "uid" and current:
                current["uid"] = parts[9]
    return {"keys": keys}


@app.post("/api/maintainer/gpg-keys/generate")
def generate_gpg_key():
    """Generate a new GPG key using the maintainer identity."""
    m = _maintainer()
    if not m.get("name") or not m.get("email"):
        raise HTTPException(status_code=400, detail="Maintainer name and email are required")
    GNUPG_HOME.mkdir(parents=True, exist_ok=True)
    os.chmod(str(GNUPG_HOME), 0o700)

    batch_input = f"""Key-Type: RSA
Key-Length: 4096
Name-Real: {m['name']}
Name-Email: {m['email']}
Expire-Date: 0
%no-protection
%commit
"""
    result = subprocess.run(
        ["gpg", "--homedir", str(GNUPG_HOME), "--batch", "--gen-key"],
        input=batch_input, capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        return {"error": result.stderr.strip(), "returncode": result.returncode}

    # Get the key ID of the newly generated key
    list_result = _run([
        "gpg", "--homedir", str(GNUPG_HOME), "--batch",
        "--list-keys", "--with-colons", "--keyid-format", "long", m["email"],
    ], timeout=15)
    keyid = ""
    for line in list_result.get("stdout", "").splitlines():
        parts = line.split(":")
        if parts[0] == "pub":
            keyid = parts[4]
    return {"keyid": keyid, "email": m["email"], "returncode": 0}


@app.get("/api/maintainer/gpg-keys/export-public")
def export_public_key():
    """Export the maintainer's public GPG key (ASCII-armored)."""
    m = _maintainer()
    if not m.get("email"):
        raise HTTPException(status_code=400, detail="Maintainer email not set")
    result = _run([
        "gpg", "--homedir", str(GNUPG_HOME), "--batch",
        "--armor", "--export", m["email"],
    ], timeout=15)
    if result["returncode"] == 0 and result["stdout"]:
        return {"public_key": result["stdout"]}
    return {"error": "No public key found for " + m["email"]}


class CopyKeysToRepoRequest(BaseModel):
    repo_index: int = 0


@app.post("/api/maintainer/gpg-keys/copy-to-repo")
def copy_keys_to_repo(req: CopyKeysToRepoRequest):
    """Copy the maintainer's GPG keys into a local APT repo's keys/ directory."""
    m = _maintainer()
    if not m.get("email"):
        raise HTTPException(status_code=400, detail="Maintainer email not set")
    r = _get_repo(req.repo_index)
    ld = _repo_local_dir(r)
    if not ld:
        raise HTTPException(status_code=400, detail="Repo has no local directory")

    keys_dir = ld / "keys"
    keys_dir.mkdir(parents=True, exist_ok=True)
    gnupg_dir = ld / ".gnupg"
    gnupg_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(str(gnupg_dir), 0o700)

    # Export private key to repo's keys/
    priv = _run([
        "gpg", "--homedir", str(GNUPG_HOME), "--batch",
        "--armor", "--export-secret-keys", m["email"],
    ], timeout=15)
    if priv["returncode"] != 0 or not priv["stdout"]:
        return {"error": "Failed to export private key", "copied": False}
    (keys_dir / "private.gpg").write_text(priv["stdout"])
    os.chmod(str(keys_dir / "private.gpg"), 0o600)

    # Export public key to repo's keys/
    pub = _run([
        "gpg", "--homedir", str(GNUPG_HOME), "--batch",
        "--armor", "--export", m["email"],
    ], timeout=15)
    if pub["returncode"] == 0 and pub["stdout"]:
        (keys_dir / "public.asc").write_text(pub["stdout"])

    # Export binary public key to repo/repo-key.gpg
    repo_dir = ld / "repo"
    repo_dir.mkdir(parents=True, exist_ok=True)
    bin_result = subprocess.run(
        ["gpg", "--homedir", str(GNUPG_HOME), "--batch", "--export", m["email"]],
        capture_output=True, timeout=15,
    )
    if bin_result.returncode == 0 and bin_result.stdout:
        (repo_dir / "repo-key.gpg").write_bytes(bin_result.stdout)

    # Import into the repo's local .gnupg so build-repo.sh can sign
    _run([
        "gpg", "--homedir", str(gnupg_dir), "--batch",
        "--import", str(keys_dir / "private.gpg"),
    ], timeout=15)

    # Auto-fill signed_by in the repo config to point to the public keyring
    settings = _load_settings()
    repos = settings.get("apt_repos", [])
    if 0 <= req.repo_index < len(repos):
        repos[req.repo_index]["signed_by"] = str(repo_dir / "repo-key.gpg")
        settings["apt_repos"] = repos
        _save_settings(settings)

    return {"copied": True, "keys_dir": str(keys_dir)}


# ===========================================================================
# INITVM
# ===========================================================================

@app.get("/api/initvm/status")
def initvm_status():
    ps = _run(["pgrep", "-af", "qemu.*initvm"], timeout=10)
    qemu_running = ps["returncode"] == 0
    soap = _elbe_control("list_projects", timeout=15)
    soap_reachable = soap["returncode"] == 0
    return {
        "qemu_running": qemu_running,
        "soap_reachable": soap_reachable,
        "detail": ps["stdout"] if qemu_running else "No QEMU process found",
    }


@app.post("/api/initvm/start")
def initvm_start():
    return _elbe("initvm", "start", "--qemu", "--directory", S("initvm_dir"), timeout=120)


@app.post("/api/initvm/stop")
def initvm_stop():
    return _elbe("initvm", "stop", "--qemu", "--directory", S("initvm_dir"), timeout=60)


@app.post("/api/initvm/ensure")
def initvm_ensure():
    return _elbe("initvm", "ensure", "--qemu", "--directory", S("initvm_dir"), timeout=120)


class CreateInitvmRequest(BaseModel):
    xml_path: Optional[str] = None
    skip_build_sources: bool = True


@app.post("/api/initvm/create")
def initvm_create(req: CreateInitvmRequest):
    """Create a brand-new initvm (takes 15-30 min).

    Refuses to run if the initvm directory already exists or if QEMU is
    already running, to prevent accidental data loss.
    """
    initvm_dir = pathlib.Path(S("initvm_dir"))
    # Guard: refuse if the initvm directory already exists
    if initvm_dir.is_dir() and any(initvm_dir.iterdir()):
        raise HTTPException(
            status_code=409,
            detail=f"InitVM directory already exists and is not empty: {initvm_dir}. "
                   "Delete it manually first if you really want to recreate.",
        )
    # Guard: refuse if QEMU is already running
    ps = _run(["pgrep", "-af", "qemu.*initvm"], timeout=10)
    if ps["returncode"] == 0:
        raise HTTPException(
            status_code=409,
            detail="A QEMU initvm process is already running. Stop it first.",
        )

    args = ["initvm", "create", "--qemu", "--directory", str(initvm_dir)]
    if req.skip_build_sources:
        args.append("--skip-build-sources")
    if req.xml_path:
        args.append(req.xml_path)
    return _elbe(*args, timeout=2400)


# ===========================================================================
# VM MANAGEMENT (multi-VM)
# ===========================================================================

def _vm_dir(name: str) -> pathlib.Path:
    return pathlib.Path(S("vms_base_dir")) / name


def _read_vm_config(vm_path: pathlib.Path) -> dict:
    cfg = vm_path / VM_CONFIG_FILE
    if cfg.exists():
        try:
            return json.loads(cfg.read_text())
        except Exception:
            pass
    return {}


def _write_vm_config(vm_path: pathlib.Path, cfg: dict):
    vm_path.mkdir(parents=True, exist_ok=True)
    (vm_path / VM_CONFIG_FILE).write_text(json.dumps(cfg, indent=2))


def _list_vms_raw() -> list[dict]:
    base = pathlib.Path(S("vms_base_dir"))
    if not base.is_dir():
        return []
    vms = []
    for d in sorted(base.iterdir()):
        if d.is_dir():
            cfg = _read_vm_config(d)
            soap_port = cfg.get("soap_port", SOAP_PORT_BASE)
            vms.append({"name": d.name, "path": str(d), "soap_port": soap_port})
    return vms


def _next_soap_port() -> int:
    ports = [v["soap_port"] for v in _list_vms_raw()]
    return max(ports, default=SOAP_PORT_BASE - 1) + 1


def _vm_qemu_running(vm_path: str) -> bool:
    """Return True if a qemu-system process has its cwd inside vm_path."""
    target = str(pathlib.Path(vm_path).resolve())
    for pid_dir in pathlib.Path("/proc").glob("[0-9]*"):
        try:
            exe = (pid_dir / "exe").resolve().name
            if "qemu" not in exe:
                continue
            cwd = os.readlink(str(pid_dir / "cwd"))
            if cwd == target:
                return True
        except OSError:
            continue
    return False


def _vm_soap_reachable(soap_port: int) -> bool:
    result = _run(
        [S("elbe_bin"), "control", "--host", S("soap_host"), "--port", str(soap_port), "list_projects"],
        timeout=15,
    )
    return result["returncode"] == 0


def _set_active_vm(vm_path: str, soap_port: int):
    """Update initvm_dir and soap_port in settings to point to the given VM."""
    s = _load_settings()
    s["initvm_dir"] = vm_path
    s["soap_port"] = str(soap_port)
    _save_settings(s)


class CreateVMRequest(BaseModel):
    name: str = "initvm"
    soap_port: Optional[int] = None
    skip_build_sources: bool = True


def _vm_state(vm_path: pathlib.Path, qemu_running: bool, soap_reachable: bool) -> str:
    """Derive a single state string for the VM.

    States:
      not_created   — only .vm_config.json exists, never started create
      creating      — QEMU running installer (no initvm.img yet)
      create_failed — QEMU stopped but no initvm.img (create was interrupted)
      stopped       — initvm.img present, QEMU not running
      starting      — initvm.img present, QEMU running, SOAP not yet up
      running       — initvm.img present, QEMU running, SOAP reachable
    """
    has_final = (vm_path / "initvm.img").exists()
    has_artifacts = any(
        p.name not in (".vm_config.json",) for p in vm_path.iterdir()
    )
    if qemu_running:
        if soap_reachable:
            return "running"
        return "creating" if not has_final else "starting"
    if has_final:
        return "stopped"
    return "create_failed" if has_artifacts else "not_created"


@app.get("/api/initvms")
def list_initvms():
    vms = _list_vms_raw()
    result = []
    for vm in vms:
        vm_path = pathlib.Path(vm["path"])
        running = _vm_qemu_running(vm["path"])
        soap_ok = _vm_soap_reachable(vm["soap_port"]) if running else False
        state = _vm_state(vm_path, running, soap_ok)
        result.append({**vm, "qemu_running": running, "soap_reachable": soap_ok, "state": state})
    return {"vms": result, "max_vms": int(S("max_vms") or 1)}


@app.post("/api/initvms")
def create_initvm_vm(req: CreateVMRequest):
    """Create a new named initvm under vms_base_dir (takes 15-30 min)."""
    max_vms = int(S("max_vms") or 1)
    current_count = len(_list_vms_raw())
    if current_count >= max_vms:
        raise HTTPException(
            status_code=409,
            detail=f"Maximum number of VMs ({max_vms}) reached. Increase max_vms in Settings to add more.",
        )
    vm_path = _vm_dir(req.name)
    non_config = [p for p in vm_path.iterdir() if p.name != VM_CONFIG_FILE] if vm_path.is_dir() else []
    if non_config:
        raise HTTPException(409, detail=f"VM '{req.name}' already exists.")
    soap_port = req.soap_port or _next_soap_port()
    _write_vm_config(vm_path, {"soap_port": soap_port})
    args = [
        "initvm", "create", "--qemu",
        "--directory", str(vm_path),
        "--port", str(soap_port),
    ]
    if req.skip_build_sources:
        args.append("--skip-build-sources")
    result = _elbe(*args, timeout=2400)
    if result["returncode"] == 0:
        _set_active_vm(str(vm_path), soap_port)
    return {**result, "name": req.name, "path": str(vm_path), "soap_port": soap_port}


@app.post("/api/initvms/{name}/start")
def start_initvm_vm(name: str):
    vm_path = _vm_dir(name)
    if not vm_path.is_dir():
        raise HTTPException(404, detail=f"VM '{name}' not found.")
    if not (vm_path / "initvm.img").exists():
        raise HTTPException(
            409,
            detail=f"VM '{name}' has not been fully created yet (initvm.img missing). Use '↺ Create' to create it first.",
        )
    cfg = _read_vm_config(vm_path)
    soap_port = cfg.get("soap_port", SOAP_PORT_BASE)
    log_dir = pathlib.Path(S("vms_base_dir")).parent / "logs"
    log_file = log_dir / f"{name}.log"

    def _do_start():
        result = _elbe(
            "initvm", "start", "--qemu",
            "--directory", str(vm_path),
            "--port", str(soap_port),
            timeout=300,
        )
        try:
            with open(log_file, "w") as f:
                f.write(f"$ {result['command']}\n")
                if result["stdout"]:
                    f.write(result["stdout"] + "\n")
                if result["stderr"]:
                    f.write(result["stderr"] + "\n")
                f.write(f"\n→ exit code: {result['returncode']}\n")
        except Exception:
            pass
        if result["returncode"] == 0:
            _set_active_vm(str(vm_path), soap_port)

    threading.Thread(target=_do_start, daemon=True).start()
    _set_active_vm(str(vm_path), soap_port)
    return {
        "started": True,
        "name": name,
        "soap_port": soap_port,
        "command": f"elbe initvm start --qemu --directory {vm_path} --port {soap_port} (background)",
        "returncode": 0,
        "stdout": "Start initiated in background. Check status badges — SOAP Daemon OK will appear when ready.",
        "stderr": "",
    }


@app.post("/api/initvms/{name}/stop")
def stop_initvm_vm(name: str):
    vm_path = _vm_dir(name)
    if not vm_path.is_dir():
        raise HTTPException(404, detail=f"VM '{name}' not found.")
    cfg = _read_vm_config(vm_path)
    soap_port = cfg.get("soap_port", SOAP_PORT_BASE)
    return _elbe(
        "initvm", "stop", "--qemu",
        "--directory", str(vm_path),
        "--port", str(soap_port),
        timeout=60,
    )


@app.get("/api/initvms/{name}/status")
def initvm_vm_status(name: str):
    """Run 'elbe control status' against this VM's SOAP daemon."""
    vm_path = _vm_dir(name)
    if not vm_path.is_dir():
        raise HTTPException(404, detail=f"VM '{name}' not found.")
    cfg = _read_vm_config(vm_path)
    soap_port = cfg.get("soap_port", SOAP_PORT_BASE)
    return _run(
        [S("elbe_bin"), "control", "--host", S("soap_host"), "--port", str(soap_port), "status"],
        timeout=15,
    )


@app.get("/api/initvms/{name}/log")
def initvm_vm_log(name: str, tail: int = 200):
    """Return the tail of the initvm create/start log for this VM.

    Combines the main session log with the QEMU installer.log (which
    contains the Debian preseed output — the real create progress).
    """
    vm_path = _vm_dir(name)
    log_dir = pathlib.Path(S("vms_base_dir")).parent / "logs"
    parts = []

    main_log = log_dir / f"{name}.log"
    if main_log.exists():
        try:
            content = main_log.read_text(errors="replace").strip()
            if content:
                parts.append(f"# {main_log}\n{content}")
        except Exception:
            pass

    # QEMU serial output — actual Debian installer progress
    installer_log = vm_path / "installer.log"
    if installer_log.exists():
        try:
            content = installer_log.read_text(errors="replace").strip()
            if content:
                parts.append(f"# {installer_log} (QEMU serial)\n{content}")
        except Exception:
            pass

    if not parts:
        return {"log": "(no log output yet — create may still be initialising)", "found": False}

    combined = "\n\n".join(parts)
    lines = combined.splitlines()
    if tail:
        lines = lines[-tail:]
    return {"log": "\n".join(lines), "found": True}


@app.post("/api/initvms/{name}/retry-create")
def retry_create_initvm_vm(name: str):
    """Remove partial create artifacts and re-run elbe initvm create."""
    vm_path = _vm_dir(name)
    if not vm_path.is_dir():
        raise HTTPException(404, detail=f"VM '{name}' not found.")
    if _vm_qemu_running(str(vm_path)):
        raise HTTPException(409, detail=f"VM '{name}' is running. Stop it first.")
    cfg = _read_vm_config(vm_path)
    soap_port = cfg.get("soap_port", SOAP_PORT_BASE)
    log_dir = pathlib.Path(S("vms_base_dir")).parent / "logs"
    log_file = log_dir / f"{name}.log"

    # Remove partial artifacts, keep .vm_config.json
    for item in vm_path.iterdir():
        if item.name == VM_CONFIG_FILE:
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()

    def _do_create():
        result = _elbe(
            "initvm", "create", "--qemu",
            "--directory", str(vm_path),
            "--port", str(soap_port),
            "--skip-build-sources",
            timeout=2400,
        )
        try:
            with open(log_file, "w") as f:
                f.write(f"$ {result['command']}\n")
                if result["stdout"]:
                    f.write(result["stdout"] + "\n")
                if result["stderr"]:
                    f.write(result["stderr"] + "\n")
                f.write(f"\n→ exit code: {result['returncode']}\n")
        except Exception:
            pass
        if result["returncode"] == 0:
            _elbe("initvm", "start", "--qemu",
                  "--directory", str(vm_path),
                  "--port", str(soap_port),
                  timeout=300)
            _set_active_vm(str(vm_path), soap_port)

    threading.Thread(target=_do_create, daemon=True).start()
    return {"retrying": True, "name": name, "soap_port": soap_port}


@app.delete("/api/initvms/{name}")
def delete_initvm_vm(name: str):
    vm_path = _vm_dir(name)
    if not vm_path.is_dir():
        raise HTTPException(404, detail=f"VM '{name}' not found.")
    if _vm_qemu_running(str(vm_path)):
        raise HTTPException(409, detail=f"VM '{name}' is running. Stop it first.")
    shutil.rmtree(vm_path)
    return {"deleted": True, "name": name}


# ===========================================================================
# PROJECTS (via elbe control → SOAP daemon)
# ===========================================================================

@app.get("/api/projects")
def list_projects():
    result = _elbe_control("list_projects")
    if result["returncode"] != 0:
        return {"projects": [], "error": result["stderr"]}
    projects = []
    for line in result["stdout"].splitlines():
        parts = line.split("\t")
        if len(parts) >= 4:
            projects.append({
                "build_dir": parts[0].strip(),
                "name": parts[1].strip(),
                "version": parts[2].strip(),
                "status": parts[3].strip(),
                "edit": parts[4].strip() if len(parts) > 4 else "",
            })
    return {"projects": projects}


@app.post("/api/projects/create")
def create_project():
    result = _elbe_control("create_project")
    if result["returncode"] != 0:
        raise HTTPException(status_code=500, detail=result["stderr"])
    return {"build_dir": result["stdout"].strip()}


class SetXmlRequest(BaseModel):
    build_dir: str
    xml_path: str


@app.post("/api/projects/set_xml")
def set_xml(req: SetXmlRequest):
    return _elbe_control("set_xml", req.build_dir, req.xml_path)


class BuildRequest(BaseModel):
    build_dir: str


@app.post("/api/projects/build")
def build_project(req: BuildRequest):
    return _elbe_control("build", req.build_dir)


@app.post("/api/projects/wait_busy")
def wait_busy(req: BuildRequest):
    return _elbe_control("wait_busy", req.build_dir, timeout=600)


@app.get("/api/projects/{build_dir:path}/files")
def get_files(build_dir: str):
    result = _elbe_control("get_files", build_dir)
    if result["returncode"] != 0:
        return {"files": [], "error": result["stderr"]}
    files = []
    for line in result["stdout"].splitlines():
        parts = line.split("\t")
        files.append({
            "name": parts[0].strip(),
            "description": parts[1].strip() if len(parts) > 1 else "",
        })
    return {"files": files}


class DownloadRequest(BaseModel):
    build_dir: str
    filename: str
    output_dir: Optional[str] = None


@app.post("/api/projects/download_file")
def download_file(req: DownloadRequest):
    """Download a single file from the initvm project to the local filesystem."""
    out = req.output_dir or S("output_dir")
    result = _elbe_control("get_file", req.build_dir, req.filename,
                           "--output", out, timeout=300)
    return result


@app.post("/api/projects/download_all")
def download_all_files(req: BuildRequest):
    """Download all files from the initvm project to the local filesystem."""
    out = S("output_dir")
    result = _elbe_control("get_files", req.build_dir, "--output", out, timeout=600)
    return result


class DeleteRequest(BaseModel):
    build_dir: str
    delete_local: bool = False


@app.post("/api/projects/delete")
def delete_project(req: DeleteRequest):
    result = _elbe_control("del_project", req.build_dir)
    if req.delete_local:
        local = pathlib.Path(req.build_dir)
        if local.is_dir():
            shutil.rmtree(local, ignore_errors=True)
    return result


@app.post("/api/projects/delete_all")
def delete_all_projects():
    return _elbe_control("del_all_projects")


@app.post("/api/projects/purge_all")
def purge_all_projects():
    """Reset + delete all projects (including busy ones)."""
    result = _elbe_control("list_projects")
    if result.get("returncode") != 0:
        return result
    deleted = []
    errors = []
    for line in result.get("stdout", "").strip().splitlines():
        parts = line.split("\t")
        if not parts:
            continue
        build_dir = parts[0].strip()
        _elbe_control("reset_project", build_dir)
        r = _elbe_control("del_project", build_dir)
        if r.get("returncode") == 0:
            deleted.append(build_dir)
        else:
            errors.append({"dir": build_dir, "error": r.get("stderr", "")})
    return {"deleted": deleted, "errors": errors}


@app.post("/api/projects/reset")
def reset_project(req: BuildRequest):
    return _elbe_control("reset_project", req.build_dir)


# ===========================================================================
# SUBMIT (high-level)
# ===========================================================================

class SubmitRequest(BaseModel):
    xml_path: str
    build_bin: bool = False
    build_sources: bool = False


# --- Background submit tracking ---
_submit_jobs: dict[str, dict] = {}   # job_id → {status, xml, log, proc, ...}
_JOBS_DIR = pathlib.Path(__file__).parent / ".jobs"


def _persist_job(job: dict):
    """Persist job state to disk so it survives Uvicorn reloads."""
    _JOBS_DIR.mkdir(exist_ok=True)
    data = {k: v for k, v in job.items() if k != "proc"}
    (_JOBS_DIR / f"{job['id']}.json").write_text(json.dumps(data, default=str))


def _load_persisted_jobs():
    """Load jobs from disk on startup (after Uvicorn reload)."""
    if not _JOBS_DIR.is_dir():
        return
    for f in _JOBS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            jid = data["id"]
            if jid not in _submit_jobs:
                # If it was running before reload, mark as lost
                if data.get("status") == "running":
                    data["status"] = "failed"
                    data["log"] = data.get("log", "") + "\n[WARN] Job lost due to server restart.\n"
                    data["finished_at"] = data.get("finished_at") or time.time()
                _submit_jobs[jid] = data
        except Exception:
            pass


_load_persisted_jobs()

# --- Submit queue / concurrency control ---
_submit_queue: list[tuple[str, list[str]]] = []   # [(job_id, args), ...]
_submit_lock = threading.Lock()


def _parse_initvm_build_dir(log: str) -> str | None:
    """Extract the initvm project path from a submit log.

    After a failed build, elbe prints lines like:
        elbe control get_files --output "..." "/var/cache/elbe/<uuid>"
        elbe control del_project "/var/cache/elbe/<uuid>"
    We extract the /var/cache/elbe/<uuid> path.
    """
    # Match the project path from either get_files or del_project lines
    m = re.search(
        r'elbe control (?:get_files|del_project)\s+.*"(/var/cache/elbe/[^"]+)"',
        log,
    )
    return m.group(1) if m else None


def _try_recover_files(job: dict):
    """After a failed submit, try to download whatever files were built."""
    initvm_dir = _parse_initvm_build_dir(job["log"])
    if not initvm_dir:
        return
    job["initvm_build_dir"] = initvm_dir
    job["log"] += f"\n[ELBE-UI] Detected initvm project: {initvm_dir}\n"
    job["log"] += "[ELBE-UI] Attempting to recover build artifacts…\n"
    _persist_job(job)

    out_dir = job.get("output_dir", "")
    if not out_dir:
        return

    result = _elbe_control("get_files", initvm_dir, "--output", out_dir, timeout=600)
    if result["returncode"] == 0:
        # Check if any files were actually downloaded
        out_path = pathlib.Path(out_dir)
        downloaded = [f.name for f in out_path.iterdir() if f.is_file()] if out_path.is_dir() else []
        if downloaded:
            job["status"] = "partial"
            job["log"] += f"[ELBE-UI] Recovered {len(downloaded)} file(s): {', '.join(downloaded)}\n"
        else:
            job["log"] += "[ELBE-UI] get_files succeeded but no files found in output dir.\n"
    else:
        job["log"] += f"[ELBE-UI] Failed to recover files: {result.get('stderr', '')}\n"
    _persist_job(job)


def _submit_worker(job_id: str, args: list[str]):
    """Run elbe submit in a background thread, streaming output to job log."""
    job = _submit_jobs[job_id]
    job["status"] = "running"
    job["started_at"] = time.time()
    _persist_job(job)
    try:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, env=env,
        )
        job["pid"] = proc.pid
        _persist_job(job)
        for line in proc.stdout:
            job["log"] += line
        proc.wait()
        job["returncode"] = proc.returncode
        job["status"] = "success" if proc.returncode == 0 else "failed"
    except Exception as e:
        job["log"] += f"\n[ERROR] {e}\n"
        job["returncode"] = -1
        job["status"] = "failed"

    # On failure, try to recover build artifacts from the initvm
    if job["status"] == "failed":
        try:
            _try_recover_files(job)
        except Exception as e:
            job["log"] += f"\n[ELBE-UI] Error during file recovery: {e}\n"

    job["finished_at"] = time.time()
    _persist_job(job)
    # After finishing, try to dispatch the next queued job
    _dispatch_next_submit()


def _count_running_submits() -> int:
    return sum(1 for j in _submit_jobs.values() if j["status"] == "running")


def _dispatch_next_submit():
    """Start the next queued job if concurrency limit allows."""
    with _submit_lock:
        max_c = int(S("max_concurrent_submits") or 1)
        while _submit_queue and _count_running_submits() < max_c:
            job_id, args = _submit_queue.pop(0)
            if job_id in _submit_jobs and _submit_jobs[job_id]["status"] == "queued":
                t = threading.Thread(target=_submit_worker, args=(job_id, args), daemon=True)
                t.start()


def _enqueue_submit(job_id: str, args: list[str]):
    """Add a job to the queue and try to dispatch immediately."""
    with _submit_lock:
        _submit_queue.append((job_id, args))
    _dispatch_next_submit()


@app.post("/api/submit")
def submit(req: SubmitRequest):
    """Submit a build in the background. Returns a job_id to track progress."""
    job_id = str(uuid.uuid4())[:8]
    # Create per-job output directory under builds/
    out_dir = pathlib.Path(S("output_dir")) / "builds" / f"{pathlib.Path(req.xml_path).stem}-{job_id}"
    out_dir.mkdir(parents=True, exist_ok=True)

    args = [S("elbe_bin"), "initvm", "submit", "--qemu",
            "--directory", S("initvm_dir"),
            "--output", str(out_dir)]
    if req.build_bin:
        args.append("--build-bin")
    if req.build_sources:
        args.append("--build-sources")
    args.append(req.xml_path)

    _submit_jobs[job_id] = {
        "id": job_id,
        "xml_path": req.xml_path,
        "xml_name": pathlib.Path(req.xml_path).stem,
        "output_dir": str(out_dir),
        "initvm_build_dir": None,
        "status": "queued",
        "log": "",
        "returncode": None,
        "pid": None,
        "started_at": None,
        "finished_at": None,
    }
    _persist_job(_submit_jobs[job_id])
    _enqueue_submit(job_id, args)

    running = _count_running_submits()
    max_c = int(S("max_concurrent_submits") or 1)
    queued = sum(1 for j in _submit_jobs.values() if j["status"] == "queued")
    return {"job_id": job_id, "status": "queued", "running": running, "max": max_c, "queued": queued}


@app.get("/api/submit/jobs")
def list_submit_jobs():
    """List all submit jobs (running + finished)."""
    jobs = []
    for j in _submit_jobs.values():
        jobs.append({
            "id": j["id"],
            "xml_name": j.get("xml_name", ""),
            "xml_path": j.get("xml_path", ""),
            "output_dir": j.get("output_dir", ""),
            "initvm_build_dir": j.get("initvm_build_dir"),
            "status": j["status"],
            "returncode": j["returncode"],
            "pid": j.get("pid"),
            "started_at": j.get("started_at"),
            "finished_at": j.get("finished_at"),
            "log_lines": j["log"].count("\n"),
        })
    return {"jobs": jobs}


@app.get("/api/submit/jobs/{job_id}")
def get_submit_job(job_id: str):
    """Get full details + log for a submit job."""
    if job_id not in _submit_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return _submit_jobs[job_id]


@app.get("/api/submit/jobs/{job_id}/log")
def get_submit_log(job_id: str, tail: int = 0):
    """Get the log output. Use tail=N to get only last N lines."""
    if job_id not in _submit_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    log = _submit_jobs[job_id]["log"]
    if tail > 0:
        lines = log.splitlines()
        log = "\n".join(lines[-tail:])
    return {"log": log, "status": _submit_jobs[job_id]["status"]}


@app.post("/api/submit/jobs/{job_id}/cancel")
def cancel_submit_job(job_id: str):
    """Kill a running submit job."""
    if job_id not in _submit_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = _submit_jobs[job_id]
    if job["status"] != "running" or not job.get("pid"):
        return {"cancelled": False, "reason": "Job is not running"}
    try:
        os.kill(job["pid"], signal.SIGTERM)
        job["status"] = "cancelled"
        job["finished_at"] = time.time()
        _persist_job(job)
        return {"cancelled": True}
    except ProcessLookupError:
        return {"cancelled": False, "reason": "Process already finished"}


@app.post("/api/submit/jobs/{job_id}/remove")
def remove_submit_job(job_id: str):
    """Remove a finished job from the list."""
    if job_id not in _submit_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    if _submit_jobs[job_id]["status"] == "running":
        return {"removed": False, "reason": "Cannot remove a running job"}
    # Remove from disk too
    jf = _JOBS_DIR / f"{job_id}.json"
    if jf.exists():
        jf.unlink()
    del _submit_jobs[job_id]
    return {"removed": True}


@app.post("/api/submit/jobs/{job_id}/download-files")
def download_submit_files(job_id: str):
    """Manually download build artifacts from the initvm for a failed/partial job."""
    if job_id not in _submit_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = _submit_jobs[job_id]
    if job["status"] == "running":
        return {"downloaded": False, "reason": "Job is still running"}

    initvm_dir = job.get("initvm_build_dir")
    if not initvm_dir:
        # Try to parse it from the log
        initvm_dir = _parse_initvm_build_dir(job["log"])
        if initvm_dir:
            job["initvm_build_dir"] = initvm_dir
            _persist_job(job)
    if not initvm_dir:
        return {"downloaded": False, "reason": "No initvm project path found in job log"}

    out_dir = job.get("output_dir", "")
    if not out_dir:
        return {"downloaded": False, "reason": "No output directory configured"}

    pathlib.Path(out_dir).mkdir(parents=True, exist_ok=True)
    result = _elbe_control("get_files", initvm_dir, "--output", out_dir, timeout=600)
    if result["returncode"] == 0:
        out_path = pathlib.Path(out_dir)
        downloaded = [f.name for f in out_path.iterdir() if f.is_file()] if out_path.is_dir() else []
        if downloaded and job["status"] == "failed":
            job["status"] = "partial"
        job["log"] += f"\n[ELBE-UI] Manual download: recovered {len(downloaded)} file(s): {', '.join(downloaded)}\n"
        _persist_job(job)
        return {"downloaded": True, "files": downloaded, "output_dir": out_dir}
    return {
        "downloaded": False,
        "reason": f"elbe control get_files failed: {result.get('stderr', '')}",
    }


@app.post("/api/submit/jobs/{job_id}/cleanup-initvm")
def cleanup_submit_initvm(job_id: str):
    """Delete the project from the initvm after files have been recovered."""
    if job_id not in _submit_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = _submit_jobs[job_id]
    initvm_dir = job.get("initvm_build_dir")
    if not initvm_dir:
        return {"cleaned": False, "reason": "No initvm project path found"}
    if job["status"] == "running":
        return {"cleaned": False, "reason": "Job is still running"}

    # Reset first (in case it's busy), then delete
    _elbe_control("reset_project", initvm_dir)
    result = _elbe_control("del_project", initvm_dir)
    if result["returncode"] == 0:
        job["log"] += f"\n[ELBE-UI] Cleaned up initvm project: {initvm_dir}\n"
        job["initvm_build_dir"] = None
        _persist_job(job)
        return {"cleaned": True, "initvm_dir": initvm_dir}
    return {"cleaned": False, "reason": result.get("stderr", "Unknown error")}


# ===========================================================================
# XML FILES – upload, list, read, write, validate
# ===========================================================================

@app.post("/api/upload_xml")
async def upload_xml(file: UploadFile = File(...)):
    upload = S("upload_dir")
    os.makedirs(upload, exist_ok=True)
    dest = os.path.join(upload, file.filename)
    content = await file.read()
    with open(dest, "wb") as f:
        f.write(content)
    return {"path": dest, "filename": file.filename}


@app.get("/api/xml_examples")
def xml_examples():
    projects = pathlib.Path(S("projects_dir"))
    if not projects.is_dir():
        return {"files": []}
    return {"files": sorted(str(p) for p in projects.glob("*.xml"))}


@app.get("/api/xml/list")
def xml_list_all():
    """List all XML files in the ELBE projects directory."""
    # Patterns for ELBE-generated temporary/internal XML files
    _ELBE_TEMP_PREFIXES = ("elbe-repodir-", "elbe-repo-", "source-")
    projects = pathlib.Path(S("projects_dir"))
    result = []
    seen = set()
    if projects.is_dir():
        for f in sorted(projects.rglob("*.xml")):
            # Skip ELBE internal/temporary files
            if any(f.name.startswith(p) for p in _ELBE_TEMP_PREFIXES):
                continue
            fp = str(f)
            if fp not in seen:
                seen.add(fp)
                result.append({"path": fp, "name": f.name, "dir": str(f.parent)})
    return {"files": result}


class XmlReadRequest(BaseModel):
    path: str


@app.post("/api/xml/read")
def xml_read(req: XmlReadRequest):
    """Read content of an XML file."""
    p = pathlib.Path(req.path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return {"path": str(p), "content": p.read_text(errors="replace")}


class XmlWriteRequest(BaseModel):
    path: str
    content: str


@app.post("/api/xml/write")
def xml_write(req: XmlWriteRequest):
    """Write / create an XML file."""
    p = pathlib.Path(req.path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(req.content)
    return {"path": str(p), "size": p.stat().st_size}


class XmlValidateRequest(BaseModel):
    path: str


@app.post("/api/xml/validate")
def xml_validate(req: XmlValidateRequest):
    """Validate an XML file using `elbe validate`."""
    return _elbe("validate", req.path, timeout=30)


class XmlPreprocessRequest(BaseModel):
    path: str
    variant: Optional[str] = None
    output: Optional[str] = None


@app.post("/api/xml/preprocess")
def xml_preprocess(req: XmlPreprocessRequest):
    """Preprocess an XML file (resolve xincludes, variants)."""
    args = ["preprocess"]
    if req.variant:
        args += ["--variant", req.variant]
    if req.output:
        args += ["--output", req.output]
    args.append(req.path)
    return _elbe(*args, timeout=60)


# ===========================================================================
# APT REPOSITORIES – CRUD + per-repo operations
# ===========================================================================


def _get_repos() -> list[dict]:
    """Return the apt_repos list from settings."""
    return _load_settings().get("apt_repos", [])


def _get_repo(index: int) -> dict:
    repos = _get_repos()
    if index < 0 or index >= len(repos):
        raise HTTPException(status_code=404, detail="Repository not found")
    return repos[index]


def _repo_local_dir(repo: dict) -> pathlib.Path | None:
    """Return the local_dir Path for a repo, or None."""
    ld = repo.get("local_dir", "")
    return pathlib.Path(ld) if ld else None


@app.get("/api/apt-repos")
def apt_repos_list():
    """List all configured APT repositories with live status."""
    repos = _get_repos()
    result = []
    for i, r in enumerate(repos):
        info = dict(r, index=i)
        ld = _repo_local_dir(r)
        if ld:
            repo_dir = ld / "repo"
            info["exists"] = repo_dir.is_dir()
            info["has_keys"] = (ld / "keys" / "private.gpg").is_file()
            info["has_index"] = (repo_dir / "Packages").is_file()
            info["has_sources_index"] = (repo_dir / "Sources").is_file()
            debs = sorted(repo_dir.glob("*.deb")) if repo_dir.is_dir() else []
            info["packages"] = [{"name": d.name, "size": d.stat().st_size} for d in debs]
            info["package_count"] = len(debs)
            # Source packages (.dsc files)
            dscs = sorted(repo_dir.glob("*.dsc")) if repo_dir.is_dir() else []
            info["source_packages"] = [{"name": d.name, "size": d.stat().st_size} for d in dscs]
            info["source_count"] = len(dscs)
        else:
            info["exists"] = None
            info["has_keys"] = None
            info["has_index"] = None
            info["has_sources_index"] = None
            info["packages"] = []
            info["package_count"] = 0
            info["source_packages"] = []
            info["source_count"] = 0
        result.append(info)
    return {"repos": result}


class AptRepoEntry(BaseModel):
    label: str = ""
    type: str = "deb"             # deb | deb-src
    uri: str = ""
    suite: str = "./"             # bookworm | stable | ./
    components: str = ""          # main contrib non-free
    arch: str = ""                # amd64 | arm64 | empty = all
    signed_by: str = ""           # path to GPG keyring
    trusted: bool = False
    enabled: bool = True
    local_dir: str = ""           # local dir for management (gen-keys, rebuild, upload)


@app.post("/api/apt-repos")
def apt_repos_add(entry: AptRepoEntry):
    """Add a new APT repository."""
    s = _load_settings()
    repos = s.get("apt_repos", [])
    repos.append(entry.dict())
    s["apt_repos"] = repos
    _save_settings(s)
    return {"index": len(repos) - 1, "repo": entry.dict()}


@app.put("/api/apt-repos/{index}")
def apt_repos_update(index: int, entry: AptRepoEntry):
    """Update an existing APT repository."""
    s = _load_settings()
    repos = s.get("apt_repos", [])
    if index < 0 or index >= len(repos):
        raise HTTPException(status_code=404, detail="Repository not found")
    repos[index] = entry.dict()
    s["apt_repos"] = repos
    _save_settings(s)
    return {"index": index, "repo": entry.dict()}


@app.delete("/api/apt-repos/{index}")
def apt_repos_delete(index: int):
    """Delete an APT repository."""
    s = _load_settings()
    repos = s.get("apt_repos", [])
    if index < 0 or index >= len(repos):
        raise HTTPException(status_code=404, detail="Repository not found")
    removed = repos.pop(index)
    s["apt_repos"] = repos
    _save_settings(s)
    return {"deleted": removed}


@app.get("/api/apt-repos/{index}/apt-line")
def apt_repos_apt_line(index: int):
    """Generate the sources.list line for a repo."""
    r = _get_repo(index)
    opts = []
    if r.get("trusted"):
        opts.append("trusted=yes")
    if r.get("arch"):
        opts.append(f"arch={r['arch']}")
    if r.get("signed_by"):
        opts.append(f"signed-by={r['signed_by']}")
    opt_str = f" [{' '.join(opts)}]" if opts else ""
    suite = r.get("suite", "./")
    components = r.get("components", "")
    line = f"{r.get('type', 'deb')}{opt_str} {r['uri']} {suite}"
    if components:
        line += f" {components}"
    return {"line": line.strip()}


@app.get("/api/apt-repos/{index}/elbe-xml")
def apt_repos_elbe_xml(index: int):
    """Generate the ELBE XML <url> snippet for a repo."""
    r = _get_repo(index)
    opts = []
    if r.get("trusted"):
        opts.append("[trusted=yes]")
    if r.get("signed_by"):
        opts.append(f"[signed-by={r['signed_by']}]")
    opt_str = " ".join(opts)
    suite = r.get("suite", "./")
    components = r.get("components", "")
    bin_line = f"{opt_str} {r['uri']} {suite}".strip()
    if components:
        bin_line += f" {components}"
    xml = f"<url>\n  <binary>{bin_line}</binary>\n"

    # Include <source> when the repo uses standard suites with components
    # (e.g. "bookworm main").  For flat repos (suite="./") ELBE's XML
    # validator rejects <source> lines, so we omit them.  Flat repos still
    # serve Sources/Sources.gz alongside Packages — apt inside the initvm
    # fetches them automatically.
    is_flat = suite.strip().rstrip("/") in (".", "./", "")
    if not is_flat and (r.get("type") == "deb-src" or components):
        src_line = bin_line
        xml += f"  <source>{src_line}</source>\n"
    xml += "</url>"

    # Provide a hint about source packages for flat repos
    ld = _repo_local_dir(r)
    has_sources = False
    if ld:
        repo_dir = ld / "repo"
        has_sources = any(repo_dir.glob("*.dsc")) if repo_dir.is_dir() else False

    return {"xml": xml, "has_sources": has_sources, "is_flat_repo": is_flat}


# --- Per-repo operations (for repos with local_dir) ---

@app.post("/api/apt-repos/{index}/gen-keys")
def apt_repos_gen_keys(index: int):
    """Run gen-keys.sh for a specific local repo, using maintainer identity."""
    r = _get_repo(index)
    ld = _repo_local_dir(r)
    if not ld:
        raise HTTPException(status_code=400, detail="Repository has no local directory")
    script = ld / "gen-keys.sh"
    if not script.is_file():
        raise HTTPException(status_code=404, detail="gen-keys.sh not found")
    m = _maintainer()
    name = m.get("name") or "ELBE Demo Repo Signing Key"
    email = m.get("email") or "elbe-demo@local"
    return _run(["bash", str(script), name, email], timeout=60)


@app.post("/api/apt-repos/{index}/rebuild")
def apt_repos_rebuild(index: int):
    """Run build-repo.sh for a specific local repo."""
    r = _get_repo(index)
    ld = _repo_local_dir(r)
    if not ld:
        raise HTTPException(status_code=400, detail="Repository has no local directory")
    script = ld / "build-repo.sh"
    if not script.is_file():
        raise HTTPException(status_code=404, detail="build-repo.sh not found")
    return _run(["bash", str(script)], timeout=120)


@app.post("/api/apt-repos/{index}/upload")
async def apt_repos_upload(index: int, file: UploadFile = File(...)):
    """Upload a .deb, .dsc, or .tar.* file into a local repo's repo/ directory."""
    r = _get_repo(index)
    ld = _repo_local_dir(r)
    if not ld:
        raise HTTPException(status_code=400, detail="Repository has no local directory")
    allowed = file.filename.endswith(".deb") or file.filename.endswith(".dsc") or ".tar." in file.filename
    if not allowed:
        raise HTTPException(status_code=400, detail="Only .deb, .dsc, and .tar.* files are accepted")
    repo_dir = ld / "repo"
    repo_dir.mkdir(parents=True, exist_ok=True)
    dest = repo_dir / file.filename
    data = await file.read()
    with open(dest, "wb") as f:
        f.write(data)
    return {"path": str(dest), "filename": file.filename, "size": len(data)}


class AptRepoDeletePkg(BaseModel):
    filename: str


@app.post("/api/apt-repos/{index}/delete-package")
def apt_repos_delete_package(index: int, req: AptRepoDeletePkg):
    """Delete a .deb/.dsc/.tar.* file from a local repo and rebuild the index."""
    r = _get_repo(index)
    ld = _repo_local_dir(r)
    if not ld:
        raise HTTPException(status_code=400, detail="Repository has no local directory")
    repo_dir = ld / "repo"
    target = repo_dir / req.filename
    allowed = req.filename.endswith(".deb") or req.filename.endswith(".dsc") or ".tar." in req.filename
    if not target.is_file() or not allowed:
        raise HTTPException(status_code=404, detail="Package file not found")
    target.unlink()
    # Auto-rebuild index after deletion
    rebuild_result = None
    script = ld / "build-repo.sh"
    remaining_debs = list(repo_dir.glob("*.deb"))
    if script.is_file() and remaining_debs:
        rebuild_result = _run(["bash", str(script)], timeout=120)
    return {"deleted": req.filename, "rebuild": rebuild_result}


# --- Backward compatibility aliases ---

@app.get("/api/apt-repo/status")
def apt_repo_status_compat():
    """Legacy endpoint – returns status of the first local repo."""
    repos = _get_repos()
    for i, r in enumerate(repos):
        if r.get("local_dir"):
            data = apt_repos_list()
            return data["repos"][i]
    return {"exists": False, "packages": []}


# ===========================================================================
# SOURCES – list source repos under sources_dir
# ===========================================================================

@app.get("/api/sources")
def list_sources():
    """List source projects under the sources directory."""
    src_dir = pathlib.Path(S("sources_dir"))
    if not src_dir.is_dir():
        return {"sources": [], "error": f"Directory not found: {src_dir}"}
    sources = []
    for d in sorted(src_dir.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            info = {
                "name": d.name,
                "path": str(d),
                "has_makefile": (d / "Makefile").is_file(),
                "has_cmake": (d / "CMakeLists.txt").is_file(),
                "has_readme": (d / "README.md").is_file(),
                "files": [f.name for f in sorted(d.iterdir()) if f.is_file() and not f.name.startswith(".")],
            }
            # Check if a matching package already exists
            pkg_name = d.name.replace("-app-", "-pkg-").replace("-src-", "-pkg-")
            pkg_dir = pathlib.Path(S("packages_dir")) / pkg_name
            info["has_package"] = pkg_dir.is_dir() and (pkg_dir / "debian").is_dir()
            info["package_name"] = pkg_name
            info["package_path"] = str(pkg_dir)
            sources.append(info)
    return {"sources": sources}


class CreatePackageTemplate(BaseModel):
    source_name: str
    package_name: Optional[str] = None
    description: str = ""
    version: str = "1.0.0"
    maintainer: str = ""  # auto-filled from Maintainer settings if empty
    architecture: str = "amd64"


@app.post("/api/sources/create-package")
def create_package_template(req: CreatePackageTemplate):
    """Create a Debian package template in packages_dir from a source project."""
    # Auto-fill maintainer from settings if not provided
    maintainer = req.maintainer or _maintainer_formatted()
    src_dir = pathlib.Path(S("sources_dir")) / req.source_name
    if not src_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Source not found: {req.source_name}")

    pkg_name = req.package_name or req.source_name.replace("-app-", "-pkg-").replace("-src-", "-pkg-")
    pkg_dir = pathlib.Path(S("packages_dir")) / pkg_name
    debian_dir = pkg_dir / "debian"
    debian_dir.mkdir(parents=True, exist_ok=True)

    # Detect binary name from Makefile if present
    binary_name = req.source_name.split("-")[-1]  # last segment as default

    # debian/control
    (debian_dir / "control").write_text(f"""Source: {pkg_name}
Section: misc
Priority: optional
Maintainer: {maintainer}
Build-Depends: debhelper-compat (= 13), gcc, make
Standards-Version: 4.6.0

Package: {pkg_name}
Architecture: {req.architecture}
Depends: ${{shlibs:Depends}}, ${{misc:Depends}}
Description: {req.description or pkg_name}
 Auto-generated Debian package for {req.source_name}.
""")

    # debian/changelog
    # Native packages (format 3.0 native) must NOT have a Debian revision
    # suffix (-1).  The version is used as-is.
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    (debian_dir / "changelog").write_text(f"""{pkg_name} ({req.version}) bookworm; urgency=low

  * Initial packaging (auto-generated by ELBE UI).

 -- {maintainer}  {now}
""")

    # debian/rules
    (debian_dir / "rules").write_text(f"""#!/usr/bin/make -f
%:
\tdh $@

override_dh_auto_build:
\t$(MAKE) -C {str(src_dir)}

override_dh_auto_install:
\t$(MAKE) -C {str(src_dir)} install DESTDIR=$(CURDIR)/debian/{pkg_name}

override_dh_auto_clean:
\t$(MAKE) -C {str(src_dir)} clean || true
""")
    (debian_dir / "rules").chmod(0o755)

    # debian/source/format
    source_dir = debian_dir / "source"
    source_dir.mkdir(exist_ok=True)
    (source_dir / "format").write_text("3.0 (native)\n")

    return {
        "package_name": pkg_name,
        "package_path": str(pkg_dir),
        "files": [str(f.relative_to(pkg_dir)) for f in sorted(pkg_dir.rglob("*")) if f.is_file()],
    }


# ===========================================================================
# PACKAGES – list, build .deb, add to repo, manage in XML projects
# ===========================================================================

@app.get("/api/packages")
def list_packages():
    """List Debian package definitions under the packages directory."""
    pkg_base = pathlib.Path(S("packages_dir"))
    if not pkg_base.is_dir():
        return {"packages": [], "error": f"Directory not found: {pkg_base}"}
    packages = []
    for d in sorted(pkg_base.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            debian_dir = d / "debian"
            has_debian = debian_dir.is_dir()
            info = {
                "name": d.name,
                "path": str(d),
                "has_debian": has_debian,
                "has_control": (debian_dir / "control").is_file() if has_debian else False,
                "has_rules": (debian_dir / "rules").is_file() if has_debian else False,
                "has_changelog": (debian_dir / "changelog").is_file() if has_debian else False,
                "files": [str(f.relative_to(d)) for f in sorted(d.rglob("*")) if f.is_file() and not f.name.startswith(".")],
            }
            # Find .deb in the package dist/ directory
            dist_dir = d / "dist"
            debs = sorted(dist_dir.glob("*.deb")) if dist_dir.is_dir() else []
            info["deb_files"] = [{"name": f.name, "path": str(f), "size": f.stat().st_size} for f in debs]
            # Find source package files (.dsc, .tar.*) in dist/ directory
            src_files = (sorted(dist_dir.glob(f"{d.name}_*.dsc")) + sorted(dist_dir.glob(f"{d.name}_*.tar.*"))) if dist_dir.is_dir() else []
            info["source_files"] = [{"name": f.name, "path": str(f), "size": f.stat().st_size} for f in src_files]
            packages.append(info)
    return {"packages": packages}


# --- Debian directory file editing ---

_DEBIAN_EDITABLE = {"control", "changelog", "rules", "source/format", "compat", "install", "dirs", "docs"}


@app.get("/api/packages/{package_name}/debian")
def list_debian_files(package_name: str):
    """List all files inside a package's debian/ directory."""
    pkg_dir = pathlib.Path(S("packages_dir")) / package_name
    if not pkg_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Package not found: {package_name}")
    debian_dir = pkg_dir / "debian"
    if not debian_dir.is_dir():
        raise HTTPException(status_code=404, detail="No debian/ directory found")
    files = []
    for f in sorted(debian_dir.rglob("*")):
        if f.is_file():
            rel = str(f.relative_to(debian_dir))
            files.append({
                "name": rel,
                "path": str(f),
                "size": f.stat().st_size,
                "editable": rel in _DEBIAN_EDITABLE,
            })
    return {"package_name": package_name, "files": files}


@app.get("/api/packages/{package_name}/debian/{file_path:path}")
def read_debian_file(package_name: str, file_path: str):
    """Read the content of a file inside debian/."""
    pkg_dir = pathlib.Path(S("packages_dir")) / package_name
    target = pkg_dir / "debian" / file_path
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: debian/{file_path}")
    # Safety: ensure the resolved path is inside the package dir
    if not str(target.resolve()).startswith(str(pkg_dir.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    return {
        "package_name": package_name,
        "file": file_path,
        "content": target.read_text(errors="replace"),
        "size": target.stat().st_size,
    }


class WriteDebianFileRequest(BaseModel):
    content: str


@app.put("/api/packages/{package_name}/debian/{file_path:path}")
def write_debian_file(package_name: str, file_path: str, req: WriteDebianFileRequest):
    """Write / update a file inside debian/."""
    if file_path not in _DEBIAN_EDITABLE:
        raise HTTPException(status_code=400, detail=f"File not editable: debian/{file_path}")
    pkg_dir = pathlib.Path(S("packages_dir")) / package_name
    if not pkg_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Package not found: {package_name}")
    target = pkg_dir / "debian" / file_path
    if not str(target.resolve()).startswith(str(pkg_dir.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(req.content)
    return {
        "package_name": package_name,
        "file": file_path,
        "size": target.stat().st_size,
    }


# --- Build artefacts (dist/) ---

@app.get("/api/packages/{package_name}/dist")
def list_dist_files(package_name: str):
    """List build artefacts in a package's dist/ directory."""
    pkg_dir = pathlib.Path(S("packages_dir")) / package_name
    if not pkg_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Package not found: {package_name}")
    dist_dir = pkg_dir / "dist"
    if not dist_dir.is_dir():
        return {"package_name": package_name, "dist_dir": str(dist_dir), "files": []}
    files = []
    for f in sorted(dist_dir.iterdir()):
        if f.is_file():
            files.append({
                "name": f.name,
                "path": str(f),
                "size": f.stat().st_size,
                "type": _classify_artefact(f.name),
            })
    return {"package_name": package_name, "dist_dir": str(dist_dir), "files": files}


@app.get("/api/packages/{package_name}/dist/{filename}")
def download_dist_file(package_name: str, filename: str):
    """Download a single build artefact from dist/."""
    pkg_dir = pathlib.Path(S("packages_dir")) / package_name
    target = pkg_dir / "dist" / filename
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: dist/{filename}")
    if not str(target.resolve()).startswith(str(pkg_dir.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    return FileResponse(str(target), filename=filename)


def _classify_artefact(name: str) -> str:
    """Classify a build artefact by its file extension."""
    if name.endswith(".deb"):
        return "deb"
    if name.endswith(".dsc"):
        return "dsc"
    if ".tar." in name:
        return "source-tarball"
    if name.endswith(".buildinfo"):
        return "buildinfo"
    if name.endswith(".changes"):
        return "changes"
    return "other"


class BuildDebRequest(BaseModel):
    package_name: str


@app.post("/api/packages/clean")
def clean_package(req: BuildDebRequest):
    """Remove build artifacts for a package (debian/rules clean + parent artefacts)."""
    pkg_dir = pathlib.Path(S("packages_dir")) / req.package_name
    if not pkg_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Package not found: {req.package_name}")
    removed = []
    # 1. Run 'dh clean' inside the package dir (cleans debian/.debhelper, debian/<pkg>, obj files)
    clean_result = None
    if (pkg_dir / "debian").is_dir():
        try:
            r = subprocess.run(
                ["dpkg-buildpackage", "-T", "clean"],
                capture_output=True, text=True, timeout=60, cwd=str(pkg_dir),
            )
            clean_result = {
                "returncode": r.returncode,
                "stdout": r.stdout.strip(),
                "stderr": r.stderr.strip(),
            }
        except Exception as e:
            clean_result = {"returncode": -1, "stdout": "", "stderr": str(e)}

    # 2. Remove artefacts from dist/ directory (.deb, .buildinfo, .changes, .dsc, .tar.*)
    dist_dir = pkg_dir / "dist"
    patterns = [
        f"{req.package_name}_*.deb",
        f"{req.package_name}-dbgsym_*.deb",
        f"{req.package_name}_*.buildinfo",
        f"{req.package_name}_*.changes",
        f"{req.package_name}_*.dsc",
        f"{req.package_name}_*.tar.*",
    ]
    for pattern in patterns:
        for f in dist_dir.glob(pattern) if dist_dir.is_dir() else []:
            try:
                f.unlink()
                removed.append(f.name)
            except OSError:
                pass

    # Also clean any stale artefacts that may still exist in the parent dir
    parent = pkg_dir.parent
    for pattern in patterns:
        for f in parent.glob(pattern):
            try:
                f.unlink()
                removed.append(f"(parent) {f.name}")
            except OSError:
                pass
    return {"clean_result": clean_result, "removed_files": removed}


class BuildDebFullRequest(BaseModel):
    package_name: str
    build_source: bool = True   # also build source package (.dsc + .tar.*)


@app.post("/api/packages/build-deb")
def build_deb(req: BuildDebFullRequest):
    """Build a .deb (and optionally a source package) using dpkg-buildpackage.

    All build artefacts are moved from the parent directory (where
    dpkg-buildpackage drops them) into ``<pkg_dir>/dist/`` so that the
    packages directory stays clean.
    """
    pkg_dir = pathlib.Path(S("packages_dir")) / req.package_name
    if not pkg_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Package not found: {req.package_name}")
    debian_dir = pkg_dir / "debian"
    if not debian_dir.is_dir():
        raise HTTPException(status_code=400, detail="No debian/ directory found")

    # Prepare dist/ output directory
    dist_dir = pkg_dir / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)

    # Build binary .deb
    try:
        result = subprocess.run(
            ["dpkg-buildpackage", "-us", "-uc", "-b"],
            capture_output=True, text=True, timeout=300, cwd=str(pkg_dir),
        )
        output = {
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except subprocess.TimeoutExpired:
        output = {"returncode": -1, "stdout": "", "stderr": "Build timed out"}
    except FileNotFoundError:
        output = {"returncode": -1, "stdout": "", "stderr": "dpkg-buildpackage not found"}

    # Move produced artefacts from parent dir into dist/
    parent = pkg_dir.parent
    _move_artefacts_to_dist(parent, req.package_name, dist_dir)

    # Collect .deb files from dist/
    debs = sorted(dist_dir.glob(f"{req.package_name}*.deb"))
    output["deb_files"] = [{"name": f.name, "path": str(f), "size": f.stat().st_size} for f in debs]
    output["dist_dir"] = str(dist_dir)

    # Build source package (.dsc + .tar.*) if requested
    output["source_files"] = []
    if req.build_source and output["returncode"] == 0:
        try:
            src_result = subprocess.run(
                ["dpkg-buildpackage", "-us", "-uc", "-S"],
                capture_output=True, text=True, timeout=300, cwd=str(pkg_dir),
            )
            output["source_returncode"] = src_result.returncode
            output["source_stderr"] = src_result.stderr.strip()
            if src_result.returncode != 0:
                output["source_error"] = src_result.stderr.strip()
        except Exception as e:
            output["source_returncode"] = -1
            output["source_error"] = str(e)
        # Move source artefacts into dist/
        _move_artefacts_to_dist(parent, req.package_name, dist_dir)
        # Collect source files from dist/
        src_files = sorted(dist_dir.glob(f"{req.package_name}_*.dsc")) + \
                    sorted(dist_dir.glob(f"{req.package_name}_*.tar.*"))
        output["source_files"] = [
            {"name": f.name, "path": str(f), "size": f.stat().st_size}
            for f in src_files
        ]
    return output


def _move_artefacts_to_dist(parent: pathlib.Path, pkg_name: str, dist_dir: pathlib.Path):
    """Move dpkg-buildpackage output files from *parent* into *dist_dir*."""
    patterns = [
        f"{pkg_name}_*.deb",
        f"{pkg_name}-dbgsym_*.deb",
        f"{pkg_name}_*.buildinfo",
        f"{pkg_name}_*.changes",
        f"{pkg_name}_*.dsc",
        f"{pkg_name}_*.tar.*",
    ]
    for pattern in patterns:
        for f in parent.glob(pattern):
            dest = dist_dir / f.name
            shutil.move(str(f), str(dest))


class AddToRepoRequest(BaseModel):
    deb_path: str
    repo_index: int = 0
    include_sources: bool = True   # also copy source package (.dsc + .tar.*)


@app.post("/api/packages/add-to-repo")
def add_deb_to_repo(req: AddToRepoRequest):
    """Copy a .deb file (and optionally source files) into an APT repo and rebuild the index."""
    deb = pathlib.Path(req.deb_path)
    if not deb.is_file() or not deb.name.endswith(".deb"):
        raise HTTPException(status_code=404, detail="Invalid .deb file path")
    r = _get_repo(req.repo_index)
    ld = _repo_local_dir(r)
    if not ld:
        raise HTTPException(status_code=400, detail="Target repo has no local directory")
    repo_dir = ld / "repo"
    repo_dir.mkdir(parents=True, exist_ok=True)
    dest = repo_dir / deb.name
    shutil.copy2(str(deb), str(dest))

    copied_files = [str(dest)]

    # Copy source files (.dsc + .tar.*) if requested and available
    source_copied = []
    if req.include_sources:
        parent = deb.parent
        # Derive package name from .deb filename: <name>_<version>_<arch>.deb
        parts = deb.stem.rsplit("_", 2)
        if len(parts) >= 2:
            pkg_base = parts[0]  # e.g. "elbe-demo-pkg-hello"
            ver_part = parts[1]   # e.g. "1.0.0-1"
            # Look for matching .dsc and .tar.* in the same directory
            for pattern in [f"{pkg_base}_{ver_part}.dsc", f"{pkg_base}_{ver_part}.tar.*"]:
                for src_file in parent.glob(pattern):
                    src_dest = repo_dir / src_file.name
                    shutil.copy2(str(src_file), str(src_dest))
                    source_copied.append(src_file.name)
                    copied_files.append(str(src_dest))

    # Auto-rebuild index
    script = ld / "build-repo.sh"
    rebuild_result = None
    if script.is_file():
        rebuild_result = _run(["bash", str(script)], timeout=120)
    return {
        "copied": str(dest),
        "copied_files": copied_files,
        "source_files": source_copied,
        "size": dest.stat().st_size,
        "rebuild": rebuild_result,
    }


class PkgInXmlRequest(BaseModel):
    xml_path: str
    package_name: str
    action: str = "add"  # add | remove


@app.post("/api/packages/manage-in-xml")
def manage_pkg_in_xml(req: PkgInXmlRequest):
    """Add or remove a <pkg> entry in the <pkg-list> of an ELBE XML file."""
    p = pathlib.Path(req.xml_path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="XML file not found")
    content = p.read_text(errors="replace")
    pkg_tag = f"<pkg>{req.package_name}</pkg>"

    if req.action == "add":
        if pkg_tag in content:
            return {"changed": False, "message": f"{req.package_name} already in pkg-list"}
        # Insert before </pkg-list>, matching existing indentation
        if "</pkg-list>" not in content:
            return {"changed": False, "error": "No <pkg-list> found in XML"}
        # Detect indentation of existing <pkg> entries
        m = re.search(r'^([ \t]*)<pkg>', content, re.MULTILINE)
        pkg_indent = m.group(1) if m else "      "
        # Detect indentation of </pkg-list>
        m2 = re.search(r'^([ \t]*)</pkg-list>', content, re.MULTILINE)
        close_indent = m2.group(1) if m2 else "    "
        content = content.replace(
            f"{close_indent}</pkg-list>",
            f"{pkg_indent}{pkg_tag}\n{close_indent}</pkg-list>",
        )
        p.write_text(content)
        return {"changed": True, "action": "added", "package": req.package_name}

    elif req.action == "remove":
        new_content = re.sub(r'\s*<pkg>' + re.escape(req.package_name) + r'</pkg>', '', content)
        if new_content == content:
            return {"changed": False, "message": f"{req.package_name} not found in pkg-list"}
        p.write_text(new_content)
        return {"changed": True, "action": "removed", "package": req.package_name}

    raise HTTPException(status_code=400, detail="action must be 'add' or 'remove'")


@app.get("/api/packages/xml-pkg-list")
def get_xml_pkg_list(xml_path: str):
    """Return the list of <pkg> entries in an ELBE XML file."""
    p = pathlib.Path(xml_path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="XML file not found")
    content = p.read_text(errors="replace")
    pkgs = re.findall(r'<pkg>([^<]+)</pkg>', content)
    return {"packages": pkgs, "xml_path": xml_path}


# ===========================================================================
# LOCAL BUILDS
# ===========================================================================

def _get_builds_dirs() -> list[pathlib.Path]:
    """Return all directories that may contain build output.

    Scans:
    1. {workspace_dir}/elbe-build-*          (legacy layout)
    2. {workspace_dir}/builds/*              (submit-job layout inside container)
    3. {builds_dir}/*                        (explicit host-side setting)
    """
    dirs: list[pathlib.Path] = []
    ws = pathlib.Path(S("workspace_dir"))

    # Legacy: elbe-build-* directly in workspace
    if ws.is_dir():
        dirs += sorted(ws.glob("elbe-build-*"))
        sub = ws / "builds"
        if sub.is_dir():
            dirs += sorted(sub.iterdir())

    # Explicit builds_dir (may live outside workspace, e.g. on the host)
    bdir = S("builds_dir").strip()
    if bdir:
        p = pathlib.Path(bdir)
        if p.is_dir():
            dirs += sorted(p.iterdir())

    return dirs


@app.get("/api/builds")
def list_builds():
    builds = []
    seen_paths = set()

    # Build a reverse index: output_dir → job info (for mapping)
    job_by_outdir: dict[str, dict] = {}
    for j in _submit_jobs.values():
        od = j.get("output_dir", "")
        if od:
            job_by_outdir[od] = j

    def _scan_build_dir(d: pathlib.Path):
        if not d.is_dir() or str(d) in seen_paths:
            return
        seen_paths.add(str(d))
        files = []
        images = []
        for f in sorted(d.iterdir()):
            if f.is_file():
                info = {"name": f.name, "size": f.stat().st_size}
                files.append(info)
                if f.suffix in (".img", ".qcow2", ".vmdk", ".iso", ".wic"):
                    images.append(info)
                elif f.name.endswith((".img.gz", ".img.tar.xz", ".img.tar.gz")):
                    images.append(info)
        if files:  # Only include non-empty directories
            entry = {
                "name": d.name,
                "path": str(d),
                "files": files,
                "images": images,
                "created": d.stat().st_mtime,
            }
            # Attach job mapping if available
            jinfo = job_by_outdir.get(str(d))
            if jinfo:
                entry["job_id"] = jinfo["id"]
                entry["job_status"] = jinfo["status"]
                entry["initvm_project"] = jinfo.get("initvm_build_dir")
            builds.append(entry)

    for d in _get_builds_dirs():
        _scan_build_dir(d)

    return {"builds": builds}


class ExtractImageRequest(BaseModel):
    build_path: str
    filename: str


@app.post("/api/builds/extract")
def extract_image(req: ExtractImageRequest):
    """Extract a compressed disk image (.img.gz, .img.tar.xz, .img.tar.gz) to .img."""
    build_dir = pathlib.Path(req.build_path)
    src = build_dir / req.filename
    if not src.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    fname = req.filename

    # .img.tar.xz → extract with tar
    if fname.endswith(".img.tar.xz") or fname.endswith(".img.tar.gz"):
        dest_name = fname.split(".img.")[0] + ".img"
        dest = build_dir / dest_name
        result = _run(
            ["tar", "--extract", "--file", str(src), "--directory", str(build_dir)],
            timeout=600,
        )
        if result["returncode"] == 0 and dest.is_file():
            return {"extracted": str(dest), "size": dest.stat().st_size}
        return {"error": "Extraction failed", "detail": result}

    # .img.gz → gunzip
    if fname.endswith(".gz"):
        dest_name = fname.rsplit(".gz", 1)[0]
        dest = build_dir / dest_name
        result = _run(["gunzip", "-k", "-f", str(src)], timeout=300)
        if result["returncode"] == 0 and dest.is_file():
            return {"extracted": str(dest), "size": dest.stat().st_size}
        return {"error": "Extraction failed", "detail": result}

    return {"extracted": str(src), "message": "File does not need extraction"}


@app.post("/api/builds/delete")
def delete_build(req: XmlReadRequest):
    """Delete a local build directory."""
    p = pathlib.Path(req.path)
    ws = pathlib.Path(S("workspace_dir"))
    builds_dir = ws / "builds"
    # Allow deleting elbe-build-* in workspace or any dir under builds/
    is_legacy = "elbe-build-" in p.name and p.parent == ws
    is_submit_build = builds_dir.is_dir() and p.parent == builds_dir
    # Also allow if under explicit builds_dir setting
    bdir = S("builds_dir").strip()
    is_explicit_build = bdir and pathlib.Path(bdir).is_dir() and p.parent == pathlib.Path(bdir)
    if not p.is_dir() or not (is_legacy or is_submit_build or is_explicit_build):
        raise HTTPException(status_code=400, detail="Invalid build directory")
    shutil.rmtree(p, ignore_errors=True)
    return {"deleted": str(p)}


class BuildFileReadRequest(BaseModel):
    build_path: str
    filename: str


@app.post("/api/builds/read-file")
def read_build_file(req: BuildFileReadRequest):
    """Read a text file from a build directory (log, xml, txt, etc.)."""
    build_dir = pathlib.Path(req.build_path)
    fpath = build_dir / req.filename

    # Security: ensure the file is inside a known build directory
    known = False
    for d in _get_builds_dirs():
        if d.is_dir() and build_dir == d:
            known = True
            break
    if not known:
        raise HTTPException(status_code=403, detail="Not a known build directory")

    if not fpath.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    TEXT_EXTS = {".txt", ".xml", ".log", ".htm", ".html", ".csv", ".json", ".yaml", ".yml"}
    if fpath.suffix.lower() not in TEXT_EXTS:
        raise HTTPException(status_code=400, detail=f"Not a viewable text file: {fpath.suffix}")

    # Limit to 2 MB to avoid huge payloads
    size = fpath.stat().st_size
    if size > 2 * 1024 * 1024:
        content = fpath.read_text(errors="replace")[:2 * 1024 * 1024]
        truncated = True
    else:
        content = fpath.read_text(errors="replace")
        truncated = False

    return {"filename": req.filename, "size": size, "truncated": truncated, "content": content}


# ===========================================================================
# SIMULATORS (QEMU instances)
# ===========================================================================

SIMULATORS_FILE = pathlib.Path(__file__).parent / "simulators.json"

_sim_processes: dict[str, dict] = {}   # sim_id → {proc, pty_fd, ws_clients, ...}


def _load_simulators() -> list[dict]:
    if SIMULATORS_FILE.is_file():
        return json.loads(SIMULATORS_FILE.read_text())
    return []


def _save_simulators(sims: list[dict]):
    SIMULATORS_FILE.write_text(json.dumps(sims, indent=2))


def _pid_alive(pid: int) -> bool:
    """Return True if a process with the given PID exists."""
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _find_orphan_qemu(image_path: str) -> Optional[int]:
    """Scan /proc for a QEMU process already using image_path. Returns PID or None."""
    if not image_path:
        return None
    for pid_dir in sorted(pathlib.Path("/proc").glob("[0-9]*")):
        try:
            cmdline = (pid_dir / "cmdline").read_bytes().decode(errors="replace")
            parts = cmdline.split("\x00")
            if parts and "qemu" in parts[0].lower() and image_path in cmdline:
                return int(pid_dir.name)
        except (PermissionError, FileNotFoundError, ValueError):
            continue
    return None


@app.get("/api/simulators")
def list_simulators():
    sims = _load_simulators()
    # Enrich with runtime status
    for s in sims:
        sid = s.get("id", "")
        if sid in _sim_processes:
            proc = _sim_processes[sid].get("proc")
            orphan_pid = _sim_processes[sid].get("orphan_pid")
            if proc and proc.poll() is None:
                s["runtime_status"] = "running"
                s["pid"] = proc.pid
            elif orphan_pid and _pid_alive(orphan_pid):
                s["runtime_status"] = "running"
                s["pid"] = orphan_pid
                s["orphan"] = True
            else:
                s["runtime_status"] = "stopped"
                del _sim_processes[sid]
        else:
            # Check for an orphan QEMU process using this image (e.g. after server restart)
            orphan_pid = _find_orphan_qemu(s.get("image_path", ""))
            if orphan_pid:
                s["runtime_status"] = "running"
                s["pid"] = orphan_pid
                s["orphan"] = True
                _sim_processes[sid] = {
                    "proc": None,
                    "orphan_pid": orphan_pid,
                    "output_buffer": b"",
                }
            else:
                s["runtime_status"] = "stopped"
    return {"simulators": sims}


class SimulatorConfig(BaseModel):
    name: str
    qemu_bin: str = ""
    memory: str = "1024"
    image_path: str = ""
    extra_args: str = ""
    serial_console: bool = True
    vnc_display: str = ""     # e.g. ":1" for VNC on port 5901


@app.post("/api/simulators")
def create_simulator(cfg: SimulatorConfig):
    sims = _load_simulators()
    sim = {
        "id": str(uuid.uuid4())[:8],
        "name": cfg.name,
        "qemu_bin": cfg.qemu_bin or S("qemu_bin"),
        "memory": cfg.memory,
        "image_path": cfg.image_path,
        "extra_args": cfg.extra_args,
        "serial_console": cfg.serial_console,
        "vnc_display": cfg.vnc_display,
    }
    sims.append(sim)
    _save_simulators(sims)
    return sim


@app.put("/api/simulators/{sim_id}")
def update_simulator(sim_id: str, cfg: SimulatorConfig):
    sims = _load_simulators()
    for s in sims:
        if s["id"] == sim_id:
            s.update({
                "name": cfg.name,
                "qemu_bin": cfg.qemu_bin or S("qemu_bin"),
                "memory": cfg.memory,
                "image_path": cfg.image_path,
                "extra_args": cfg.extra_args,
                "serial_console": cfg.serial_console,
                "vnc_display": cfg.vnc_display,
            })
            _save_simulators(sims)
            return s
    raise HTTPException(status_code=404, detail="Simulator not found")


@app.delete("/api/simulators/{sim_id}")
def delete_simulator(sim_id: str):
    if sim_id in _sim_processes:
        _stop_sim(sim_id)
    sims = [s for s in _load_simulators() if s["id"] != sim_id]
    _save_simulators(sims)
    return {"deleted": sim_id}


def _stop_sim(sim_id: str):
    if sim_id in _sim_processes:
        p = _sim_processes[sim_id]
        proc = p.get("proc")
        orphan_pid = p.get("orphan_pid")
        if proc and proc.poll() is None:
            pid = proc.pid
            # 1) Try graceful shutdown: send SIGTERM to the whole process group
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # 2) Force kill the process group
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    proc.kill()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
        elif orphan_pid:
            # Orphan process: no Popen object, kill directly by PID
            try:
                os.kill(orphan_pid, signal.SIGTERM)
                time.sleep(2)
                if _pid_alive(orphan_pid):
                    os.kill(orphan_pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        # Reap zombie just in case
        if proc:
            try:
                proc.wait(timeout=0)
            except Exception:
                pass
        pty_fd = p.get("pty_fd")
        if pty_fd is not None:
            try:
                os.close(pty_fd)
            except OSError:
                pass
        del _sim_processes[sim_id]


@app.post("/api/simulators/{sim_id}/start")
def start_simulator(sim_id: str):
    """Start a QEMU simulator with console output captured for the web UI.

    When serial_console is enabled (default), QEMU runs with ``-nographic``
    which multiplexes VGA text output + serial + QEMU monitor onto
    stdout/stdin.  This means GRUB menus, kernel boot messages and the
    login prompt all appear in the captured output.
    """
    sims = _load_simulators()
    sim = next((s for s in sims if s["id"] == sim_id), None)
    if not sim:
        raise HTTPException(status_code=404, detail="Simulator not found")

    if sim_id in _sim_processes:
        proc = _sim_processes[sim_id].get("proc")
        orphan_pid = _sim_processes[sim_id].get("orphan_pid")
        if proc and proc.poll() is None:
            return {"started": False, "reason": "Already running", "pid": proc.pid}
        if orphan_pid and _pid_alive(orphan_pid):
            return {"started": False, "orphan_detected": True, "pid": orphan_pid,
                    "reason": f"An existing QEMU process (PID {orphan_pid}) is already using this image."}

    img = sim.get("image_path", "")
    if not img or not pathlib.Path(img).is_file():
        raise HTTPException(status_code=400, detail=f"Image not found: {img}")

    qemu = sim.get("qemu_bin") or S("qemu_bin")
    mem = sim.get("memory") or "1024"

    # Detect image format from extension
    img_format = "qcow2" if img.endswith(".qcow2") else "raw"
    args = [qemu, "-m", mem, "-drive", f"file={img},format={img_format},if=virtio"]

    if sim.get("serial_console", True):
        # -nographic: no graphical window, VGA text output goes to stdout
        # -serial mon:stdio: multiplex serial port + QEMU monitor on stdin/stdout
        # This captures GRUB, kernel boot, and login prompt in the web console
        args += ["-nographic", "-serial", "mon:stdio"]
    else:
        # VNC-only mode: no serial capture
        vnc = sim.get("vnc_display", "") or ":0"
        args += ["-vnc", vnc]

    # User networking so guest can reach host at 10.0.2.2
    args += ["-nic", "user,model=virtio"]

    # Extra args from the user
    extra = sim.get("extra_args", "").strip()
    if extra:
        import shlex
        args += shlex.split(extra)

    try:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
            start_new_session=True,  # own process group for clean kill
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    _sim_processes[sim_id] = {
        "proc": proc,
        "pty_fd": None,
        "output_buffer": b"",
        "ws_clients": set(),
    }

    # Background reader thread — reads everything QEMU sends to stdout
    def _reader():
        entry = _sim_processes.get(sim_id)
        if not entry:
            return
        while True:
            try:
                data = proc.stdout.read(4096)
                if not data:
                    break
                entry["output_buffer"] += data
                # Keep only last 128KB to hold GRUB + boot output
                if len(entry["output_buffer"]) > 131072:
                    entry["output_buffer"] = entry["output_buffer"][-131072:]
            except Exception:
                break

    threading.Thread(target=_reader, daemon=True).start()

    return {"started": True, "pid": proc.pid, "sim_id": sim_id, "command": " ".join(args)}


@app.post("/api/simulators/{sim_id}/stop")
def stop_simulator(sim_id: str):
    if sim_id not in _sim_processes:
        return {"stopped": False, "reason": "Not running"}
    entry = _sim_processes[sim_id]
    pid = entry.get("proc", {})
    pid = pid.pid if hasattr(pid, "pid") else None
    _stop_sim(sim_id)
    return {"stopped": True, "killed_pid": pid}


@app.post("/api/simulators/{sim_id}/force-kill")
def force_kill_simulator(sim_id: str):
    """Force-kill a simulator by sending SIGKILL. Also kills orphan child processes."""
    if sim_id not in _sim_processes:
        return {"killed": False, "reason": "Not tracked (may be an orphan process)"}
    entry = _sim_processes[sim_id]
    proc = entry.get("proc")
    orphan_pid = entry.get("orphan_pid")
    pid = proc.pid if proc else orphan_pid
    if proc and proc.poll() is None:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.wait(timeout=3)
        except Exception:
            pass
    elif orphan_pid:
        try:
            os.kill(orphan_pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    pty_fd = entry.get("pty_fd")
    if pty_fd is not None:
        try:
            os.close(pty_fd)
        except OSError:
            pass
    if sim_id in _sim_processes:
        del _sim_processes[sim_id]
    return {"killed": True, "pid": pid}


@app.get("/api/simulators/{sim_id}/output")
def get_sim_output(sim_id: str, tail: int = 200):
    """Get captured console output (last N lines)."""
    if sim_id not in _sim_processes:
        return {"output": "", "running": False}
    entry = _sim_processes[sim_id]
    buf = entry.get("output_buffer", b"")
    try:
        text = buf.decode("utf-8", errors="replace")
    except Exception:
        text = str(buf)
    if tail > 0:
        lines = text.splitlines()
        text = "\n".join(lines[-tail:])
    proc = entry.get("proc")
    running = proc is not None and proc.poll() is None
    return {"output": text, "running": running}


@app.post("/api/simulators/{sim_id}/input")
async def send_sim_input(sim_id: str, request: Request):
    """Send text input to the simulator's stdin (for serial console)."""
    if sim_id not in _sim_processes:
        raise HTTPException(status_code=404, detail="Simulator not running")
    body = await request.json()
    text = body.get("text", "")
    proc = _sim_processes[sim_id].get("proc")
    if proc and proc.stdin:
        try:
            proc.stdin.write(text.encode())
            proc.stdin.flush()
            return {"sent": True}
        except Exception as e:
            return {"sent": False, "error": str(e)}
    return {"sent": False, "error": "No stdin available"}


@app.get("/api/simulators/images")
def list_available_images():
    """List disk images from local builds for use in simulators.

    Finds .img, .qcow2 (ready to boot) and compressed archives
    (.img.tar.xz, .img.tar.gz, .img.gz) that can be extracted first.
    """
    images = []
    seen = set()

    BOOT_EXTS = {".img", ".qcow2"}
    COMPRESSED_PATTERNS = (".img.tar.xz", ".img.tar.gz", ".img.gz")

    for d in _get_builds_dirs():
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if not f.is_file() or str(f) in seen:
                continue
            is_bootable = f.suffix in BOOT_EXTS
            is_compressed = any(f.name.endswith(p) for p in COMPRESSED_PATTERNS)
            if is_bootable or is_compressed:
                seen.add(str(f))
                images.append({
                    "name": f.name,
                    "path": str(f),
                    "build": d.name,
                    "size": f.stat().st_size,
                    "needs_extract": is_compressed,
                })

    return {"images": images}
