/**
 * Runs API (via nodemon → bun) + Vite together.
 *
 * Why CTRL+C sometimes left zombies (especially on Windows):
 * - Deep process tree: dev → bun → nodemon → node → bun (server) / bun → vite.
 * - We used to fire `taskkill` async then `process.exit` immediately — the kill often
 *   had not finished, so children kept running as "orphans".
 * - Optional: `shell: true` adds a cmd.exe layer; signals do not propagate cleanly.
 *
 * Port pre-clean (opt-in): frees listeners on SERVER_PORT (default 7000) + Vite (default 7003).
 * Enable: `DEV_NUCLEAR=1` (or `true` / `yes` / `on`)
 * Custom ports: `DEV_PORTS=7000,7003`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";

const isWin = process.platform === "win32";

const devDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(devDir, "..", "..");
const webRoot = path.join(repoRoot, "web");
const bunPathMarker = path.join(repoRoot, ".dev-bun-path");
if (typeof process.versions.bun === "string") {
  try {
    fs.writeFileSync(bunPathMarker, process.execPath, "utf8");
  } catch {
    /* non-fatal */
  }
}

const runtime =
  typeof process.versions.bun === "string" ? process.execPath : "bun";
/** Only wrap in cmd.exe when we must resolve `bun` from PATH (e.g. parent is Node). */
const useShell = isWin && runtime === "bun";

function nuclearEnabled(): boolean {
  const v = process.env.DEV_NUCLEAR?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseDevPorts(): number[] {
  const raw = process.env.DEV_PORTS?.trim();
  if (raw) {
    return [
      ...new Set(
        raw
          .split(/[,;\s]+/)
          .map((s) => parseInt(s, 10))
          .filter((n) => !Number.isNaN(n) && n > 0 && n < 65536),
      ),
    ];
  }
  const api = parseInt(process.env.SERVER_PORT ?? "7000", 10);
  const web = parseInt(process.env.VITE_PORT ?? "7003", 10);
  return [...new Set([api, web].filter((n) => !Number.isNaN(n) && n > 0))];
}

function killListenersOnPorts(ports: number[]): void {
  if (!ports.length || !nuclearEnabled()) return;
  for (const port of ports) {
    if (isWin) {
      try {
        execSync(
          `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
          { stdio: "ignore", windowsHide: true },
        );
      } catch {
        /* ignore */
      }
    } else {
      try {
        execSync(`lsof -ti tcp:${port} | xargs kill -9 2>/dev/null`, {
          shell: "/bin/sh",
          stdio: "ignore",
        });
      } catch {
        /* ignore */
      }
    }
  }
}

killListenersOnPorts(parseDevPorts());

interface Proc {
  name: string;
  color: string;
  cmd: string;
  args: string[];
  cwd?: string;
}

const procs: Proc[] = [
  { name: "server", color: "\x1b[36m", cmd: runtime, args: ["run", "dev:server"] },
  { name: "web   ", color: "\x1b[35m", cmd: runtime, args: ["run", "dev"], cwd: webRoot },
];

const childEnv = {
  ...process.env,
  ...(typeof process.versions.bun === "string"
    ? { BUN_BIN: process.execPath }
    : {}),
};

const RESET = "\x1b[0m";
const children: ChildProcess[] = [];
let teardownDone = false;

function prefix(name: string, color: string, chunk: Buffer) {
  const text = chunk.toString();
  const lines = text.split("\n");
  const last = lines.pop();
  for (const line of lines) {
    process.stdout.write(`${color}[${name}]${RESET} ${line}\n`);
  }
  if (last) process.stdout.write(`${color}[${name}]${RESET} ${last}`);
  if (name === "server" && text.includes("[nodemon] app crashed")) {
    cleanupAndExit(1);
  }
}

function killChildProcesses(): void {
  for (const c of children) {
    if (!c.pid) continue;
    try {
      if (isWin) {
        spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          c.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}

function cleanupAndExit(code: number): void {
  if (!teardownDone) {
    teardownDone = true;
    killChildProcesses();
  }
  process.exit(code);
}

for (const p of procs) {
  const child = spawn(p.cmd, p.args, {
    cwd: p.cwd,
    shell: useShell,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (c) => prefix(p.name, p.color, c));
  child.stderr?.on("data", (c) => prefix(p.name, p.color, c));
  child.on("exit", (code) => {
    process.stdout.write(`${p.color}[${p.name}]${RESET} exited (${code})\n`);
    cleanupAndExit(code ?? 0);
  });
  children.push(child);
}

function onSignal(signal: NodeJS.Signals): void {
  const code = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 0;
  cleanupAndExit(code);
}

process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
if (isWin) process.on("SIGBREAK", () => onSignal("SIGBREAK"));

/** Windows: SIGINT is delivered to readline when stdin is a TTY. */
if (isWin && process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => onSignal("SIGINT"));
}
