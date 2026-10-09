# kervan-mcp

The MCP resource server of Kervan, a fictional cargo company used as a reference
system for Mandate's brownfield work. It exposes four customer tools over MCP
Streamable HTTP and accepts only access tokens issued by `kervan-auth` for this
exact resource. The cross-repository contract (hostnames, ports, token format,
tool shapes) lives in the Kervan `SPEC.md`; this README only says how this
repository implements it. All data is synthetic.

```text
voice ──(MCP, Bearer JWT)──▶ mcp ──(JWKS)──────────────▶ auth
                             mcp ──(REST, X-Service-Token)──▶ core
                             mcp ──(REST)──────────────────▶ search
```

## Endpoints

| Method and path | Auth | Answer |
|---|---|---|
| `POST /mcp` | Bearer | MCP JSON-RPC (stateless Streamable HTTP, JSON responses) |
| `GET`/`DELETE /mcp` | Bearer | 405: stateless server, no SSE stream or session |
| `GET /.well-known/oauth-protected-resource` | none | RFC 9728 metadata |
| `GET /health` | none | `{"status":"ok"}` |

### Token checks

Every `/mcp` request needs `Authorization: Bearer <token>`. The token must be an
ES256 JWT that verifies against `AUTH_JWKS_URL`, with `iss == AUTH_ISSUER`,
`aud == MCP_RESOURCE` (exact string comparison: no arrays, no trailing-slash or
case leniency) and an `exp` in the future.

- Missing token: `401`, `WWW-Authenticate: Bearer resource_metadata="<origin of MCP_RESOURCE>/.well-known/oauth-protected-resource"`.
- Invalid token: `401`, the same header plus `, error="invalid_token"`.
- JWKS unreachable or not `200`: `503` (the token was not judged).

### Tools

`docs/mcp-tools.json` is exactly what `tools/list` returns; `test/contract.test.ts`
checks it. After changing a tool, regenerate it with `npm run docs:tools`.

| Tool | Scope | Calls |
|---|---|---|
| `get_shipment` | `shipments:read` | `GET {CORE_URL}/api/v1/shipments/{tracking_no}` |
| `reschedule_delivery` | `deliveries:write` | `POST {CORE_URL}/api/v1/shipments/{tracking_no}/reschedule` |
| `open_ticket` | `tickets:write` | `POST {CORE_URL}/api/v1/tickets` with `channel: "agent"` |
| `search_help` | `help:read` | `GET {SEARCH_URL}/search?q=…&k=3` |

Core is called with `X-Service-Token: $SERVICE_TOKEN`. A successful answer is
returned as text JSON and as `structuredContent`. Errors are tool results with
`isError: true`, never JSON-RPC errors:

| Situation | Text |
|---|---|
| Token lacks the tool's scope | `insufficient_scope: <scope>` |
| Upstream answers 4xx or 5xx | `<status> <error code>`, e.g. `409 not_reschedulable` (`upstream_error` when the body has no `error`) |
| Upstream unreachable or not JSON | `upstream_unavailable` |
| Arguments fail the input schema | the SDK's validation message |

## Configuration

Environment only; the defaults are the compose values.

| Variable | Default |
|---|---|
| `PORT` | `3001` |
| `MCP_RESOURCE` | `http://mcp:3001/mcp` |
| `AUTH_ISSUER` | `http://auth:9000` |
| `AUTH_JWKS_URL` | `http://auth:9000/jwks.json` |
| `CORE_URL` | `http://core:8080` |
| `SEARCH_URL` | `http://search:8001` |
| `SERVICE_TOKEN` | `svc-dev-token` |
| `LOG_FILE` | unset: stdout only (the image sets `/var/log/kervan/mcp.jsonl`) |

## Logs

One JSON object per line on stdout and appended to `LOG_FILE`:
`ts`, `level`, `service` (`mcp`), `msg`, and when they apply `trace_id`, `tool`,
`status`, `duration_ms`, `reason`. Tool arguments are never logged, so
verification codes and free text stay out; tokens are never logged. An incoming
`X-Trace-Id` is reused and forwarded to core and search.

## Development

Node 22 or later.

```sh
npm ci
npm run build        # tsc -> dist/
npm test             # vitest: local JWKS, fake core and fake search
npm start            # node dist/main.js
npm run docs:tools   # rewrite docs/mcp-tools.json from the code
```

## Container

```sh
docker build -t kervan-mcp .
docker run --rm -p 3001:3001 kervan-mcp
```

Dependencies are installed with `npm ci --ignore-scripts` in layers that see only
`package.json` and `package-lock.json`; the sources are compiled in a
`RUN --network=none` step. The runtime image is `node:22-slim`, runs as `node`,
and exposes port 3001.
