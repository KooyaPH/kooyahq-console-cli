import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { verifyReleaseAssets } from '../scripts/verify-release-assets.mjs'

function releaseFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kooyahq-cli-release-'))
  const packageRoot = join(root, 'package')
  const assetDirectory = join(root, 'release-assets')
  mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true })
  mkdirSync(join(packageRoot, 'docs'), { recursive: true })
  mkdirSync(join(packageRoot, 'skills', 'kooyahq-cli'), { recursive: true })
  mkdirSync(assetDirectory, { recursive: true })
  const metadata = {
    name: options.name ?? '@kooya/cli',
    version: options.version ?? '0.5.0',
    private: options.private ?? false,
    engines: { node: '>=22' },
    bin: { kooyahq: 'dist/bin/kooyahq.js', 'kooyahq-mcp': 'dist/bin/kooyahq-mcp.js' },
  }
  if (options.omitPrivate) delete metadata.private
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(metadata))
  if (options.cliBinDirectory) {
    mkdirSync(join(packageRoot, 'dist', 'bin', 'kooyahq.js'))
  } else {
    writeFileSync(join(packageRoot, 'dist', 'bin', 'kooyahq.js'), '#!/usr/bin/env node\n')
  }
  writeFileSync(join(packageRoot, 'dist', 'bin', 'kooyahq-mcp.js'), '#!/usr/bin/env node\n')
  writeFileSync(join(packageRoot, 'README.md'), '# KooyaHQ CLI\n')
  writeFileSync(join(packageRoot, 'docs', 'installation.md'), '# Install\n')
  writeFileSync(join(packageRoot, 'docs', 'codex-mcp.md'), '# MCP\n')
  writeFileSync(join(packageRoot, 'docs', 'scenarios.md'), '# Scenarios\n')
  mkdirSync(join(packageRoot, 'docs', 'ai-clients'), { recursive: true })
  writeFileSync(join(packageRoot, 'docs', 'ai-clients', 'claude.md'), '# Claude\n')
  mkdirSync(join(packageRoot, 'skills', 'kooyahq-cli'), { recursive: true })
  writeFileSync(join(packageRoot, 'skills', 'kooyahq-cli', 'SKILL.md'), '# Skill\n')
  writeFileSync(join(packageRoot, 'skills', 'kooyahq-cli', 'VERSION'), '1\n')
  if (options.hardlink) {
    linkSync(join(packageRoot, 'dist', 'bin', 'kooyahq.js'), join(packageRoot, 'dist', 'linked.js'))
  }
  if (options.symlink) {
    symlinkSync('bin/kooyahq.js', join(packageRoot, 'dist', 'linked.js'))
  }
  for (const [relativePath, contents] of options.files ?? []) {
    const path = join(packageRoot, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }

  const tarball = join(assetDirectory, 'kooya-cli.tgz')
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package'])
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  writeFileSync(join(assetDirectory, 'kooya-cli.tgz.sha256'), `${digest}  kooya-cli.tgz\n`)
  return { root, assetDirectory, tarball }
}

test('validates a versioned public asset package and checksum manifest', async (t) => {
  const fixture = releaseFixture()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  const result = await verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0')
  assert.deepEqual(result, { name: '@kooya/cli', version: '0.5.0' })
})

test('rejects an invalid tag, a mismatched package name, or a mismatched version', async (t) => {
  const fixture = releaseFixture()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, '0.5.0'), /tag/)
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0-01'), /tag/)

  const nameFixture = releaseFixture({ name: 'kooyahq-cli' })
  t.after(() => rmSync(nameFixture.root, { recursive: true, force: true }))
  await assert.rejects(verifyReleaseAssets(nameFixture.assetDirectory, 'v0.5.0'), /package name/)

  const versionFixture = releaseFixture({ version: '0.4.1' })
  t.after(() => rmSync(versionFixture.root, { recursive: true, force: true }))
  await assert.rejects(verifyReleaseAssets(versionFixture.assetDirectory, 'v0.5.0'), /version/)
})

test('rejects a private package', async (t) => {
  const fixture = releaseFixture({ private: true })
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /private/)

  const unspecified = releaseFixture({ omitPrivate: true })
  t.after(() => rmSync(unspecified.root, { recursive: true, force: true }))
  await assert.rejects(verifyReleaseAssets(unspecified.assetDirectory, 'v0.5.0'), /private: false/)
})

test('rejects source, test, and design files in the package archive', async (t) => {
  for (const [path, contents] of [
    ['src/internal.ts', 'internal source'],
    ['tests/release.test.mjs', 'private tests'],
    ['design/architecture.md', 'private design'],
    ['internal/server.ts', 'private source'],
    ['.env', 'synthetic credential'],
    ['docs/ai-clients/internal-roadmap.md', 'private roadmap'],
    ['dist/test.js', 'compiled test'],
    ['dist/internal-tests.js', 'compiled internal tests'],
    ['dist/test-fixtures/fixture.js', 'compiled test fixture'],
  ]) {
    const fixture = releaseFixture({ files: [[path, contents]] })
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
    await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /private source|allowlist/)
  }
})

test('rejects hard links in the package archive', async (t) => {
  const fixture = releaseFixture({ hardlink: true })
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /non-regular entry/)
})

test('rejects symbolic links in the package archive', async (t) => {
  let fixture
  try {
    fixture = releaseFixture({ symlink: true })
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) {
      t.skip('symbolic links are unavailable in this test environment')
      return
    }
    throw error
  }
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /non-regular entry/)
})

test('requires executable paths to be regular files rather than directories', async (t) => {
  const fixture = releaseFixture({ cliBinDirectory: true })
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /required regular file/)
})

test('rejects a checksum that does not match the release asset', async (t) => {
  const fixture = releaseFixture()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  writeFileSync(join(fixture.assetDirectory, 'kooya-cli.tgz.sha256'), `${'0'.repeat(64)}  kooya-cli.tgz\n`)
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /SHA-256/)
})

test('rejects missing release assets', async (t) => {
  const fixture = releaseFixture()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  rmSync(fixture.tarball)
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /kooya-cli\.tgz/)
})

test('rejects an oversized release archive', async (t) => {
  const fixture = releaseFixture()
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
  truncateSync(fixture.tarball, 100 * 1024 * 1024 + 1)
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /100 MiB/)
})
