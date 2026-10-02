import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArchiveExtractionArgs } from "../scripts/archive-extraction.mjs";

test("uses relative archive paths on Windows to avoid tar treating C: as a host", () => {
  const root = String.raw`C:\Users\runner\AppData\Local\Temp\kooyahq-public-smoke-test`;

  assert.deepEqual(
    buildArchiveExtractionArgs(
      `${root}\\kooya-cli.tgz`,
      `${root}\\unpacked`,
      root,
      "win32",
    ),
    ["-xzf", "kooya-cli.tgz", "-C", "unpacked"],
  );
});

test("uses relative archive paths on POSIX", () => {
  assert.deepEqual(
    buildArchiveExtractionArgs(
      "/tmp/kooyahq-public-smoke-test/kooya-cli.tgz",
      "/tmp/kooyahq-public-smoke-test/unpacked",
      "/tmp/kooyahq-public-smoke-test",
      "linux",
    ),
    ["-xzf", "kooya-cli.tgz", "-C", "unpacked"],
  );
});

test("rejects archive paths on another Windows drive", () => {
  assert.throws(
    () =>
      buildArchiveExtractionArgs(
        String.raw`D:\kooya-cli.tgz`,
        String.raw`C:\temp\unpacked`,
        String.raw`C:\temp`,
        "win32",
      ),
    /same directory tree/,
  );
});
