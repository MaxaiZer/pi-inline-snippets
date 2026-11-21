import { describe, expect, it } from "vitest";
import { expandSnippetReferences, findProtectedRanges, parseSnippetReferences } from "../src/parser.ts";

const snippets: Record<string, string> = {
  dotnet: "DOTNET CONTENT",
  testing: "TESTING CONTENT",
  strict: "STRICT CONTENT",
  empty: "",
};

async function readSnippet(name: string): Promise<string | undefined> {
  return snippets[name];
}

describe("parseSnippetReferences", () => {
  it("finds a single reference", () => {
    expect(parseSnippetReferences("Review this.\n\n#dotnet\n\nThanks.")).toEqual([
      { name: "dotnet", raw: "#dotnet", start: 14, end: 21 },
    ]);
  });

  it("finds multiple references in order", () => {
    const references = parseSnippetReferences("#dotnet then #testing then #strict");
    expect(references.map((reference) => reference.name)).toEqual(["dotnet", "testing", "strict"]);
  });

  it("finds references at the beginning, middle and end", () => {
    const references = parseSnippetReferences("#dotnet\nmiddle #testing middle\n#strict");
    expect(references.map((reference) => reference.name)).toEqual(["dotnet", "testing", "strict"]);
  });

  it("supports letters, numbers, hyphens and underscores", () => {
    const references = parseSnippetReferences("#security-review #test_2 #abc123");
    expect(references.map((reference) => reference.name)).toEqual([
      "security-review",
      "test_2",
      "abc123",
    ]);
  });

  it("does not match invalid or partial names", () => {
    const text = [
      "#../secret",
      "#foo/bar",
      "#foo.bar",
      "C#sharp",
      "text#tag",
      "## heading",
      "# heading",
      "#",
      "#-leading-hyphen",
      "#_leading-underscore",
    ].join(" ");
    expect(parseSnippetReferences(text)).toEqual([]);
  });

  it("does not touch hashtags inside fenced code blocks", () => {
    const text = [
      "before",
      "```markdown",
      "#dotnet",
      "```",
      "after #testing",
      "~~~~",
      "#strict",
      "~~~~",
      "end #security-review",
    ].join("\n");
    expect(parseSnippetReferences(text).map((reference) => reference.name)).toEqual([
      "testing",
      "security-review",
    ]);
  });

  it("handles longer closing fences and info strings", () => {
    const text = "```js title=\"x\"\n#dotnet\n````\n#testing";
    expect(parseSnippetReferences(text).map((reference) => reference.name)).toEqual(["testing"]);
  });

  it("handles an unclosed fence through the end of the message", () => {
    const text = "#dotnet\n```\n#testing\n#strict";
    expect(parseSnippetReferences(text).map((reference) => reference.name)).toEqual(["dotnet"]);
  });

  it("protects fenced blocks inside blockquotes", () => {
    const text = "> ```md\n> #dotnet\n> ```\n#testing";
    expect(parseSnippetReferences(text).map((reference) => reference.name)).toEqual(["testing"]);
  });

  it("protects fenced blocks inside list items", () => {
    const text = "- ```md\n  #dotnet\n  ```\n#testing";
    expect(parseSnippetReferences(text).map((reference) => reference.name)).toEqual(["testing"]);
  });

  it("does not touch hashtags inside inline code", () => {
    const text = "Use `#dotnet` and ``#testing`` but #strict is real.";
    expect(parseSnippetReferences(text).map((reference) => reference.name)).toEqual(["strict"]);
  });

  it("does not treat an unmatched backtick as inline code", () => {
    expect(parseSnippetReferences("a ` b #dotnet").map((reference) => reference.name)).toEqual([
      "dotnet",
    ]);
  });

  it("handles inline code containing backtick runs", () => {
    const text = "``a ` #dotnet`` then #testing";
    expect(parseSnippetReferences(text).map((reference) => reference.name)).toEqual(["testing"]);
  });

  it("treats escaped backticks as literal characters, not inline code", () => {
    expect(parseSnippetReferences("\\` #dotnet \\` and #testing").map((reference) => reference.name)).toEqual([
      "dotnet",
      "testing",
    ]);
  });

  it("does not treat code spans crossing a blank line as inline code", () => {
    expect(parseSnippetReferences("`start\n\n#dotnet\n\nend`").map((reference) => reference.name)).toEqual([
      "dotnet",
    ]);
  });

  it("finds references adjacent to punctuation", () => {
    const text = "(#dotnet), [#testing]. **#strict**";
    expect(parseSnippetReferences(text).map((reference) => reference.name)).toEqual([
      "dotnet",
      "testing",
      "strict",
    ]);
  });

  it("finds a reference before a sentence-ending period", () => {
    expect(parseSnippetReferences("Use #dotnet. Then #testing!").map((reference) => reference.name)).toEqual([
      "dotnet",
      "testing",
    ]);
  });

  it("does not partially match a filename-like reference", () => {
    expect(parseSnippetReferences("#dotnet.md and #dotnet. and #dotnet")).toEqual([
      expect.objectContaining({ name: "dotnet", raw: "#dotnet" }),
      expect.objectContaining({ name: "dotnet", raw: "#dotnet" }),
    ]);
  });
});

describe("findProtectedRanges", () => {
  it("covers fenced blocks including fences and inline code spans", () => {
    const text = "a `x` b\n```\nc\n```\nd";
    const ranges = findProtectedRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      "`x`",
      "```\nc\n```\n",
    ]);
  });
});

describe("expandSnippetReferences", () => {
  it("expands a single reference and preserves surrounding whitespace", async () => {
    const text = "Review this.\n\n#dotnet\n\nThanks.\n";
    const result = await expandSnippetReferences(text, readSnippet);
    expect(result).toEqual({
      text: "Review this.\n\nDOTNET CONTENT\n\nThanks.\n",
      expanded: 1,
    });
  });

  it("expands multiple references in any position", async () => {
    const text = "#dotnet\nmiddle\n#testing\nend #strict";
    const result = await expandSnippetReferences(text, readSnippet);
    expect(result.text).toBe(
      "DOTNET CONTENT\nmiddle\nTESTING CONTENT\nend STRICT CONTENT",
    );
    expect(result.expanded).toBe(3);
  });

  it("leaves unknown references unchanged", async () => {
    const result = await expandSnippetReferences("a #missing b", readSnippet);
    expect(result).toEqual({ text: "a #missing b", expanded: 0 });
  });

  it("expands repeated references once per occurrence", async () => {
    const result = await expandSnippetReferences("#dotnet and #dotnet", readSnippet);
    expect(result.text).toBe("DOTNET CONTENT and DOTNET CONTENT");
    expect(result.expanded).toBe(2);
  });

  it("supports empty snippets", async () => {
    const result = await expandSnippetReferences("a #empty b", readSnippet);
    expect(result).toEqual({ text: "a  b", expanded: 1 });
  });

  it("does not expand references inside code", async () => {
    const text = "`#dotnet`\n```\n#testing\n```\n#strict";
    const result = await expandSnippetReferences(text, readSnippet);
    expect(result.text).toBe("`#dotnet`\n```\n#testing\n```\nSTRICT CONTENT");
  });

  it("does not recursively expand snippet contents", async () => {
    const result = await expandSnippetReferences(
      "#a",
      async (name) => (name === "a" ? "#b" : "B CONTENT"),
    );
    expect(result.text).toBe("#b");
  });

  it("logs and preserves a reference when reading throws", async () => {
    const logged: string[] = [];
    const result = await expandSnippetReferences(
      "before #bad after #good",
      async (name) => {
        if (name === "bad") {
          throw new Error("boom");
        }
        return "OK";
      },
      (message) => logged.push(message),
    );
    expect(result.text).toBe("before #bad after OK");
    expect(logged).toHaveLength(1);
  });

  it("does not add extra whitespace around expanded content", async () => {
    const result = await expandSnippetReferences("#dotnet\n#testing", readSnippet);
    expect(result.text).toBe("DOTNET CONTENT\nTESTING CONTENT");
  });
});
