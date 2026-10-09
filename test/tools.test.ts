import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY, SEARCH, SERVICE_TOKEN, SHIPMENT, startHarness, TICKET, type Harness } from "./helpers.js";

let h: Harness;
let client: Client;

beforeAll(async () => {
  h = await startHarness();
  client = await h.connect(await h.mint());
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.core.requests.length = 0;
  h.search.requests.length = 0;
});

async function call(name: string, args: Record<string, unknown>, c: Client = client): Promise<CallToolResult> {
  return (await c.callTool({ name, arguments: args })) as CallToolResult;
}

function expectOk(result: CallToolResult, body: unknown): void {
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(body) }]);
  expect(result.structuredContent).toEqual(body);
}

function expectError(result: CallToolResult, text: string): void {
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text }]);
  expect(result.structuredContent).toBeUndefined();
}

describe("get_shipment", () => {
  it("calls core with the service token", async () => {
    expectOk(await call("get_shipment", { tracking_no: "KRV00000001" }), SHIPMENT);
    expect(h.core.requests).toHaveLength(1);
    const [req] = h.core.requests;
    expect(req).toMatchObject({ method: "GET", url: "/api/v1/shipments/KRV00000001" });
    expect(req?.headers["x-service-token"]).toBe(SERVICE_TOKEN);
  });

  it("maps 404 to a tool error", async () => {
    expectError(await call("get_shipment", { tracking_no: "KRV99999999" }), "404 not_found");
  });

  it("validates the tracking number before calling core", async () => {
    const result = await call("get_shipment", { tracking_no: "KRV123" });
    expect(result.isError).toBe(true);
    expect(h.core.requests).toHaveLength(0);
  });
});

describe("reschedule_delivery", () => {
  it("posts the camelCase body to core", async () => {
    const result = await call("reschedule_delivery", {
      tracking_no: "KRV00000001",
      new_date: "2026-10-14",
      verification_code: "1234",
      reason: "Not at home",
    });
    expectOk(result, DELIVERY);
    const [req] = h.core.requests;
    expect(req).toMatchObject({
      method: "POST",
      url: "/api/v1/shipments/KRV00000001/reschedule",
      body: { newDate: "2026-10-14", verificationCode: "1234", reason: "Not at home" },
    });
    expect(req?.headers["x-service-token"]).toBe(SERVICE_TOKEN);
    expect(req?.headers["content-type"]).toBe("application/json");
  });

  it("omits reason when not given", async () => {
    await call("reschedule_delivery", { tracking_no: "KRV00000001", new_date: "2026-10-14", verification_code: "1234" });
    expect(h.core.requests[0]?.body).toEqual({ newDate: "2026-10-14", verificationCode: "1234" });
  });

  it("maps 403 verification_failed", async () => {
    const result = await call("reschedule_delivery", {
      tracking_no: "KRV00000001",
      new_date: "2026-10-14",
      verification_code: "9999",
    });
    expectError(result, "403 verification_failed");
  });

  it("maps 409 not_reschedulable", async () => {
    const result = await call("reschedule_delivery", {
      tracking_no: "KRV00000002",
      new_date: "2026-10-14",
      verification_code: "1234",
    });
    expectError(result, "409 not_reschedulable");
  });

  it("maps 400 invalid_date", async () => {
    const result = await call("reschedule_delivery", {
      tracking_no: "KRV00000001",
      new_date: "2020-01-01",
      verification_code: "1234",
    });
    expectError(result, "400 invalid_date");
  });

  it("maps a 5xx without a body to a tool error", async () => {
    const result = await call("reschedule_delivery", {
      tracking_no: "KRV00000003",
      new_date: "2026-10-14",
      verification_code: "1234",
    });
    expectError(result, "500 upstream_error");
  });

  it("requires a 4-digit verification code", async () => {
    const result = await call("reschedule_delivery", {
      tracking_no: "KRV00000001",
      new_date: "2026-10-14",
      verification_code: "12345",
    });
    expect(result.isError).toBe(true);
    expect(h.core.requests).toHaveLength(0);
  });
});

describe("open_ticket", () => {
  it("posts with channel agent", async () => {
    const result = await call("open_ticket", {
      tracking_no: "KRV00000001",
      category: "DAMAGED",
      description: "Box arrived crushed",
    });
    expectOk(result, TICKET);
    expect(h.core.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/tickets",
      body: { trackingNo: "KRV00000001", category: "DAMAGED", description: "Box arrived crushed", channel: "agent" },
    });
  });

  it("omits trackingNo when not given", async () => {
    const result = await call("open_ticket", { category: "OTHER", description: "Question about invoices" });
    expect(result.isError).toBeFalsy();
    expect(h.core.requests[0]?.body).toEqual({ category: "OTHER", description: "Question about invoices", channel: "agent" });
  });

  it("maps 404 for an unknown tracking number", async () => {
    const result = await call("open_ticket", { tracking_no: "KRV99999999", category: "LOST", description: "Never came" });
    expectError(result, "404 not_found");
  });

  it("rejects an unknown category and an over-long description", async () => {
    expect((await call("open_ticket", { category: "ANGRY", description: "x" })).isError).toBe(true);
    expect((await call("open_ticket", { category: "OTHER", description: "x".repeat(2001) })).isError).toBe(true);
    expect(h.core.requests).toHaveLength(0);
  });
});

describe("search_help", () => {
  it("queries search with k=3", async () => {
    expectOk(await call("search_help", { query: "change delivery date & time" }), SEARCH);
    const [req] = h.search.requests;
    const url = new URL(req?.url ?? "", "http://search");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("change delivery date & time");
    expect(url.searchParams.get("k")).toBe("3");
    expect(req?.headers["x-service-token"]).toBeUndefined();
  });

  it("rejects a query over 500 characters", async () => {
    expect((await call("search_help", { query: "x".repeat(501) })).isError).toBe(true);
    expect(h.search.requests).toHaveLength(0);
  });
});

describe("scope check", () => {
  it.each([
    ["get_shipment", "shipments:read", { tracking_no: "KRV00000001" }],
    ["reschedule_delivery", "deliveries:write", { tracking_no: "KRV00000001", new_date: "2026-10-14", verification_code: "1234" }],
    ["open_ticket", "tickets:write", { category: "OTHER", description: "x" }],
    ["search_help", "help:read", { query: "hours" }],
  ])("%s needs %s", async (tool, scope, args) => {
    const others = ["shipments:read", "deliveries:write", "tickets:write", "help:read"].filter((s) => s !== scope);
    const limited = await h.connect(await h.mint({ scope: others.join(" ") }));
    expectError(await call(tool, args, limited), `insufficient_scope: ${scope}`);
    expect(h.core.requests).toHaveLength(0);
    expect(h.search.requests).toHaveLength(0);
  });

  it("a token with only shipments:read can look up but not reschedule", async () => {
    const reader = await h.connect(await h.mint({ scope: "shipments:read" }));
    expectOk(await call("get_shipment", { tracking_no: "KRV00000001" }, reader), SHIPMENT);
    const result = await call(
      "reschedule_delivery",
      { tracking_no: "KRV00000001", new_date: "2026-10-14", verification_code: "1234" },
      reader,
    );
    expectError(result, "insufficient_scope: deliveries:write");
  });
});

describe("logs (SPEC §6)", () => {
  it("log tool calls as JSON lines without personal data", async () => {
    h.logs.length = 0;
    await call("reschedule_delivery", { tracking_no: "KRV00000002", new_date: "2026-10-14", verification_code: "4321" });
    const line = h.logs.find((l) => l.tool === "reschedule_delivery");
    expect(line).toMatchObject({ level: "warn", service: "mcp", status: 409, tool: "reschedule_delivery" });
    expect(typeof line?.ts).toBe("string");
    expect(typeof line?.msg).toBe("string");
    expect(typeof line?.trace_id).toBe("string");
    expect(typeof line?.duration_ms).toBe("number");
    expect(JSON.stringify(h.logs)).not.toContain("4321");
  });
});
