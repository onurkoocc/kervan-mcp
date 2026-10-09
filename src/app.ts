import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { bearerAuth, createTokenVerifier, type TokenVerifier } from "./auth.js";
import { SCOPES, type Config } from "./config.js";
import type { Logger } from "./log.js";
import { createMcpServer } from "./tools.js";
import { createUpstreams, type Upstreams } from "./upstream.js";

export interface AppDeps {
  verifier?: TokenVerifier;
  upstreams?: Upstreams;
}

const TRACE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function createApp(config: Config, log: Logger, deps: AppDeps = {}): Express {
  const verifier = deps.verifier ?? createTokenVerifier(config);
  const upstreams = deps.upstreams ?? createUpstreams(config);

  const app = express();
  app.disable("x-powered-by");

  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get("x-trace-id");
    res.locals.traceId = incoming && TRACE_ID.test(incoming) ? incoming : randomUUID();
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: config.resource,
      authorization_servers: [config.authIssuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
    });
  });

  const auth = bearerAuth(config, verifier, log);

  app.post("/mcp", auth, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    const traceId = res.locals.traceId as string;
    const server = createMcpServer({ upstreams, log, traceId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("mcp request failed", { trace_id: traceId, reason: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless server: no SSE stream to resume and no session to delete.
  app.all("/mcp", auth, (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  // Malformed JSON bodies and other errors raised by middleware.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err === "object" && err !== null && "status" in err ? Number(err.status) : 500;
    if (status >= 500) {
      log.error("request failed", { trace_id: res.locals.traceId as string, status, reason: String(err) });
    }
    res
      .status(status >= 400 && status < 600 ? status : 500)
      .json({ jsonrpc: "2.0", error: { code: status < 500 ? -32700 : -32603, message: status < 500 ? "Parse error" : "Internal server error" }, id: null });
  });

  return app;
}
