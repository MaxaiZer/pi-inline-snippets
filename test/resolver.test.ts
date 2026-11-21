import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnippetResolver, isValidSnippetName } from "../src/resolver.ts";

describe("SnippetResolver", () => {
  let root: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pi-inline-snippets-"));
    globalDir = path.join(root, "global");
    projectDir = path.join(root, "project", ".pi", "snippets");
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function resolver(logger?: (message: string, ...details: unknown[]) => void): SnippetResolver {
    return new SnippetResolver({ globalDir, projectDir }, logger);
  }

  it("resolves a global snippet", async () => {
    await writeFile(path.join(globalDir, "dotnet.md"), "global dotnet");
    await expect(resolver().resolve("dotnet")).resolves.toBe("global dotnet");
  });

  it("resolves a project snippet", async () => {
    await writeFile(path.join(projectDir, "testing.md"), "project testing");
    await expect(resolver().resolve("testing")).resolves.toBe("project testing");
  });

  it("lets a project snippet override a global snippet", async () => {
    await writeFile(path.join(globalDir, "strict.md"), "global strict");
    await writeFile(path.join(projectDir, "strict.md"), "project strict");
    await expect(resolver().resolve("strict")).resolves.toBe("project strict");
  });

  it("returns undefined for a missing snippet", async () => {
    await expect(resolver().resolve("missing")).resolves.toBeUndefined();
  });

  it("returns empty contents for an empty file", async () => {
    await writeFile(path.join(globalDir, "empty.md"), "");
    await expect(resolver().resolve("empty")).resolves.toBe("");
  });

  it("rejects invalid snippet names before touching the filesystem", async () => {
    await writeFile(path.join(root, "secret.md"), "secret");
    const instance = resolver();
    for (const name of ["../secret", "..", "foo/bar", "foo\\bar", ".hidden", "foo bar", ""]) {
      await expect(instance.resolve(name)).resolves.toBeUndefined();
    }
  });

  it("rejects path traversal attempts", async () => {
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside");
    await expect(resolver().resolve("../outside")).resolves.toBeUndefined();
    await expect(resolver().resolve(`..${path.sep}outside`)).resolves.toBeUndefined();
  });

  it("rejects a symlink that resolves outside the snippet directory", async () => {
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(globalDir, "linked.md"));
    const messages: string[] = [];
    await expect(resolver((message) => messages.push(message)).resolve("linked")).resolves.toBeUndefined();
    expect(messages.some((message) => message.includes("resolves outside"))).toBe(true);
  });

  it("returns undefined and logs when a snippet is unreadable", async () => {
    const file = path.join(globalDir, "unreadable.md");
    await writeFile(file, "secret");
    await chmod(file, 0o000);
    try {
      const messages: string[] = [];
      await expect(resolver((message) => messages.push(message)).resolve("unreadable")).resolves.toBeUndefined();
      expect(messages.some((message) => message.includes("Failed to read snippet"))).toBe(true);
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("does not fall back to a global snippet when a project file is unreadable", async () => {
    await writeFile(path.join(globalDir, "strict.md"), "global strict");
    const projectFile = path.join(projectDir, "strict.md");
    await writeFile(projectFile, "project strict");
    await chmod(projectFile, 0o000);
    try {
      await expect(resolver().resolve("strict")).resolves.toBeUndefined();
    } finally {
      await chmod(projectFile, 0o600);
    }
  });

  it("lists snippets from both directories with project overrides deduplicated", async () => {
    await writeFile(path.join(globalDir, "dotnet.md"), "");
    await writeFile(path.join(globalDir, "testing.md"), "");
    await writeFile(path.join(projectDir, "strict.md"), "");
    await writeFile(path.join(projectDir, "dotnet.md"), "");
    await writeFile(path.join(projectDir, "notes.txt"), "");
    await mkdir(path.join(projectDir, "folder.md"));

    await expect(resolver().list()).resolves.toEqual(["dotnet", "strict", "testing"]);
  });
});

describe("isValidSnippetName", () => {
  it("accepts letters, numbers, hyphens and underscores", () => {
    expect(isValidSnippetName("dotnet")).toBe(true);
    expect(isValidSnippetName("security-review_2")).toBe(true);
    expect(isValidSnippetName("ABC123")).toBe(true);
  });

  it("rejects names containing path or extension characters", () => {
    expect(isValidSnippetName("../x")).toBe(false);
    expect(isValidSnippetName("x/y")).toBe(false);
    expect(isValidSnippetName("x.y")).toBe(false);
    expect(isValidSnippetName("x y")).toBe(false);
    expect(isValidSnippetName("")).toBe(false);
  });
});
