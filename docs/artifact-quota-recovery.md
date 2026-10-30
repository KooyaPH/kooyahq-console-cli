# Recover a CLI candidate when Actions artifact storage is full

This runbook covers the failure where the private KooyaHQ source workflow passes its staging ancestry check, package tests, typecheck, build, and package audit, then fails only at `actions/upload-artifact@v4` because Actions artifact storage is over quota.

It is linked to the current Console CLI/MCP qualification in [F11 issue #313](https://github.com/KooyaPH/KooyaHQ/issues/313) and tracks the handoff fix in [issue #352](https://github.com/KooyaPH/KooyaHQ/issues/352).

Recovery rebuilds the package from the exact source commit, reruns the package checks and audit, and pushes only `kooya-cli.tgz` plus `kooya-cli.tgz.sha256` to `candidate/v<version>`. That branch triggers the normal public archive validation, install and MCP smoke tests on Ubuntu, macOS, and Windows, then the isolated release job. The procedure never creates a stable tag or GitHub Release itself.

## Use this only for the artifact quota failure

1. Confirm the failed run is the `KooyaHQ CLI Release` workflow for a `cli-v<version>` tag and its `package` job passed through `Pack and audit public distribution contents`. The only failed step must be `actions/upload-artifact@v4` with an artifact storage quota error. Do not recover a run with a failed test, build, source ancestry check, audit, or unrelated runner error.
2. Record the full `headSha` from the failed run. This source commit must be an ancestor of `staging`, and the tag version must still match `packages/cli/package.json` at that commit.
3. Rebuild and audit from that exact commit on a trusted maintainer machine. Do not run package install/build/test steps in a process that has the public release repository write key available.
4. After the checks pass, run the recovery command from a clean clone of this public release repository. It verifies the archive and checksum again, creates the candidate branch without force, and records the source commit in the candidate commit message.
5. Watch the `Validate and publish CLI release` workflow. Require its normal candidate archive and three-platform install/MCP gates to pass. The publish job checks the candidate head again before creating a stable tag or release.

## Rebuild the audited archive from the failed source SHA

Set `SOURCE_SHA` to the exact full `headSha` from the failed run. Set `SOURCE_REPO` to the existing private KooyaHQ clone. The following commands run the same package checks and build steps as the source workflow, then run its private package-content audit before making the checksum:

```bash
set -euo pipefail

SOURCE_SHA=replace-with-full-failed-run-head-sha
SOURCE_REPO=/path/to/KooyaHQ
RECOVERY_ROOT="$(mktemp -d)"
SOURCE_CHECKOUT="$RECOVERY_ROOT/source"
ASSETS="$RECOVERY_ROOT/cli-release-assets"

git -C "$SOURCE_REPO" fetch origin "$SOURCE_SHA"
git -C "$SOURCE_REPO" worktree add --detach "$SOURCE_CHECKOUT" "$SOURCE_SHA"
VERSION="$(node -p "require('$SOURCE_CHECKOUT/packages/cli/package.json').version")"
test "$(git -C "$SOURCE_CHECKOUT" rev-parse HEAD)" = "$SOURCE_SHA"
test "$(node -p "require('$SOURCE_CHECKOUT/packages/cli/package.json').name")" = '@kooya/cli'
test "$(node -p "require('$SOURCE_CHECKOUT/packages/cli/package.json').private")" = 'false'
mkdir -p "$ASSETS"

cd "$SOURCE_CHECKOUT"
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
node --test .github/scripts/tests/wait-for-public-cli-release.test.mjs
pnpm --filter @kooya/cli test
pnpm --filter @kooya/cli typecheck
pnpm --filter @kooya/cli build

cd "$SOURCE_CHECKOUT/packages/cli"
npm pack --json --pack-destination "$ASSETS" > "$RECOVERY_ROOT/npm-pack.json"
FILENAME="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))[0].filename)" "$RECOVERY_ROOT/npm-pack.json")"
mv "$ASSETS/$FILENAME" "$ASSETS/kooya-cli.tgz"
node "$SOURCE_CHECKOUT/.github/scripts/audit-cli-package.mjs" "$ASSETS/kooya-cli.tgz" "$VERSION"
(cd "$ASSETS" && sha256sum kooya-cli.tgz > kooya-cli.tgz.sha256)
```

Review the source run logs and local command results before proceeding. Keep `SOURCE_SHA`, `VERSION`, and `ASSETS` available for the next step. The recovery command accepts a source SHA only as provenance; it does not claim to reproduce or certify the private test run by itself.

## Push the audited candidate

Run this only after the source checks and audit have completed. Use the official release repository clone and the same `SOURCE_SHA`, `VERSION`, and `ASSETS` values:

```bash
git clone git@github.com:KooyaPH/kooyahq-console-cli.git "$RECOVERY_ROOT/kooyahq-console-cli"
cd "$RECOVERY_ROOT/kooyahq-console-cli"
node scripts/recover-candidate.mjs \
  --version "$VERSION" \
  --source-sha "$SOURCE_SHA" \
  --assets "$ASSETS"
```

The recovery helper fails closed when the stable tag exists, the candidate branch points at a different source commit, or either asset differs. A retry with the same source SHA and byte-identical assets reports the existing candidate without changing it. The Git push is non-forcing, and the helper creates no tag or release. A different existing candidate requires maintainer review; do not delete or replace it to make the retry pass.

The public candidate workflow requires the branch head to remain at the audited commit and its diff from `main` to add exactly the tarball and checksum. It validates the checksum, package metadata, and archive allowlist before executing the packed CLI/MCP smoke tests. Only the dependent `publish` job receives `contents: write`; it rechecks the branch head and will not add, replace, or repair assets on an existing stable release. Any partially published or mismatched release requires explicit maintainer investigation.

## Completion evidence

Record the source run URL and SHA, package version, archive SHA-256, recovery candidate commit, public workflow run, and final three-platform checks in F11 #313 and follow-up #352. Do not mark the release qualified from the local rebuild alone; qualification requires the public release workflow and installed-artifact checks.
