import assert from "node:assert/strict";

export function buildCommandInvocation(
  command,
  args,
  platform = process.platform,
) {
  const windowsBatch =
    platform === "win32" &&
    (command === "npm" || /\.(?:cmd|bat)$/i.test(command));
  if (!windowsBatch) {
    return { command, args, windowsVerbatimArguments: false };
  }

  const executable = command === "npm" ? "npm.cmd" : command;
  const commandLine = [executable, ...args]
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
