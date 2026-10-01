#!/usr/bin/env node

import { createReadStream, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGE_NAME = '@kooya/cli'
const TARBALL_NAME = 'kooya-cli.tgz'
const CHECKSUM_NAME = `${TARBALL_NAME}.sha256`
const MAX_TARBALL_BYTES = 100 * 1024 * 1024
const MAX_TAR_LIST_BYTES = 16 * 1024 * 1024
const STABLE_SEMVER = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const REQUIRED_FILES = [
  'package/package.json',
  'package/README.md',
  'package/docs/installation.md',
  'package/docs/codex-mcp.md',
  'package/docs/scenarios.md',
  'package/skills/kooyahq-cli/SKILL.md',
  'package/skills/kooyahq-cli/VERSION',
  'package/dist/bin/kooyahq.js',
  'package/dist/bin/kooyahq-mcp.js',
]
const ALLOWED_DIRECTORIES = new Set([
  'package',
  'package/dist',
  'package/docs',
  'package/docs/ai-clients',
  'package/skills',
  'package/skills/kooyahq-cli',
])
const ALLOWED_AI_CLIENT_GUIDES = new Set([
  'antigravity.md',
  'claude.md',
  'cursor.md',
  'gemini.md',
  'hermes.md',
  'index.md',
  'web-and-remote.md',
])

function fail(message) {
  throw new Error(message)
}

function regularFile(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') fail(`release asset is missing: ${label}`)
    throw error
  }

  if (!stat.isFile()) fail(`release asset must be a regular file: ${label}`)
  return stat
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function listArchiveFiles(tarball) {
  let listing
  let verboseListing
  try {
    listing = execFileSync('tar', ['-tzf', tarball], {
      encoding: 'utf8',
      maxBuffer: MAX_TAR_LIST_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    verboseListing = execFileSync('tar', ['-tvzf', tarball], {
      encoding: 'utf8',
      maxBuffer: MAX_TAR_LIST_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    fail(`cannot read release archive: ${error.message}`)
  }

  const entries = listing.replace(/\r\n/g, '\n').split('\n').filter(Boolean)
  const details = verboseListing.replace(/\r\n/g, '\n').split('\n').filter(Boolean)
  if (entries.length === 0) fail('release archive is empty')
  if (details.length !== entries.length) fail('release archive member types could not be verified')

  for (const [index, entry] of entries.entries()) {
    const expectedType = entry.endsWith('/') ? 'd' : '-'
    if (details[index][0] !== expectedType) {
      fail(`release archive contains a non-regular entry: ${entry}`)
    }

    const normalized = entry.replace(/\/+$/, '')
    if (normalized !== 'package' && !normalized.startsWith('package/')) {
      fail(`release archive contains a path outside package/: ${entry}`)
    }

    const parts = normalized.split('/')
    if (parts.includes('.') || parts.includes('..')) {
      fail(`release archive contains an unsafe path: ${entry}`)
    }

    if (parts.slice(1).some((part) => /^(src|tests?|designs?|research|\.git|\.superpowers)$/i.test(part))
      || /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|AGENTS\.md|CLAUDE\.md|PLAN\.md|issues\.md|questions\.md)$/.test(normalized)) {
      fail(`release archive contains private source, tests, design material, credentials, or internal files: ${entry}`)
    }

    const isAllowedFile = isPublicPackageFile(normalized)
    const isAllowedDirectory = entry.endsWith('/') && (
      ALLOWED_DIRECTORIES.has(normalized)
      || normalized.startsWith('package/dist/')
      || normalized.startsWith('package/docs/ai-clients/')
    )
    if (!isAllowedFile && !isAllowedDirectory) {
      fail(`release archive contains a file outside the public distribution allowlist: ${entry}`)
    }
  }

  for (const requiredFile of REQUIRED_FILES) {
    const matches = entries.flatMap((entry, index) => (
      entry.replace(/\/+$/, '') === requiredFile ? [index] : []
    ))
    if (matches.length !== 1 || entries[matches[0]].endsWith('/') || details[matches[0]][0] !== '-') {
      fail(`release archive must contain exactly one required regular file: ${requiredFile}`)
    }
  }
  return entries
}

function isPublicPackageFile(path) {
  if (REQUIRED_FILES.includes(path)) return true
  const compiledFile = /^package\/dist\/(.+\.js)$/.exec(path)
  if (compiledFile) {
    const segments = compiledFile[1].split('/')
    const filename = segments.pop()
    const testDirectory = segments.some((segment) => /(?:^|[^a-z0-9])(?:tests?|specs?)(?:[^a-z0-9]|$)/i.test(segment))
    const testFilename = /(?:^|[._-])tests?(?=[._-]|$)/i.test(filename)
      || /(?:^|[._-])spec(?=[._-]|$)/i.test(filename)
    if (!testDirectory && !testFilename) return true
  }
  const aiClientGuide = /^package\/docs\/ai-clients\/([^/]+\.md)$/.exec(path)
  return aiClientGuide !== null && ALLOWED_AI_CLIENT_GUIDES.has(aiClientGuide[1])
}

function readPackageMetadata(tarball) {
  let contents
  try {
    contents = execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    fail(`cannot read package/package.json from release archive: ${error.message}`)
  }

  try {
    return JSON.parse(contents)
  } catch {
    fail('release package/package.json is invalid JSON')
  }
}

export async function verifyReleaseAssets(assetDirectory, tag) {
  if (typeof tag !== 'string' || !STABLE_SEMVER.test(tag)) {
    fail('release tag must be v<stable-semver>')
  }
  const expectedVersion = tag.slice(1)

  const directory = resolve(assetDirectory)
  let directoryEntries
  try {
    directoryEntries = readdirSync(directory)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      fail(`release asset directory is missing: ${directory}`)
    }
    throw error
  }

  const expectedAssets = [TARBALL_NAME, CHECKSUM_NAME]
  for (const name of expectedAssets) {
    if (!directoryEntries.includes(name)) fail(`release asset is missing: ${name}`)
  }
  for (const name of directoryEntries) {
    if (!expectedAssets.includes(name)) fail(`unexpected file in release asset directory: ${name}`)
  }

  const tarball = resolve(directory, TARBALL_NAME)
  const checksumPath = resolve(directory, CHECKSUM_NAME)
  const tarballStat = regularFile(tarball, TARBALL_NAME)
  regularFile(checksumPath, CHECKSUM_NAME)
  if (tarballStat.size > MAX_TARBALL_BYTES) {
    fail(`release archive exceeds the 100 MiB size limit: ${TARBALL_NAME}`)
  }

  const checksum = readFileSync(checksumPath, 'utf8')
  const checksumMatch = /^([a-f0-9]{64})  kooya-cli\.tgz\n?$/.exec(checksum)
  if (!checksumMatch) fail(`${CHECKSUM_NAME} must contain the SHA-256 for ${TARBALL_NAME}`)
  if ((await sha256File(tarball)) !== checksumMatch[1]) {
    fail(`SHA-256 checksum does not match ${TARBALL_NAME}`)
  }

  listArchiveFiles(tarball)
  const metadata = readPackageMetadata(tarball)
  if (metadata.name !== PACKAGE_NAME) {
    fail(`release package name must be ${PACKAGE_NAME}`)
  }
  if (metadata.private !== false) fail('release package must explicitly declare private: false')
  if (metadata.version !== expectedVersion) {
    fail(`package version ${metadata.version} does not match release tag ${tag}`)
  }
  if (metadata.engines?.node !== '>=22') fail('release package must require Node.js 22 or newer')
  if (metadata.bin?.kooyahq !== 'dist/bin/kooyahq.js' || metadata.bin?.['kooyahq-mcp'] !== 'dist/bin/kooyahq-mcp.js') {
    fail('release package must expose both KooyaHQ executables')
  }

  return { name: metadata.name, version: metadata.version }
}

async function runCli() {
  const [assetDirectory, tag, ...extraArgs] = process.argv.slice(2)
  if (!assetDirectory || !tag || extraArgs.length > 0) {
    fail('usage: node scripts/verify-release-assets.mjs <asset-directory> <v<semver>>')
  }

  const packageInfo = await verifyReleaseAssets(assetDirectory, tag)
  console.log(`Verified ${packageInfo.name}@${packageInfo.version} release assets for ${tag}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
