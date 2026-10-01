#!/usr/bin/env node

import { createReadStream, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGE_NAME = '@kooya/cli'
const TARBALL_NAME = 'kooya-cli.tgz'
const CHECKSUM_NAME = `${TARBALL_NAME}.sha256`
const MAX_TARBALL_BYTES = 512 * 1024 * 1024
const MAX_TAR_LIST_BYTES = 16 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

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
  try {
    listing = execFileSync('tar', ['-tzf', tarball], {
      encoding: 'utf8',
      maxBuffer: MAX_TAR_LIST_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    fail(`cannot read release archive: ${error.message}`)
  }

  const entries = listing.split('\n').filter(Boolean)
  if (entries.length === 0) fail('release archive is empty')

  for (const entry of entries) {
    const normalized = entry.replace(/\/+$/, '')
    if (normalized !== 'package' && !normalized.startsWith('package/')) {
      fail(`release archive contains a path outside package/: ${entry}`)
    }

    const parts = normalized.split('/')
    if (parts.includes('.') || parts.includes('..')) {
      fail(`release archive contains an unsafe path: ${entry}`)
    }

    if (parts.slice(1).some((part) => /^(src|tests?|design)$/i.test(part))) {
      fail('release archive contains source files (src, tests, or design paths are forbidden)')
    }
  }

  if (!entries.some((entry) => entry.replace(/\/+$/, '') === 'package/package.json')) {
    fail('release archive is missing package/package.json')
  }
  return entries
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
  if (typeof tag !== 'string' || !tag.startsWith('v') || !SEMVER.test(tag.slice(1))) {
    fail('release tag must be v<semver>')
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
    fail(`release archive exceeds the 512 MiB size limit: ${TARBALL_NAME}`)
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
  if (metadata.private === true) fail('release package must not be private')
  if (metadata.version !== expectedVersion) {
    fail(`package version ${metadata.version} does not match release tag ${tag}`)
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
