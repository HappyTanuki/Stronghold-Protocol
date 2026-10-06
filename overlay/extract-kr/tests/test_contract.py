"""Black-box failure contracts for the KR client extraction CLI.

All corrupt/malformed input trees are disposable copies below D:/Hermes/cache/scratch.
The installed client and pinned upstream checkout are read-only test subjects.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath


ADAPTER_DIR = Path(__file__).resolve().parents[1]
DEPLOY_DIR = Path(os.environ.get("STRONGHOLD_DEPLOY_ROOT", "C:/Users/rlaal/source/repos/stronghold-latest-deploy"))
UPSTREAM = Path(os.environ.get("STRONGHOLD_UPSTREAM", str(DEPLOY_DIR / "upstream")))
INSTALL = Path(os.environ.get("KR_INSTALL_ROOT", "I:/YostarGames/Arknights_KR"))
PYTHON = Path(os.environ.get("KR_PYTHON", "C:/Users/rlaal/source/repos/Stronghold-local-assets-repair/.venv/Scripts/python.exe"))
SCRATCH = Path(os.environ.get("KR_TEST_SCRATCH", "D:/Hermes/cache/scratch"))
PINNED_UPSTREAM_HEAD = "763e224b8d72c2362e70a8f1283a74e644195712"
CLI = ADAPTER_DIR / "extract_kr.py"
FIXTURE = ADAPTER_DIR / "tests/fixtures/kr-41.0.1-71ac81.json"


class ExtractorContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        for required in (PYTHON, INSTALL, UPSTREAM, FIXTURE):
            if not required.exists():
                raise AssertionError(f"required real test input is missing (not a skip): {required}")
        SCRATCH.mkdir(parents=True, exist_ok=True)
        cls.work = Path(tempfile.mkdtemp(prefix="kr-tests-contract-", dir=SCRATCH))
        cls.install_copy = cls.work / "install-copy"
        cls.upstream_copy = cls.work / "upstream-copy"
        cls._copy_install_seed(cls.install_copy)
        cls._clone_upstream(cls.upstream_copy)
        cls._install_originals = {
            p.relative_to(cls.install_copy): p.read_bytes()
            for p in cls.install_copy.rglob("*")
            if p.is_file()
        }

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.work, ignore_errors=True)

    @classmethod
    def _copy_install_seed(cls, target: Path) -> None:
        rels = [
            "Arknights.exe",
            "Arknights_Data/app.info",
            "game-launcher-config.json",
            "manifest.json",
            cls.fixture["catalogs"]["B"]["path"],
            cls.fixture["catalogs"]["H"]["path"],
            cls.fixture["catalogs"]["persistent"]["path"],
            "Arknights_Data/StreamingAssets/AB/Windows/arts/maps/common/meshes/s_wind_device.ab",
        ]
        for rel in rels:
            source = INSTALL.joinpath(*PurePosixPath(rel).parts)
            destination = target.joinpath(*PurePosixPath(rel).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)

    @classmethod
    def _clone_upstream(cls, target: Path) -> None:
        clone = subprocess.run(
            ["git", "clone", "--config", "core.autocrlf=false", "--shared", "--no-checkout", str(UPSTREAM), str(target)],
            text=True,
            capture_output=True,
            check=False,
        )
        if clone.returncode:
            raise AssertionError(f"could not clone pinned upstream into scratch: {clone.stdout}{clone.stderr}")
        checkout = subprocess.run(
            ["git", "-C", str(target), "checkout", "--detach", PINNED_UPSTREAM_HEAD],
            text=True,
            capture_output=True,
            check=False,
        )
        if checkout.returncode:
            raise AssertionError(f"could not check out pinned upstream in scratch: {checkout.stdout}{checkout.stderr}")
        head = subprocess.run(
            ["git", "-C", str(target), "rev-parse", "HEAD"], text=True, capture_output=True, check=False
        )
        if head.returncode or head.stdout.strip() != PINNED_UPSTREAM_HEAD:
            raise AssertionError(f"scratch upstream is not pinned at {PINNED_UPSTREAM_HEAD}: {head.stdout}{head.stderr}")

    @staticmethod
    def _digest(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def _write_json(path: Path, value: object) -> None:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _assert_baseline_preflight(self, install: Path | None = None, upstream: Path | None = None) -> None:
        result = self._run(
            "inspect", "--upstream", upstream or self.upstream_copy,
            "--install", install or self.install_copy, "--all-jobs",
        )
        self.assertEqual(result.returncode, 0, f"valid fixture preflight failed:\n{result.stdout}\n{result.stderr}")
        self.assertEqual(result.stderr, "", "valid fixture preflight should be clean")
        report = json.loads(result.stdout)
        self.assertEqual(report["identity"]["tag"], "Arknights_KR")
        self.assertEqual(report["identity"]["version"], "41.0.1")
        self.assertEqual(report["jobs"]["mesh/s_wind_device"]["status"], "available")

    def _assert_cli_error(self, result: subprocess.CompletedProcess[str], diagnostic: str, code: int = 2) -> None:
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "", "rejected CLI invocation must not print a success report")
        self.assertEqual(result.stderr.strip(), f"extract_kr: {diagnostic}")

    def _run(self, *args: str | Path) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return subprocess.run(
            [str(PYTHON), "-B", str(CLI), *(str(arg) for arg in args)],
            cwd=ADAPTER_DIR,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def _extract(self, install: Path, output: Path, group: str, upstream: Path | None = None) -> subprocess.CompletedProcess[str]:
        return self._run(
            "extract",
            "--upstream",
            upstream or UPSTREAM,
            "--install",
            install,
            "--only",
            group,
            "--out-root",
            output,
        )

    def test_extract_requires_an_explicit_supported_selection(self) -> None:
        no_selection = self.work / "no-selection"
        result = self._run(
            "extract", "--upstream", UPSTREAM, "--install", INSTALL, "--out-root", no_selection
        )
        self._assert_cli_error(result, "extract requires explicit --only group/prefix or --profile board")
        self.assertFalse(no_selection.exists(), "invalid invocation must not create a success/staging package")

        unknown = self.work / "unknown-selection"
        result = self._extract(INSTALL, unknown, "mesh/not-a-real-job")
        self._assert_cli_error(result, "unknown --only group/prefix: mesh/not-a-real-job")
        self.assertFalse(unknown.exists(), "unknown group must fail before package creation")

    def test_existing_destination_is_refused_without_touching_it(self) -> None:
        self._assert_baseline_preflight()
        output = self.work / "already-exists"
        output.mkdir()
        sentinel = output / "keep.txt"
        sentinel.write_text("caller-owned\n", encoding="utf-8")
        before = self._digest(sentinel)

        result = self._extract(INSTALL, output, "mesh/s_wind_device")

        self._assert_cli_error(
            result,
            f"fresh output directory required; refusing existing/invalid path: {output.resolve()}",
        )
        self.assertEqual(self._digest(sentinel), before)
        self.assertEqual(sorted(p.name for p in output.iterdir()), ["keep.txt"])

    def test_destination_inside_client_or_upstream_copy_is_refused(self) -> None:
        self._assert_baseline_preflight()
        # Use disposable copies so a regression cannot write into the installed client or real upstream.
        for label, protected_copy in (("client", self.install_copy), ("upstream", self.upstream_copy)):
            with self.subTest(root=label):
                output = protected_copy / "must-not-be-created"
                result = self._extract(self.install_copy, output, "mesh/s_wind_device", self.upstream_copy)
                self._assert_cli_error(
                    result,
                    "output directory may not be inside upstream or the Korean client installation",
                )
                self.assertFalse(output.exists(), f"output was created under the protected {label} copy")

    def test_cn_unknown_and_contradictory_identity_fail_before_output(self) -> None:
        app = self.install_copy / "Arknights_Data/app.info"
        launcher = self.install_copy / "game-launcher-config.json"
        manifest = self.install_copy / "manifest.json"
        original = {p: p.read_bytes() for p in (app, launcher, manifest)}
        cases = (
            ("CN", "Yostar\nArknights_CN", "Arknights_CN", "Arknights_CN"),
            ("unknown", "Yostar\nMystery_Client", "Mystery_Client", "Mystery_Client"),
            ("contradictory", "Yostar\nArknights_KR", "Arknights_CN", "Arknights_KR"),
        )
        try:
            for label, app_text, launcher_tag, manifest_name in cases:
                with self.subTest(identity=label):
                    for path, data in original.items():
                        path.write_bytes(data)
                    self._assert_baseline_preflight()
                    app.write_text(app_text, encoding="utf-8")
                    config = json.loads(original[launcher])
                    config["tag"] = launcher_tag
                    self._write_json(launcher, config)
                    game_manifest = json.loads(original[manifest])
                    game_manifest["name"] = manifest_name
                    self._write_json(manifest, game_manifest)
                    output = self.work / f"invalid-identity-{label}"
                    result = self._extract(self.install_copy, output, "mesh/s_wind_device", self.upstream_copy)
                    expected = (
                        "launcher config does not identify Arknights_KR"
                        if label == "contradictory"
                        else "app.info does not identify Arknights_KR"
                    )
                    self._assert_cli_error(result, expected)
                    self.assertFalse(output.exists(), "identity rejection must precede package creation")
        finally:
            for path, data in original.items():
                path.write_bytes(data)

    def test_conflicting_duplicate_active_catalog_entries_are_rejected(self) -> None:
        self._assert_baseline_preflight()
        catalog_path = self.install_copy.joinpath(*PurePosixPath(self.fixture["catalogs"]["H"]["path"]).parts)
        original = catalog_path.read_bytes()
        try:
            catalog = json.loads(original)
            rel = self.fixture["inputs"]["wind"]["relative_path"]
            records = [record for record in catalog["abInfos"] if record.get("name") == rel]
            self.assertEqual(len(records), 1, "real active catalog seed changed; rebuild the disposable test fixture")
            conflicting = dict(records[0])
            conflicting["md5"] = "0" * 32
            catalog["abInfos"].append(conflicting)
            self._write_json(catalog_path, catalog)

            if str(ADAPTER_DIR) not in sys.path:
                sys.path.insert(0, str(ADAPTER_DIR))
            import extract_kr as adapter

            with self.assertRaises(adapter.AdapterError) as raised:
                adapter._catalog_index(catalog, "H")
            self.assertEqual(str(raised.exception), f"conflicting duplicate catalog entry: {rel}")
            result = self._run("inspect", "--upstream", self.upstream_copy, "--install", self.install_copy, "--all-jobs")
            self._assert_cli_error(
                result,
                f"unsupported H catalog bytes: sha256 {self._digest(catalog_path)}",
            )
        finally:
            catalog_path.write_bytes(original)

    def test_unsafe_catalog_path_is_rejected_in_disposable_copy(self) -> None:
        self._assert_baseline_preflight()
        catalog_path = self.install_copy.joinpath(*PurePosixPath(self.fixture["catalogs"]["H"]["path"]).parts)
        original = catalog_path.read_bytes()
        try:
            catalog = json.loads(original)
            rel = self.fixture["inputs"]["wind"]["relative_path"]
            record = next(record for record in catalog["abInfos"] if record.get("name") == rel)
            unsafe = dict(record)
            unsafe["name"] = "../outside.ab"
            catalog["abInfos"].append(unsafe)
            self._write_json(catalog_path, catalog)

            if str(ADAPTER_DIR) not in sys.path:
                sys.path.insert(0, str(ADAPTER_DIR))
            import extract_kr as adapter

            with self.assertRaises(adapter.AdapterError) as raised:
                adapter._catalog_index(catalog, "H")
            self.assertEqual(str(raised.exception), "unsafe H catalog entry: '../outside.ab'")
            result = self._run("inspect", "--upstream", self.upstream_copy, "--install", self.install_copy, "--all-jobs")
            self._assert_cli_error(
                result,
                f"unsupported H catalog bytes: sha256 {self._digest(catalog_path)}",
            )
        finally:
            catalog_path.write_bytes(original)

    def test_corrupt_selected_bundle_fails_without_success_manifest(self) -> None:
        self._assert_baseline_preflight()
        rel = "Arknights_Data/StreamingAssets/AB/Windows/arts/maps/common/meshes/s_wind_device.ab"
        bundle = self.install_copy.joinpath(*PurePosixPath(rel).parts)
        original = bundle.read_bytes()
        try:
            damaged = bytearray(original)
            damaged[len(damaged) // 2] ^= 0x01
            bundle.write_bytes(damaged)
            output = self.work / "corrupt-bundle-output"
            result = self._extract(self.install_copy, output, "mesh/s_wind_device", self.upstream_copy)
            self._assert_cli_error(result, "catalog MD5 mismatch for arts/maps/common/meshes/s_wind_device.ab")
            self.assertFalse((output / "data/local-assets.json").exists(), "corrupt input must not produce a success manifest")
        finally:
            bundle.write_bytes(original)

    def test_real_unsupported_missing_and_empty_groups_are_hard_failures(self) -> None:
        unsupported = self.work / "missing-fooldoctor"
        result = self._extract(INSTALL, unsupported, "emoticon/fooldoctor")
        self._assert_cli_error(
            result,
            "not present in active KR catalog: ui/emoticon/theme/[uc]emoticon_foolsday_doctor.ab",
        )
        self.assertFalse(unsupported.exists())

        empty = self.work / "empty-token-group"
        result = self._extract(INSTALL, empty, "spine/token_10039_ulpia_block")
        self._assert_cli_error(result, "selected group produced zero export entries: spine/token_10039_ulpia_block")
        self.assertFalse(empty.exists(), "opening a zero-export bundle is not successful extraction")

    def test_contract_preimage_drift_in_disposable_upstream_copy_is_rejected(self) -> None:
        self._assert_baseline_preflight()
        source = self.upstream_copy / "tools/local-extract/extract.py"
        original = source.read_bytes()
        try:
            source.write_bytes(original + b"\n# isolated drift fixture\n")
            actual = self._digest(source)
            result = self._run("inspect", "--upstream", self.upstream_copy, "--install", self.install_copy, "--all-jobs")
            self._assert_cli_error(
                result,
                f"upstream source drift: tools/local-extract/extract.py (sha256 {actual})",
            )
        finally:
            source.write_bytes(original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
