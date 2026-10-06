#!/usr/bin/env python3
"""Strict, KR-only Stronghold client extraction adapter.

This adapter resolves the verified Korean Windows installation against its active
catalog, invokes guarded upstream helpers in a private staging tree, and commits
only a complete, validated package. It never invokes upstream main().
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

ADAPTER_DIR = Path(__file__).resolve().parent
CONTRACT_PATH = ADAPTER_DIR / "contract.json"
EXIT_SOURCE = 2
EXIT_OPERATION = 1
HEX32 = re.compile(r"^[0-9a-fA-F]{32}$")


class AdapterError(Exception):
    """Expected source, selection, or contract refusal (CLI exit 2)."""
    exit_code = EXIT_SOURCE


class OperationError(Exception):
    """Decode, export, or package validation error (CLI exit 1)."""
    exit_code = EXIT_OPERATION


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AdapterError(f"cannot read JSON {path}: {exc}") from exc


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    text = json.dumps(value, ensure_ascii=False, indent=2 if pretty else None,
                      separators=None if pretty else (",", ":"), sort_keys=False)
    return (text + "\n").encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def md5_file(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_record(path: Path) -> dict[str, Any]:
    return {"size": path.stat().st_size, "sha256": sha256_file(path), "md5": md5_file(path)}


def _path_has_reparse_flag(path: Path) -> bool:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return False
    return path.is_symlink() or bool(getattr(st, "st_file_attributes", 0) & 0x400)


def assert_no_reparse_components(path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        if _path_has_reparse_flag(current):
            raise AdapterError(f"reparse/symlink path component refused: {current}")


def _contains_path(child: Path, parent: Path) -> bool:
    try:
        child_s = os.path.normcase(os.path.abspath(child))
        parent_s = os.path.normcase(os.path.abspath(parent))
        return os.path.commonpath([child_s, parent_s]) == parent_s
    except (ValueError, OSError):
        return False


def _reject_traversal_arg(value: str, label: str) -> None:
    if any(part == ".." for part in re.split(r"[\\/]", value)):
        raise AdapterError(f"{label} may not contain '..' path traversal")


def safe_relative(value: str, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value or ":" in value:
        raise AdapterError(f"unsafe {label}: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(p in ("", ".", "..") for p in path.parts):
        raise AdapterError(f"unsafe {label}: {value!r}")
    return path


def _load_contract() -> dict[str, Any]:
    contract = read_json(CONTRACT_PATH)
    if not isinstance(contract, dict) or contract.get("schemaVersion") != 1:
        raise AdapterError(f"unsupported adapter contract: {CONTRACT_PATH}")
    return contract


def verify_upstream(upstream: Path, contract: dict[str, Any]) -> dict[str, Any]:
    assert_no_reparse_components(upstream)
    upstream = upstream.resolve(strict=True)
    if not upstream.is_dir():
        raise AdapterError(f"upstream is not a directory: {upstream}")
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(upstream), "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise AdapterError(f"cannot read upstream HEAD: {result.stderr.strip()}")
    head = result.stdout.strip()
    if head != contract["upstream"]["head"]:
        raise AdapterError(f"unsupported upstream HEAD {head}; expected {contract['upstream']['head']}")
    hashes = {}
    for relative, expected in contract["upstream"]["files"].items():
        rel = safe_relative(relative, "upstream contract path")
        path = upstream.joinpath(*rel.parts)
        if not path.is_file() or _path_has_reparse_flag(path):
            raise AdapterError(f"missing or unsafe guarded upstream file: {relative}")
        actual = sha256_file(path)
        hashes[relative] = actual
        if actual.lower() != expected.lower():
            raise AdapterError(f"upstream source drift: {relative} (sha256 {actual})")
    return {"head": head, "files": hashes}


def _catalog_index(document: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(document, dict) or not isinstance(document.get("abInfos"), list):
        raise AdapterError(f"invalid {label} catalog schema")
    indexed: dict[str, dict[str, Any]] = {}
    for record in document["abInfos"]:
        if not isinstance(record, dict) or not isinstance(record.get("name"), str):
            raise AdapterError(f"invalid record in {label} catalog")
        name = record["name"]
        safe_relative(name, f"{label} catalog entry")
        previous = indexed.get(name)
        if previous is not None and previous != record:
            raise AdapterError(f"conflicting duplicate catalog entry: {name}")
        indexed[name] = record
    return indexed


def _catalog_identity(record: dict[str, Any]) -> tuple[str, str, int]:
    md5, hash_id, ab_size = record.get("md5"), record.get("hash"), record.get("abSize")
    if not isinstance(md5, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", md5):
        raise AdapterError(f"invalid catalog md5 for {record.get('name')!r}")
    if not isinstance(hash_id, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", hash_id):
        raise AdapterError(f"invalid catalog hash for {record.get('name')!r}")
    if isinstance(ab_size, bool) or not isinstance(ab_size, int) or ab_size <= 0:
        raise AdapterError(f"invalid catalog abSize for {record.get('name')!r}")
    total_size = record.get("totalSize")
    if isinstance(total_size, bool) or not isinstance(total_size, int) or total_size < 0:
        raise AdapterError(f"invalid catalog totalSize for {record.get('name')!r}")
    return hash_id.lower(), md5.lower(), ab_size


def _assert_record_matches_file(record: dict[str, Any], path: Path) -> dict[str, Any]:
    _, expected_md5, expected_size = _catalog_identity(record)
    actual_size, actual_md5 = path.stat().st_size, md5_file(path)
    if actual_size != expected_size:
        raise AdapterError(f"catalog size mismatch for {record['name']}: {actual_size} != {expected_size}")
    if actual_md5.lower() != expected_md5:
        raise AdapterError(f"catalog MD5 mismatch for {record['name']}")
    return file_record(path)


class CatalogResolver:
    """Resolve an active H identity to verified H bytes or unchanged B bytes."""
    def __init__(self, b_root: Path, h_root: Path, h_doc: dict[str, Any], b_doc: dict[str, Any], p_doc: dict[str, Any]):
        self.b_root, self.h_root = b_root, h_root
        self.h = _catalog_index(h_doc, "H")
        self.b = _catalog_index(b_doc, "B")
        self.p = _catalog_index(p_doc, "persistent")

    @staticmethod
    def _resolve_under(root: Path, relative: str) -> Path | None:
        rel = safe_relative(relative, "catalog entry")
        path = root.joinpath(*rel.parts)
        if _path_has_reparse_flag(path):
            raise AdapterError(f"reparse/symlink bundle refused: {path}")
        if not path.exists():
            return None
        resolved = path.resolve(strict=True)
        if not _contains_path(resolved, root.resolve(strict=True)):
            raise AdapterError(f"bundle escapes its source root: {path}")
        if not resolved.is_file():
            raise AdapterError(f"catalog bundle is not a file: {path}")
        return resolved

    def resolve(self, logical_path: str) -> dict[str, Any]:
        safe_relative(logical_path, "logical bundle path")
        kr_variant = f"[[kr]]/{logical_path}"
        selected_path = kr_variant if kr_variant in self.h else logical_path
        active = self.h.get(selected_path)
        if active is None:
            raise AdapterError(f"not present in active KR catalog: {logical_path}")
        _catalog_identity(active)
        h_file = self._resolve_under(self.h_root, selected_path)
        if h_file is not None:
            data = _assert_record_matches_file(active, h_file)
            persistent = self.p.get(selected_path)
            if persistent is None:
                raise AdapterError(f"downloaded H bundle missing from persistent_res_list.json: {selected_path}")
            if _catalog_identity(persistent) != _catalog_identity(active):
                raise AdapterError(f"persistent inventory identity mismatch: {selected_path}")
            return {
                "logicalPath": logical_path, "relativePath": selected_path, "sourceRoot": "H",
                "absolutePath": str(h_file), "activeCatalogRecord": active,
                "sourceCatalogRecord": active, "baseCatalogRecord": self.b.get(logical_path),
                "persistentRecord": persistent, **data,
            }
        if selected_path != logical_path:
            raise AdapterError(f"localized KR override is cataloged but absent from H; refusing fallback: {selected_path}")
        base = self.b.get(logical_path)
        if base is None:
            raise AdapterError(f"H bundle absent and no B catalog identity for verified base fallback: {logical_path}")
        if _catalog_identity(base) != _catalog_identity(active):
            raise AdapterError(f"B bytes are not the active H identity; refusing stale fallback: {logical_path}")
        b_file = self._resolve_under(self.b_root, logical_path)
        if b_file is None:
            raise AdapterError(f"bundle missing from both H and verified B: {logical_path}")
        data = _assert_record_matches_file(base, b_file)
        return {
            "logicalPath": logical_path, "relativePath": logical_path, "sourceRoot": "B",
            "absolutePath": str(b_file), "activeCatalogRecord": active,
            "sourceCatalogRecord": base, "baseCatalogRecord": base,
            "persistentRecord": None, **data,
        }


def _read_identity_file(path: Path) -> tuple[bytes, Any]:
    if not path.is_file() or _path_has_reparse_flag(path):
        raise AdapterError(f"missing or unsafe client identity file: {path}")
    data = path.read_bytes()
    return data, json.loads(data.decode("utf-8-sig"))


def verify_install(install: Path, contract: dict[str, Any]) -> dict[str, Any]:
    assert_no_reparse_components(install)
    install = install.resolve(strict=True)
    if not install.is_dir():
        raise AdapterError(f"client install root is not a directory: {install}")
    assert_no_reparse_components(install)
    data_dir = install / "Arknights_Data"
    b_root = data_dir / "StreamingAssets" / "AB" / "Windows"
    h_root = data_dir / "PersistentData" / "Bundles"
    for root in (b_root, h_root):
        if not root.is_dir():
            raise AdapterError(f"unsupported Korean client layout; missing bundle root: {root}")
        assert_no_reparse_components(root)
    app_path = data_dir / "app.info"
    config_path = install / "game-launcher-config.json"
    manifest_path = install / "manifest.json"
    if not (install / "Arknights.exe").is_file():
        raise AdapterError(f"not a Windows Arknights game root: missing {install / 'Arknights.exe'}")
    app_bytes = app_path.read_bytes() if app_path.is_file() and not _path_has_reparse_flag(app_path) else None
    if app_bytes is None:
        raise AdapterError(f"missing or unsafe client identity file: {app_path}")
    try:
        config_bytes, launcher = _read_identity_file(config_path)
        manifest_bytes, manifest = _read_identity_file(manifest_path)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise AdapterError(f"invalid client identity metadata: {exc}") from exc
    app_lines = [line.strip() for line in app_bytes.decode("utf-8-sig", errors="replace").splitlines() if line.strip()]
    expected = contract["supportedClient"]
    if len(app_lines) < 2 or app_lines[-1] != expected["tag"] or expected["tag"] not in app_lines:
        raise AdapterError(f"app.info does not identify {expected['tag']}")
    if not isinstance(launcher, dict) or launcher.get("tag") != expected["tag"]:
        raise AdapterError(f"launcher config does not identify {expected['tag']}")
    if not isinstance(manifest, dict) or manifest.get("name") != expected["tag"]:
        raise AdapterError(f"installation manifest does not identify {expected['tag']}")
    version = launcher.get("version")
    if version != expected["version"] or manifest.get("version") != version:
        raise AdapterError(f"unsupported/inconsistent client version: {version!r}/{manifest.get('version')!r}")

    paths = {"B": b_root / "hot_update_list.json", "H": h_root / "hot_update_list.json",
             "persistent": h_root / "persistent_res_list.json"}
    docs, hashes = {}, {}
    for label, path in paths.items():
        if not path.is_file() or _path_has_reparse_flag(path):
            raise AdapterError(f"missing or unsafe {label} catalog: {path}")
        raw = path.read_bytes()
        try:
            doc = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise AdapterError(f"invalid {label} catalog: {exc}") from exc
        docs[label] = doc
        hashes[label] = sha256_bytes(raw)
        key = {"B": "bCatalog", "H": "hCatalog", "persistent": "persistentCatalog"}[label]
        pinned = contract["snapshot"][key]
        if hashes[label].lower() != pinned["sha256"].lower():
            raise AdapterError(f"unsupported {label} catalog bytes: sha256 {hashes[label]}")
    for label, doc, pin in (("H", docs["H"], contract["snapshot"]["hCatalog"]),
                            ("B", docs["B"], contract["snapshot"]["bCatalog"])):
        for field in ("versionId", "manifestName", "manifestVersion"):
            if doc.get(field) != pin[field]:
                raise AdapterError(f"{label} catalog {field} mismatch")
    for field in ("manifestName", "manifestVersion"):
        if docs["persistent"].get(field) != contract["snapshot"]["persistentCatalog"][field] or docs["persistent"].get(field) != docs["H"].get(field):
            raise AdapterError(f"persistent/H catalog {field} mismatch")
    resolver = CatalogResolver(b_root.resolve(strict=True), h_root.resolve(strict=True), docs["H"], docs["B"], docs["persistent"])
    identities = {
        "tag": expected["tag"], "version": version,
        "appInfoSha256": sha256_bytes(app_bytes), "launcherConfigSha256": sha256_bytes(config_bytes),
        "installationManifestSha256": sha256_bytes(manifest_bytes),
        "manifestName": docs["H"]["manifestName"], "manifestVersion": docs["H"]["manifestVersion"],
        "catalogVersionId": docs["H"]["versionId"],
        "snapshotId": f"{docs['H']['versionId']}/{docs['H']['manifestVersion']}",
    }
    return {"installRoot": install, "bRoot": b_root.resolve(strict=True), "hRoot": h_root.resolve(strict=True),
            "resolver": resolver, "catalogDocs": docs, "catalogPaths": paths, "catalogHashes": hashes,
            "identities": identities}


def load_guarded_upstream(upstream: Path, contract: dict[str, Any]) -> tuple[Any, Any, Any]:
    """Import the original pinned helper modules by path; never run their CLI main()."""
    upstream = upstream.resolve(strict=True)
    sys.dont_write_bytecode = True
    helper_dir = upstream / "tools" / "local-extract"
    if str(helper_dir) not in sys.path:
        sys.path.insert(0, str(helper_dir))
    spec = importlib.util.spec_from_file_location("stronghold_kr_guarded_extract", helper_dir / "extract.py")
    if spec is None or spec.loader is None:
        raise AdapterError("cannot load guarded upstream extraction helpers")
    helper = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = helper
    spec.loader.exec_module(helper)
    aklz4 = importlib.import_module("aklz4")
    if Path(aklz4.__file__).resolve() != (helper_dir / "aklz4.py").resolve():
        raise AdapterError("LZ4AK decoder was imported from an unexpected location")
    unitypy = importlib.import_module("UnityPy")
    try:
        versions = {name: importlib.metadata.version(name) for name in ("UnityPy", "lz4", "Pillow")}
    except importlib.metadata.PackageNotFoundError as exc:
        raise AdapterError(f"required extraction dependency is missing: {exc}") from exc
    expected = {"UnityPy": "1.25.4", "lz4": "4.4.5", "Pillow": "12.3.0"}
    if versions != expected:
        raise AdapterError(f"unsupported extraction dependency versions: {versions}; expected {expected}")
    if sys.version_info[:2] != (3, 11):
        raise AdapterError(f"Python 3.11 required, got {sys.version.split()[0]}")
    return helper, unitypy, {"python": sys.version.split()[0], **versions}


def _job_rows(helper: Any) -> list[dict[str, Any]]:
    rows = []
    for job in helper.JOBS:
        rel, group, kinds, keep = helper.job_parts(job)
        rows.append({"job": job, "bundle": rel, "group": group, "kinds": sorted(kinds), "keep": keep})
    return rows


def inspect_jobs(install: Path, upstream: Path, contract: dict[str, Any], all_jobs: bool) -> dict[str, Any]:
    context = verify_install(install, contract)
    helper, unitypy, versions = load_guarded_upstream(upstream, contract)
    rows = _job_rows(helper)
    if not all_jobs:
        required = set(contract["boardProfile"]["groups"])
        rows = [row for row in rows if row["group"] in required]
    results = {}
    for row in rows:
        rel, group = row["bundle"], row["group"]
        result: dict[str, Any] = {"bundle": rel, "group": group, "requestedTypes": row["kinds"], "status": "unknown"}
        try:
            source = context["resolver"].resolve(rel)
            result["source"] = {"root": source["sourceRoot"], "relativePath": source["relativePath"],
                                "catalogRecord": source["activeCatalogRecord"], "sha256": source["sha256"], "size": source["size"]}
            try:
                env = unitypy.load(source["absolutePath"])
            except Exception as exc:
                result.update(status="decode_error", error=f"{type(exc).__name__}: {exc}")
            else:
                counts: dict[str, int] = {}
                candidates = 0
                for obj in env.objects:
                    kind = obj.type.name
                    counts[kind] = counts.get(kind, 0) + 1
                    if kind not in row["kinds"]:
                        continue
                    try:
                        name = getattr(obj.read(), "m_Name", "") or ""
                    except Exception:
                        continue
                    if row["keep"] is None or row["keep"].search(name):
                        candidates += 1
                result["objectTypeCounts"] = dict(sorted(counts.items()))
                result["exportableCandidates"] = candidates
                result["status"] = "zero_export_types" if candidates == 0 else "available"
        except AdapterError as exc:
            result.update(status="missing_or_invalid_source", error=str(exc))
        results[group] = result
    return {"identity": context["identities"], "catalogs": context["catalogHashes"], "jobs": results,
            "enemySpines": {"status": "unverified_not_scanned", "ids": contract["knownLimitations"]["enemySpines"]["ids"],
                            "reason": "targeted catalog-resolved enemy scan and exports have not been accepted"},
            "dependencyVersions": versions}


def _selected_jobs(helper: Any, only: list[str], profile: str | None, contract: dict[str, Any]) -> tuple[list[Any], list[str], str]:
    if profile and only:
        raise AdapterError("--profile and --only are mutually exclusive")
    if profile not in (None, "board"):
        raise AdapterError(f"unsupported extraction profile: {profile}")
    rows = _job_rows(helper)
    known_groups = sorted({row["group"] for row in rows})
    if profile == "board":
        requested = list(contract["boardProfile"]["groups"])
        missing = [group for group in requested if group not in known_groups]
        if missing:
            raise AdapterError(f"guarded upstream JOBS does not provide board groups: {missing}")
        selected = set(requested)
        return [row["job"] for row in rows if row["group"] in selected], requested, "board"
    if not only:
        raise AdapterError("extract requires explicit --only group/prefix or --profile board")
    prefixes = []
    for raw in only:
        if not raw or raw != raw.strip("/"):
            raise AdapterError(f"invalid --only group prefix: {raw!r}")
        safe_relative(raw, "--only group prefix")
        prefix = raw.rstrip("/")
        if prefix == "spine/enemy" or prefix.startswith("spine/enemy/"):
            raise AdapterError("enemy Spine extraction is unverified and unsupported in adapter v1")
        if not any(name == prefix or name.startswith(prefix + "/") for name in known_groups):
            raise AdapterError(f"unknown --only group/prefix: {prefix}")
        prefixes.append(prefix)
    jobs = helper.select_jobs(prefixes)
    if not jobs:
        raise AdapterError(f"--only selected no jobs: {prefixes}")
    selected_groups = sorted({helper.job_parts(job)[1] for job in jobs})
    return jobs, selected_groups, "only"

def _stage_verified(source: dict[str, Any], input_root: Path, stage_as: str) -> dict[str, Any]:
    rel = safe_relative(stage_as, "private staging path")
    target = input_root.joinpath(*rel.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or _path_has_reparse_flag(target):
        raise OperationError(f"private staging collision: {target}")
    before = file_record(Path(source["absolutePath"]))
    if before != {"size": source["size"], "sha256": source["sha256"], "md5": source["md5"]}:
        raise AdapterError(f"source changed while staging: {source['relativePath']}")
    for attempt in range(3):
        try:
            with Path(source["absolutePath"]).open("rb") as src, target.open("xb") as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
            break
        except PermissionError:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
            if attempt == 2:
                raise
            import time
            time.sleep(0.15)
    if file_record(target) != before:
        raise OperationError(f"staged bytes do not match verified source: {stage_as}")
    return {
        "role": "primary", "logicalPath": source["logicalPath"], "relativePath": source["relativePath"],
        "sourceRoot": source["sourceRoot"], "absolutePath": source["absolutePath"],
        "catalogRecord": source["activeCatalogRecord"], "sourceCatalogRecord": source["sourceCatalogRecord"],
        "baseCatalogRecord": source["baseCatalogRecord"], "persistentRecord": source["persistentRecord"],
        "size": source["size"], "sha256": source["sha256"], "md5": source["md5"], "stagedPath": str(target),
    }


def _shader_dependency_names(resolver: CatalogResolver) -> list[str]:
    candidates = set()
    for name in resolver.h:
        logical = name[len("[[kr]]/"):] if name.startswith("[[kr]]/") else name
        if logical == "[uc]shaders.ab" or (logical.startswith("shaders/") and logical.endswith(".ab")):
            candidates.add(logical)
    return sorted(candidates)


def _available_dependency(resolver: CatalogResolver, logical_path: str) -> dict[str, Any] | None:
    try:
        return resolver.resolve(logical_path)
    except AdapterError as exc:
        if "bundle missing from both H and verified B" in str(exc):
            return None
        raise


def _bundle_header(env: Any) -> dict[str, Any]:
    file = getattr(env, "file", None)
    if file is None:
        return {}
    value = getattr(file, "dataflags", None)
    try:
        flags = int(value) if value is not None else None
    except (TypeError, ValueError):
        flags = None
    block_flags = getattr(file, "_block_info_flags", None)
    try:
        block_flags = int(block_flags) if block_flags is not None else None
    except (TypeError, ValueError):
        block_flags = None
    return {
        "signature": getattr(file, "signature", None), "formatVersion": getattr(file, "version", None),
        "playerVersion": getattr(file, "version_player", None), "engineVersion": getattr(file, "version_engine", None),
        "archiveFlags": flags, "blockInfoCompressionFlags": (flags & 0x3F) if flags is not None else None,
        "dataBlockFlags": block_flags,
    }


def _object_metadata(env: Any, helper: Any, job: Any, entries: dict[str, Any], primary_objects: list[Any] | None = None) -> tuple[list[dict[str, Any]], dict[str, int], list[dict[str, Any]]]:
    _, _, kinds, keep = helper.job_parts(job)
    counts: dict[str, int] = {}
    objects: list[dict[str, Any]] = []
    texture_formats: list[dict[str, Any]] = []
    for obj in list(primary_objects if primary_objects is not None else env.objects):
        kind = obj.type.name
        counts[kind] = counts.get(kind, 0) + 1
        if kind not in kinds:
            continue
        item: dict[str, Any] = {"pathId": str(obj.path_id), "type": kind, "originalName": None,
                                "exportedName": None, "outputPath": None}
        try:
            data = obj.read()
            raw_name = getattr(data, "m_Name", "") or ""
            if keep is not None and not keep.search(raw_name):
                continue
            exported = helper.safe_name(raw_name or f"obj_{obj.path_id}")
            item.update(originalName=raw_name, exportedName=exported)
            if kind == "Texture2D":
                item["width"] = getattr(data, "m_Width", None)
                item["height"] = getattr(data, "m_Height", None)
                texture_format = getattr(data, "m_TextureFormat", None)
                item["textureFormat"] = int(texture_format) if texture_format is not None else None
                texture_formats.append({"pathId": str(obj.path_id), "name": raw_name, "width": item["width"],
                                        "height": item["height"], "format": item["textureFormat"]})
            if kind in ("Texture2D", "Sprite"):
                entry = entries.get(exported)
                if entry and entry.get("kind") in ("Texture2D", "Sprite"):
                    item["outputPath"] = entry.get("path")
            elif kind == "Mesh":
                mesh_key = exported
                if mesh_key not in entries and f"{exported}_{obj.path_id}" in entries:
                    mesh_key = f"{exported}_{obj.path_id}"
                entry = entries.get(mesh_key)
                if entry and entry.get("kind") == "Mesh":
                    item.update(exportedName=mesh_key, outputPath=entry.get("path"))
            elif kind == "TextAsset":
                raw = data.m_Script
                blob = raw.encode("utf-8", "surrogateescape") if isinstance(raw, str) else bytes(raw)
                if exported.endswith((".atlas", ".skel")):
                    filename = exported
                elif blob[:1] in (b"\n", b"") or b"size:" in blob[:200]:
                    filename = exported + ".atlas"
                else:
                    filename = exported + ".skel"
                if filename in entries:
                    item.update(exportedName=filename, outputPath=entries[filename].get("path"))
            elif kind in ("Material", "GameObject"):
                entry = entries.get("materials" if kind == "Material" else "prefab")
                if entry:
                    item["outputPath"] = entry.get("path")
        except Exception as exc:
            item["readError"] = f"{type(exc).__name__}: {exc}"
        objects.append(item)
    return objects, dict(sorted(counts.items())), texture_formats


def _normalize_obj_files(package_assets: Path, groups: dict[str, dict[str, Any]]) -> None:
    for group, entries in groups.items():
        for entry in entries.values():
            if entry.get("kind") != "Mesh":
                continue
            url = entry.get("path", "")
            if not url.startswith("/assets/local/"):
                raise OperationError(f"invalid mesh manifest URL: {url!r}")
            rel = safe_relative(url[len("/assets/local/"):], "mesh output URL")
            path = package_assets.joinpath(*rel.parts)
            text = path.read_bytes().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
            path.write_bytes(text.encode("utf-8"))
            entry["verts"] = sum(line.startswith("v ") for line in text.splitlines())
            entry["faces"] = sum(line.startswith("f ") for line in text.splitlines())


def _derive_kr_normal(package_assets: Path, groups: dict[str, dict[str, Any]], texture_records: list[dict[str, Any]], helper: Any, contract: dict[str, Any]) -> dict[str, Any]:
    from PIL import Image
    entries = groups.get("map/autochess")
    if not entries or "TX_autochessi_N" not in entries:
        raise OperationError("missing TX_autochessi_N packed normal source")
    expected = contract["realFixtures"]["normalDxt5nmAg"]
    texture = next((item for item in texture_records if item.get("name") == expected["source"]), None)
    if not texture or texture.get("format") != expected["textureFormat"]:
        raise AdapterError(f"unsupported KR normal encoding; expected TextureFormat {expected['textureFormat']}, found {texture}")
    if (texture.get("width"), texture.get("height")) != (expected["sourceWidth"], expected["sourceHeight"]):
        raise AdapterError("unsupported KR packed normal dimensions")
    raw_path = package_assets / "map" / "autochess" / f"{expected['source']}.png"
    try:
        raw = Image.open(raw_path).convert("RGBA")
    except Exception as exc:
        raise OperationError(f"cannot decode packed normal PNG: {exc}") from exc
    source_hash = sha256_bytes(raw.tobytes())
    if source_hash != expected["sourceRgbaSha256"]:
        raise OperationError(f"packed normal source RGBA hash mismatch: {source_hash}")
    red, green, _, alpha = raw.split()
    if red.getextrema() != (255, 255):
        raise AdapterError("DXT5nm/AG recipe refused: constant-red source profile no longer matches")
    # Verified KR DXT5nm source: X is A, Y is G. Preserve the raw RGBA image.
    ag = Image.merge("RGB", (alpha, green, Image.new("L", raw.size, 0)))
    derived = helper.derive_normal_rg(ag)
    output = package_assets / "map" / "autochess" / "TX_autochessi_N_rgb.png"
    derived.save(output, format="PNG")
    pixel_hash = sha256_bytes(derived.convert("RGB").tobytes())
    if pixel_hash != expected["derivedRgbSha256"]:
        raise OperationError(f"DXT5nm/AG normal pixel hash mismatch: {pixel_hash}")
    blue = derived.convert("RGB").getchannel("B")
    z_range = blue.getextrema()
    if z_range == (expected["mustNotBeConstantZ"], expected["mustNotBeConstantZ"]):
        raise OperationError("derived normal regression: Z is constant 128")
    entries["TX_autochessi_N_rgb"] = {
        "path": "/assets/local/map/autochess/TX_autochessi_N_rgb.png", "w": derived.width, "h": derived.height,
        "kind": "Derived", "from": expected["source"], "derive": "normal_dxt5nm_ag",
    }
    return {"source": expected["source"], "sourceTextureFormat": texture["format"],
            "channels": {"x": "A", "y": "G", "z": "reconstructed"}, "sourceAlphaPreserved": True,
            "output": "TX_autochessi_N_rgb.png", "pixelSha256": pixel_hash,
            "firstPixelRgb": list(derived.convert("RGB").getpixel((0, 0))), "zRange": list(z_range)}


def _pixel_hash(path: Path, crop: tuple[int, int, int, int] | None = None, mode: str = "RGBA") -> tuple[str, int, int, bytes]:
    from PIL import Image
    image = Image.open(path).convert(mode)
    if crop is not None:
        x, y, w, h = crop
        image = image.crop((x, y, x + w, y + h))
    pixels = image.tobytes()
    return sha256_bytes(pixels), image.width, image.height, pixels


def _manifest_asset_path(package: Path, entry: dict[str, Any]) -> Path:
    url = entry.get("path")
    if not isinstance(url, str) or not url.startswith("/assets/local/"):
        raise OperationError(f"invalid package asset URL: {url!r}")
    rel = safe_relative(url[len("/assets/local/"):], "manifest asset URL")
    root = package / "public" / "assets" / "local"
    path = root.joinpath(*rel.parts)
    if not _contains_path(path.resolve(strict=False), root.resolve(strict=False)):
        raise OperationError(f"manifest asset escapes package: {url}")
    return path


def _load_manifest(package: Path) -> dict[str, Any]:
    doc = read_json(package / "data" / "local-assets.json")
    if not isinstance(doc, dict) or doc.get("version") != 1 or doc.get("source") != "local-client" or doc.get("locale") != "ko-KR":
        raise OperationError("manifest does not satisfy local-assets version-1/KR contract")
    groups = doc.get("groups")
    if not isinstance(groups, dict) or not groups:
        raise OperationError("manifest has no groups")
    count, paths = 0, {}
    for group, entries in groups.items():
        safe_relative(group, "manifest group")
        if not isinstance(entries, dict):
            raise OperationError(f"invalid manifest group: {group}")
        count += len(entries)
        for name, entry in entries.items():
            safe_relative(name, "manifest entry key")
            if not isinstance(entry, dict):
                raise OperationError(f"invalid manifest entry: {group}/{name}")
            prefix = f"/assets/local/{group}/"
            if not isinstance(entry.get("path"), str) or not entry["path"].startswith(prefix):
                raise OperationError(f"noncanonical manifest URL for {group}/{name}: {entry.get('path')!r}")
            path = _manifest_asset_path(package, entry)
            if not path.is_file() or _path_has_reparse_flag(path):
                raise OperationError(f"missing or unsafe manifest asset: {path}")
            folded = path.relative_to(package / "public").as_posix().casefold()
            previous = paths.get(folded)
            if previous is not None and previous != entry["path"]:
                raise OperationError(f"case-folding asset collision: {previous} / {entry['path']}")
            paths[folded] = entry["path"]
    if doc.get("count") != count:
        raise OperationError(f"manifest count mismatch: {doc.get('count')} != {count}")
    return doc


def _validate_obj_file(path: Path) -> dict[str, int]:
    vertices = normals = faces = max_index = 0
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.startswith("v ") or line.startswith("vn "):
            try:
                values = [float(value) for value in line.split()[1:]]
            except ValueError as exc:
                raise OperationError(f"invalid OBJ number at {path}:{line_number}") from exc
            if len(values) < 3 or not all(value == value and abs(value) != float("inf") for value in values):
                raise OperationError(f"nonfinite/incomplete OBJ vector at {path}:{line_number}")
            if line.startswith("v "):
                vertices += 1
            else:
                normals += 1
        elif line.startswith("f "):
            faces += 1
            indices = line.split()[1:]
            if len(indices) < 3:
                raise OperationError(f"short OBJ face at {path}:{line_number}")
            for token in indices:
                try:
                    index = int(token.split("/", 1)[0])
                except ValueError as exc:
                    raise OperationError(f"invalid OBJ face index at {path}:{line_number}") from exc
                if index <= 0:
                    raise OperationError(f"unsupported/nonpositive OBJ face index at {path}:{line_number}")
                max_index = max(max_index, index)
    if vertices < 3 or faces < 1 or max_index > vertices:
        raise OperationError(f"invalid OBJ geometry {path}: {vertices} vertices, {faces} faces, max index {max_index}")
    return {"vertices": vertices, "normals": normals, "faces": faces}


def _required_entry(manifest: dict[str, Any], group: str, key: str) -> dict[str, Any]:
    entry = manifest.get("groups", {}).get(group, {}).get(key)
    if not isinstance(entry, dict):
        raise OperationError(f"required package mapping missing: {group}/{key}")
    return entry


def validate_board_package(package: Path, manifest: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    profile = contract["boardProfile"]
    groups = manifest["groups"]
    missing = [group for group in profile["groups"] if group not in groups]
    if missing:
        raise OperationError(f"board package missing required groups: {missing}")
    for slot, (group, key) in profile["images"].items():
        entry = _required_entry(manifest, group, key)
        path = _manifest_asset_path(package, entry)
        if path.suffix.lower() != ".png":
            raise OperationError(f"board image is not PNG: {group}/{key}")
        try:
            from PIL import Image
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                width, height = image.size
        except Exception as exc:
            raise OperationError(f"unreadable board image {group}/{key}: {exc}") from exc
        if width < 2 or height < 2:
            raise OperationError(f"invalid board image dimensions: {group}/{key}")
        if key in ("TX_autochessi_N_rgb", "TX_autochessi_M_rough") and entry.get("kind") != "Derived":
            raise OperationError(f"derived board map has wrong kind: {group}/{key}")
    for slot, (group, key) in profile["meshes"].items():
        entry = _required_entry(manifest, group, key)
        path = _manifest_asset_path(package, entry)
        if entry.get("kind") != "Mesh":
            raise OperationError(f"board mesh mapping has wrong kind: {group}/{key}")
        geometry = _validate_obj_file(path)
        if entry.get("verts") != geometry["vertices"] or entry.get("faces") != geometry["faces"]:
            raise OperationError(f"board mesh manifest geometry mismatch: {group}/{key}")
        mesh_fixture = contract.get("realFixtures", {}).get(group)
        if isinstance(mesh_fixture, dict):
            mesh_text = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            mesh_hash = sha256_bytes(mesh_text)
            if (mesh_fixture.get("mesh") != key
                    or geometry["vertices"] != mesh_fixture.get("vertices")
                    or geometry["faces"] != mesh_fixture.get("faces")
                    or mesh_hash != mesh_fixture.get("objSha256Lf")):
                raise OperationError(f"real-source mesh fixture mismatch: {group} (sha256 {mesh_hash})")

    theme = read_json(_manifest_asset_path(package, _required_entry(manifest, "map/autochess", "materials")))
    fx_materials = read_json(_manifest_asset_path(package, _required_entry(manifest, "map/fx", "materials")))
    prefab = read_json(_manifest_asset_path(package, _required_entry(manifest, "map/fx", "prefab")))
    if not isinstance(theme, dict) or not theme or not isinstance(fx_materials, dict) or not fx_materials or not isinstance(prefab, list) or not prefab:
        raise OperationError("board theme/fx materials or prefab hierarchy is empty")
    shaders = {item.get("shader") for item in theme.values() if isinstance(item, dict)}
    if "Torappu/Scene/StandardDirectional" not in shaders or "Torappu/Unlit/Texture" not in shaders:
        raise OperationError(f"board theme shader references unresolved: {sorted(str(v) for v in shaders)}")
    for name, material in {**theme, **fx_materials}.items():
        if not isinstance(material, dict) or not isinstance(material.get("shader"), str) or not material["shader"]:
            raise OperationError(f"unresolved material shader reference: {name}")
    for group, table in (("map/autochess", theme), ("map/fx", fx_materials)):
        entries = groups.get(group, {})
        for material_name, material in table.items():
            for prop, texture in (material.get("textures") or {}).items():
                texture_name = texture.get("texture") if isinstance(texture, dict) else None
                if not texture_name:
                    raise OperationError(f"invalid texture reference {material_name}/{prop}")
                key = texture_name if texture_name in entries else _safe_name(texture_name)
                entry = entries.get(key)
                if not isinstance(entry, dict) or not _manifest_asset_path(package, entry).is_file():
                    raise OperationError(f"unresolved material texture {group}/{material_name}/{prop}: {texture_name}")

    fx_entries = groups.get("map/fx", {})
    mesh_keys = {key for key, value in fx_entries.items() if isinstance(value, dict) and value.get("kind") == "Mesh"}
    gate_nodes = {}
    for slot, node_name in profile["gateNodes"].items():
        candidates = [node for node in prefab if isinstance(node, dict) and node.get("name") == node_name]
        if node_name == "Start_back":
            candidates = [node for node in candidates if node.get("parent") == "[opt]start_box"]
        if not candidates:
            raise OperationError(f"required gate prefab node missing: {node_name}")
        selected = candidates[0]
        mesh = selected.get("mesh")
        if not isinstance(mesh, str) or mesh not in mesh_keys:
            raise OperationError(f"unresolved gate mesh mapping for {slot}/{node_name}: {mesh!r}")
        materials = selected.get("materials") or []
        if any(name and name not in fx_materials for name in materials):
            raise OperationError(f"unresolved gate material mapping for {slot}/{node_name}")
        gate_nodes[slot] = {"name": node_name, "parent": selected.get("parent"), "mesh": mesh,
                            "scale": selected.get("scale"), "duplicateCount": len(candidates)}

    fixture = contract["realFixtures"]
    d_entry = _required_entry(manifest, "map/autochess", "TX_autochessi_D")
    d_hash, d_w, d_h, d_pixels = _pixel_hash(_manifest_asset_path(package, d_entry))
    d_spec = fixture["map/autochess"]
    if (d_w, d_h, d_hash) != (d_spec["diffuseWidth"], d_spec["diffuseHeight"], d_spec["diffuseRgbaSha256"]):
        raise OperationError(f"KR diffuse pixel snapshot mismatch: {d_w}x{d_h} {d_hash}")
    from PIL import Image
    d_image = Image.open(_manifest_asset_path(package, d_entry)).convert("RGBA")
    if d_image.transpose(Image.Transpose.FLIP_TOP_BOTTOM).tobytes() == d_pixels:
        raise OperationError("canonical top-down diffuse atlas is vertically reversed")
    for rect_key, hash_key in (("crateSideRect", "crateSideRgbaSha256"), ("crateTopRect", "crateTopRgbaSha256")):
        crop_hash, _, _, _ = _pixel_hash(_manifest_asset_path(package, d_entry), tuple(d_spec[rect_key]))
        if crop_hash != d_spec[hash_key]:
            raise OperationError(f"KR atlas crop pixel mismatch: {rect_key}")
    normal_spec = fixture["normalDxt5nmAg"]
    normal_hash, normal_w, normal_h, _ = _pixel_hash(
        _manifest_asset_path(package, _required_entry(manifest, "map/autochess", "TX_autochessi_N_rgb")), mode="RGB")
    if normal_hash != normal_spec["derivedRgbSha256"] or (normal_w, normal_h) != (normal_spec["sourceWidth"], normal_spec["sourceHeight"]):
        raise OperationError("DXT5nm/AG normal pixel snapshot mismatch")
    rough_hash, _, _, _ = _pixel_hash(
        _manifest_asset_path(package, _required_entry(manifest, "map/autochess", "TX_autochessi_M_rough")), mode="RGB")
    if rough_hash != fixture["roughness"]["derivedRgbSha256"]:
        raise OperationError("roughness map pixel snapshot mismatch")

    tiles_entry = _required_entry(manifest, "map/autochess", "tiles")
    if tiles_entry.get("kind") != "Derived" or tiles_entry.get("path") != "/assets/local/map/autochess/tiles.json":
        raise OperationError("tiles.json manifest mapping is not canonical")
    tiles = read_json(_manifest_asset_path(package, tiles_entry))
    if tiles.get("version") != 2 or not isinstance(tiles.get("board3d"), dict):
        raise OperationError("saved tiles.json is not a version-2 board crop table")
    expected_surface_count = profile.get("board3dSurfaceCount")
    if len(tiles["board3d"]) != expected_surface_count:
        raise OperationError(f"saved tiles.json board3d surface count unexpected: {len(tiles['board3d'])}")
    for key, (group, asset_key) in profile["images"].items():
        if key in ("D", "common", "BG"):
            src = tiles.get("source", {}).get(key)
            filename = _required_entry(manifest, group, asset_key)["path"].rsplit("/", 1)[-1]
            if not isinstance(src, dict) or src.get("path") != f"/assets/local/map/autochess/{filename}":
                raise OperationError(f"tiles.json source URL mismatch for {key}")
    return {"groups": list(profile["groups"]), "imageSlots": sorted(profile["images"]),
            "meshSlots": sorted(profile["meshes"]), "gateNodes": gate_nodes,
            "themeMaterialCount": len(theme), "fxMaterialCount": len(fx_materials),
            "fxPrefabNodeCount": len(prefab), "tilesBoard3dSurfaceCount": len(tiles["board3d"]),
            "diffuseRgbaSha256": d_hash, "normalRgbSha256": normal_hash, "roughnessRgbSha256": rough_hash}


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.\-\[\]]+", "_", value).strip("._")[:120] or "unnamed"

def _output_inventory(package: Path, manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    inventory = {}
    for entries in manifest["groups"].values():
        for entry in entries.values():
            path = _manifest_asset_path(package, entry)
            relative = path.relative_to(package).as_posix()
            data = path.read_bytes()
            row: dict[str, Any] = {"size": len(data), "sha256": sha256_bytes(data)}
            if path.suffix.lower() == ".png":
                pixel_hash, width, height, _ = _pixel_hash(path)
                row.update(pixelSha256=pixel_hash, width=width, height=height)
                if entry.get("w") != width or entry.get("h") != height:
                    raise OperationError(f"manifest PNG dimensions mismatch for {relative}")
            inventory[relative] = row
    return dict(sorted(inventory.items()))


def _expected_asset_files(manifest: dict[str, Any]) -> set[str]:
    expected = set()
    for entries in manifest["groups"].values():
        for entry in entries.values():
            suffix = safe_relative(entry["path"][len("/assets/local/"):], "manifest URL")
            expected.add((PurePosixPath("public") / "assets" / "local" / suffix).as_posix())
    return expected


def _validate_package_tree(package: Path, expected_assets: set[str]) -> None:
    public_root = package / "public" / "assets" / "local"
    actual_assets = set()
    if public_root.exists():
        for path in public_root.rglob("*"):
            if _path_has_reparse_flag(path):
                raise OperationError(f"reparse/symlink in package: {path}")
            if path.is_file():
                actual_assets.add(path.relative_to(package).as_posix())
    if actual_assets != expected_assets:
        raise OperationError(f"asset inventory mismatch: extra={sorted(actual_assets - expected_assets)[:8]} missing={sorted(expected_assets - actual_assets)[:8]}")
    required = {"data/local-assets.json", "provenance.json", "validation.json"} | expected_assets
    actual = {path.relative_to(package).as_posix() for path in package.rglob("*") if path.is_file()}
    if actual != required:
        raise OperationError(f"package inventory mismatch: extra={sorted(actual - required)[:8]} missing={sorted(required - actual)[:8]}")


def _verify_provenance_sources(provenance: dict[str, Any], context: dict[str, Any]) -> None:
    resolver: CatalogResolver = context["resolver"]
    for source in provenance.get("sourceFiles", []):
        if not isinstance(source, dict):
            raise OperationError("invalid provenance source record")
        logical = source.get("logicalPath")
        resolved = resolver.resolve(logical)
        for key in ("relativePath", "sourceRoot", "sha256", "md5", "size"):
            if source.get(key) != resolved.get(key):
                raise OperationError(f"provenance source mismatch for {logical}: {key}")
        if source.get("catalogRecord") != resolved["activeCatalogRecord"]:
            raise OperationError(f"provenance active catalog record mismatch for {logical}")
        if source.get("sourceCatalogRecord") != resolved["sourceCatalogRecord"]:
            raise OperationError(f"provenance source catalog record mismatch for {logical}")
        if source.get("persistentRecord") != resolved["persistentRecord"]:
            raise OperationError(f"provenance persistent inventory mismatch for {logical}")
        expected = Path(resolved["absolutePath"])
        actual = Path(str(source.get("absolutePath", "")))
        if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(expected)):
            raise OperationError(f"provenance source path escapes verified client root: {actual}")
        real = expected.resolve(strict=True)
        if not (_contains_path(real, context["bRoot"]) or _contains_path(real, context["hRoot"])):
            raise OperationError(f"provenance source is outside B/H roots: {expected}")
        if sha256_file(real) != source.get("sha256"):
            raise OperationError(f"client source changed since extraction: {logical}")


def _check_crop_script(upstream: Path, package: Path) -> dict[str, Any]:
    node = shutil.which("node")
    if not node:
        raise AdapterError("Node.js is required to validate board tiles.json")
    result = subprocess.run([node, str(ADAPTER_DIR / "crop_kr.mjs"), "--upstream", str(upstream),
                             "--package-root", str(package), "--check"], capture_output=True, text=True, check=False)
    if result.returncode:
        raise OperationError(f"saved tiles.json validation failed: {(result.stderr or result.stdout).strip()}")
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        raise OperationError("crop validator returned malformed status") from exc


def validate_package(package: Path, upstream: Path, contract: dict[str, Any], *, require_validation_record: bool = True) -> dict[str, Any]:
    assert_no_reparse_components(package)
    assert_no_reparse_components(upstream)
    package = package.resolve(strict=True)
    if not package.is_dir():
        raise OperationError(f"package root is not a directory: {package}")
    upstream = upstream.resolve(strict=True)
    if _contains_path(package, upstream):
        raise AdapterError("package root inside upstream worktree is refused")
    upstream_record = verify_upstream(upstream, contract)
    manifest = _load_manifest(package)
    provenance = read_json(package / "provenance.json")
    if not isinstance(provenance, dict) or provenance.get("schemaVersion") != 1:
        raise OperationError("missing/unsupported provenance schema")
    source_identity = provenance.get("sourceIdentity", {})
    install = Path(source_identity.get("installRoot", ""))
    try:
        context = verify_install(install, contract)
    except (AdapterError, OSError) as exc:
        raise OperationError(f"cannot re-verify recorded KR source: {exc}") from exc
    if _contains_path(package, context["installRoot"]):
        raise AdapterError("package root inside Korean game installation is refused")
    if provenance.get("upstream") != upstream_record:
        raise OperationError("provenance upstream preimage/HEAD mismatch")
    if source_identity.get("identity") != context["identities"]:
        raise OperationError("provenance client identity mismatch")
    if source_identity.get("catalogHashes") != context["catalogHashes"]:
        raise OperationError("provenance catalog snapshot mismatch")
    _verify_provenance_sources(provenance, context)
    inventory = _output_inventory(package, manifest)
    if inventory != provenance.get("outputFiles"):
        raise OperationError("asset output hashes/pixel inventory differ from provenance")
    manifest_bytes = (package / "data" / "local-assets.json").read_bytes()
    if sha256_bytes(manifest_bytes) != provenance.get("manifestSha256"):
        raise OperationError("local-assets.json hash differs from provenance")
    expected_assets = _expected_asset_files(manifest)
    _validate_package_tree(package, expected_assets)

    board = None
    tiles = None
    if provenance.get("profile") == "board":
        board = validate_board_package(package, manifest, contract)
        tiles = _check_crop_script(upstream, package)
    elif "tiles" in manifest.get("groups", {}).get("map/autochess", {}):
        raise OperationError("tiles.json is present without a complete board profile")
    if require_validation_record:
        report = read_json(package / "validation.json")
        if not isinstance(report, dict) or report.get("status") != "valid" or report.get("manifestCount") != manifest["count"]:
            raise OperationError("validation.json is missing or inconsistent")
    return {"status": "valid", "manifestCount": manifest["count"], "groups": sorted(manifest["groups"]),
            "assetFileCount": len(inventory), "profile": provenance.get("profile"), "board": board,
            "tiles": tiles, "sourceSnapshotId": context["identities"]["snapshotId"]}


def _expected_input_hash(group: str, contract: dict[str, Any]) -> str | None:
    fixture = contract.get("realFixtures", {}).get(group, {})
    value = fixture.get("inputSha256") if isinstance(fixture, dict) else None
    return value if isinstance(value, str) and value else None


def _unique_sources(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for item in items:
        key = (item["sourceRoot"], item["relativePath"])
        previous = unique.get(key)
        if previous is not None and previous["sha256"] != item["sha256"]:
            raise OperationError(f"same resolved source has inconsistent hashes: {key}")
        if previous is None:
            unique[key] = item
    return [unique[key] for key in sorted(unique)]


def _manifest_doc(groups: dict[str, dict[str, Any]], context: dict[str, Any]) -> dict[str, Any]:
    sorted_groups = {group: dict(sorted(entries.items())) for group, entries in sorted(groups.items())}
    identity = context["identities"]
    return {"version": 1, "source": "local-client", "locale": "ko-KR", "sourceSnapshot": identity["snapshotId"],
            "count": sum(len(entries) for entries in sorted_groups.values()), "groups": sorted_groups}


def _add_tiles_manifest(groups: dict[str, dict[str, Any]]) -> None:
    groups.setdefault("map/autochess", {})["tiles"] = {
        "path": "/assets/local/map/autochess/tiles.json", "kind": "Derived",
        "derive": "board_atlas_crop_v2", "from": ["TX_autochessi_D", "TX_autochessi_common_D", "TX_autochessi_BG"],
    }

def _extract(args: argparse.Namespace, contract: dict[str, Any]) -> dict[str, Any]:
    _reject_traversal_arg(args.out_root, "--out-root")
    out_arg = Path(args.out_root)
    if not out_arg.is_absolute():
        raise AdapterError("--out-root must be an absolute path")
    upstream_arg = Path(args.upstream)
    install_arg = Path(args.install)
    assert_no_reparse_components(upstream_arg)
    assert_no_reparse_components(install_arg)
    upstream = upstream_arg.resolve(strict=True)
    install = install_arg.resolve(strict=True)
    if _contains_path(out_arg, upstream) or _contains_path(out_arg, install):
        raise AdapterError("output directory may not be inside upstream or the Korean client installation")
    upstream_record = verify_upstream(upstream_arg, contract)
    context = verify_install(install_arg, contract)
    helper, unitypy, versions = load_guarded_upstream(upstream, contract)
    jobs, requested_groups, profile = _selected_jobs(helper, args.only, args.profile, contract)

    job_sources: list[tuple[Any, dict[str, Any]]] = []
    folded_paths: dict[str, str] = {}
    for job in jobs:
        relative, group, _, _ = helper.job_parts(job)
        source = context["resolver"].resolve(relative)
        expected_hash = _expected_input_hash(group, contract)
        if expected_hash and source["sha256"] != expected_hash:
            raise AdapterError(f"real-source fixture mismatch for {group}: {source['sha256']}")
        folded = source["relativePath"].casefold()
        previous = folded_paths.get(folded)
        if previous is not None and previous != source["relativePath"]:
            raise AdapterError(f"case-folding catalog path collision: {previous} / {source['relativePath']}")
        folded_paths[folded] = source["relativePath"]
        job_sources.append((job, source))

    needs_material_dependencies = profile == "board" or any(
        "Material" in helper.job_parts(job)[2] and not helper.job_parts(job)[1].startswith("mesh/")
        for job in jobs
    )
    dependency_sources = []
    if needs_material_dependencies:
        for relative in _shader_dependency_names(context["resolver"]):
            source = _available_dependency(context["resolver"], relative)
            if source is None:
                continue
            folded = source["relativePath"].casefold()
            previous = folded_paths.get(folded)
            if previous is not None and previous != source["relativePath"]:
                raise AdapterError(f"case-folding dependency path collision: {previous} / {source['relativePath']}")
            folded_paths[folded] = source["relativePath"]
            dependency_sources.append(source)
        if profile == "board":
            available = {source["logicalPath"] for source in dependency_sources}
            missing = sorted({"shaders/standarddirectional.ab", "[uc]shaders.ab"} - available)
            if missing:
                raise AdapterError(f"required board shader dependencies unavailable: {missing}")

    # All requested sources and dependencies have been resolved before output creation.
    for source in [value for _, value in job_sources] + dependency_sources:
        safe_relative(source["relativePath"], "resolved source path")
    if ".." in out_arg.parts:
        raise AdapterError("--out-root may not contain '..' path traversal")
    if not out_arg.parent.is_dir():
        raise AdapterError(f"--out-root parent must already exist: {out_arg.parent}")
    assert_no_reparse_components(out_arg.parent)
    parent = out_arg.parent.resolve(strict=True)
    target = parent / out_arg.name
    if not out_arg.name or target.exists() or _path_has_reparse_flag(target):
        raise AdapterError(f"fresh output directory required; refusing existing/invalid path: {target}")
    if _contains_path(target, upstream) or _contains_path(target, install):
        raise AdapterError("output directory may not be inside upstream or the Korean client installation")

    stage = Path(tempfile.mkdtemp(prefix=f".{target.name}.stage-", dir=str(parent)))
    input_root = stage / ".kr-private-input"
    package_assets = stage / "public" / "assets" / "local"
    package_assets.mkdir(parents=True, exist_ok=True)
    (stage / "data").mkdir(parents=True, exist_ok=True)
    source_files: list[dict[str, Any]] = []
    source_after: list[tuple[Path, str, int]] = []
    logs: list[str] = []
    job_results: list[dict[str, Any]] = []
    group_manifest: dict[str, dict[str, Any]] = {}
    normal_recipe = None
    try:
        input_root.mkdir()
        staged_jobs: dict[int, dict[str, Any]] = {}
        for job, source in job_sources:
            relative, _, _, _ = helper.job_parts(job)
            staged = _stage_verified(source, input_root, relative)
            staged["role"] = "primary"
            staged_jobs[id(job)] = staged
            source_files.append({key: value for key, value in staged.items() if key != "stagedPath"})
            source_after.append((Path(source["absolutePath"]), source["sha256"], source["size"]))
        for source in dependency_sources:
            staged = _stage_verified(source, input_root, source["logicalPath"])
            staged["role"] = "dependency"
            source_files.append({key: value for key, value in staged.items() if key != "stagedPath"})
            source_after.append((Path(source["absolutePath"]), source["sha256"], source["size"]))

        original_derived = helper.DERIVED
        original_load = unitypy.load
        helper.DERIVED = [entry for entry in original_derived if entry[2] != "normal_rg"]
        current_capture: dict[str, Any] = {}

        def load_staged_file(loader: Any, path: Any, *load_args: Any, **load_kwargs: Any) -> Any:
            if isinstance(path, (str, os.PathLike)):
                staged_path = Path(path)
                if _contains_path(staged_path, input_root):
                    # UnityPy's path loader leaves its stream reader in a reference
                    # cycle. Close the staged bundle stream deterministically: the
                    # private input tree is deleted before package promotion, and
                    # Windows refuses to remove a still-open bundle.
                    with staged_path.open("rb") as stream:
                        return loader(stream, *load_args, **load_kwargs)
            return loader(path, *load_args, **load_kwargs)

        def capture_load(path: Any, *load_args: Any, **load_kwargs: Any) -> Any:
            env = load_staged_file(original_load, path, *load_args, **load_kwargs)
            expected = os.path.normcase(os.path.abspath(str(current_capture.get("stagedPath", ""))))
            actual = os.path.normcase(os.path.abspath(str(path)))
            if expected and actual == expected:
                original_env_load_file = env.load_file

                def load_staged_dependency(file: Any, *args: Any, **kwargs: Any) -> Any:
                    return load_staged_file(original_env_load_file, file, *args, **kwargs)

                env.load_file = load_staged_dependency
                current_capture["env"] = env
                current_capture["objects"] = list(env.objects)
            return env

        unitypy.load = capture_load
        try:
            for job, source in job_sources:
                relative, group, _, _ = helper.job_parts(job)
                current_capture.clear()
                current_capture.update(staged_jobs[id(job)])
                try:
                    helper.export_bundle(input_root, job, package_assets, group_manifest, logs.append)
                except Exception as exc:
                    raise OperationError(f"upstream exporter raised for {relative}: {type(exc).__name__}: {exc}") from exc
                if "env" not in current_capture:
                    raise OperationError(f"upstream exporter did not load selected bundle: {relative}")
                entries = group_manifest.get(group, {})
                if not entries:
                    raise AdapterError(f"selected group produced zero export entries: {group}")
                env = current_capture["env"]
                objects, counts, texture_formats = _object_metadata(env, helper, job, entries, current_capture.get("objects"))
                job_results.append({
                    "bundle": relative, "group": group, "sourceRoot": source["sourceRoot"],
                    "relativePath": source["relativePath"], "sourceSha256": source["sha256"],
                    "exportEntries": len(entries),
                    "outputs": sorted({entry["path"] for entry in entries.values() if isinstance(entry, dict) and entry.get("path")}),
                    "objectTypeCounts": counts, "objects": objects, "textureFormats": texture_formats,
                    "unityBundle": _bundle_header(env),
                    "cabIndex": sorted(str(key) for key in getattr(env, "cabs", {}).keys()),
                })
                if any(line.startswith("FAIL load") for line in logs[-8:]):
                    raise OperationError(f"upstream reported a bundle load failure for {relative}")
        finally:
            unitypy.load = original_load
            helper.DERIVED = original_derived

        _normalize_obj_files(package_assets, group_manifest)
        if "map/autochess" in group_manifest:
            normal_rows = [row for job in job_results if job["group"] == "map/autochess" for row in job["textureFormats"]
                           if row.get("name") == "TX_autochessi_N"]
            normal_recipe = _derive_kr_normal(package_assets, group_manifest, normal_rows, helper, contract)
            rough_entry = group_manifest["map/autochess"].get("TX_autochessi_M_rough")
            if not rough_entry:
                raise OperationError("upstream roughness helper did not create TX_autochessi_M_rough")
            rough_hash, _, _, _ = _pixel_hash(package_assets / "map" / "autochess" / "TX_autochessi_M_rough.png", mode="RGB")
            if rough_hash != contract["realFixtures"]["roughness"]["derivedRgbSha256"]:
                raise OperationError(f"roughness derivation pixel hash mismatch: {rough_hash}")
        for group in requested_groups:
            if not group_manifest.get(group):
                raise AdapterError(f"selected group produced no successful files: {group}")

        if profile == "board":
            node = shutil.which("node")
            if not node:
                raise AdapterError("Node.js is required to generate board tiles.json")
            crop = subprocess.run([node, str(ADAPTER_DIR / "crop_kr.mjs"), "--upstream", str(upstream),
                                   "--package-root", str(stage)], capture_output=True, text=True, check=False)
            if crop.returncode:
                raise OperationError(f"crop generation failed: {(crop.stderr or crop.stdout).strip()}")
            _add_tiles_manifest(group_manifest)

        # Private source copies are not part of the final package.
        shutil.rmtree(input_root)
        source_files = _unique_sources(source_files)
        for label, path in context["catalogPaths"].items():
            if sha256_file(path) != context["catalogHashes"][label]:
                raise AdapterError(f"{label} catalog changed during extraction")
        for path, expected_sha, expected_size in source_after:
            if path.stat().st_size != expected_size or sha256_file(path) != expected_sha:
                raise AdapterError(f"client source changed during extraction: {path}")

        manifest = _manifest_doc(group_manifest, context)
        manifest_data = json_bytes(manifest)
        (stage / "data" / "local-assets.json").write_bytes(manifest_data)
        inventory = _output_inventory(stage, manifest)
        provenance = {
            "schemaVersion": 1, "adapter": "stronghold-korean-extract", "adapterVersion": contract["adapterVersion"],
            "profile": profile, "requestedGroups": sorted(requested_groups), "producedGroups": sorted(group_manifest),
            "missingGroups": [],
            "sourceIdentity": {
                "installRoot": str(context["installRoot"]), "identity": context["identities"],
                "catalogHashes": context["catalogHashes"],
                "catalogPaths": {key: str(path) for key, path in context["catalogPaths"].items()},
                "bundleRoots": {"B": str(context["bRoot"]), "H": str(context["hRoot"])},
            },
            "upstream": upstream_record, "dependencyVersions": versions, "sourceFiles": source_files,
            "jobs": job_results,
            "transformRecipes": {
                "normal": normal_recipe,
                "roughness": "rough_from_gloss (G=255-A, R=255, B=0)" if "map/autochess" in group_manifest else None,
                "meshCoordinates": "guarded upstream UnityPy OBJ convention; no second board rotation",
                "pngOrientation": "UnityPy canonical top-down; no additional Y flip",
            },
            "outputFiles": inventory, "manifestSha256": sha256_bytes(manifest_data),
            "warnings": logs, "knownLimitations": contract["knownLimitations"],
        }
        (stage / "provenance.json").write_bytes(json_bytes(provenance, pretty=True))
        board_report = validate_board_package(stage, manifest, contract) if profile == "board" else None
        tiles_report = _check_crop_script(upstream, stage) if profile == "board" else None
        validation = {
            "schemaVersion": 1, "status": "valid", "profile": profile, "manifestCount": manifest["count"],
            "groups": sorted(manifest["groups"]), "assetFileCount": len(inventory),
            "board": board_report, "tiles": tiles_report, "sourceSnapshotId": context["identities"]["snapshotId"],
        }
        (stage / "validation.json").write_bytes(json_bytes(validation, pretty=True))
        checked = validate_package(stage, upstream, contract, require_validation_record=True)
        if target.exists():
            raise AdapterError(f"output path appeared during extraction; refusing promotion: {target}")
        os.rename(stage, target)
        try:
            final_validation = validate_package(target, upstream, contract, require_validation_record=True)
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise
        return {"status": "valid", "outRoot": str(target), "profile": profile,
                "manifestCount": manifest["count"], "groups": sorted(manifest["groups"]),
                "assetFileCount": len(inventory), "validation": final_validation,
                "validationBeforePromotion": checked}
    except Exception:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        raise
    finally:
        if input_root.exists():
            shutil.rmtree(input_root, ignore_errors=True)
        if stage.exists() and stage != target:
            shutil.rmtree(stage, ignore_errors=True)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="read-only KR catalog and job inspection")
    inspect.add_argument("--upstream", required=True)
    inspect.add_argument("--install", required=True)
    inspect.add_argument("--all-jobs", action="store_true")
    extract = commands.add_parser("extract", help="create a fresh validated KR package")
    extract.add_argument("--upstream", required=True)
    extract.add_argument("--install", required=True)
    extract.add_argument("--only", action="append", default=[])
    extract.add_argument("--profile", choices=["board"])
    extract.add_argument("--out-root", required=True)
    validate = commands.add_parser("validate", help="read-only package/source/provenance validation")
    validate.add_argument("--upstream", required=True)
    validate.add_argument("--out-root", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
        contract = _load_contract()
        if args.command == "inspect":
            upstream = Path(args.upstream)
            verify_upstream(upstream, contract)
            report = inspect_jobs(Path(args.install), upstream, contract, args.all_jobs)
        elif args.command == "extract":
            report = _extract(args, contract)
        else:
            _reject_traversal_arg(args.out_root, "--out-root")
            package = Path(args.out_root)
            if not package.is_absolute():
                raise AdapterError("--out-root must be an absolute path")
            upstream = Path(args.upstream)
            report = validate_package(package, upstream, contract, require_validation_record=True)
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (AdapterError, OperationError) as exc:
        print(f"extract_kr: {exc}", file=sys.stderr)
        return getattr(exc, "exit_code", EXIT_OPERATION)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"extract_kr: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_OPERATION


if __name__ == "__main__":
    raise SystemExit(main())

