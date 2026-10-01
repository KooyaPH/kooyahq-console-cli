import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommandInvocation } from "./platform-command.mjs";

const [archive, expectedVersion] = process.argv.slice(2);
assert.ok(archive && expectedVersion, "pass the candidate tarball and version");
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);

const temp = mkdtempSync(join(tmpdir(), "kooyahq-candidate-smoke-"));
const prefix = join(temp, "global");
const profileHome = join(temp, "profile");
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
  npm_config_cache: join(temp, "npm-cache"),
  npm_config_prefix: prefix,
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_userconfig: userConfig,
});

function run(command, args) {
  const invocation = buildCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: temp,
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

function cliPath(name) {
  return join(
    prefix,
    process.platform === "win32" ? `${name}.cmd` : "bin",
    ...(process.platform === "win32" ? [] : [name]),
  );
}

try {
  run("npm", ["install", "--global", archive]);
  assert.equal(run(cliPath("kooyahq"), ["--version"]), expectedVersion);
  assert.equal(run(cliPath("kooyahq-mcp"), ["--version"]), expectedVersion);

  const installedPackage = join(
    run("npm", ["root", "--global"]),
    "@kooya",
    "cli",
  );
  const handshake = fileURLToPath(new URL("./smoke-mcp.mjs", import.meta.url));
  run(process.execPath, [
    handshake,
    join(installedPackage, "dist", "bin", "kooyahq-mcp.js"),
  ]);
  process.stdout.write(
    `Packed CLI install and MCP handshake passed on ${process.platform}.\n`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
