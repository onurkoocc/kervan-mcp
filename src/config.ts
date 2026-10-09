/** Runtime configuration. Read from the environment only; defaults are the compose values (SPEC §2). */
export interface Config {
  port: number;
  /** Canonical resource identifier of this server. Tokens must carry exactly this `aud`. */
  resource: string;
  authIssuer: string;
  authJwksUrl: string;
  coreUrl: string;
  searchUrl: string;
  serviceToken: string;
  /** Unset: log to stdout only. */
  logFile: string | undefined;
}

export const SCOPES = ["shipments:read", "deliveries:write", "tickets:write", "help:read"] as const;
export type Scope = (typeof SCOPES)[number];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const value = (name: string, fallback: string): string => {
    const v = env[name];
    return v === undefined || v === "" ? fallback : v;
  };
  const port = Number(value("PORT", "3001"));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${JSON.stringify(env.PORT)}`);
  }
  return {
    port,
    resource: value("MCP_RESOURCE", "http://mcp:3001/mcp"),
    authIssuer: value("AUTH_ISSUER", "http://auth:9000"),
    authJwksUrl: value("AUTH_JWKS_URL", "http://auth:9000/jwks.json"),
    coreUrl: value("CORE_URL", "http://core:8080"),
    searchUrl: value("SEARCH_URL", "http://search:8001"),
    serviceToken: value("SERVICE_TOKEN", "svc-dev-token"),
    logFile: env.LOG_FILE === "" ? undefined : env.LOG_FILE,
  };
}

/** The RFC 9728 metadata URL advertised in `WWW-Authenticate` (served at the resource's origin). */
export function protectedResourceMetadataUrl(config: Config): string {
  return new URL("/.well-known/oauth-protected-resource", config.resource).href;
}
