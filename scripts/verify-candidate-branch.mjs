#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const EXPECTED_CHANGES = [
  'A\trelease-assets/kooya-cli.tgz',
  'A\trelease-assets/kooya-cli.tgz.sha256',
]

function fail(message) {
  throw new Error(message)
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd()
  } catch (error) {
    const detail = error.stderr?.toString().trim()
    fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
}

export function verifyCandidateRef(tag, commit, { cwd = process.cwd() } = {}) {
  if (!STABLE_TAG.test(tag ?? '')) fail('candidate version must be v<stable-semver>')
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) fail('candidate commit must be a full lowercase Git SHA')

  const branch = `candidate/${tag}`
  const ref = `refs/heads/${branch}`
  const remoteLine = git(['ls-remote', 'origin', ref], cwd)
  const remoteHead = remoteLine.split(/\s+/)[0]
  if (remoteHead !== commit) {
    fail(`${ref} moved or does not point to the audited candidate commit ${commit}`)
  }

  git(['fetch', '--no-tags', 'origin', 'main'], cwd)
  git(['cat-file', '-e', `${commit}^{commit}`], cwd)
  const base = git(['merge-base', 'origin/main', commit], cwd)
  const changed = git(['diff', '--name-status', '--no-renames', base, commit], cwd)
  const actualChanges = changed ? changed.split('\n').sort() : []
  const expectedChanges = [...EXPECTED_CHANGES].sort()
  if (actualChanges.length !== expectedChanges.length
    || actualChanges.some((change, index) => change !== expectedChanges[index])) {
    fail('candidate branch must add exactly kooya-cli.tgz and kooya-cli.tgz.sha256 relative to main')
  }

  return { branch, commit, base }
}

async function runCli() {
  const [tag, commit, ...extraArgs] = process.argv.slice(2)
  if (!tag || !commit || extraArgs.length > 0) {
    fail('usage: node scripts/verify-candidate-branch.mjs <v<semver>> <full-commit-sha>')
  }
  const result = verifyCandidateRef(tag, commit)
  console.log(`Verified ${result.branch} still points to ${result.commit}; only the two release assets changed`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
