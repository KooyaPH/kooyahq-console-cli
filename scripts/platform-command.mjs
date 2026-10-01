import assert from "node:assert/strict";
import { win32 } from "node:path";

export function buildCommandInvocation(
  command,
  args,
  platform = process.platform,
  runtimePath = process.execPath,
) {
  if (platform === "win32" && command === "npm") {
    const npmCli = win32.join(
      win32.dirname(runtimePath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    return {
      command: runtimePath,
      args: [npmCli, ...args],
      windowsVerbatimArguments: false,
    };
  }

  const windowsBatch =
    platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  if (!windowsBatch) {
    return { command, args, windowsVerbatimArguments: false };
  }

  const commandLine = [command, ...args]
    .map((value) => {
      assert.doesNotMatch(
        value,
        /["%\r\n\0]/u,
        "unsafe Windows command argument",
      );
      return `"${value}"`;
    })
    .join(" ");

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
