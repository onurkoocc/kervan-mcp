import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { protectedResourceMetadataUrl, type Config } from "./config.js";
import type { Logger } from "./log.js";

/** The token is missing, malformed, or fails a check: answer 401 `invalid_token`. */
export class InvalidTokenError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "InvalidTokenError";
  }
}

/** The keys could not be fetched: the token was not judged, so answer 503. */
export class KeysUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "KeysUnavailableError";
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthInfo>;
}

/**
 * Validates kervan-auth access tokens (SPEC §3.4, §3.5): ES256 signature from the
 * issuer's JWKS, `iss == AUTH_ISSUER`, `aud == MCP_RESOURCE` exactly, not expired.
 */
export function createTokenVerifier(config: Config, keys?: JWTVerifyGetKey): TokenVerifier {
  const jwks = keys ?? createRemoteJWKSet(new URL(config.authJwksUrl), { timeoutDuration: 2000 });

  return {
    async verify(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: config.authIssuer,
          algorithms: ["ES256"],
          requiredClaims: ["exp"],
        }));
      } catch (err) {
        if (keysUnavailable(err)) {
          throw new KeysUnavailableError(err instanceof Error ? err.message : String(err));
        }
        throw new InvalidTokenError((err as errors.JOSEError).code);
      }

      // Exact string comparison, on purpose: no array audiences, no trailing-slash or case leniency.
      if (typeof payload.aud !== "string" || payload.aud !== config.resource) {
        throw new InvalidTokenError("aud_mismatch");
      }

      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
      const clientId =
        typeof payload.client_id === "string" ? payload.client_id : typeof payload.sub === "string" ? payload.sub : "";
      return {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        resource: new URL(payload.aud),
      };
    },
  };
}

/**
 * Failures that say nothing about the token: the JWKS fetch timed out, failed, answered
 * non-200 (jose raises a plain JOSEError for that) or returned an unusable key set.
 */
function keysUnavailable(err: unknown): boolean {
  return (
    !(err instanceof errors.JOSEError) ||
    err instanceof errors.JWKSTimeout ||
    err instanceof errors.JWKSInvalid ||
    err.constructor === errors.JOSEError
  );
}

/** Express middleware guarding the MCP endpoint. Sets `req.auth` for the SDK transport. */
export function bearerAuth(config: Config, verifier: TokenVerifier, log: Logger) {
  const metadata = `resource_metadata="${protectedResourceMetadataUrl(config)}"`;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const traceId = res.locals.traceId as string | undefined;
    const header = req.headers.authorization;
    const match = header ? /^Bearer(?: +(.*))?$/i.exec(header) : null;

    if (!match) {
      log.warn("unauthenticated request", { trace_id: traceId, status: 401, reason: "missing_token" });
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer ${metadata}`)
        .json({ error: "unauthorized", error_description: "Bearer token required" });
      return;
    }

    try {
      const token = match[1]?.trim() ?? "";
      if (!token) throw new InvalidTokenError("empty_token");
      (req as Request & { auth?: AuthInfo }).auth = await verifier.verify(token);
      next();
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        log.warn("token rejected", { trace_id: traceId, status: 401, reason: err.reason });
        res
          .status(401)
          .set("WWW-Authenticate", `Bearer ${metadata}, error="invalid_token"`)
          .json({ error: "invalid_token", error_description: "The access token is invalid" });
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      log.error("token verification unavailable", { trace_id: traceId, status: 503, reason });
      res.status(503).json({ error: "temporarily_unavailable", error_description: "Cannot verify tokens right now" });
    }
  };
}
