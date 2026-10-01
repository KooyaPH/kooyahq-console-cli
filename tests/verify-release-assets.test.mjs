import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { verifyReleaseAssets } from '../scripts/verify-release-assets.mjs'

function releaseFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kooyahq-cli-release-'))
  const packageRoot = join(root, 'package')
  const assetDirectory = join(root, 'release-assets')
  mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true })
  mkdirSync(assetDirectory, { recursive: true })
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: options.name ?? '@kooya/cli',
      version: options.version ?? '0.5.0',
      private: options.private ?? false,
      bin: { kooyahq: 'dist/bin/kooyahq.js', 'kooyahq-mcp': 'dist/bin/kooyahq-mcp.js' },
    }),
  )
  writeFileSync(join(packageRoot, 'dist', 'bin', 'kooyahq.js'), '#!/usr/bin/env node\n')
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
})

test('rejects source, test, and design files in the package archive', async (t) => {
  for (const [path, contents] of [
    ['src/internal.ts', 'internal source'],
    ['tests/release.test.mjs', 'private tests'],
    ['design/architecture.md', 'private design'],
  ]) {
    const fixture = releaseFixture({ files: [[path, contents]] })
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }))
    await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /source files/)
  }
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
  truncateSync(fixture.tarball, 512 * 1024 * 1024 + 1)
  await assert.rejects(verifyReleaseAssets(fixture.assetDirectory, 'v0.5.0'), /512 MiB/)
})
