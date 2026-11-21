# pi-inline-snippets

A small [Pi](https://github.com/earendil-works/pi) extension that expands `#snippet-name` references into Markdown files before a message reaches the model.

It works in the Pi interactive TUI and in RPC mode, including clients such as Paseo. Substitution is implemented with Pi's `input` event and does not depend on any TUI API.

## Example

Given `.pi/snippets/dotnet.md`, `.pi/snippets/testing.md`, and `.pi/snippets/strict.md`, this message:

```text
Review this implementation.

#dotnet

Pay special attention to performance.

#testing

#strict
```

is delivered to the model as:

```text
Review this implementation.

<contents of dotnet.md>

Pay special attention to performance.

<contents of testing.md>

<contents of strict.md>
```

Only the references are replaced. All surrounding text, line breaks, and whitespace are preserved.

## Installation

The extension requires Pi 1.4 or newer and Node.js 22.19 or newer.

Install directly from GitHub:

```bash
pi install git:github.com/MaxaiZer/pi-inline-snippets
```

Then update the installed package when a new version is published:

```bash
pi update --extensions
```

For local development, install the package from the repository root:

```bash
pi install .
```

Or load the extension from a local checkout for a single Pi invocation:

```bash
pi --extension /absolute/path/to/pi-inline-snippets/src/index.ts
```

You can also add the GitHub package to `~/.pi/agent/settings.json` manually:

```json
{
  "packages": [
    "git:github.com/MaxaiZer/pi-inline-snippets"
  ]
}
```

No changes to Pi or Paseo are required.

## Snippet directories

Snippets are plain Markdown files with a `.md` extension.

| Scope | Directory |
| --- | --- |
| Global | `~/.pi/agent/snippets/` |
| Project | `<project>/.pi/snippets/` |

```text
~/.pi/agent/snippets/
├── dotnet.md
├── testing.md
└── strict.md

<project>/.pi/snippets/
└── dotnet.md
```

The project directory is resolved from the working directory that Pi provides to the extension. A project snippet overrides a global snippet with the same filename.

Snippet files may be empty. Empty snippets expand to nothing.

## Usage

Reference a snippet by writing `#`, followed by its filename without `.md`:

```text
#dotnet
```

References can appear anywhere in a message and in any order:

```text
Use #testing first, then #dotnet, and finish with #security-review.
```

The same reference can be used more than once. Each occurrence is expanded independently:

```text
Compare #dotnet with #dotnet again.
```

Snippet contents are never scanned recursively, so a `#reference` inside a snippet file stays literal.

Unknown references are left exactly as written:

```text
#missing-snippet
```

## Naming conventions

Snippet names must:

- contain only ASCII letters, digits, hyphens, and underscores;
- start with a letter or digit;
- be at most 200 characters long.

Valid names:

```text
dotnet
security-review
test_2
ABC123
```

Invalid references such as `#../secret`, `#foo/bar`, or `#foo.md` are not treated as snippets. Names are validated before any filesystem lookup, and resolved paths must stay inside the configured snippet directories. Symlinks that point outside a snippet directory are rejected.

## Markdown-aware substitution

References are ignored when they occur inside:

- fenced code blocks opened with three or more backticks or tildes, including an unclosed fence that continues to the end of the message;
- inline code spans delimited by matching backtick runs, such as `` `#dotnet` `` or `` ``#testing`` ``.

For example, this message expands only `#testing`:

````text
```markdown
#dotnet
```

Use `#dotnet` as an example, but expand #testing.
````

Escaped backticks are treated as literal characters rather than inline-code delimiters.

## Error handling

A missing or unreadable snippet does not block message submission. The original reference is left unchanged.

Unexpected filesystem errors are written to stderr with the `[inline-snippets]` prefix. In RPC mode, stderr is the diagnostic channel; stdout remains reserved for Pi protocol records.

If a project snippet file exists but cannot be read, that failure is reported and the global snippet with the same name is not used. The project file still takes precedence.

## Autocomplete

In the interactive TUI, typing `#` offers snippet names from both directories. Project snippets override global snippets with the same name, and suggestions are filtered as you type. Each suggestion shows a one-line preview taken from the first non-empty line of the snippet; empty snippets fall back to `Markdown snippet`.

Autocomplete is optional. It is registered through `ctx.ui.addAutocompleteProvider()` during `session_start`, and it delegates to the normal file autocomplete when the cursor is not in a snippet reference. RPC clients and Paseo do not need autocomplete; the input substitution path has no UI dependency.

## Pi TUI and RPC compatibility

The extension handles Pi's `input` event with `source` values `interactive`, `rpc`, and `extension`:

- when at least one reference resolves, it returns `{ action: "transform", text }`;
- when no reference resolves, it returns `{ action: "continue" }`.

The extension does not call `pi.sendMessage()` and does not use `ctx.ui` for substitution. This is why messages submitted through RPC by Paseo are transformed exactly like messages typed in the TUI.

The RPC integration test starts the real `pi --mode rpc` process, submits a prompt through the JSONL protocol, and verifies the prompt observed by a separate `before_agent_start` probe extension.

## Development

```bash
npm install
npm test
npm run typecheck
```

Tests cover single and multiple references, references at the start/middle/end, whitespace preservation, unknown references, global and project snippets, project overrides, fenced and inline code, invalid names and path traversal, repeated references, empty snippets, unreadable files, symlink escapes, Pi input integration, autocomplete, and RPC mode.

## Project layout

```text
src/
├── index.ts      Pi event integration and autocomplete
├── parser.ts     Markdown-aware reference parsing and expansion
├── resolver.ts   Validated filesystem lookup
└── types.ts      Shared types
```
