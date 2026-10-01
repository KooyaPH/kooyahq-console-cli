import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommandInvocation } from "../scripts/platform-command.mjs";

test("runs Windows CLI command shims through cmd.exe", () => {
  const cli = buildCommandInvocation(
    "C:\\Program Files\\Kooya\\kooyahq.cmd",
    ["--version"],
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
});

test("runs Windows npm through the npm CLI next to the Node executable", () => {
  const npm = buildCommandInvocation(
    "npm",
    ["install", "--global", "kooya-cli.tgz"],
    "win32",
    "C:\\Program Files\\nodejs\\node.exe",
  );

  assert.deepEqual(npm, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: [
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "install",
      "--global",
      "kooya-cli.tgz",
    ],
    windowsVerbatimArguments: false,
  });
});

test("runs Unix npm commands directly without changing their arguments", () => {
  const command = buildCommandInvocation(
    "npm",
    ["install", "--global", "kooya-cli.tgz"],
    "linux",
  );

  assert.equal(command.command, "npm");
  assert.deepEqual(command.args, ["install", "--global", "kooya-cli.tgz"]);
  assert.equal(command.windowsVerbatimArguments, false);
});

test("rejects unsafe Windows command arguments before quoting them", () => {
  assert.throws(
    () => buildCommandInvocation("kooyahq.cmd", ["%PATH%"], "win32"),
    /unsafe Windows command argument/,
  );
});
