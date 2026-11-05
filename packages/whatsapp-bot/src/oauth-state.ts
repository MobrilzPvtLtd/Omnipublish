import crypto from "node:crypto";

export interface OAuthContext { session: string; workspace: string }

export function createOAuthState(secret: string, context: OAuthContext, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, session: context.session, ws: context.workspace,
    ts: Date.now(), nonce: crypto.randomBytes(24).toString("hex") })).toString("base64url");
  return body + "." + crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

/** Verifica firma, sesión, negocio, proveedor y plazo. El caller reclama el nonce antes del intercambio. */
export function readOAuthState(secret: string, context: OAuthContext, state: string, platforms: readonly string[]): Record<string, any> | null {
  if (!state || state.length > 4096) return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data || !Number.isFinite(data.ts) || data.ts > Date.now() + 30000 || Date.now() - data.ts > 300000
      || data.session !== context.session || !context.session || data.ws !== context.workspace
      || !platforms.includes(data.platform) || !/^[0-9a-f]{48}$/.test(data.nonce)) return null;
    return data;
  } catch { return null; }
}
