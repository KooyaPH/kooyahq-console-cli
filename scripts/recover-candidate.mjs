#!/usr/bin/env node

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { verifyReleaseAssets } from './verify-release-assets.mjs'
import { verifyCandidateRef } from './verify-candidate-branch.mjs'

const ASSETS = ['release-assets/kooya-cli.tgz', 'release-assets/kooya-cli.tgz.sha256']
const ALLOWED_REMOTE = /^(?:git@github\.com:KooyaPH\/kooyahq-console-cli\.git|https:\/\/github\.com\/KooyaPH\/kooyahq-console-cli(?:\.git)?|ssh:\/\/git@github\.com\/KooyaPH\/kooyahq-console-cli\.git)$/i

function fail(message) {
  throw new Error(message)
}

function git(args, cwd, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: options.encoding,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = error.stderr?.toString().trim()
    fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
}

function gitText(args, cwd) {
  return git(args, cwd, { encoding: 'utf8' }).trimEnd()
}

function remoteSha(cwd, ref) {
  const line = gitText(['ls-remote', 'origin', ref], cwd)
  return line ? line.split(/\s+/)[0] : null
}

function changedAssetsOnly(cwd, commit) {
  const base = gitText(['merge-base', 'origin/main', commit], cwd)
  const changed = gitText(['diff', '--name-status', '--no-renames', base, commit], cwd)
  const actual = changed ? changed.split('\n').sort() : []
  const expected = ASSETS.map((path) => `A\t${path}`).sort()
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    fail('existing candidate differs from the asset-only release handoff; refusing to replace it')
  }
}

async function verifyExistingCandidate({ cwd, tag, sourceSha, assetDirectory, commit }) {
  verifyCandidateRef(tag, commit, { cwd })
  changedAssetsOnly(cwd, commit)

  const message = gitText(['show', '-s', '--format=%B', commit], cwd)
  const expectedSource = `Source commit: ${sourceSha}`
  if (!message.split('\n').includes(expectedSource)) {
    fail('existing candidate records a different source commit; refusing to replace it')
  }

  for (const name of ['kooya-cli.tgz', 'kooya-cli.tgz.sha256']) {
    const fromRemote = git(['show', `${commit}:release-assets/${name}`], cwd)
    const fromInput = readFileSync(join(assetDirectory, name))
    if (!fromRemote.equals(fromInput)) {
      fail(`existing candidate contains different ${name}; refusing to replace it`)
    }
  }
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--version', '--source-sha', '--assets'].includes(key) || values.has(key)) {
      fail('usage: node scripts/recover-candidate.mjs --version <semver> --source-sha <full-sha> --assets <audited-assets-dir>')
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      fail(`missing value for ${key}`)
    }
    values.set(key, value)
    index += 1
  }

  if (values.size !== 3) {
    fail('usage: node scripts/recover-candidate.mjs --version <semver> --source-sha <full-sha> --assets <audited-assets-dir>')
  }
  const version = values.get('--version')
  const sourceSha = values.get('--source-sha')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) fail('version must be stable semver without a v prefix')
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('source SHA must be a full lowercase Git SHA')
  return { tag: `v${version}`, sourceSha, assetDirectory: resolve(values.get('--assets')) }
}

export async function recoverCandidate({
  tag,
  sourceSha,
  assetDirectory,
  remoteUrl,
  verifyAssets = verifyReleaseAssets,
  tempDirectory = tmpdir(),
}) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) fail('tag must be v<stable-semver>')
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) fail('source SHA must be a full lowercase Git SHA')
  if (!remoteUrl) fail('public release repository remote URL is required')

  await verifyAssets(assetDirectory, tag)
  const workspace = mkdtempSync(join(tempDirectory, 'kooya-cli-candidate-recovery-'))
  try {
    const clone = join(workspace, 'repo')
    git(['clone', '--no-checkout', remoteUrl, clone])
    git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], clone)

    const branch = `candidate/${tag}`
    const tagRef = `refs/tags/${tag}`
    const branchRef = `refs/heads/${branch}`
    if (remoteSha(clone, tagRef)) {
      fail(`stable tag ${tag} already exists; recovery will not create or mutate a stable release`)
    }

    const existingSha = remoteSha(clone, branchRef)
    if (existingSha) {
      git(['fetch', '--no-tags', 'origin', `${branchRef}:refs/remotes/origin/${branch}`], clone)
      await verifyExistingCandidate({
        cwd: clone,
        tag,
        sourceSha,
        assetDirectory,
        commit: existingSha,
      })
      return { status: 'already-present', branch, commit: existingSha }
    }

    git(['switch', '--detach', 'refs/remotes/origin/main'], clone)
    git(['switch', '-c', branch], clone)
    const assetPath = join(clone, 'release-assets')
    mkdirSync(assetPath, { recursive: true })
    copyFileSync(join(assetDirectory, 'kooya-cli.tgz'), join(assetPath, 'kooya-cli.tgz'))
    copyFileSync(join(assetDirectory, 'kooya-cli.tgz.sha256'), join(assetPath, 'kooya-cli.tgz.sha256'))
    await verifyAssets(assetPath, tag)

    git(['add', '--', ...ASSETS], clone)
    git(['config', 'user.name', 'KooyaHQ CLI Release Recovery'], clone)
    git(['config', 'user.email', 'cli-release-recovery@users.noreply.github.com'], clone)
    git(['commit', '-m', `release: KooyaHQ CLI ${tag} candidate`, '-m', `Source commit: ${sourceSha}`], clone)
    const commit = gitText(['rev-parse', 'HEAD'], clone)
    changedAssetsOnly(clone, commit)

    if (remoteSha(clone, tagRef)) {
      fail(`stable tag ${tag} appeared during recovery; refusing to push candidate assets`)
    }
    if (remoteSha(clone, branchRef)) {
      fail(`${branchRef} appeared during recovery; fetch and review it before retrying`)
    }

    try {
      git(['push', 'origin', `HEAD:${branchRef}`], clone)
    } catch (error) {
      const racedCommit = remoteSha(clone, branchRef)
      if (!racedCommit) throw error
      git(['fetch', '--no-tags', 'origin', `${branchRef}:refs/remotes/origin/${branch}`], clone)
      await verifyExistingCandidate({
        cwd: clone,
        tag,
        sourceSha,
        assetDirectory,
        commit: racedCommit,
      })
      return { status: 'already-present', branch, commit: racedCommit }
    }

    const pushedCommit = remoteSha(clone, branchRef)
    if (pushedCommit !== commit) fail(`candidate push resolved to ${pushedCommit ?? 'no remote ref'}, expected ${commit}`)
    await verifyExistingCandidate({ cwd: clone, tag, sourceSha, assetDirectory, commit: pushedCommit })
    return { status: 'created', branch, commit: pushedCommit }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function runCli() {
  const { tag, sourceSha, assetDirectory } = parseArguments(process.argv.slice(2))
  const remoteUrl = gitText(['remote', 'get-url', 'origin'], process.cwd())
  if (!ALLOWED_REMOTE.test(remoteUrl)) {
    fail('origin must be KooyaPH/kooyahq-console-cli; refusing to push to another repository')
  }

  const result = await recoverCandidate({ tag, sourceSha, assetDirectory, remoteUrl })
  if (result.status === 'created') {
    console.log(`Pushed ${result.branch} (${result.commit}); the public candidate workflow must pass before release publication`)
  } else {
    console.log(`${result.branch} already contains this exact audited archive and source commit (${result.commit}); no branch was changed`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
