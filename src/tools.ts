import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Scope } from "./config.js";
import type { Logger } from "./log.js";
import type { UpstreamResult, Upstreams } from "./upstream.js";

export const SERVER_INFO = { name: "kervan-mcp", version: "0.1.0" } as const;

export interface ToolContext {
  upstreams: Upstreams;
  log: Logger;
  traceId: string;
}

type Extra = { authInfo?: { scopes: string[] } | undefined };

const trackingNo = z
  .string()
  .regex(/^KRV[0-9]{8}$/)
  .describe("Shipment tracking number: KRV followed by 8 digits, e.g. KRV12345678");

/** One MCP server per request (stateless mode), bound to that request's trace id. */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });

  server.registerTool(
    "get_shipment",
    {
      title: "Get shipment",
      description: "Look up a shipment's status, route, estimated delivery date and latest event by tracking number.",
      inputSchema: { tracking_no: trackingNo },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, extra) =>
      run(ctx, "get_shipment", "shipments:read", extra, () =>
        ctx.upstreams.core("GET", `/api/v1/shipments/${encodeURIComponent(args.tracking_no)}`, ctx.traceId),
      ),
  );

  server.registerTool(
    "reschedule_delivery",
    {
      title: "Reschedule delivery",
      description:
        "Move a shipment's delivery to a new date. Needs the last four digits of the recipient's phone as verification. " +
        "The date must be between tomorrow and 14 days ahead; delivered, returned or out-for-delivery shipments cannot be rescheduled.",
      inputSchema: {
        tracking_no: trackingNo,
        new_date: z
          .string()
          .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
          .describe("New delivery date, YYYY-MM-DD"),
        verification_code: z
          .string()
          .regex(/^[0-9]{4}$/)
          .describe("Last four digits of the recipient's phone number"),
        reason: z.string().optional().describe("Why the customer wants a new date"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, extra) =>
      run(ctx, "reschedule_delivery", "deliveries:write", extra, () =>
        ctx.upstreams.core("POST", `/api/v1/shipments/${encodeURIComponent(args.tracking_no)}/reschedule`, ctx.traceId, {
          newDate: args.new_date,
          verificationCode: args.verification_code,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        }),
      ),
  );

  server.registerTool(
    "open_ticket",
    {
      title: "Open support ticket",
      description: "Open a customer support ticket, optionally about a shipment (damaged, lost, delayed, or other).",
      inputSchema: {
        tracking_no: trackingNo.optional(),
        category: z.enum(["DAMAGED", "LOST", "DELAY", "OTHER"]).describe("Kind of problem"),
        description: z.string().max(2000).describe("What happened, in the customer's words"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, extra) =>
      run(ctx, "open_ticket", "tickets:write", extra, () =>
        ctx.upstreams.core("POST", "/api/v1/tickets", ctx.traceId, {
          ...(args.tracking_no === undefined ? {} : { trackingNo: args.tracking_no }),
          category: args.category,
          description: args.description,
          channel: "agent",
        }),
      ),
  );

  server.registerTool(
    "search_help",
    {
      title: "Search help articles",
      description: "Search the Kervan knowledge base and return the three best-matching help articles.",
      inputSchema: { query: z.string().max(500).describe("What the customer wants to know") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, extra) =>
      run(ctx, "search_help", "help:read", extra, () =>
        ctx.upstreams.search(`/search?${new URLSearchParams({ q: args.query, k: "3" })}`, ctx.traceId),
      ),
  );

  return server;
}

async function run(
  ctx: ToolContext,
  tool: string,
  scope: Scope,
  extra: Extra,
  call: () => Promise<UpstreamResult>,
): Promise<CallToolResult> {
  if (!extra.authInfo?.scopes.includes(scope)) {
    ctx.log.warn("tool call refused", { trace_id: ctx.traceId, tool, status: 403, reason: "insufficient_scope" });
    return failure(`insufficient_scope: ${scope}`);
  }

  const started = performance.now();
  const result = await call();
  const duration_ms = Math.round(performance.now() - started);

  switch (result.kind) {
    case "ok":
      ctx.log.info("tool call", { trace_id: ctx.traceId, tool, status: result.status, duration_ms });
      return {
        content: [{ type: "text", text: JSON.stringify(result.body) }],
        structuredContent: result.body,
      };
    case "error": {
      const level = result.status >= 500 ? "error" : "warn";
      ctx.log[level]("tool call failed", { trace_id: ctx.traceId, tool, status: result.status, duration_ms });
      return failure(`${result.status} ${result.code}`);
    }
    case "unavailable":
      ctx.log.error("upstream unavailable", { trace_id: ctx.traceId, tool, duration_ms, reason: result.reason });
      return failure("upstream_unavailable");
  }
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
