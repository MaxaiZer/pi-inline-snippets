import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const extensionPath = path.join(repositoryRoot, "src", "index.ts");
const probePath = path.join(repositoryRoot, "test", "fixtures", "rpc-probe.ts");

async function waitForFile(file: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return await readFile(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function cleanEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key)) {
      continue;
    }
    environment[key] = value;
  }
  return { ...environment, ...overrides };
}

describe("Pi RPC mode", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let root: string | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child?.once("exit", resolve));
    }
    child = undefined;
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
    root = undefined;
  });

  it("expands snippets for a prompt submitted through RPC", async () => {
    root = await mkdtemp(path.join(tmpdir(), "pi-inline-snippets-rpc-"));
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const globalSnippets = path.join(home, ".pi", "agent", "snippets");
    const projectSnippets = path.join(project, ".pi", "snippets");
    const probeOutput = path.join(root, "probe.json");

    await mkdir(globalSnippets, { recursive: true });
    await mkdir(projectSnippets, { recursive: true });
    await writeFile(path.join(globalSnippets, "global.md"), "GLOBAL CONTENT");
    await writeFile(path.join(projectSnippets, "dotnet.md"), "DOTNET CONTENT");

    child = spawn(
      process.env.PI_BIN ?? "pi",
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--extension",
        extensionPath,
        "--extension",
        probePath,
        "--offline",
        "--no-mcp",
        "--provider",
        "openai",
        "--model",
        "gpt-4o-mini",
        "--api-key",
        "test-key",
      ],
      {
        cwd: project,
        env: cleanEnvironment({
          HOME: home,
          PI_SNIPPET_PROBE_FILE: probeOutput,
          PI_OFFLINE: "1",
        }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const prompt = "Review this.\n\n#dotnet\n\nMiddle\n\n#global\n\nRepeated #dotnet\n";
    child.stdin.write(`${JSON.stringify({ id: "rpc-test", type: "prompt", message: prompt })}\n`);

    let probeContent: string;
    try {
      probeContent = await waitForFile(probeOutput, 20_000);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }

    const probe = JSON.parse(probeContent) as { prompt: string; type: string };
    expect(probe.type).toBe("before_agent_start");
    expect(probe.prompt).toBe(
      "Review this.\n\nDOTNET CONTENT\n\nMiddle\n\nGLOBAL CONTENT\n\nRepeated DOTNET CONTENT\n",
    );
  }, 30_000);
});
