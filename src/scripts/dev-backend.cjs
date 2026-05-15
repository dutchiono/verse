/**
 * Nodemon runs this via `node` so we can spawn Bun with an absolute path
 * (Bun is often missing from PATH inside nodemon's Windows shell).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const marker = path.join(root, ".dev-bun-path");

function resolveBun() {
  const fromEnv = process.env.BUN_BIN?.trim();
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(marker)) return fs.readFileSync(marker, "utf8").trim();
  } catch {
    /* ignore */
  }
  return "bun";
}

const bunExe = resolveBun();
const child = spawn(bunExe, ["src/index.ts"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: process.env,
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
