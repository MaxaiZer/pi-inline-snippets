import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SnippetDirectories, SnippetLogger } from "./types.ts";

const MAX_SNIPPET_NAME_LENGTH = 200;
const SNIPPET_EXTENSION = ".md";

export function isValidSnippetName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_SNIPPET_NAME_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)
  );
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SnippetResolver {
  private readonly directories: SnippetDirectories;
  private readonly logger: SnippetLogger;

  constructor(directories: SnippetDirectories, logger?: SnippetLogger) {
    this.directories = directories;
    this.logger = logger ?? (() => {});
  }

  async resolve(name: string): Promise<string | undefined> {
    if (!isValidSnippetName(name)) {
      return undefined;
    }

    const fileName = `${name}${SNIPPET_EXTENSION}`;
    const searchDirectories = [this.directories.projectDir, this.directories.globalDir];

    for (const directory of searchDirectories) {
      const directoryPath = path.resolve(directory);
      const filePath = path.resolve(directoryPath, fileName);

      if (!isInsideDirectory(directoryPath, filePath)) {
        this.logger(`Rejected snippet path outside snippet directory: ${filePath}`);
        continue;
      }

      let fileStats;
      try {
        fileStats = await stat(filePath);
      } catch (error) {
        if (!isMissing(error)) {
          this.logger(`Failed to inspect snippet "${name}" at ${filePath}`, error);
        }
        continue;
      }

      if (!fileStats.isFile()) {
        this.logger(`Ignoring snippet "${name}" because ${filePath} is not a regular file`);
        continue;
      }

      try {
        const [realDirectory, realFile] = await Promise.all([
          realpath(directoryPath),
          realpath(filePath),
        ]);
        if (!isInsideDirectory(realDirectory, realFile)) {
          this.logger(`Rejected snippet "${name}" because ${filePath} resolves outside ${directoryPath}`);
          return undefined;
        }

        return await readFile(realFile, "utf8");
      } catch (error) {
        this.logger(`Failed to read snippet "${name}" from ${filePath}: ${errorMessage(error)}`, error);
        return undefined;
      }
    }

    return undefined;
  }

  async list(): Promise<string[]> {
    const names = new Set<string>();

    for (const directory of [this.directories.projectDir, this.directories.globalDir]) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!isMissing(error)) {
          this.logger(`Failed to list snippets in ${directory}`, error);
        }
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(SNIPPET_EXTENSION)) {
          continue;
        }
        const name = entry.name.slice(0, -SNIPPET_EXTENSION.length);
        if (isValidSnippetName(name)) {
          names.add(name);
        }
      }
    }

    return [...names].sort((left, right) => left.localeCompare(right));
  }
}
