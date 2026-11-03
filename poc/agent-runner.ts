
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

type AgentType = "claude" | "codex";

interface RunOptions {
  agent: AgentType;
  workingDirectory: string;
  prompt: string;
}

async function runAgent(options: RunOptions): Promise<number> {
  const { agent, prompt } = options;
  const cwd = resolve(options.workingDirectory);

  if (!existsSync(cwd)) {
    throw new Error(`Directory does not exist: ${cwd}`);
  }

  // Testowa konfiguracja. W docelowym runnerze
  // dodamy obsługę sesji, anulowania i uprawnień.
  const command = agent === "claude" ? "claude" : "codex";

  const args =
    agent === "claude"
      ? [
          "-p",
          prompt,
          "--max-turns",
          "5",
          "--output-format",
          "text",
          "--allowedTools",
          "Read",
          "Edit",
          "Write",
        ]
      : [
          "exec",
          "--sandbox",
          "workspace-write",
          "--json",
          prompt,
        ];

  console.log(`\nStarting ${agent}...`);
  console.log(`Workspace: ${cwd}\n`);

  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout.on("data", (data: Buffer) => {
      process.stdout.write(data);
    });

    child.stderr.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      console.log(`\nAgent exited with code: ${code}`);
      resolveRun(code ?? 1);
    });
  });
}

// Używamy wyłącznie testowego repozytorium.
const workspace =
  process.argv[3] ??
  "/Users/akopton/repos/.agent-worktrees/agent-test-repo/TASK-003";
  
const agent = (process.argv[2] ?? "claude") as AgentType;

if (agent !== "claude" && agent !== "codex") {
  throw new Error("Agent must be 'claude' or 'codex'");
}

const prompt = `
Create a file named math-utils.ts.

Implement:
- square(n: number): number
- cube(n: number): number

Do not modify any other files.
Do not run git commit, git push, or switch branches.
Summarize the changes when finished.
`;

runAgent({
  agent,
  workingDirectory: workspace,
  prompt,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("Agent runner failed:", error);
    process.exitCode = 1;
  });
