type Level = "debug" | "info" | "warn" | "error";

const colors: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const reset = "\x1b[0m";

function fmt(level: Level, scope: string, msg: string, extra?: unknown): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const tag = `${colors[level]}${level.toUpperCase().padEnd(5)}${reset}`;
  const body = extra !== undefined ? `${msg} ${JSON.stringify(extra)}` : msg;
  return `${ts} ${tag} [${scope}] ${body}`;
}

export function makeLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => console.log(fmt("debug", scope, msg, extra)),
    info: (msg: string, extra?: unknown) => console.log(fmt("info", scope, msg, extra)),
    warn: (msg: string, extra?: unknown) => console.warn(fmt("warn", scope, msg, extra)),
    error: (msg: string, extra?: unknown) => console.error(fmt("error", scope, msg, extra)),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
