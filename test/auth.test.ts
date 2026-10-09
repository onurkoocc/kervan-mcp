import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ISSUER, newSigner, RESOURCE, startFake, startHarness, type Harness } from "./helpers.js";
import { createTokenVerifier, KeysUnavailableError } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const PRM = 'resource_metadata="http://mcp:3001/.well-known/oauth-protected-resource"';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

async function expectInvalid(token: string, reason: string): Promise<void> {
  const res = await h.rpc(token, "tools/list");
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe(`Bearer ${PRM}, error="invalid_token"`);
  expect(await res.json()).toMatchObject({ error: "invalid_token" });
  expect(h.logs.at(-1)).toMatchObject({ level: "warn", service: "mcp", status: 401, reason });
}

describe("bearer token validation (SPEC §3.5)", () => {
  it("accepts a valid token", async () => {
    const res = await h.rpc(await h.mint(), "tools/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      "get_shipment",
      "reschedule_delivery",
      "open_ticket",
      "search_help",
    ]);
  });

  it("works through the SDK client (initialize, then tools/list)", async () => {
    const client = await h.connect(await h.mint());
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
  });

  it("answers 401 without error code when the token is missing", async () => {
    const res = await h.rpc(undefined, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer ${PRM}`);
  });

  it("treats a non-Bearer Authorization header as missing", async () => {
    const res = await fetch(h.mcpUrl, { method: "POST", headers: { Authorization: "Basic dXNlcjpwYXNz" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer ${PRM}`);
  });

  it("rejects a token for another audience", async () => {
    await expectInvalid(await h.mint({ aud: "http://other:3001/mcp" }), "aud_mismatch");
  });

  it("compares aud exactly: no trailing slash, no case folding, no arrays", async () => {
    await expectInvalid(await h.mint({ aud: `${RESOURCE}/` }), "aud_mismatch");
    await expectInvalid(await h.mint({ aud: RESOURCE.toUpperCase() }), "aud_mismatch");
    await expectInvalid(await h.mint({ aud: [RESOURCE] }), "aud_mismatch");
  });

  it("rejects a token from another issuer", async () => {
    await expectInvalid(await h.mint({ iss: "http://evil:9000" }), "ERR_JWT_CLAIM_VALIDATION_FAILED");
  });

  it("rejects an expired token", async () => {
    await expectInvalid(await h.mint({ expiresIn: -10 }), "ERR_JWT_EXPIRED");
  });

  it("rejects a token without exp", async () => {
    await expectInvalid(await h.mint({ omitExp: true }), "ERR_JWT_CLAIM_VALIDATION_FAILED");
  });

  it("rejects a bad signature (other key, same kid)", async () => {
    const forger = await newSigner(h.signer.kid);
    await expectInvalid(await h.mint({ signer: forger }), "ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
  });

  it("rejects a token signed with an unknown kid", async () => {
    const stranger = await newSigner("unknown-kid");
    await expectInvalid(await h.mint({ signer: stranger }), "ERR_JWKS_NO_MATCHING_KEY");
  });

  it("rejects garbage", async () => {
    await expectInvalid("not-a-jwt", "ERR_JWS_INVALID");
  });

  it("guards GET and DELETE on /mcp too", async () => {
    const get = await fetch(h.mcpUrl);
    expect(get.status).toBe(401);
    const del = await fetch(h.mcpUrl, { method: "DELETE", headers: { Authorization: `Bearer ${await h.mint()}` } });
    expect(del.status).toBe(405);
  });

  it("never logs the token", () => {
    expect(JSON.stringify(h.logs)).not.toMatch(/eyJ/);
  });
});

describe("unauthenticated endpoints", () => {
  it("serves protected resource metadata (RFC 9728)", async () => {
    const res = await fetch(`${h.baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["shipments:read", "deliveries:write", "tickets:write", "help:read"],
      bearer_methods_supported: ["header"],
    });
  });

  it("serves /health", async () => {
    const res = await fetch(`${h.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("JWKS outage", () => {
  it("is not reported as an invalid token", async () => {
    const down = await startFake(() => ({ status: 503, body: { error: "down" } }));
    const config = loadConfig({ AUTH_JWKS_URL: `${down.url}/jwks.json`, AUTH_ISSUER: ISSUER, MCP_RESOURCE: RESOURCE });
    const verifier = createTokenVerifier(config);
    await expect(verifier.verify(await h.mint())).rejects.toBeInstanceOf(KeysUnavailableError);
    await down.close();
  });
});
