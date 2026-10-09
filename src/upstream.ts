import type { Config } from "./config.js";

export type UpstreamResult =
  | { kind: "ok"; status: number; body: Record<string, unknown> }
  /** The upstream answered with an error status; `code` is its `error` field. */
  | { kind: "error"; status: number; code: string }
  /** No usable answer: unreachable, timed out, or not JSON. */
  | { kind: "unavailable"; reason: string };

export interface Upstreams {
  core(method: "GET" | "POST", path: string, traceId: string, body?: unknown): Promise<UpstreamResult>;
  search(path: string, traceId: string): Promise<UpstreamResult>;
}

const TIMEOUT_MS = 10_000;

export function createUpstreams(config: Config): Upstreams {
  return {
    core: (method, path, traceId, body) =>
      call(new URL(path, config.coreUrl), {
        method,
        headers: {
          "X-Service-Token": config.serviceToken,
          "X-Trace-Id": traceId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    search: (path, traceId) => call(new URL(path, config.searchUrl), { method: "GET", headers: { "X-Trace-Id": traceId } }),
  };
}

async function call(url: URL, init: RequestInit): Promise<UpstreamResult> {
  let res: globalThis.Response;
  let text: string;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }

  let body: unknown;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (res.ok) {
    if (!isObject(body)) return { kind: "unavailable", reason: `${res.status} answer is not a JSON object` };
    return { kind: "ok", status: res.status, body };
  }
  const code = isObject(body) && typeof body.error === "string" && body.error !== "" ? body.error : "upstream_error";
  return { kind: "error", status: res.status, code };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
