import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { recoverCandidate } from '../scripts/recover-candidate.mjs'
import { verifyCandidateRef } from '../scripts/verify-candidate-branch.mjs'
import { verifyReleaseAssets } from '../scripts/verify-release-assets.mjs'

const WORKFLOW = new URL('../.github/workflows/release.yml', import.meta.url)

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
}

function releaseFixture(root, version = '0.7.0', marker = 'candidate payload') {
  const packageRoot = join(root, 'package')
  const assetDirectory = join(root, 'assets')
  mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true })
  mkdirSync(join(packageRoot, 'docs'), { recursive: true })
  mkdirSync(join(packageRoot, 'skills', 'kooyahq-cli'), { recursive: true })
  mkdirSync(assetDirectory, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@kooya/cli',
    version,
    private: false,
    engines: { node: '>=22' },
    bin: { kooyahq: 'dist/bin/kooyahq.js', 'kooyahq-mcp': 'dist/bin/kooyahq-mcp.js' },
  }))
  writeFileSync(join(packageRoot, 'README.md'), '# KooyaHQ CLI\n')
  writeFileSync(join(packageRoot, 'docs', 'installation.md'), '# Install\n')
  writeFileSync(join(packageRoot, 'docs', 'codex-mcp.md'), '# MCP\n')
  writeFileSync(join(packageRoot, 'docs', 'scenarios.md'), '# Scenarios\n')
  mkdirSync(join(packageRoot, 'docs', 'ai-clients'), { recursive: true })
  writeFileSync(join(packageRoot, 'docs', 'ai-clients', 'claude.md'), '# Claude\n')
  writeFileSync(join(packageRoot, 'skills', 'kooyahq-cli', 'SKILL.md'), '# Skill\n')
  writeFileSync(join(packageRoot, 'skills', 'kooyahq-cli', 'VERSION'), '1\n')
  writeFileSync(join(packageRoot, 'dist', 'bin', 'kooyahq.js'), `#!/usr/bin/env node\n${marker}\n`)
  writeFileSync(join(packageRoot, 'dist', 'bin', 'kooyahq-mcp.js'), '#!/usr/bin/env node\n')
  const tarball = join(assetDirectory, 'kooya-cli.tgz')
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package'])
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  writeFileSync(join(assetDirectory, 'kooya-cli.tgz.sha256'), `${digest}  kooya-cli.tgz\n`)
  return assetDirectory
}

function bareRemote(root) {
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  mkdirSync(seed, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: seed, stdio: 'ignore' })
  git(['config', 'user.name', 'Release fixture'], seed)
  git(['config', 'user.email', 'release-fixture@example.invalid'], seed)
  writeFileSync(join(seed, 'README.md'), 'Public release assets repository fixture\n')
  git(['add', 'README.md'], seed)
  git(['commit', '-m', 'seed main'], seed)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', 'origin', 'main'], seed)
  return remote
}

function workflowJob(workflow, name) {
  const jobsStart = workflow.indexOf('\njobs:\n')
  assert.notEqual(jobsStart, -1)
  const start = workflow.indexOf(`\n  ${name}:\n`, jobsStart)
  assert.notEqual(start, -1, `missing job ${name}`)
  const bodyStart = workflow.indexOf('\n', start + 1) + 1
  const nextJob = workflow.slice(bodyStart).search(/^  [a-z][a-z0-9-]*:\s*$/m)
  return workflow.slice(start, nextJob === -1 ? undefined : bodyStart + nextJob)
}

test('artifact-quota recovery pushes only audited assets and still requires the public release gates', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kooya-cli-quota-recovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assetDirectory = releaseFixture(root)
  const remoteUrl = bareRemote(root)
  const sourceSha = 'a'.repeat(40)

  // The Actions artifact endpoint is deliberately unavailable in this simulation.
  // Recovery uses only the already audited local package and checksum.
  let artifactUploadAttempts = 0
  const unavailableArtifactUpload = () => {
    artifactUploadAttempts += 1
    throw new Error('Actions artifact storage quota exceeded')
  }
  assert.throws(unavailableArtifactUpload, /quota exceeded/)
  artifactUploadAttempts = 0

  const first = await recoverCandidate({
    tag: 'v0.7.0',
    sourceSha,
    assetDirectory,
    remoteUrl,
  })
  assert.equal(first.status, 'created')
  assert.equal(artifactUploadAttempts, 0)

  const checkout = join(root, 'candidate-checkout')
  git(['clone', '--no-checkout', remoteUrl, checkout])
  git(['fetch', 'origin', 'refs/heads/candidate/v0.7.0:refs/remotes/origin/candidate/v0.7.0'], checkout)
  const candidateSha = git(['rev-parse', 'refs/remotes/origin/candidate/v0.7.0'], checkout)
  assert.equal(candidateSha, first.commit)
  assert.deepEqual(
    git(['diff', '--name-status', 'origin/main...refs/remotes/origin/candidate/v0.7.0'], checkout).split('\n').sort(),
    ['A\trelease-assets/kooya-cli.tgz', 'A\trelease-assets/kooya-cli.tgz.sha256'],
  )
  assert.equal(verifyCandidateRef('v0.7.0', candidateSha, { cwd: checkout }).branch, 'candidate/v0.7.0')

  const workflow = readFileSync(WORKFLOW, 'utf8')
  assert.doesNotMatch(workflow, /upload-artifact/)
  const validate = workflowJob(workflow, 'validate')
  const smoke = workflowJob(workflow, 'candidate-smoke')
  const publish = workflowJob(workflow, 'publish')
  const publicSmoke = workflowJob(workflow, 'public-smoke')
  for (const unprivilegedJob of [validate, smoke, publicSmoke]) {
    assert.doesNotMatch(unprivilegedJob, /contents:\s*write|GH_TOKEN|secrets\./)
  }
  assert.match(publish, /needs:\s*\[validate, candidate-smoke\]/)
  assert.match(publish, /permissions:\s*\n\s+contents:\s*write/)
  assert.match(publish, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/)
  assert.match(publish, /verify-candidate-branch\.mjs/)
  assert.doesNotMatch(publish, /gh release upload/)
  assert.match(publish, /cmp --silent release-assets\/kooya-cli\.tgz/)
  assert.match(publish, /cmp --silent release-assets\/kooya-cli\.tgz\.sha256/)
})

test('recovery is idempotent for the same source commit and rejects conflicting candidate assets', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kooya-cli-quota-idempotency-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assetDirectory = releaseFixture(root)
  const remoteUrl = bareRemote(root)
  const sourceSha = 'b'.repeat(40)

  const first = await recoverCandidate({ tag: 'v0.7.0', sourceSha, assetDirectory, remoteUrl })
  const retry = await recoverCandidate({ tag: 'v0.7.0', sourceSha, assetDirectory, remoteUrl })
  assert.equal(first.status, 'created')
  assert.deepEqual(retry, { ...first, status: 'already-present' })

  const differentAssets = releaseFixture(root, '0.7.0', 'different audited package')
  await assert.rejects(
    recoverCandidate({ tag: 'v0.7.0', sourceSha, assetDirectory: differentAssets, remoteUrl }),
    /different kooya-cli\.tgz|different kooya-cli\.tgz\.sha256|different source commit/,
  )
  await assert.rejects(
    recoverCandidate({ tag: 'v0.7.0', sourceSha: 'c'.repeat(40), assetDirectory, remoteUrl }),
    /different source commit/,
  )
})

test('recovery refuses to push when a stable release tag already exists', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kooya-cli-quota-stable-tag-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assetDirectory = releaseFixture(root)
  const remoteUrl = bareRemote(root)
  const seed = join(root, 'seed')
  git(['tag', 'v0.7.0'], seed)
  git(['push', 'origin', 'refs/tags/v0.7.0'], seed)

  await assert.rejects(
    recoverCandidate({ tag: 'v0.7.0', sourceSha: 'd'.repeat(40), assetDirectory, remoteUrl }),
    /stable tag v0\.7\.0 already exists/,
  )
  assert.equal(git(['ls-remote', '--heads', 'origin', 'refs/heads/candidate/v0.7.0'], seed), '')
})
