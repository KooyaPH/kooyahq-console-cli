import { posix, win32 } from "node:path";

export function buildArchiveExtractionArgs(
  archivePath,
  extractionDirectory,
  workingDirectory,
  platform = process.platform,
) {
  const pathApi = platform === "win32" ? win32 : posix;
  const archiveArgument = pathApi.relative(workingDirectory, archivePath);
  const extractionArgument = pathApi.relative(
    workingDirectory,
    extractionDirectory,
  );

  for (const argument of [archiveArgument, extractionArgument]) {
    if (
      pathApi.isAbsolute(argument) ||
      argument === ".." ||
      argument.startsWith(`..${pathApi.sep}`)
    ) {
      throw new Error(
        "archive and extraction paths must be under the same directory tree",
      );
    }
  }

  return ["-xzf", archiveArgument, "-C", extractionArgument];
}
