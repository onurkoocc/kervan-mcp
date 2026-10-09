import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Level = "info" | "warn" | "error";

/**
 * Optional fields of a log line (SPEC §6). Never put personal data here:
 * tracking numbers are fine; names, phones, emails and verification codes are not.
 */
export interface LogFields {
  trace_id?: string;
  tool?: string;
  status?: number;
  duration_ms?: number;
  reason?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** Also append each line to this file. */
  file?: string | undefined;
  /** Where stdout lines go; defaults to process.stdout. */
  stdout?: (line: string) => void;
  now?: () => Date;
}

/** JSON-lines logger: one object per line on stdout and, when configured, appended to a file. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(line));
  const now = options.now ?? (() => new Date());
  let file = options.file;
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      // The append below reports the problem.
    }
  }

  const write = (level: Level, msg: string, fields: LogFields = {}): void => {
    const entry: Record<string, unknown> = { ts: now().toISOString(), level, service: "mcp", msg };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && !(key in entry)) entry[key] = value;
    }
    const line = `${JSON.stringify(entry)}\n`;
    stdout(line);
    if (file) {
      try {
        appendFileSync(file, line);
      } catch (err) {
        const failed = file;
        file = undefined; // Fall back to stdout only rather than failing every request.
        write("error", "log file not writable; logging to stdout only", {
          reason: err instanceof Error ? err.message : String(err),
          file: failed,
        });
      }
    }
  };

  return {
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
