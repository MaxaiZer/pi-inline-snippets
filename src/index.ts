import { homedir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { expandSnippetReferences, findProtectedRanges } from "./parser.ts";
import { SnippetResolver } from "./resolver.ts";
import type { ExpansionResult, SnippetDirectories, SnippetLogger } from "./types.ts";

const LOG_PREFIX = "[inline-snippets]";
const MAX_SUGGESTIONS = 20;

export interface InlineSnippetsOptions {
  globalDir?: string;
  projectDir?: string;
  logger?: SnippetLogger;
}

function createLogger(overrides?: SnippetLogger): SnippetLogger {
  return overrides ?? ((message, ...details) => console.error(`${LOG_PREFIX} ${message}`, ...details));
}

export function defaultGlobalSnippetDirectory(): string {
  return path.join(homedir(), ".pi", "agent", "snippets");
}

export function snippetDirectoriesFor(cwd: string, options?: InlineSnippetsOptions): SnippetDirectories {
  return {
    globalDir: options?.globalDir ?? defaultGlobalSnippetDirectory(),
    projectDir: options?.projectDir ?? path.join(cwd, ".pi", "snippets"),
  };
}

export async function transformUserInput(
  text: string,
  cwd: string,
  options?: InlineSnippetsOptions,
): Promise<ExpansionResult> {
  if (!text.includes("#")) {
    return { text, expanded: 0 };
  }

  const logger = createLogger(options?.logger);
  const resolver = new SnippetResolver(snippetDirectoriesFor(cwd, options), logger);
  return expandSnippetReferences(text, (name) => resolver.resolve(name), logger);
}

function cursorOffset(lines: string[], cursorLine: number, cursorCol: number): number {
  let offset = 0;
  for (let index = 0; index < cursorLine; index += 1) {
    offset += (lines[index] ?? "").length + 1;
  }
  return offset + cursorCol;
}

function isInsideCode(lines: string[], cursorLine: number, cursorCol: number): boolean {
  const text = lines.join("\n");
  const offset = cursorOffset(lines, cursorLine, cursorCol);
  return findProtectedRanges(text).some((range) => range.start <= offset && offset < range.end);
}

function extractSnippetToken(line: string, cursorCol: number): string | undefined {
  const beforeCursor = line.slice(0, cursorCol);
  const match = /(?<![\p{L}\p{N}_#/\\&.-])#([A-Za-z0-9_-]*)$/u.exec(beforeCursor);
  return match?.[1];
}

function createSnippetAutocompleteProvider(
  current: AutocompleteProvider,
  resolver: SnippetResolver,
): AutocompleteProvider {
  let cachedNames: string[] | undefined;
  let cacheExpiresAt = 0;

  const getNames = async (): Promise<string[]> => {
    const now = Date.now();
    if (cachedNames && now < cacheExpiresAt) {
      return cachedNames;
    }
    cachedNames = await resolver.list();
    cacheExpiresAt = now + 1_000;
    return cachedNames;
  };

  return {
    triggerCharacters: ["#"],
    async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? "";
      const token = extractSnippetToken(line, cursorCol);
      if (token === undefined || isInsideCode(lines, cursorLine, cursorCol)) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const names = await getNames();
      if (options.signal.aborted) {
        return null;
      }

      const query = token.toLowerCase();
      const items: AutocompleteItem[] = names
        .filter((name) => name.toLowerCase().includes(query))
        .slice(0, MAX_SUGGESTIONS)
        .map((name) => ({
          value: `#${name}`,
          label: `#${name}`,
          description: "Markdown snippet",
        }));

      if (items.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return { items, prefix: `#${token}` };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export default function inlineSnippetsExtension(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx): Promise<InputEventResult> => {
    const result = await transformUserInput(event.text, ctx.cwd);
    if (result.expanded === 0) {
      return { action: "continue" };
    }
    return {
      action: "transform",
      text: result.text,
      ...(event.images ? { images: event.images } : {}),
    };
  });

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (typeof ctx.ui.addAutocompleteProvider !== "function") {
      return;
    }
    const resolver = new SnippetResolver(snippetDirectoriesFor(ctx.cwd), createLogger());
    ctx.ui.addAutocompleteProvider((current) => createSnippetAutocompleteProvider(current, resolver));
  });
}
