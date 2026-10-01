import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommandInvocation } from "../scripts/platform-command.mjs";

test("runs Windows npm and CLI command shims through cmd.exe", () => {
  const cli = buildCommandInvocation(
    "C:\\Program Files\\Kooya\\kooyahq.cmd",
    ["--version"],
    "win32",
  );
  const npm = buildCommandInvocation(
    "npm",
    ["install", "--global", "kooya-cli.tgz"],
    "win32",
  );

  assert.equal(cli.command, "cmd.exe");
  assert.deepEqual(cli.args, [
    "/d",
    "/s",
    "/v:off",
    "/c",
    '""C:\\Program Files\\Kooya\\kooyahq.cmd" "--version""',
  ]);
  assert.equal(cli.windowsVerbatimArguments, true);
  assert.equal(npm.command, "cmd.exe");
  assert.match(npm.args[4], /"npm\.cmd" "install"/);
});

test("runs Unix commands directly without changing their arguments", () => {
  const command = buildCommandInvocation(
    "/usr/local/bin/kooyahq",
    ["--version"],
    "linux",
  );

  assert.equal(command.command, "/usr/local/bin/kooyahq");
  assert.deepEqual(command.args, ["--version"]);
  assert.equal(command.windowsVerbatimArguments, false);
});

test("rejects unsafe Windows command arguments before quoting them", () => {
  assert.throws(
    () => buildCommandInvocation("kooyahq.cmd", ["%PATH%"], "win32"),
    /unsafe Windows command argument/,
  );
});
