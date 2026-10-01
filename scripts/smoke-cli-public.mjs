import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommandInvocation } from "./platform-command.mjs";

const version = process.argv[2];
assert.match(
  version ?? "",
  /^\d+\.\d+\.\d+$/,
  "pass the stable release version",
);

const repository = "KooyaPH/kooyahq-console-cli";
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`;
const release = await waitForPublicRelease(releaseApi, `v${version}`);
assert.equal(release.tag_name, `v${version}`);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);
const matchingAssets = release.assets.filter(
  (asset) => asset.name === "kooya-cli.tgz",
);
assert.equal(
  matchingAssets.length,
  1,
  "release must have exactly one CLI tarball",
);
const assetUrl = `https://github.com/${repository}/releases/download/v${version}/kooya-cli.tgz`;
assert.equal(matchingAssets[0].browser_download_url, assetUrl);
assert.match(matchingAssets[0].digest ?? "", /^sha256:[a-f0-9]{64}$/i);

const temp = mkdtempSync(join(tmpdir(), "kooyahq-public-smoke-"));
const prefix = join(temp, "global");
const profileHome = join(temp, "profile");
const packageCache = join(temp, "npm-cache");
mkdirSync(profileHome, { recursive: true });
const userConfig = join(temp, "empty.npmrc");
writeFileSync(userConfig, "");
const env = { ...process.env, HOME: profileHome, USERPROFILE: profileHome };
for (const key of Object.keys(env)) {
  if (
    /^KOOYAHQ_|^npm_config_|^NODE_AUTH_TOKEN$|^NPM_TOKEN$|^GH_TOKEN$|^GITHUB_TOKEN$/i.test(
      key,
    )
  )
    delete env[key];
}
Object.assign(env, {
  npm_config_cache: packageCache,
  npm_config_prefix: prefix,
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_userconfig: userConfig,
});

function run(command, args, options = {}) {
  const invocation = buildCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? temp,
    env,
    encoding: "utf8",
    timeout: 180_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args[0]} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function npm(args, options) {
  return run("npm", args, options);
}

function cliPath(name) {
  return join(
    prefix,
    process.platform === "win32" ? `${name}.cmd` : "bin",
    ...(process.platform === "win32" ? [] : [name]),
  );
}

try {
  const packageUrl = `https://github.com/${repository}/releases/latest/download/kooya-cli.tgz`;
  npm(["install", "--global", packageUrl]);
  const globalRoot = npm(["root", "--global"]);
  const installedPackage = join(globalRoot, "@kooya", "cli");
  assert.equal(run(cliPath("kooyahq"), ["--version"]), version);
  assert.equal(run(cliPath("kooyahq-mcp"), ["--version"]), version);
  assert.match(run(cliPath("kooyahq"), ["update", "--check"]), /current/i);
  assert.match(run(cliPath("kooyahq"), ["update"]), /current/i);

  const mcpHandshake = fileURLToPath(
    new URL("./smoke-mcp.mjs", import.meta.url),
  );
  const mcpServer = join(installedPackage, "dist", "bin", "kooyahq-mcp.js");
  run(process.execPath, [mcpHandshake, mcpServer]);

  const assetResponse = await fetch(assetUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(
    assetResponse.status,
    200,
    "public release tarball must download without authentication",
  );
  const assetBytes = await readBoundedBody(assetResponse, 100 * 1024 * 1024);
  assert.ok(assetBytes.length > 0, "public release tarball must not be empty");
  assert.equal(
    createHash("sha256").update(assetBytes).digest("hex"),
    matchingAssets[0].digest.slice("sha256:".length).toLowerCase(),
    "public asset digest must match GitHub release metadata",
  );
  const archive = join(temp, "kooya-cli.tgz");
  writeFileSync(archive, assetBytes);

  const unpacked = join(temp, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", archive, "-C", unpacked]);
  const fixtureRoot = join(unpacked, "package");
  const metadataPath = join(fixtureRoot, "package.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.name, "@kooya/cli");
  assert.equal(metadata.version, version);
  // This is the first public release; exercise the older-version update path with a local fixture.
  metadata.version = "0.4.1";
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const fixturePack = JSON.parse(
    npm(["pack", "--json", "--pack-destination", temp], { cwd: fixtureRoot }),
  );
  assert.equal(fixturePack.length, 1);
  npm(["uninstall", "--global", "@kooya/cli"]);
  npm(["install", "--global", join(temp, fixturePack[0].filename)]);
  assert.equal(run(cliPath("kooyahq"), ["--version"]), "0.4.1");

  const configDirectory = join(profileHome, ".kooyahq");
  mkdirSync(configDirectory);
  const configPath = join(configDirectory, "config.json");
  const profile =
    '{"apiKey":"synthetic-smoke-value","organizationId":"test-organization"}\n';
  writeFileSync(configPath, profile);
  assert.match(
    run(cliPath("kooyahq"), ["update", "--check"]),
    new RegExp(
      `0\\.4\\.1.*${version.replaceAll(".", "\\.")}|${version.replaceAll(".", "\\.")}.*0\\.4\\.1`,
      "s",
    ),
  );
  assert.match(
    run(cliPath("kooyahq"), ["update"]),
    new RegExp(
      `Updated KooyaHQ CLI from 0\\.4\\.1 to ${version.replaceAll(".", "\\.")}`,
    ),
  );
  assert.equal(run(cliPath("kooyahq"), ["--version"]), version);
  assert.equal(readFileSync(configPath, "utf8"), profile);
  run(process.execPath, [mcpHandshake, mcpServer]);
  process.stdout.write(
    `Unauthenticated GitHub install, verified update, profile preservation, and MCP handshake passed on ${process.platform}.\n`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

async function readBoundedBody(response, maximumBytes) {
  if (!response.body)
    throw new Error("The public release tarball has no response body.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error(
          "The public release tarball exceeds the supported package size.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function waitForPublicRelease(apiUrl, expectedTag) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await fetch(apiUrl, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const release = await response.json();
        if (
          release.tag_name === expectedTag &&
          release.draft === false &&
          release.prerelease === false
        )
          return release;
      }
    } catch {
      // The public tag and release workflow can take a short time to converge.
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(
    `Public GitHub release ${expectedTag} did not become available without authentication.`,
  );
}
