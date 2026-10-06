# Independent final re-review — KR extraction adapter

## Verdict: APPROVED — scoped

The two remaining blocking findings are resolved in the reviewed delta. No additional blocker was found within the requested scope.

## Resolved findings

### B2 — raw `crop_kr.mjs` inputs are rejected before normalized paths are used

`crop_kr.mjs` preserves `RAW_UPSTREAM` and `RAW_PACKAGE`. At the start of `main()`, it calls `assertNoReparse()` for both raw inputs before assigning `UPSTREAM = path.resolve(...)` or `PACKAGE = path.resolve(...)`, and before the upstream/package validators run.

`tests/test_real.py::RealKoreanExtractionTests.test_crop_check_refuses_raw_package_and_upstream_junction_paths` now:

- establishes a valid real-package `crop_kr.mjs --check` baseline;
- creates actual Windows directory junctions with `mklink /J`;
- supplies a junction independently as `--package-root` and as `--upstream`;
- requires exit code `1`, no stdout, and the reparse/symlink-refusal diagnostic in each case.

This closes the prior path-normalization bypass for the supported crop validator command.

### B3 — copied-package mutation tests prove the intended rejection

`test_board_validator_rejects_independent_package_mutations` now preflights the unmodified board package and requires a successful, silent `validate` result with `status: valid` before testing mutations. Each isolated package copy then requires:

- exit code `1`;
- no success stdout; and
- its mutation-specific diagnostic marker(s).

The four covered mutations are `missing-tiles`, `missing-crate-entry`, `corrupt-normal`, and `outside-source`. This prevents a shared unrelated validator failure from satisfying every negative case.

## Verification performed

- Fresh focused Windows-real regression run completed successfully:

  ```text
  test_crop_check_refuses_raw_package_and_upstream_junction_paths ... ok
  test_board_validator_rejects_independent_package_mutations ... ok

  Ran 2 tests in 18.202s
  OK
  ```

- Direct preflight of `D:/Hermes/cache/scratch/kr-fix-board-c27675cc05` returned `status: valid`, `manifestCount: 62`, and the eight declared board groups. Its direct guarded `crop_kr.mjs --check` also returned `status: valid` with 37 materials and 36 board-3D surfaces.
- The pinned upstream remained at `763e224b8d72c2362e70a8f1283a74e644195712` with empty porcelain status after verification.
- Handoff evidence reports the complete Python suite as **26 tests passed in 38.978s**; this re-review independently reran the two tests that exercise the final B2/B3 fixes.

## Scope limits

This approval covers the declared board package and its eight explicit supported groups only. It does not claim full-client parity, live runtime/browser visual parity, live endpoint behavior, or deployment validation. Unsupported fool-day emotes, the zero-export Ulpia token group, and unverified enemy Spine IDs remain outside this approval scope.
