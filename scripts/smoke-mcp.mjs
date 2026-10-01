import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const serverPath = process.argv[2];
assert.ok(serverPath, "pass the installed MCP server JavaScript file");

const child = spawn(process.execPath, [resolve(serverPath)], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout });

try {
  await new Promise((resolveHandshake, rejectHandshake) => {
    let stage = 0;
    let settled = false;
    const timeout = setTimeout(
      () => fail(new Error("MCP smoke test timed out.")),
      10_000,
    );

    child.once("error", fail);
    child.once("exit", (status) => {
      if (stage !== 2 || status !== 0) {
        fail(
          new Error(`MCP smoke server exited early (${status ?? "signal"}).`),
        );
      }
    });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (stage === 0) {
          assert.equal(message.id, 1);
          assert.equal(message.result.protocolVersion, "2025-06-18");
          stage = 1;
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
          );
          return;
        }
        assert.equal(message.id, 2);
        assert.deepEqual(
          message.result.tools.map((tool) => tool.name),
          ["kooyahq_status", "kooyahq_discover", "kooyahq_call"],
        );
        stage = 2;
        lines.close();
        child.stdin.end();
      } catch (error) {
        fail(error);
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      })}\n`,
    );

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      rejectHandshake(error);
    }

    child.once("exit", (status) => {
      if (settled) return;
      if (stage === 2 && status === 0) {
        settled = true;
        clearTimeout(timeout);
        resolveHandshake();
      } else {
        fail(
          new Error(`MCP smoke server exited early (${status ?? "signal"}).`),
        );
      }
    });
  });

  process.stdout.write("MCP initialize and tools/list handshake passed.\n");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
