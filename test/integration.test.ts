import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import inlineSnippetsExtension, { transformUserInput } from "../src/index.ts";

type InputHandler = (event: InputEvent, ctx: { cwd: string }) => Promise<InputEventResult>;
type SessionStartHandler = (
  event: unknown,
  ctx: {
    cwd: string;
    ui: { addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): void };
  },
) => void;

function fakePi(): { pi: ExtensionAPI; input: () => InputHandler; sessionStart: () => SessionStartHandler } {
  let inputHandler: InputHandler | undefined;
  let sessionStartHandler: SessionStartHandler | undefined;
  const pi = {
    on(event: string, handler: InputHandler | SessionStartHandler) {
      if (event === "input") {
        inputHandler = handler as InputHandler;
      } else if (event === "session_start") {
        sessionStartHandler = handler as SessionStartHandler;
      }
      return () => {};
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    input: () => {
      if (!inputHandler) throw new Error("input handler not registered");
      return inputHandler;
    },
    sessionStart: () => {
      if (!sessionStartHandler) throw new Error("session_start handler not registered");
      return sessionStartHandler;
    },
  };
}

describe("Pi input integration", () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pi-inline-snippets-int-"));
    projectDir = path.join(root, ".pi", "snippets");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "dotnet.md"), "DOTNET CONTENT");
    await writeFile(path.join(projectDir, "testing.md"), "TESTING CONTENT");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("transforms an RPC prompt containing snippets", async () => {
    const { pi, input } = fakePi();
    inlineSnippetsExtension(pi);

    const result = await input()(
      { type: "input", text: "Check #dotnet and #testing", source: "rpc" },
      { cwd: root },
    );

    expect(result).toEqual({
      action: "transform",
      text: "Check DOTNET CONTENT and TESTING CONTENT",
    });
  });

  it("transforms an interactive prompt containing snippets", async () => {
    const { pi, input } = fakePi();
    inlineSnippetsExtension(pi);

    const result = await input()(
      { type: "input", text: "#dotnet", source: "interactive" },
      { cwd: root },
    );

    expect(result).toEqual({ action: "transform", text: "DOTNET CONTENT" });
  });

  it("continues when no snippets are present", async () => {
    const { pi, input } = fakePi();
    inlineSnippetsExtension(pi);

    const result = await input()(
      { type: "input", text: "Just a normal message", source: "rpc" },
      { cwd: root },
    );

    expect(result).toEqual({ action: "continue" });
  });

  it("continues when all references are unknown", async () => {
    const { pi, input } = fakePi();
    inlineSnippetsExtension(pi);

    const result = await input()(
      { type: "input", text: "Try #missing", source: "rpc" },
      { cwd: root },
    );

    expect(result).toEqual({ action: "continue" });
  });

  it("preserves attached images", async () => {
    const { pi, input } = fakePi();
    inlineSnippetsExtension(pi);
    const images = [{ type: "image" as const, data: "abc", mimeType: "image/png" }];

    const result = await input()(
      { type: "input", text: "#dotnet", source: "rpc", images },
      { cwd: root },
    );

    expect(result).toEqual({ action: "transform", text: "DOTNET CONTENT", images });
  });

  it("uses the extension context cwd for project snippets", async () => {
    const otherRoot = await mkdtemp(path.join(tmpdir(), "pi-inline-snippets-other-"));
    try {
      await expect(transformUserInput("#dotnet", otherRoot)).resolves.toEqual({
        text: "#dotnet",
        expanded: 0,
      });
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("leaves hashtags inside fenced code blocks untouched", async () => {
    const { pi, input } = fakePi();
    inlineSnippetsExtension(pi);

    const text = "```md\n#dotnet\n```\n#testing";
    const result = await input()({ type: "input", text, source: "rpc" }, { cwd: root });

    expect(result).toEqual({
      action: "transform",
      text: "```md\n#dotnet\n```\nTESTING CONTENT",
    });
  });
});

describe("autocomplete", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pi-inline-snippets-auto-"));
    const projectDir = path.join(root, ".pi", "snippets");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "dotnet.md"), "");
    await writeFile(path.join(projectDir, "testing.md"), "");
    await writeFile(path.join(projectDir, "strict.md"), "");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function currentProvider(): AutocompleteProvider {
    return {
      async getSuggestions() {
        return null;
      },
      applyCompletion(lines) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
      shouldTriggerFileCompletion() {
        return true;
      },
    };
  }

  it("suggests snippet names after #", async () => {
    const { pi, sessionStart } = fakePi();
    inlineSnippetsExtension(pi);
    let provider: AutocompleteProvider | undefined;
    sessionStart()(
      {},
      {
        cwd: root,
        ui: {
          addAutocompleteProvider(factory) {
            provider = factory(currentProvider());
          },
        },
      },
    );

    expect(provider).toBeDefined();
    const suggestions = await provider!.getSuggestions(["#d"], 0, 2, {
      signal: new AbortController().signal,
    });

    expect(suggestions).toEqual({
      items: [
        { value: "#dotnet", label: "#dotnet", description: "Markdown snippet" },
      ],
      prefix: "#d",
    });
  });

  it("delegates to the current provider inside a fenced code block", async () => {
    const { pi, sessionStart } = fakePi();
    inlineSnippetsExtension(pi);
    let provider: AutocompleteProvider | undefined;
    sessionStart()(
      {},
      {
        cwd: root,
        ui: {
          addAutocompleteProvider(factory) {
            provider = factory(currentProvider());
          },
        },
      },
    );

    const suggestions = await provider!.getSuggestions(["```", "#d", "```"], 1, 2, {
      signal: new AbortController().signal,
    });
    expect(suggestions).toBeNull();
  });
});
