"""Mandatory real-KR subprocess tests for the frozen extractor CLI.

The source client and pinned upstream are read-only. Every extraction and every
mutated package is confined to a unique kr-tests-* directory under D:/Hermes/cache/scratch.
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

from PIL import Image


ADAPTER_DIR = Path(__file__).resolve().parents[1]
DEPLOY_DIR = Path(os.environ.get("STRONGHOLD_DEPLOY_ROOT", "C:/Users/rlaal/source/repos/stronghold-latest-deploy"))
UPSTREAM = Path(os.environ.get("STRONGHOLD_UPSTREAM", str(DEPLOY_DIR / "upstream")))
INSTALL = Path(os.environ.get("KR_INSTALL_ROOT", "I:/YostarGames/Arknights_KR"))
PYTHON = Path(os.environ.get("KR_PYTHON", "C:/Users/rlaal/source/repos/Stronghold-local-assets-repair/.venv/Scripts/python.exe"))
SCRATCH = Path(os.environ.get("KR_TEST_SCRATCH", "D:/Hermes/cache/scratch"))
CLI = ADAPTER_DIR / "extract_kr.py"
NODE_TEST = ADAPTER_DIR / "tests/board-pack.test.mjs"
FIXTURE = ADAPTER_DIR / "tests/fixtures/kr-41.0.1-71ac81.json"
B_REL = "Arknights_Data/StreamingAssets/AB/Windows"
H_REL = "Arknights_Data/PersistentData/Bundles"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def path_under(root: Path, url: str) -> Path:
    """Resolve a package URL without allowing an absolute or traversal path."""
    prefix = "/assets/local/"
    if not isinstance(url, str) or not url.startswith(prefix):
        raise AssertionError(f"manifest path is not a canonical local-assets URL: {url!r}")
    parts = PurePosixPath(url).parts
    if ".." in parts or parts[0] != "/":
        raise AssertionError(f"unsafe manifest URL: {url!r}")
    return root / "public" / Path(*parts[1:])


def flatten_strings(value: object) -> list[str]:
    if isinstance(value, dict):
        return [s for key, child in value.items() for s in ([key] if isinstance(key, str) else []) + flatten_strings(child)]
    if isinstance(value, list):
        return [s for child in value for s in flatten_strings(child)]
    return [value] if isinstance(value, str) else []


def normal_z_table() -> bytes:
    table = bytearray(256 * 256)
    for x_byte in range(256):
        x = x_byte / 127.5 - 1.0
        for y_byte in range(256):
            y = y_byte / 127.5 - 1.0
            z = max(0.0, 1.0 - x * x - y * y) ** 0.5
            table[(x_byte << 8) | y_byte] = min(255, int(round(127.5 + 127.5 * z)))
    return bytes(table)


class RealKoreanExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        for required in (PYTHON, INSTALL, UPSTREAM, FIXTURE, NODE_TEST):
            if not required.exists():
                raise AssertionError(f"required real test input is missing (not a skip): {required}")
        cls.node = shutil.which("node")
        if not cls.node:
            raise AssertionError("node is required by the frozen board-renderer artifact checks")
        SCRATCH.mkdir(parents=True, exist_ok=True)
        cls.work = Path(tempfile.mkdtemp(prefix="kr-tests-real-", dir=SCRATCH))
        cls.outputs = {name: cls.work / f"{name}-package" for name in ("wind", "wind-repeat", "crate", "sprite", "board")}
        cls.source_before = cls._source_snapshot()
        cls.upstream_status_before = cls._upstream_status()
        cls.upstream_hashes_before = cls._upstream_hashes()
        cls.commands: dict[str, subprocess.CompletedProcess[str]] = {}
        for name in ("wind", "wind-repeat"):
            cls.commands[name] = cls._extract_only("mesh/s_wind_device", cls.outputs[name])
        cls.commands["crate"] = cls._extract_only("mesh/s_common_box_01", cls.outputs["crate"])
        cls.commands["sprite"] = cls._extract_only("emoticon/basic_2", cls.outputs["sprite"])
        cls.commands["board"] = cls._extract_board(cls.outputs["board"])

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.work, ignore_errors=True)

    @classmethod
    def _asset_root(cls, root_name: str) -> Path:
        return INSTALL / (B_REL if root_name == "B" else H_REL)

    @classmethod
    def _source_snapshot(cls) -> dict[str, str]:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        rels = [record["path"] for record in fixture["identity"].values()]
        rels.extend(record["path"] for record in fixture["catalogs"].values())
        board_inputs = (
            ("H", "arts/maps/map_autochess/res.ab"),
            ("H", "arts/maps/map_autochess/bkg_mesh.ab"),
            ("B", "arts/maps/common/meshes/s_background_common.ab"),
            ("B", "arts/maps/common/meshes/s_common_box_01.ab"),
            ("B", "arts/maps/common/meshes/s_wind_device.ab"),
            ("H", "arts/effects/[pack]map.ab"),
            ("B", "arts/maps/common/res.ab"),
            ("B", "arts/maps/effect.ab"),
            ("H", "ui/emoticon/theme/[uc]emoticon_autochess_basic_2.ab"),
            ("H", "shaders/standarddirectional.ab"),
            ("H", "[uc]shaders.ab"),
        )
        snapshot = {}
        for rel in rels:
            path = INSTALL.joinpath(*PurePosixPath(rel).parts)
            if not path.is_file():
                raise AssertionError(f"required KR identity/catalog source is missing (not a skip): {path}")
            snapshot[rel] = sha256(path.read_bytes())
        for root, rel in board_inputs:
            path = cls._asset_root(root) / PurePosixPath(rel)
            if not path.is_file():
                raise AssertionError(f"required real KR bundle is missing (not a skip): {path}")
            snapshot[f"{root}/{rel}"] = sha256(path.read_bytes())
        return snapshot

    @classmethod
    def _upstream_status(cls) -> str:
        result = subprocess.run(
            ["git", "-C", str(UPSTREAM), "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"],
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode:
            raise AssertionError(f"could not read pinned upstream status: {result.stderr}")
        return result.stdout

    @classmethod
    def _upstream_hashes(cls) -> dict[str, str]:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        hashes = {}
        for rel, expected in fixture["upstream_files"].items():
            path = UPSTREAM.joinpath(*PurePosixPath(rel).parts)
            if not path.is_file():
                raise AssertionError(f"pinned upstream input is missing: {path}")
            actual = sha256(path.read_bytes())
            if actual != expected:
                raise AssertionError(f"upstream preimage drift for {rel}: {actual} != {expected}")
            hashes[rel] = actual
        return hashes

    @classmethod
    def _run_cli(cls, *args: str | Path) -> subprocess.CompletedProcess[str]:
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

    @classmethod
    def _extract_only(cls, group: str, output: Path) -> subprocess.CompletedProcess[str]:
        return cls._run_cli(
            "extract", "--upstream", UPSTREAM, "--install", INSTALL, "--only", group, "--out-root", output
        )

    @classmethod
    def _extract_board(cls, output: Path) -> subprocess.CompletedProcess[str]:
        return cls._run_cli(
            "extract", "--upstream", UPSTREAM, "--install", INSTALL, "--profile", "board", "--out-root", output
        )

    def require_success(self, name: str) -> Path:
        result = self.commands[name]
        self.assertEqual(result.returncode, 0, f"{name} CLI failed:\n{result.stdout}\n{result.stderr}")
        output = self.outputs[name]
        self.assertTrue(output.is_dir(), f"{name} CLI exited 0 without the requested package")
        self.assertFalse(output.is_relative_to(UPSTREAM), "tests must not extract into upstream")
        self.assertFalse(output.is_relative_to(INSTALL), "tests must not extract into the installed client")
        return output

    @staticmethod
    def read_manifest(package: Path) -> dict:
        path = package / "data/local-assets.json"
        if not path.is_file():
            raise AssertionError(f"package manifest is missing: {path}")
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def entry_path(package: Path, group: str, name: str) -> tuple[dict, Path]:
        manifest = RealKoreanExtractionTests.read_manifest(package)
        entry = manifest.get("groups", {}).get(group, {}).get(name)
        if not isinstance(entry, dict):
            raise AssertionError(f"manifest entry missing: {group}/{name}")
        return entry, path_under(package, entry.get("path"))

    def test_installed_kr_identity_catalogs_and_upstream_fixture_are_exact(self) -> None:
        fixture = self.fixture
        self.assertEqual(fixture["freeze"]["upstream_head"], "763e224b8d72c2362e70a8f1283a74e644195712")
        self.assertEqual(fixture["freeze"]["game"], "Arknights_KR")
        self.assertEqual(fixture["freeze"]["game_version"], "41.0.1")
        for record in fixture["identity"].values():
            path = INSTALL.joinpath(*PurePosixPath(record["path"]).parts)
            self.assertEqual(sha256(path.read_bytes()), record["sha256"], str(path))
        app_text = (INSTALL / "Arknights_Data/app.info").read_text(encoding="utf-8")
        self.assertTrue(all(token in app_text for token in fixture["identity"]["app_info"]["contains"]))
        launcher = json.loads((INSTALL / "game-launcher-config.json").read_text(encoding="utf-8"))
        self.assertEqual(launcher["tag"], fixture["identity"]["launcher_config"]["tag"])
        self.assertEqual(launcher["version"], fixture["identity"]["launcher_config"]["version"])
        game_manifest = json.loads((INSTALL / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(game_manifest["name"], fixture["identity"]["game_manifest"]["name"])
        self.assertEqual(game_manifest["version"], fixture["identity"]["game_manifest"]["version"])

        catalogs = {}
        for name, record in fixture["catalogs"].items():
            path = INSTALL.joinpath(*PurePosixPath(record["path"]).parts)
            raw = path.read_bytes()
            self.assertEqual(sha256(raw), record["sha256"], str(path))
            catalogs[name] = json.loads(raw)
            for key, fixture_key in (("versionId", "version_id"), ("manifestName", "manifest_name"), ("manifestVersion", "manifest_version")):
                if fixture_key in record:
                    self.assertEqual(catalogs[name][key], record[fixture_key], f"{name}.{key}")

        catalog_maps = {name: {entry["name"]: entry for entry in catalog.get("abInfos", [])} for name, catalog in catalogs.items()}
        for key in ("wind", "crate", "sprite", "board", "map_fx"):
            source = fixture["inputs"][key]
            root = self._asset_root(source["root"])
            ab_path = root / PurePosixPath(source["relative_path"])
            raw = ab_path.read_bytes()
            self.assertEqual(len(raw), source["size"], key)
            self.assertEqual(sha256(raw), source["sha256"], key)
            h_record = catalog_maps["H"].get(source["relative_path"])
            self.assertIsNotNone(h_record, f"{key} not in active H catalog")
            for field, expected in source["active_H_record"].items():
                self.assertEqual(h_record.get(field), expected, f"active H {key}.{field}")
            self.assertEqual(h_record.get("md5"), hashlib.md5(raw).hexdigest(), f"active H MD5 for {key}")
            self.assertEqual(h_record.get("abSize"), len(raw), f"active H abSize for {key}")
            if "base_B_record" in source:
                b_record = catalog_maps["B"].get(source["relative_path"])
                self.assertIsNotNone(b_record, f"{key} absent from base catalog")
                for field, expected in source["base_B_record"].items():
                    self.assertEqual(b_record.get(field), expected, f"base B {key}.{field}")
                self.assertEqual(b_record.get("md5"), hashlib.md5(raw).hexdigest(), f"base B MD5 for {key}")
            if "persistent_record" in source:
                persistent = catalog_maps["persistent"].get(source["relative_path"])
                self.assertIsNotNone(persistent, f"{key} absent from persistent download inventory")
                for field, expected in source["persistent_record"].items():
                    self.assertEqual(persistent.get(field), expected, f"persistent {key}.{field}")

    def test_real_unity_objects_pixels_and_normal_regression_match_frozen_source(self) -> None:
        # Decode source bundles independently of the adapter CLI; this is also the
        # guard against silently refreshing fixture hashes from a broken export.
        local_extract = str(UPSTREAM / "tools/local-extract")
        if local_extract not in sys.path:
            sys.path.insert(0, local_extract)
        import aklz4  # noqa: F401 -- registers the pinned custom Unity bundle decoder
        import UnityPy
        import extract as upstream_extract

        def load_objects(source_key: str):
            source = self.fixture["inputs"][source_key]
            bundle = self._asset_root(source["root"]) / PurePosixPath(source["relative_path"])
            return source, list(UnityPy.load(str(bundle)).objects)

        for source_key in ("wind", "crate"):
            source, objects = load_objects(source_key)
            golden = source["mesh"]
            meshes = [obj for obj in objects if obj.type.name == "Mesh" and getattr(obj.read(), "m_Name", "") == golden["name"]]
            self.assertEqual(len(meshes), 1, f"source {source_key} must have exactly one target Mesh")
            obj = meshes[0]
            data = obj.read()
            text = data.export().replace("\r\n", "\n")
            self.assertEqual(str(obj.path_id), golden["path_id"])
            self.assertEqual(sha256(text.encode("utf-8")), golden["obj_sha256"])
            self.assertEqual(sum(line.startswith("v ") for line in text.splitlines()), golden["vertices"])
            self.assertEqual(sum(line.startswith("f ") for line in text.splitlines()), golden["faces"])

        sprite_source, sprite_objects = load_objects("sprite")
        del sprite_source
        sprites = {}
        for obj in sprite_objects:
            if obj.type.name == "Sprite":
                data = obj.read()
                image = data.image.convert("RGBA")
                sprites[data.m_Name] = {"size": list(image.size), "rgba_sha256": sha256(image.tobytes())}
        self.assertEqual(sprites, self.fixture["inputs"]["sprite"]["sprites"])

        _board_source, board_objects = load_objects("board")
        texture_goldens = self.fixture["board_goldens"]["textures"]
        textures = {}
        for obj in board_objects:
            if obj.type.name != "Texture2D":
                continue
            data = obj.read()
            name = data.m_Name
            if name not in texture_goldens:
                continue
            image = data.image.convert("RGBA")
            textures[name] = (data, image)
            golden = texture_goldens[name]
            self.assertEqual(int(data.m_TextureFormat), golden["format"], name)
            self.assertEqual(list(image.size), golden["size"], name)
            self.assertEqual(sha256(image.tobytes()), golden["rgba_sha256"], name)
        self.assertEqual(set(textures), set(texture_goldens))

        normal_fixture = self.fixture["board_goldens"]["normal_regression"]
        source_normal = textures["TX_autochessi_N"][1]
        self.assertEqual(int(textures["TX_autochessi_N"][0].m_TextureFormat), normal_fixture["texture_format"])
        source_rgba = source_normal.tobytes()
        self.assertEqual(list(source_normal.getpixel((0, 0))), normal_fixture["sample_raw_rgba_0_0"])
        z_table = bytearray(256 * 256)
        for x_byte in range(256):
            x = x_byte / 127.5 - 1.0
            for y_byte in range(256):
                y = y_byte / 127.5 - 1.0
                z = max(0.0, 1.0 - x * x - y * y) ** 0.5
                z_table[(x_byte << 8) | y_byte] = min(255, int(round(127.5 + 127.5 * z)))
        legacy = bytearray(len(source_rgba) // 4 * 3)
        corrected = bytearray(len(source_rgba) // 4 * 3)
        old_z = set()
        correct_z = set()
        for i in range(0, len(source_rgba), 4):
            r, g, _b, a = source_rgba[i : i + 4]
            old_z_byte = z_table[(r << 8) | g]
            new_z_byte = z_table[(a << 8) | g]
            old_z.add(old_z_byte)
            correct_z.add(new_z_byte)
            j = (i // 4) * 3
            legacy[j : j + 3] = bytes((r, g, old_z_byte))
            corrected[j : j + 3] = bytes((a, g, new_z_byte))
        self.assertEqual([min(old_z), max(old_z)], normal_fixture["legacy_rg_blue_z_extrema"])
        self.assertEqual(sha256(bytes(legacy)), normal_fixture["legacy_rg_rgb_sha256"])
        self.assertEqual([min(correct_z), max(correct_z)], normal_fixture["dxt5nm_ag_z_extrema"])
        self.assertEqual(sha256(bytes(corrected)), normal_fixture["dxt5nm_ag_rgb_sha256"])
        self.assertEqual(list(Image.frombytes("RGB", source_normal.size, bytes(corrected)).getpixel((0, 0))), normal_fixture["dxt5nm_ag_sample_rgb_0_0"])

        gloss = textures["TX_autochessi_M"][1].tobytes()
        rough = bytearray(len(gloss) // 4 * 3)
        for i in range(0, len(gloss), 4):
            j = (i // 4) * 3
            rough[j : j + 3] = bytes((255, 255 - gloss[i + 3], 0))
        rough_fixture = self.fixture["board_goldens"]["roughness"]
        self.assertEqual(sha256(bytes(rough)), rough_fixture["derived_rgb_sha256"])
        self.assertEqual(list(Image.frombytes("RGB", textures["TX_autochessi_M"][1].size, bytes(rough)).getpixel((0, 0))), rough_fixture["sample_0_0"])

        diffuse = textures["TX_autochessi_D"][1]
        atlas_fixture = self.fixture["board_goldens"]["atlas_orientation"]
        self.assertEqual(sha256(diffuse.tobytes()), atlas_fixture["top_down_rgba_sha256"])
        self.assertEqual(sha256(diffuse.transpose(Image.Transpose.FLIP_TOP_BOTTOM).tobytes()), atlas_fixture["vertical_flip_rgba_sha256"])
        for name, golden in self.fixture["board_goldens"]["crate_crops"].items():
            x, y, width, height = golden["rect"]
            crop = diffuse.crop((x, y, x + width, y + height))
            self.assertEqual(sha256(crop.tobytes()), golden["rgba_sha256"], name)

        fx_source, fx_objects = load_objects("map_fx")
        self.assertEqual(fx_source["sha256"], self.fixture["inputs"]["map_fx"]["sha256"])
        fx_golden = self.fixture["inputs"]["map_fx"]["start_back"]
        exported_mesh_names = {}
        seen = set()
        mesh_records = {}
        for obj in fx_objects:
            if obj.type.name != "Mesh":
                continue
            data = obj.read()
            name = upstream_extract.safe_name(data.m_Name or f"obj_{obj.path_id}")
            file_name = name + ".obj"
            if file_name in seen:
                name = f"{name}_{obj.path_id}"
            seen.add(file_name)
            exported_mesh_names[obj.path_id] = name
            text = data.export().replace("\r\n", "\n")
            mesh_records[str(obj.path_id)] = {"name": name, "sha256": sha256(text.encode("utf-8"))}
        self.assertEqual(mesh_records[fx_golden["mesh_path_id"]]["name"], fx_golden["mesh_name"])
        self.assertEqual(mesh_records[fx_golden["mesh_path_id"]]["sha256"], fx_golden["mesh_sha256"])
        self.assertEqual(mesh_records[fx_golden["scaled_alternative_path_id"]]["sha256"], fx_golden["scaled_alternative_sha256"])
        matching_nodes = []
        for obj in fx_objects:
            if obj.type.name == "GameObject" and getattr(obj.read(), "m_Name", "") == "Start_back":
                node = upstream_extract.prefab_node(obj.read(), exported_mesh_names)
                if node["parent"] == fx_golden["parent"]:
                    matching_nodes.append((str(obj.path_id), node))
        self.assertEqual(len(matching_nodes), 1)
        self.assertEqual(matching_nodes[0][0], fx_golden["node_path_id"])
        self.assertEqual(matching_nodes[0][1]["mesh"], fx_golden["mesh_name"])

    def test_real_wind_mesh_smoke_and_repeat_are_deterministic(self) -> None:
        first = self.require_success("wind")
        repeat = self.require_success("wind-repeat")
        fixture = self.fixture["inputs"]["wind"]["mesh"]
        group = "mesh/s_wind_device"
        entry, obj = self.entry_path(first, group, fixture["name"])
        self.assertEqual(entry.get("kind"), "Mesh")
        self.assertEqual(entry.get("verts"), fixture["vertices"])
        self.assertTrue(obj.is_file())
        obj_bytes = obj.read_bytes().replace(b"\r\n", b"\n")
        self.assertEqual(sha256(obj_bytes), fixture["obj_sha256"])
        self.assertEqual(sum(line.startswith(b"v ") for line in obj_bytes.splitlines()), fixture["vertices"])
        self.assertEqual(sum(line.startswith(b"f ") for line in obj_bytes.splitlines()), fixture["faces"])

        manifest = self.read_manifest(first)
        self.assertEqual(set(manifest.get("groups", {})), {group}, "narrow selection must not merge prior groups")
        self.assertTrue(set(self.fixture["freeze"]["manifest_core_keys"]).issubset(manifest))
        self.assertEqual(manifest["count"], sum(len(group_entries) for group_entries in manifest["groups"].values()))
        prefab_entry, prefab_file = self.entry_path(first, group, "prefab")
        self.assertEqual(prefab_entry.get("kind"), "Prefab")
        self.assertTrue(prefab_file.is_file())
        prefab = json.loads(prefab_file.read_text(encoding="utf-8"))
        self.assertTrue(any(node.get("mesh") == fixture["name"] for node in prefab), "prefab must reference the exported OBJ")

        repeat_manifest = self.read_manifest(repeat)
        self.assertEqual(manifest, repeat_manifest)
        first_group = first / "public/assets/local/mesh/s_wind_device"
        repeat_group = repeat / "public/assets/local/mesh/s_wind_device"
        def files(root: Path) -> dict[str, str]:
            return {p.relative_to(root).as_posix(): sha256(p.read_bytes()) for p in sorted(root.rglob("*")) if p.is_file()}
        self.assertEqual(files(first_group), files(repeat_group), "repeated real export changed core artifact bytes")
        self.assertTrue((first / "provenance.json").is_file())
        provenance = json.loads((first / "provenance.json").read_text(encoding="utf-8"))
        prov_strings = "\n".join(flatten_strings(provenance)).replace("\\", "/")
        self.assertIn(self.fixture["inputs"]["wind"]["sha256"], prov_strings)
        self.assertIn("s_wind_device.ab", prov_strings)
        self.assertIn("41.0.1", prov_strings)

    def test_real_crate_manifest_mesh_prefab_and_saved_obj(self) -> None:
        package = self.require_success("crate")
        fixture = self.fixture["inputs"]["crate"]["mesh"]
        group = "mesh/s_common_box_01"
        entry, obj = self.entry_path(package, group, fixture["name"])
        self.assertEqual(entry.get("kind"), "Mesh")
        self.assertEqual(entry.get("verts"), fixture["vertices"])
        self.assertTrue(obj.is_file(), "crate OBJ referenced by manifest must exist")
        raw = obj.read_bytes().replace(b"\r\n", b"\n")
        self.assertEqual(sha256(raw), fixture["obj_sha256"])
        self.assertEqual(sum(line.startswith(b"v ") for line in raw.splitlines()), fixture["vertices"])
        self.assertEqual(sum(line.startswith(b"f ") for line in raw.splitlines()), fixture["faces"])
        _, prefab_file = self.entry_path(package, group, "prefab")
        prefab = json.loads(prefab_file.read_text(encoding="utf-8"))
        self.assertTrue(any(node.get("mesh") == fixture["name"] for node in prefab), "crate prefab must point at pCube2")
        manifest = self.read_manifest(package)
        self.assertEqual(set(manifest["groups"]), {group})

    def test_real_sprite_exports_are_true_120_square_sprites(self) -> None:
        package = self.require_success("sprite")
        fixture = self.fixture["inputs"]["sprite"]["sprites"]
        group = "emoticon/basic_2"
        manifest = self.read_manifest(package)
        self.assertEqual(set(manifest.get("groups", {})), {group})
        entries = manifest["groups"][group]
        self.assertEqual(set(entries), set(fixture), "the six real Sprite names are the expected selection")
        for name, golden in fixture.items():
            with self.subTest(sprite=name):
                entry = entries[name]
                self.assertEqual(entry.get("kind"), "Sprite", "do not substitute padded Texture2D images")
                self.assertEqual([entry.get("w"), entry.get("h")], golden["size"])
                path = path_under(package, entry["path"])
                self.assertTrue(path.is_file())
                with Image.open(path) as image:
                    rgba = image.convert("RGBA")
                    self.assertEqual(list(rgba.size), golden["size"])
                    self.assertEqual(sha256(rgba.tobytes()), golden["rgba_sha256"])

    def test_real_board_profile_assets_pixels_normals_materials_and_tiles(self) -> None:
        package = self.require_success("board")
        fixture = self.fixture
        manifest = self.read_manifest(package)
        groups = manifest.get("groups", {})
        missing = set(fixture["freeze"]["board_required_groups"]) - set(groups)
        self.assertFalse(missing, f"board profile omitted required groups: {sorted(missing)}")
        self.assertEqual(manifest["count"], sum(len(entries) for entries in groups.values()))

        for name, golden in fixture["board_goldens"]["textures"].items():
            with self.subTest(texture=name):
                entry, path = self.entry_path(package, "map/autochess", name)
                self.assertEqual(entry.get("kind"), "Texture2D")
                self.assertEqual([entry.get("w"), entry.get("h")], golden["size"])
                self.assertTrue(path.is_file())
                with Image.open(path) as image:
                    rgba = image.convert("RGBA")
                    self.assertEqual(list(rgba.size), golden["size"])
                    self.assertEqual(sha256(rgba.tobytes()), golden["rgba_sha256"])

        map_group = groups["map/autochess"]
        n_entry = map_group["TX_autochessi_N"]
        n_path = path_under(package, n_entry["path"])
        derived_entry, derived_path = self.entry_path(package, "map/autochess", "TX_autochessi_N_rgb")
        normal_fixture = fixture["board_goldens"]["normal_regression"]
        self.assertEqual(n_entry.get("kind"), "Texture2D")
        self.assertEqual(derived_entry.get("kind"), "Derived")
        self.assertEqual(derived_entry.get("derive"), "normal_dxt5nm_ag")
        self.assertEqual(derived_entry.get("from"), "TX_autochessi_N")
        with Image.open(n_path) as image:
            raw_normal = image.convert("RGBA")
            raw_bytes = raw_normal.tobytes()
            self.assertEqual(list(raw_normal.getpixel((0, 0))), normal_fixture["sample_raw_rgba_0_0"])
        with Image.open(derived_path) as image:
            derived = image.convert("RGB")
            derived_bytes = derived.tobytes()
            self.assertEqual(list(derived.size), normal_fixture["dxt5nm_ag_size"])
            self.assertEqual(list(derived.getpixel((0, 0))), normal_fixture["dxt5nm_ag_sample_rgb_0_0"])
            self.assertEqual(sha256(derived_bytes), normal_fixture["dxt5nm_ag_rgb_sha256"])

        z_table = normal_z_table()
        expected_ag = bytearray(derived.width * derived.height * 3)
        legacy_z_values = set()
        out_index = 0
        for i in range(0, len(raw_bytes), 4):
            r, g, _b, a = raw_bytes[i : i + 4]
            legacy_z_values.add(z_table[(r << 8) | g])
            expected_ag[out_index] = a
            expected_ag[out_index + 1] = g
            expected_ag[out_index + 2] = z_table[(a << 8) | g]
            out_index += 3
        self.assertEqual(legacy_z_values, {128}, "legacy RG interpretation of this DXT5nm image is flat blue/Z=128")
        self.assertEqual(bytes(expected_ag), derived_bytes, "derived normal must match A/G and per-pixel reconstructed Z")

        m_entry, m_path = self.entry_path(package, "map/autochess", "TX_autochessi_M")
        rough_entry, rough_path = self.entry_path(package, "map/autochess", "TX_autochessi_M_rough")
        self.assertEqual(m_entry.get("kind"), "Texture2D")
        self.assertEqual(rough_entry.get("derive"), "rough_from_gloss")
        with Image.open(m_path) as image:
            gloss_bytes = image.convert("RGBA").tobytes()
        expected_rough = bytearray(len(gloss_bytes) // 4 * 3)
        for i in range(0, len(gloss_bytes), 4):
            out = (i // 4) * 3
            expected_rough[out : out + 3] = bytes((255, 255 - gloss_bytes[i + 3], 0))
        with Image.open(rough_path) as image:
            rough = image.convert("RGB")
            self.assertEqual(list(rough.getpixel((0, 0))), fixture["board_goldens"]["roughness"]["sample_0_0"])
            self.assertEqual(sha256(rough.tobytes()), fixture["board_goldens"]["roughness"]["derived_rgb_sha256"])
            self.assertEqual(bytes(expected_rough), rough.tobytes())

        tiles_path = package / "public/assets/local/map/autochess/tiles.json"
        self.assertTrue(tiles_path.is_file(), "board profile must save tiles.json beside TX_autochessi_D")
        tiles = json.loads(tiles_path.read_text(encoding="utf-8"))
        self.assertEqual(tiles.get("version"), 2)
        for key, filename, dims in (("D", "TX_autochessi_D.png", [2048, 2048]), ("common", "TX_autochessi_common_D.png", [1024, 1024]), ("BG", "TX_autochessi_BG.png", [1024, 1024])):
            self.assertEqual(tiles["source"][key]["path"], f"/assets/local/map/autochess/{filename}")
            self.assertEqual([tiles["source"][key]["w"], tiles["source"][key]["h"]], dims)
            self.assertNotIn("..", tiles["source"][key]["path"])
        for name, golden in fixture["board_goldens"]["crate_crops"].items():
            surface = tiles["board3d"][name]
            self.assertEqual(surface["rect"], golden["rect"])
            with Image.open(path_under(package, map_group["TX_autochessi_D"]["path"])) as image:
                x, y, w, h = golden["rect"]
                crop = image.convert("RGBA").crop((x, y, x + w, y + h))
                self.assertEqual(sha256(crop.tobytes()), golden["rgba_sha256"])
        with Image.open(path_under(package, map_group["TX_autochessi_D"]["path"])) as image:
            rgba = image.convert("RGBA")
            self.assertEqual(sha256(rgba.tobytes()), fixture["board_goldens"]["atlas_orientation"]["top_down_rgba_sha256"])
            self.assertEqual(sha256(rgba.transpose(Image.Transpose.FLIP_TOP_BOTTOM).tobytes()), fixture["board_goldens"]["atlas_orientation"]["vertical_flip_rgba_sha256"])

        all_names = {name for group_entries in groups.values() for name in group_entries}
        for group in ("map/autochess", "map/fx"):
            material_entry, material_path = self.entry_path(package, group, "materials")
            self.assertEqual(material_entry.get("kind"), "Materials")
            self.assertTrue(material_path.is_file())
            materials = json.loads(material_path.read_text(encoding="utf-8"))
            self.assertTrue(materials, f"{group} material table is empty")
            for material_name, material in materials.items():
                for binding in material.get("textures", {}).values():
                    texture_name = binding.get("texture")
                    self.assertIn(texture_name, all_names, f"{group}/{material_name} texture {texture_name} unresolved in KR output")
        _, fx_prefab_path = self.entry_path(package, "map/fx", "prefab")
        self.assertTrue(fx_prefab_path.is_file())
        self.assertTrue(json.loads(fx_prefab_path.read_text(encoding="utf-8")))
        provenance_path = package / "provenance.json"
        self.assertTrue(provenance_path.is_file())
        provenance_text = "\n".join(flatten_strings(json.loads(provenance_path.read_text(encoding="utf-8")))).replace("\\", "/")
        self.assertIn(fixture["inputs"]["board"]["sha256"], provenance_text)
        self.assertIn("Arknights_KR", provenance_text)
        self.assertNotIn("Arknights_CN", provenance_text)

    def test_board_validator_is_successful_and_read_only(self) -> None:
        package = self.require_success("board")
        before = {p.relative_to(package).as_posix(): sha256(p.read_bytes()) for p in package.rglob("*") if p.is_file()}
        result = self._run_cli("validate", "--upstream", UPSTREAM, "--out-root", package)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        after = {p.relative_to(package).as_posix(): sha256(p.read_bytes()) for p in package.rglob("*") if p.is_file()}
        self.assertEqual(before, after, "validate must not write or repair package artifacts")

    def test_contract_real_artifact_fixtures_match_board_package_and_independent_golden(self) -> None:
        package = self.require_success("board")
        contract = json.loads((ADAPTER_DIR / "contract.json").read_text(encoding="utf-8"))
        real = contract["realFixtures"]
        for group, source_key in (("mesh/s_wind_device", "wind"), ("mesh/s_common_box_01", "crate")):
            with self.subTest(group=group):
                mesh_fixture = self.fixture["inputs"][source_key]["mesh"]
                contract_fixture = real[group]
                self.assertEqual(contract_fixture["objSha256Lf"], mesh_fixture["obj_sha256"])
                _, obj = self.entry_path(package, group, mesh_fixture["name"])
                normalized = obj.read_bytes().replace(b"\\r\\n", b"\\n").replace(b"\\r", b"\\n")
                self.assertEqual(sha256(normalized), contract_fixture["objSha256Lf"])

        normal_fixture = real["normalDxt5nmAg"]
        independent_hash = self.fixture["board_goldens"]["textures"]["TX_autochessi_N"]["rgba_sha256"]
        self.assertEqual(normal_fixture["sourceRgbaSha256"], independent_hash)
        _, source_path = self.entry_path(package, "map/autochess", normal_fixture["source"])
        with Image.open(source_path) as image:
            self.assertEqual(sha256(image.convert("RGBA").tobytes()), normal_fixture["sourceRgbaSha256"])

    def test_board_validator_rejects_drifted_contract_mesh_output_hash(self) -> None:
        package = self.require_success("board")
        contract = json.loads((ADAPTER_DIR / "contract.json").read_text(encoding="utf-8"))
        contract["realFixtures"]["mesh/s_wind_device"]["objSha256Lf"] = "0" * 64
        if str(ADAPTER_DIR) not in sys.path:
            sys.path.insert(0, str(ADAPTER_DIR))
        import extract_kr as adapter

        with self.assertRaisesRegex(adapter.OperationError, "real-source mesh fixture mismatch: mesh/s_wind_device"):
            adapter.validate_board_package(package, self.read_manifest(package), contract)

    def test_normal_derivation_rejects_drifted_source_rgba_hash(self) -> None:
        package = self.require_success("board")
        contract = json.loads((ADAPTER_DIR / "contract.json").read_text(encoding="utf-8"))
        normal = contract["realFixtures"]["normalDxt5nmAg"]
        normal["sourceRgbaSha256"] = "0" * 64
        if str(ADAPTER_DIR) not in sys.path:
            sys.path.insert(0, str(ADAPTER_DIR))
        import extract_kr as adapter

        helper, _, _ = adapter.load_guarded_upstream(UPSTREAM, contract)
        source = self.entry_path(package, "map/autochess", normal["source"])[1]
        texture = {"name": normal["source"], "format": normal["textureFormat"],
                   "width": normal["sourceWidth"], "height": normal["sourceHeight"]}
        with tempfile.TemporaryDirectory(prefix="kr-normal-contract-", dir=self.work) as temp:
            package_assets = Path(temp) / "public/assets/local"
            target = package_assets / "map/autochess" / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            with self.assertRaisesRegex(adapter.OperationError, "packed normal source RGBA hash mismatch"):
                adapter._derive_kr_normal(package_assets, {"map/autochess": {normal["source"]: {}}},
                                          [texture], helper, contract)

    @staticmethod
    def _create_directory_junction(link: Path, target: Path) -> None:
        result = subprocess.run(
            f'mklink /J "{link}" "{target}"', shell=True, text=True, capture_output=True, check=False
        )
        if result.returncode:
            raise AssertionError(f"could not create Windows test junction {link}: {result.stdout}{result.stderr}")
        attributes = getattr(link.lstat(), "st_file_attributes", 0)
        if not attributes & 0x400:
            link.rmdir()
            raise AssertionError(f"test path is not a Windows reparse point: {link}")

    @unittest.skipUnless(os.name == "nt", "requires Windows junctions")
    def test_validate_refuses_raw_package_and_upstream_junction_paths(self) -> None:
        package = self.require_success("board")
        for label, package_arg, upstream_arg, target in (
            ("package", None, UPSTREAM, package),
            ("upstream", package, None, UPSTREAM),
        ):
            with self.subTest(path=label):
                temp = Path(tempfile.mkdtemp(prefix=f"kr-junction-validate-{label}-", dir=self.work))
                link = temp / "junction"
                self._create_directory_junction(link, target)
                try:
                    result = self._run_cli(
                        "validate", "--upstream", upstream_arg or link, "--out-root", package_arg or link
                    )
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertEqual(
                        result.stderr.strip(),
                        f"extract_kr: reparse/symlink path component refused: {link}",
                    )
                finally:
                    link.rmdir()
                    shutil.rmtree(temp, ignore_errors=True)

    @unittest.skipUnless(os.name == "nt", "requires Windows junctions")
    def test_extract_refuses_raw_client_and_upstream_junction_roots(self) -> None:
        for label, client_arg, upstream_arg, target in (
            ("client", None, UPSTREAM, INSTALL),
            ("upstream", INSTALL, None, UPSTREAM),
        ):
            with self.subTest(root=label):
                temp = Path(tempfile.mkdtemp(prefix=f"kr-junction-extract-{label}-", dir=self.work))
                link = temp / "junction"
                output = temp / "output"
                self._create_directory_junction(link, target)
                try:
                    result = self._run_cli(
                        "extract", "--upstream", upstream_arg or link, "--install", client_arg or link,
                        "--only", "mesh/s_wind_device", "--out-root", output,
                    )
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertEqual(
                        result.stderr.strip(),
                        f"extract_kr: reparse/symlink path component refused: {link}",
                    )
                    self.assertFalse(output.exists(), "junction input must be refused before staging output")
                finally:
                    link.rmdir()
                    shutil.rmtree(temp, ignore_errors=True)

    @unittest.skipUnless(os.name == "nt", "requires Windows junctions")
    def test_crop_check_refuses_raw_package_and_upstream_junction_paths(self) -> None:
        package = self.require_success("board")
        baseline = subprocess.run(
            [self.node, str(ADAPTER_DIR / "crop_kr.mjs"), "--upstream", str(UPSTREAM),
             "--package-root", str(package), "--check"],
            cwd=ADAPTER_DIR, text=True, capture_output=True, check=False,
        )
        self.assertEqual(baseline.returncode, 0, f"valid crop-check baseline failed:\n{baseline.stdout}\n{baseline.stderr}")
        self.assertEqual(json.loads(baseline.stdout)["status"], "valid")

        for label, package_arg, upstream_arg, target in (
            ("package", None, UPSTREAM, package),
            ("upstream", package, None, UPSTREAM),
        ):
            with self.subTest(path=label):
                temp = Path(tempfile.mkdtemp(prefix=f"kr-junction-crop-{label}-", dir=self.work))
                link = temp / "junction"
                self._create_directory_junction(link, target)
                try:
                    result = subprocess.run(
                        [self.node, str(ADAPTER_DIR / "crop_kr.mjs"), "--upstream", str(upstream_arg or link),
                         "--package-root", str(package_arg or link), "--check"],
                        cwd=ADAPTER_DIR, text=True, capture_output=True, check=False,
                    )
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    self.assertEqual(result.stdout, "")
                    self.assertIn(f"reparse/symlink path component refused: {link}", result.stderr)
                finally:
                    link.rmdir()
                    shutil.rmtree(temp, ignore_errors=True)

    def test_board_validator_rejects_independent_package_mutations(self) -> None:
        package = self.require_success("board")

        baseline = self._run_cli("validate", "--upstream", UPSTREAM, "--out-root", package)
        self.assertEqual(baseline.returncode, 0, f"valid baseline package preflight failed:\n{baseline.stdout}\n{baseline.stderr}")
        self.assertEqual(baseline.stderr, "")
        self.assertEqual(json.loads(baseline.stdout)["status"], "valid")

        def remove_tiles(copy: Path) -> None:
            (copy / "public/assets/local/map/autochess/tiles.json").unlink()

        def remove_crate_entry(copy: Path) -> None:
            manifest_path = copy / "data/local-assets.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertIn("mesh/s_common_box_01", manifest["groups"])
            removed = manifest["groups"]["mesh/s_common_box_01"].pop("pCube2")
            asset = path_under(copy, removed["path"])
            asset_relative = asset.relative_to(copy).as_posix()
            asset.unlink()
            manifest["count"] = sum(len(entries) for entries in manifest["groups"].values())
            manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            manifest_path.write_bytes(manifest_bytes)
            provenance_path = copy / "provenance.json"
            provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
            provenance["outputFiles"].pop(asset_relative)
            provenance["manifestSha256"] = sha256(manifest_bytes)
            provenance_path.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        def corrupt_derived_normal(copy: Path) -> None:
            manifest = self.read_manifest(copy)
            url = manifest["groups"]["map/autochess"]["TX_autochessi_N_rgb"]["path"]
            target = path_under(copy, url)
            with Image.open(target) as source:
                image = source.convert("RGB")
            red, green, blue = image.getpixel((0, 0))
            image.putpixel((0, 0), ((red + 1) % 256, green, blue))
            image.save(target, format="PNG")
            data = target.read_bytes()
            with Image.open(target) as saved:
                rgba = saved.convert("RGBA")
                width, height = rgba.size
                pixel_hash = sha256(rgba.tobytes())
            relative = target.relative_to(copy).as_posix()
            provenance_path = copy / "provenance.json"
            provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
            provenance["outputFiles"][relative] = {
                "size": len(data), "sha256": sha256(data), "pixelSha256": pixel_hash,
                "width": width, "height": height,
            }
            provenance_path.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        def put_outside_source_in_provenance(copy: Path) -> None:
            path = copy / "provenance.json"
            provenance = json.loads(path.read_text(encoding="utf-8"))
            sources = provenance.get("sourceFiles", [])
            source = next((item for item in sources if str(item.get("absolutePath", "")).lower().endswith(".ab")), None)
            self.assertIsNotNone(source, "provenance schema has no source bundle absolutePath to mutate")
            source["absolutePath"] = "../../outside-root/forged.ab"
            path.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        mutations = (
            ("missing-tiles", remove_tiles, 1, ("missing or unsafe manifest asset:", "tiles.json")),
            ("missing-crate-entry", remove_crate_entry, 1, ("required package mapping missing: mesh/s_common_box_01/pCube2",)),
            ("corrupt-normal", corrupt_derived_normal, 1, ("DXT5nm/AG normal pixel snapshot mismatch",)),
            ("outside-source", put_outside_source_in_provenance, 1, ("provenance source path escapes verified client root:",)),
        )
        for label, mutate, expected_exit, diagnostics in mutations:
            with self.subTest(mutation=label), tempfile.TemporaryDirectory(prefix=f"kr-tests-mut-{label}-", dir=self.work) as temp:
                target = Path(temp) / "package"
                shutil.copytree(package, target)
                mutate(target)
                result = self._run_cli("validate", "--upstream", UPSTREAM, "--out-root", target)
                self.assertEqual(result.returncode, expected_exit, f"unexpected exit code for {label}:\n{result.stdout}\n{result.stderr}")
                self.assertEqual(result.stdout, "", f"validator emitted success output for rejected {label}")
                for diagnostic in diagnostics:
                    self.assertIn(diagnostic, result.stderr, f"wrong diagnostic for {label}:\n{result.stderr}")

    def test_board_validator_rejects_upstream_contract_drift_in_isolated_copy(self) -> None:
        package = self.require_success("board")
        baseline = self._run_cli("validate", "--upstream", UPSTREAM, "--out-root", package)
        self.assertEqual(baseline.returncode, 0, f"valid baseline package preflight failed:\n{baseline.stdout}\n{baseline.stderr}")
        self.assertEqual(baseline.stderr, "")
        self.assertEqual(json.loads(baseline.stdout)["status"], "valid")

        with tempfile.TemporaryDirectory(prefix="kr-tests-mut-upstream-drift-", dir=self.work) as temp:
            clone = Path(temp) / "upstream"
            copied = subprocess.run(
                ["git", "clone", "--config", "core.autocrlf=false", "--shared", "--no-checkout", str(UPSTREAM), str(clone)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(copied.returncode, 0, f"could not clone upstream into scratch:\n{copied.stdout}\n{copied.stderr}")
            pinned = self.fixture["freeze"]["upstream_head"]
            checkout = subprocess.run(
                ["git", "-C", str(clone), "checkout", "--detach", pinned],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(checkout.returncode, 0, f"could not check out pinned upstream:\n{checkout.stdout}\n{checkout.stderr}")
            head = subprocess.run(["git", "-C", str(clone), "rev-parse", "HEAD"], text=True, capture_output=True, check=False)
            self.assertEqual(head.returncode, 0, head.stderr)
            self.assertEqual(head.stdout.strip(), pinned)

            preimage = clone / "tools/local-extract/extract.py"
            preimage.write_bytes(preimage.read_bytes() + b"\n# drift only in disposable upstream copy\n")
            actual = sha256(preimage.read_bytes())
            result = self._run_cli("validate", "--upstream", clone, "--out-root", package)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(
                result.stderr.strip(),
                f"extract_kr: upstream source drift: tools/local-extract/extract.py (sha256 {actual})",
            )

    def test_renderer_board_pack_contract_against_the_same_real_board_package(self) -> None:
        package = self.require_success("board")
        env = os.environ.copy()
        env["STRONGHOLD_UPSTREAM"] = str(UPSTREAM)
        env["KR_PACKAGE_ROOT"] = str(package)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run(
            [self.node, "--test", str(NODE_TEST)],
            cwd=ADAPTER_DIR,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, f"board-pack.test.mjs failed:\n{result.stdout}\n{result.stderr}")

    def test_source_catalog_bundle_and_upstream_hashes_are_unchanged(self) -> None:
        self.assertEqual(self._source_snapshot(), self.source_before, "KR source/catalog bytes changed during tests")
        self.assertEqual(self._upstream_hashes(), self.upstream_hashes_before, "pinned upstream source bytes changed")
        self.assertEqual(self._upstream_status(), self.upstream_status_before, "upstream git status changed during tests")
        for name, output in self.outputs.items():
            if output.exists():
                self.assertFalse(output.is_relative_to(UPSTREAM), f"{name} output landed in upstream")
                self.assertFalse(output.is_relative_to(INSTALL), f"{name} output landed in KR install")


if __name__ == "__main__":
    unittest.main(verbosity=2)
