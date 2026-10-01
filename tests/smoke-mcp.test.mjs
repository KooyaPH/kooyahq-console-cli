import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const smokeScript = fileURLToPath(
  new URL("../scripts/smoke-mcp.mjs", import.meta.url),
);

function runFixture({
  tools = ["kooyahq_status", "kooyahq_discover", "kooyahq_call"],
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kooyahq-mcp-smoke-test-"));
  const serverPath = join(directory, "server.mjs");
  const toolNames = JSON.stringify(tools);
  writeFileSync(
    serverPath,
    `
    import { createInterface } from 'node:readline'
    const lines = createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }) + '\\n')
      }
      if (message.method === 'tools/list') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: ${toolNames}.map((name) => ({ name })) } }) + '\\n')
        lines.close()
      }
    })
  `,
  );

  try {
    return spawnSync(process.execPath, [smokeScript, serverPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("MCP smoke accepts the expected initialization and KooyaHQ tools", () => {
  const result = runFixture();

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("MCP smoke rejects a server that exposes the wrong tools", () => {
  const result = runFixture({ tools: ["unexpected_tool"] });

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
});
