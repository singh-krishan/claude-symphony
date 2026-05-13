type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(" ") || s.includes("=") || s.includes('"')) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function emit(level: LogLevel, fields: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const ts = new Date().toISOString();
  const parts = [`[${ts}]`, `level=${level}`];

  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }

  process.stderr.write(parts.join(" ") + "\n");
}

export const log = {
  debug(fields: Record<string, unknown>): void {
    emit("debug", fields);
  },
  info(fields: Record<string, unknown>): void {
    emit("info", fields);
  },
  warn(fields: Record<string, unknown>): void {
    emit("warn", fields);
  },
  error(fields: Record<string, unknown>): void {
    emit("error", fields);
  },
};
