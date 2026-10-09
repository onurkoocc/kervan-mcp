import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";
import { createApp } from "../src/app.js";
import { loadConfig, SCOPES, type Config } from "../src/config.js";
import { createLogger } from "../src/log.js";

export const RESOURCE = "http://mcp:3001/mcp";
export const ISSUER = "http://auth:9000";
export const SERVICE_TOKEN = "svc-test-token";
export const CLIENT_ID = "http://voice:7000/client-metadata.json";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

type Handler = (req: Recorded) => { status: number; body?: unknown };

export interface FakeServer {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** A local JSON HTTP server that records every request. */
export async function startFake(handler: Handler): Promise<FakeServer> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(recorded);
      const { status, body } = handler(recorded);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  return { url: await listen(server), requests, close: () => close(server) };
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

export function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export interface Signer {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

export async function newSigner(kid: string): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  return { kid, privateKey, publicJwk };
}

export interface MintOptions {
  scope?: string;
  aud?: string | string[];
  iss?: string;
  expiresIn?: number;
  signer?: Signer;
  kid?: string;
  omitExp?: boolean;
}

export const SHIPMENT = {
  trackingNo: "KRV00000001",
  status: "IN_TRANSIT",
  originCity: "Istanbul",
  destinationCity: "Ankara",
  estimatedDelivery: "2026-10-12",
  lastEvent: { at: "2026-10-09T08:00:00Z", description: "Departed Istanbul hub" },
};
export const DELIVERY = {
  trackingNo: "KRV00000001",
  deliveryDate: "2026-10-14",
  window: "MORNING",
  status: "RESCHEDULED",
  attempts: 0,
};
export const TICKET = {
  ticketId: "TCK-000042",
  trackingNo: "KRV00000001",
  category: "DAMAGED",
  description: "Box arrived crushed",
  status: "OPEN",
  channel: "agent",
  createdAt: "2026-10-09T09:00:00Z",
};
export const SEARCH = {
  results: [{ id: "kb-001", title: "Changing your delivery date", snippet: "You can move a delivery…", score: 0.91 }],
};

function fakeCore(req: Recorded): { status: number; body?: unknown } {
  if (req.headers["x-service-token"] !== SERVICE_TOKEN) return { status: 401, body: { error: "unauthorized" } };
  const err = (status: number, error: string) => ({ status, body: { error, message: `${error} (fake)` } });
  const path = req.url;
  if (req.method === "GET" && path === "/api/v1/shipments/KRV00000001") return { status: 200, body: SHIPMENT };
  if (req.method === "GET" && path.startsWith("/api/v1/shipments/")) return err(404, "not_found");
  if (req.method === "POST" && path === "/api/v1/shipments/KRV00000001/reschedule") {
    const body = req.body as { verificationCode?: string; newDate?: string };
    if (body.verificationCode !== "1234") return err(403, "verification_failed");
    if (body.newDate === "2020-01-01") return err(400, "invalid_date");
    return { status: 200, body: DELIVERY };
  }
  if (req.method === "POST" && path === "/api/v1/shipments/KRV00000002/reschedule") return err(409, "not_reschedulable");
  if (req.method === "POST" && path === "/api/v1/shipments/KRV00000003/reschedule") return { status: 500 };
  if (req.method === "POST" && path.endsWith("/reschedule")) return err(404, "not_found");
  if (req.method === "POST" && path === "/api/v1/tickets") {
    const body = req.body as { trackingNo?: string };
    if (body.trackingNo === "KRV99999999") return err(404, "not_found");
    return { status: 201, body: { ...TICKET, trackingNo: body.trackingNo ?? null } };
  }
  return err(404, "not_found");
}

export interface Harness {
  config: Config;
  mcpUrl: string;
  baseUrl: string;
  core: FakeServer;
  search: FakeServer;
  jwks: FakeServer;
  signer: Signer;
  logs: Record<string, unknown>[];
  mint(options?: MintOptions): Promise<string>;
  connect(token: string): Promise<Client>;
  rpc(token: string | undefined, method: string, params?: unknown): Promise<Response>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const signer = await newSigner("kervan-test-1");
  const jwks = await startFake(() => ({ status: 200, body: { keys: [signer.publicJwk] } }));
  const core = await startFake(fakeCore);
  const search = await startFake(() => ({ status: 200, body: SEARCH }));

  const config = loadConfig({
    PORT: "0",
    MCP_RESOURCE: RESOURCE,
    AUTH_ISSUER: ISSUER,
    AUTH_JWKS_URL: `${jwks.url}/jwks.json`,
    CORE_URL: core.url,
    SEARCH_URL: search.url,
    SERVICE_TOKEN,
  });
  const logs: Record<string, unknown>[] = [];
  const log = createLogger({ stdout: (line) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  const server = createApp(config, log).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const clients: Client[] = [];

  const mint = async (o: MintOptions = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const payload: JWTPayload = { scope: o.scope ?? SCOPES.join(" "), client_id: CLIENT_ID, iat: now };
    if (!o.omitExp) payload.exp = now + (o.expiresIn ?? 300);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: o.kid ?? (o.signer ?? signer).kid })
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? RESOURCE)
      .setSubject(CLIENT_ID)
      .setJti(crypto.randomUUID())
      .sign((o.signer ?? signer).privateKey);
  };

  return {
    config,
    mcpUrl,
    baseUrl,
    core,
    search,
    jwks,
    signer,
    logs,
    mint,
    async connect(token) {
      const client = new Client({ name: "kervan-mcp-test", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    rpc(token, method, params = {}) {
      return fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    },
    async close() {
      await Promise.all(clients.map((c) => c.close()));
      await close(server);
      await Promise.all([jwks.close(), core.close(), search.close()]);
    },
  };
}
