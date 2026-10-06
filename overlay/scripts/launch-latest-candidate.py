#!/usr/bin/env python3
"""Read-only preflight and explicit isolated launcher for the 9f93096 KR candidate.

Run on happytanuki.kr. Default mode only inspects Docker/container/port/resource state.
Use --launch --image-id sha256:<built-image-id> to create and start the one loopback
candidate. This script never changes routing and never stops/removes/restarts a container.
"""
from __future__ import annotations

import argparse
import copy
import http.client
import json
import os
import posixpath
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlencode

SOCKET_PATH = "/var/run/docker.sock"
SOURCE_NAME = "stronghold-ko-game-763e224"
SOURCE_IMAGE_ID = "sha256:e020310545a0a1156756f2197badf4b3867644fdc26e8a842de14f72f918cc34"
SOURCE_HEALTH_PORT = 3004
CANDIDATE_NAME = "stronghold-ko-game-9f93096-kr"
CANDIDATE_PORT = 3006
CONTAINER_PORT = "3000/tcp"
CANDIDATE_REVISION = "9f93096efaf4d1e671c76b8ca3efc4692b02d15b"
PRIVATE_ASSET_SOURCE = "/home/happytanuki/Docker/stronghold/releases/9f93096-kr-41.0.1-71ac81/public/assets"
ASSET_DESTINATION = "/app/public/assets"
SHARED_ASSET_ROOTS = (
    "/home/happytanuki/Stronghold-Protocol/public/assets",
    "/home/happytanuki/Docker/stronghold/shared/Stronghold-Protocol/public/assets",
)
HEALTH_TIMEOUT_SECONDS = 45


class PreflightError(RuntimeError):
    """A safe, user-actionable refusal before an unsafe/unsupported operation."""


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect(SOCKET_PATH)


def docker_request(method: str, path: str, body: dict | None = None) -> tuple[int, bytes]:
    conn = UnixHTTPConnection("localhost", timeout=15)
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {} if data is None else {"Content-Type": "application/json", "Content-Length": str(len(data))}
    try:
        conn.request(method, path, body=data, headers=headers)
        response = conn.getresponse()
        status = response.status
        payload = response.read()
        return status, payload
    except (OSError, http.client.HTTPException) as exc:
        raise PreflightError("Docker API is unavailable on this host") from exc
    finally:
        conn.close()


def docker_json(status: int, payload: bytes, label: str, allowed: tuple[int, ...] = ()) -> dict:
    if status in allowed:
        return {}
    if status < 200 or status >= 300:
        # Docker's response body is intentionally suppressed: it may contain copied config values.
        raise PreflightError(f"Docker API {label} returned HTTP {status}")
    try:
        value = json.loads(payload) if payload else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreflightError(f"Docker API {label} returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise PreflightError(f"Docker API {label} returned an unexpected response")
    return value


def docker_prefix() -> str:
    status, payload = docker_request("GET", "/version")
    version = docker_json(status, payload, "version")
    api_version = version.get("ApiVersion")
    if not isinstance(api_version, str) or not re.fullmatch(r"\d+\.\d+", api_version):
        raise PreflightError("Docker API version is unavailable")
    return "/v" + api_version


def inspect_container(prefix: str, name: str, label: str) -> dict:
    status, payload = docker_request("GET", prefix + "/containers/" + quote(name, safe="") + "/json")
    return docker_json(status, payload, label)


def is_shared_asset_source(source: str) -> bool:
    if not isinstance(source, str) or not source.startswith("/"):
        return False
    source_path = posixpath.normpath(posixpath.realpath(source))
    for root in SHARED_ASSET_ROOTS:
        root_path = posixpath.normpath(posixpath.realpath(root))
        try:
            common = posixpath.commonpath((source_path, root_path))
        except ValueError:
            continue
        # Reject a bind into the shared tree and an ancestor bind that would expose it.
        if common == source_path or common == root_path:
            return True
    return False


def split_bind(bind: str) -> tuple[str, str, str]:
    parts = bind.split(":", 2)
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise PreflightError("Source container has an unparseable bind definition")
    return parts[0], parts[1], parts[2] if len(parts) == 3 else ""


def rewrite_shared_asset_mounts(host_config: dict, inspected_mounts: list[dict], private_assets: str) -> dict:
    """Replace all inherited asset-target binds with one private read-only candidate bind.

    Other bind definitions are preserved. Any other inherited mount sourced from or
    overlapping the protected shared asset tree is rejected instead of being copied.
    """
    private_assets = posixpath.normpath(private_assets)
    if not private_assets.startswith("/") or is_shared_asset_source(private_assets):
        raise PreflightError("Private asset source is not a safe absolute candidate path")

    rewritten = copy.deepcopy(host_config)
    kept_binds = []
    for raw in rewritten.get("Binds") or []:
        source, destination, options = split_bind(raw)
        if destination == ASSET_DESTINATION:
            continue
        if is_shared_asset_source(source):
            raise PreflightError("Source container has an extra bind from the protected shared asset tree")
        kept_binds.append(raw)

    kept_mounts = []
    for mount in rewritten.get("Mounts") or []:
        if not isinstance(mount, dict):
            raise PreflightError("Source container has an invalid mount definition")
        source = mount.get("Source", "")
        destination = mount.get("Target") or mount.get("Destination") or ""
        if destination == ASSET_DESTINATION:
            continue
        if mount.get("Type") == "bind" and is_shared_asset_source(source):
            raise PreflightError("Source container has an extra mount from the protected shared asset tree")
        kept_mounts.append(mount)

    for mount in inspected_mounts:
        if not isinstance(mount, dict):
            raise PreflightError("Source container has an invalid inspected mount")
        source = mount.get("Source", "")
        destination = mount.get("Destination", "")
        if destination == ASSET_DESTINATION:
            continue
        if mount.get("Type") == "bind" and is_shared_asset_source(source):
            raise PreflightError("Source container has an extra inspected mount from the protected shared asset tree")

    rewritten["Binds"] = kept_binds + [private_assets + ":" + ASSET_DESTINATION + ":ro"]
    rewritten["Mounts"] = kept_mounts
    return rewritten


def resolve_private_assets() -> str:
    configured = Path(PRIVATE_ASSET_SOURCE)
    try:
        resolved = configured.resolve(strict=True)
    except OSError as exc:
        raise PreflightError("Private candidate asset tree is not staged at the required release path") from exc
    if not resolved.is_dir() or configured.is_symlink():
        raise PreflightError("Private candidate asset path must be a real directory, not a symlink")
    path = posixpath.normpath(resolved.as_posix())
    if is_shared_asset_source(path):
        raise PreflightError("Private candidate asset tree aliases the protected shared asset tree")
    if "9f93096-kr-41.0.1-71ac81" not in path:
        raise PreflightError("Asset path is not the versioned 9f93096 KR release")
    return path


def check_loopback_port_free(port: int) -> None:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise PreflightError(f"Candidate loopback port {port} is occupied")
    finally:
        probe.close()


def fetch_health(port: int, timeout: float = 2.0) -> dict:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=timeout) as response:
            if response.status != 200:
                raise PreflightError(f"Health endpoint on loopback port {port} returned HTTP {response.status}")
            data = response.read(8192)
    except PreflightError:
        raise
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        raise PreflightError(f"Health endpoint on loopback port {port} is unavailable") from exc
    try:
        result = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreflightError(f"Health endpoint on loopback port {port} returned invalid JSON") from exc
    if not isinstance(result, dict):
        raise PreflightError(f"Health endpoint on loopback port {port} returned an unexpected response")
    return result


def validate_source_health() -> dict:
    health = fetch_health(SOURCE_HEALTH_PORT)
    if health.get("ok") is not True or health.get("app") != "0.1.3":
        raise PreflightError("Current port-3004 source backend is not the expected healthy 0.1.3 baseline")
    return health


def inspect_candidate_image(prefix: str, image_id: str) -> tuple[dict, dict]:
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id or ""):
        raise PreflightError("--image-id must be an immutable sha256:<64 lowercase hex> image ID")
    status, payload = docker_request("GET", prefix + "/images/" + quote(image_id, safe="") + "/json")
    image = docker_json(status, payload, "candidate image")
    if image.get("Id") != image_id:
        raise PreflightError("Candidate image inspection did not return the requested immutable image ID")
    labels = ((image.get("Config") or {}).get("Labels") or {})
    if labels.get("org.opencontainers.image.revision") != CANDIDATE_REVISION:
        raise PreflightError("Candidate image revision label is not the frozen 9f93096 commit")
    version_label = labels.get("org.opencontainers.image.version", "")
    if not re.fullmatch(r"0\.1\.4(?:[-+].*)?", version_label):
        raise PreflightError("Candidate image version label is not 0.1.4")
    return image, labels


def checked_snapshot(prefix: str, image_id: str | None = None) -> dict:
    if os.name != "posix":
        raise PreflightError("Launcher must run on the Linux candidate host; local Windows execution is read-only syntax/preflight validation only")
    if not Path(SOCKET_PATH).exists():
        raise PreflightError("Docker Unix socket is unavailable; run this script on happytanuki.kr")

    api = docker_prefix()
    source = inspect_container(api, SOURCE_NAME, "current 3004 baseline")
    if source.get("Name", "").lstrip("/") != SOURCE_NAME:
        raise PreflightError("Inspected Docker source is not the named current 3004 baseline")
    if source.get("Image") != SOURCE_IMAGE_ID:
        raise PreflightError("Current 3004 source image ID differs from the pinned rollback baseline")
    if not (source.get("State") or {}).get("Running"):
        raise PreflightError("Current 3004 source container is not running; refusing a stale baseline")

    source_health = validate_source_health()
    name_status, name_payload = docker_request("GET", api + "/containers/" + quote(CANDIDATE_NAME, safe="") + "/json")
    if name_status != 404:
        docker_json(name_status, name_payload, "candidate name check")
        raise PreflightError("Candidate container name is already occupied")
    check_loopback_port_free(CANDIDATE_PORT)

    assets_source = resolve_private_assets()
    image_summary = None
    if image_id:
        image, labels = inspect_candidate_image(api, image_id)
        image_summary = {"id": image["Id"], "revision": labels["org.opencontainers.image.revision"], "version": labels["org.opencontainers.image.version"]}

    return {
        "api": api,
        "source": source,
        "source_health": source_health,
        "assets_source": assets_source,
        "image": image_summary,
    }


def compare_mounts(source_mounts: list[dict], candidate_mounts: list[dict], private_assets: str) -> bool:
    def norm(mount: dict) -> tuple:
        return (
            mount.get("Type"),
            posixpath.normpath(mount.get("Source", "")),
            mount.get("Destination"),
            mount.get("RW"),
            mount.get("Propagation", ""),
        )

    old_other = sorted(norm(m) for m in source_mounts if m.get("Destination") != ASSET_DESTINATION)
    new_other = sorted(norm(m) for m in candidate_mounts if m.get("Destination") != ASSET_DESTINATION)
    replacement = [m for m in candidate_mounts if m.get("Destination") == ASSET_DESTINATION]
    return (
        old_other == new_other
        and len(replacement) == 1
        and replacement[0].get("Type") == "bind"
        and posixpath.normpath(replacement[0].get("Source", "")) == private_assets
        and replacement[0].get("RW") is False
        and not any(is_shared_asset_source(m.get("Source", "")) for m in candidate_mounts if m.get("Type") == "bind")
    )


def compare_host_hardening(source: dict, candidate: dict) -> bool:
    source_config = source.get("Config") or {}
    candidate_config = candidate.get("Config") or {}
    if source_config.get("Env") != candidate_config.get("Env"):
        return False
    for key in ("User", "WorkingDir", "Entrypoint", "Cmd", "Healthcheck"):
        if source_config.get(key) != candidate_config.get(key):
            return False
    source_host = source.get("HostConfig") or {}
    candidate_host = candidate.get("HostConfig") or {}
    ignored = {"PortBindings", "Binds", "Mounts", "RestartPolicy"}
    for key, value in source_host.items():
        if key not in ignored and candidate_host.get(key) != value:
            return False
    if source_host.get("Privileged") is True or source_host.get("NetworkMode") == "host":
        return False
    if candidate_host.get("Privileged") is True or candidate_host.get("NetworkMode") == "host":
        return False
    if candidate_host.get("RestartPolicy") != {"Name": "no", "MaximumRetryCount": 0}:
        return False
    return True


def launch_candidate(snapshot: dict, image_id: str) -> dict:
    api = snapshot["api"]
    source = snapshot["source"]
    assets_source = snapshot["assets_source"]
    image, labels = inspect_candidate_image(api, image_id)

    # Re-read both exclusive resources immediately before create to close the preflight/launch gap.
    name_status, _ = docker_request("GET", api + "/containers/" + quote(CANDIDATE_NAME, safe="") + "/json")
    if name_status != 404:
        raise PreflightError("Candidate container name became occupied before launch")
    check_loopback_port_free(CANDIDATE_PORT)

    body = copy.deepcopy(source.get("Config") or {})
    body["Image"] = image_id
    body["Labels"] = labels
    host_config = rewrite_shared_asset_mounts(source.get("HostConfig") or {}, source.get("Mounts") or [], assets_source)
    host_config["PortBindings"] = {CONTAINER_PORT: [{"HostIp": "127.0.0.1", "HostPort": str(CANDIDATE_PORT)}]}
    host_config["PublishAllPorts"] = False
    host_config["RestartPolicy"] = {"Name": "no", "MaximumRetryCount": 0}
    body["HostConfig"] = host_config

    create_path = api + "/containers/create?" + urlencode({"name": CANDIDATE_NAME})
    create_status, create_payload = docker_request("POST", create_path, body)
    created = docker_json(create_status, create_payload, "candidate create")
    container_id = created.get("Id")
    if not isinstance(container_id, str) or not container_id:
        raise PreflightError("Docker created no candidate ID; no source container was changed")

    try:
        start_status, start_payload = docker_request("POST", api + "/containers/" + container_id + "/start")
        if start_status not in (204, 304):
            raise PreflightError(f"Candidate was created but start returned HTTP {start_status}; it was not cleaned up")
    except PreflightError:
        raise

    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    candidate = None
    health = None
    while time.monotonic() < deadline:
        status, payload = docker_request("GET", api + "/containers/" + container_id + "/json")
        candidate = docker_json(status, payload, "candidate readback")
        if not (candidate.get("State") or {}).get("Running"):
            raise PreflightError("Candidate stopped before readiness; candidate is preserved for inspection")
        try:
            health = fetch_health(CANDIDATE_PORT, timeout=2.0)
            if health.get("ok") is True:
                break
        except PreflightError:
            pass
        time.sleep(1)
    if not health or health.get("ok") is not True:
        raise PreflightError("Candidate stayed running but did not become healthy within 45 seconds; candidate is preserved")
    if health.get("app") != "0.1.4":
        raise PreflightError("Candidate health version is not 0.1.4; candidate is preserved")

    status, payload = docker_request("GET", api + "/containers/" + container_id + "/json")
    candidate = docker_json(status, payload, "final candidate readback")
    hostconfig_ok = compare_host_hardening(source, candidate)
    mounts_ok = compare_mounts(source.get("Mounts") or [], candidate.get("Mounts") or [], assets_source)
    expected_bindings = {CONTAINER_PORT: [{"HostIp": "127.0.0.1", "HostPort": str(CANDIDATE_PORT)}]}
    if candidate.get("Image") != image_id or (candidate.get("Config") or {}).get("Image") != image_id:
        raise PreflightError("Candidate readback does not use the requested immutable image ID; candidate is preserved")
    if not hostconfig_ok:
        raise PreflightError("Candidate readback changed baseline environment or hardening settings; candidate is preserved")
    if not mounts_ok:
        raise PreflightError("Candidate readback has an unexpected or non-read-only mount; candidate is preserved")
    if (candidate.get("HostConfig") or {}).get("PortBindings") != expected_bindings:
        raise PreflightError("Candidate readback is not bound only to 127.0.0.1:3006; candidate is preserved")
    final_health = fetch_health(CANDIDATE_PORT)
    if final_health.get("ok") is not True or final_health.get("app") != "0.1.4":
        raise PreflightError("Candidate final health readback is not 0.1.4; candidate is preserved")
    for key in ("matches", "rooms", "humans", "sessions", "sockets"):
        value = final_health.get(key)
        if isinstance(value, (int, float)) and value != 0:
            raise PreflightError(f"Candidate final health has nonzero {key}; candidate is preserved")

    return {
        "status": "candidate_running_verified",
        "candidate": CANDIDATE_NAME,
        "container_id": container_id,
        "source_container": SOURCE_NAME,
        "source_image_id": source.get("Image"),
        "candidate_image_id": image.get("Id"),
        "image_revision": labels["org.opencontainers.image.revision"],
        "image_version": labels["org.opencontainers.image.version"],
        "loopback_binding": "127.0.0.1:3006->3000/tcp",
        "asset_mount": {"source": assets_source, "destination": ASSET_DESTINATION, "read_only": True},
        "environment_values_logged": False,
        "environment_equal_to_source": True,
        "hardening_equal_to_source": True,
        "non_asset_mounts_equal_to_source": True,
        "health": final_health,
        "nginx_changed": False,
        "source_stopped_or_modified": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--launch", action="store_true", help="create/start the isolated candidate (never enabled by default)")
    parser.add_argument("--image-id", help="immutable sha256 image ID from the completed build")
    args = parser.parse_args()
    try:
        if args.launch and not args.image_id:
            raise PreflightError("--launch requires --image-id from the completed 0.1.4 build")
        snapshot = checked_snapshot(args.image_id)
        if not args.launch:
            result = {
                "status": "read_only_preflight_passed",
                "source_container": SOURCE_NAME,
                "source_image_id": snapshot["source"].get("Image"),
                "source_health": snapshot["source_health"],
                "candidate_name_available": True,
                "candidate_loopback_port": CANDIDATE_PORT,
                "private_assets_ready": True,
                "immutable_candidate_image": snapshot["image"],
                "launch_performed": False,
                "routing_changed": False,
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        result = launch_candidate(snapshot, args.image_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except PreflightError as exc:
        print(json.dumps({"status": "blocked", "error": str(exc), "side_effects": "none unless an explicit launch already created the candidate"}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
