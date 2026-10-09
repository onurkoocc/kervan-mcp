import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("logger", () => {
  it("writes the same JSON line to stdout and LOG_FILE", () => {
    dir = mkdtempSync(join(tmpdir(), "kervan-mcp-log-"));
    const file = join(dir, "nested", "mcp.jsonl");
    const out: string[] = [];
    const log = createLogger({ file, stdout: (l) => out.push(l), now: () => new Date("2026-10-09T12:00:00.000Z") });
    log.info("tool call", { trace_id: "t1", tool: "get_shipment", status: 200, duration_ms: 12, skipped: undefined });
    log.error("boom");

    const expected = [
      '{"ts":"2026-10-09T12:00:00.000Z","level":"info","service":"mcp","msg":"tool call","trace_id":"t1","tool":"get_shipment","status":200,"duration_ms":12}\n',
      '{"ts":"2026-10-09T12:00:00.000Z","level":"error","service":"mcp","msg":"boom"}\n',
    ];
    expect(out).toEqual(expected);
    expect(readFileSync(file, "utf8")).toBe(expected.join(""));
  });

  it("does not let fields override the fixed ones", () => {
    const out: string[] = [];
    createLogger({ stdout: (l) => out.push(l) }).warn("m", { service: "other", level: "info" });
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ service: "mcp", level: "warn" });
  });
});
