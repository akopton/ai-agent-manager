
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

type AgentType = "claude" | "codex";

const agent = process.argv[2] as AgentType;

const workspace = resolve(
  process.argv[3] ??
    "/Users/akopton/repos/.agent-worktrees/agent-test-repo/TASK-005"
);

if (agent !== "claude" && agent !== "codex") {
  throw new Error("Usage: stop-agent.ts <claude|codex>");
}

if (!existsSync(workspace)) {
  throw new Error(`Workspace not found: ${workspace}`);
}

const prompt = `
Create a small TypeScript utility library.

Implement separate files for:
1. String utilities
2. Number utilities
3. Array utilities
4. Date utilities
5. Object utilities
6. Validation utilities
7. Formatting utilities
8. Type guards

Write each module as a separate file.

Do not commit, push, or switch branches.
Only work inside the current repository.
`;

const command = agent === "claude" ? "claude" : "codex";

const args =
  agent === "claude"
    ? [
        "-p",
        prompt,
        "--max-turns",
        "30",
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

console.log(`Starting ${agent}...`);
console.log(`Workspace: ${workspace}`);

const child: ChildProcess = spawn(command, args, {
  cwd: workspace,
  stdio: ["ignore", "pipe", "pipe"],

  // macOS/Linux: osobna grupa procesów,
  // aby móc zatrzymać także procesy potomne.
  detached: true,
});

let stopRequested = false;
let finished = false;
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function signalAgent(signal: NodeJS.Signals): void {
  if (!child.pid) return;

  try {
    // Ujemny PID wskazuje grupę procesów (POSIX).
    process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      console.error(`Cannot send ${signal}:`, error);
    }
  }
}

function stopAgent(): void {
  if (stopRequested || finished) return;

  stopRequested = true;

  console.log("\nStopping agent...");

  // Najpierw próbujemy zakończyć proces łagodnie.
  signalAgent("SIGTERM");

  // Jeśli proces nie zakończy się w ciągu 10 sekund,
  // wymuszamy zatrzymanie.
  forceKillTimer = setTimeout(() => {
    if (!finished) {
      console.log("Force stopping agent...");
      signalAgent("SIGKILL");
    }
  }, 10_000);

  forceKillTimer.unref();
}

child.stdout?.on("data", (data: Buffer) => {
  process.stdout.write(data);
});

child.stderr?.on("data", (data: Buffer) => {
  process.stderr.write(data);
});

child.on("error", (error) => {
  console.error("Agent process error:", error);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  finished = true;

  if (forceKillTimer) clearTimeout(forceKillTimer);

  rl.close();

  console.log("\nAgent finished.");
  console.log(`Exit code: ${code}`);
  console.log(`Signal: ${signal ?? "none"}`);
  console.log(`Stopped manually: ${stopRequested}`);

  console.log("\nWorkspace files have not been deleted.");

  process.exitCode = stopRequested ? 130 : (code ?? 1);
});

rl.on("line", () => {
  stopAgent();
});

process.on("SIGINT", () => {
  stopAgent();
});

console.log("\nPress ENTER to stop the agent.\n");
