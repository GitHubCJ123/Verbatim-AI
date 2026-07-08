import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2.106.1";

export const EDGE_APP_SECRET_HEADER = "x-verbatim-app-secret";

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    `authorization, x-client-info, apikey, content-type, ${EDGE_APP_SECRET_HEADER}`,
  "access-control-allow-methods": "POST, OPTIONS",
};

interface RateLimitConfig {
  userLimit: number;
  ipLimit: number;
  windowSeconds: number;
}

interface RequireEdgeAccessOptions {
  functionName: "transcribe" | "cleanup";
  maxBodyBytes: number;
  rateLimit: RateLimitConfig;
}

interface EdgeContext {
  user: User | null;
  ipHash: string;
}

type EdgeAccessResult =
  | { ok: true; context: EdgeContext }
  | { ok: false; response: Response };

type GuardResult = { ok: true } | { ok: false; response: Response };

const memoryRateLimits = new Map<string, { count: number; resetAt: number }>();
let anonClient: SupabaseClient | null = null;
let serviceClient: SupabaseClient | null = null;

export function clean(v: string | undefined): string | undefined {
  return v?.replace(/[\x00-\x1F\x7F]/g, "").trim();
}

export function envInt(name: string, fallback: number): number {
  const raw = clean(Deno.env.get(name));
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

export function genericCrash(functionName: string, e: unknown): Response {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  console.error(`${functionName} crash:`, msg);
  return json({ error: `${functionName} failed unexpectedly.` }, 500);
}

export async function requireEdgeAccess(
  req: Request,
  options: RequireEdgeAccessOptions,
): Promise<EdgeAccessResult> {
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const bytes = Number.parseInt(contentLength, 10);
    if (Number.isFinite(bytes) && bytes > options.maxBodyBytes) {
      return { ok: false, response: json({ error: "Request body is too large." }, 413) };
    }
  }

  const appSecretResult = verifyAppSecret(req);
  if (!appSecretResult.ok) return appSecretResult;

  // Enforcement is OFF by default so this change is safe to ship without a
  // coordinated rollout. Enable via EDGE_HARDENING_ENABLED=true ONLY AFTER
  // enabling Supabase anonymous sign-ins and applying migration 0014. While
  // off, the function behaves exactly as before (accepts the anon-key auth
  // Supabase already allows via --no-verify-jwt; no JWT requirement, no rate
  // limiting). The optional app-secret check above still applies if set.
  if (clean(Deno.env.get("EDGE_HARDENING_ENABLED")) !== "true") {
    return { ok: true, context: { user: null, ipHash: "" } };
  }

  const authResult = await verifyUser(req);
  if (!authResult.ok) return authResult;

  const ipHash = await hashIp(callerIp(req));
  const rateResult = await enforceRateLimits({
    functionName: options.functionName,
    userId: authResult.user.id,
    ipHash,
    config: options.rateLimit,
  });
  if (!rateResult.ok) return rateResult;

  return { ok: true, context: { user: authResult.user, ipHash } };
}

function verifyAppSecret(req: Request): GuardResult {
  const expected = clean(Deno.env.get("VERBATIM_EDGE_APP_SECRET"));
  if (!expected) return { ok: true };
  const supplied = clean(req.headers.get(EDGE_APP_SECRET_HEADER) ?? undefined);
  if (!supplied || !constantTimeEqual(supplied, expected)) {
    return { ok: false, response: json({ error: "Unauthorized." }, 401) };
  }
  return { ok: true };
}

async function verifyUser(req: Request): Promise<{ ok: true; user: User } | { ok: false; response: Response }> {
  const token = bearerToken(req);
  if (!token) return { ok: false, response: json({ error: "Missing bearer token." }, 401) };

  const anonKey = clean(Deno.env.get("SUPABASE_ANON_KEY"));
  if (anonKey && constantTimeEqual(token, anonKey)) {
    return { ok: false, response: json({ error: "A user session is required." }, 401) };
  }

  const client = getAnonClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.id) {
    console.warn("edge auth rejected request:", error?.message ?? "missing user");
    return { ok: false, response: json({ error: "A valid user session is required." }, 401) };
  }

  const claims = decodeJwtPayload(token);
  if (claims.role !== "authenticated" || claims.sub !== data.user.id) {
    return { ok: false, response: json({ error: "A valid user session is required." }, 401) };
  }

  return { ok: true, user: data.user };
}

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function getAnonClient(token: string): SupabaseClient {
  const url = clean(Deno.env.get("SUPABASE_URL"));
  const anonKey = clean(Deno.env.get("SUPABASE_ANON_KEY"));
  if (!url || !anonKey) throw new Error("Supabase auth environment is not configured.");
  anonClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return anonClient;
}

function getServiceClient(): SupabaseClient | null {
  const url = clean(Deno.env.get("SUPABASE_URL"));
  const key = clean(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!url || !key) return null;
  if (!serviceClient) {
    serviceClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceClient;
}

async function enforceRateLimits(input: {
  functionName: string;
  userId: string;
  ipHash: string;
  config: RateLimitConfig;
}): Promise<{ ok: true } | { ok: false; response: Response }> {
  const checks = [
    { kind: "user", key: input.userId, limit: input.config.userLimit },
    { kind: "ip", key: input.ipHash, limit: input.config.ipLimit },
  ];

  for (const check of checks) {
    const result = await checkRateLimit({
      functionName: input.functionName,
      limiterKind: check.kind,
      limiterKey: check.key,
      limit: check.limit,
      windowSeconds: input.config.windowSeconds,
    });
    if (!result.allowed) {
      return {
        ok: false,
        response: json(
          { error: "Rate limit exceeded." },
          429,
          { "retry-after": String(Math.max(1, result.retryAfterSeconds)) },
        ),
      };
    }
  }

  return { ok: true };
}

async function checkRateLimit(input: {
  functionName: string;
  limiterKind: string;
  limiterKey: string;
  limit: number;
  windowSeconds: number;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const client = getServiceClient();
  if (client) {
    const { data, error } = await client.rpc("check_edge_rate_limit", {
      p_function_name: input.functionName,
      p_limiter_kind: input.limiterKind,
      p_limiter_key: input.limiterKey,
      p_limit: input.limit,
      p_window_seconds: input.windowSeconds,
    });
    if (!error && Array.isArray(data) && data[0]) {
      const row = data[0] as { allowed: boolean; reset_at: string };
      const resetAt = Date.parse(row.reset_at);
      return {
        allowed: row.allowed,
        retryAfterSeconds: Number.isFinite(resetAt)
          ? Math.ceil((resetAt - Date.now()) / 1000)
          : input.windowSeconds,
      };
    }

    console.error("edge rate limit RPC failed:", error?.message ?? "empty response");
    if (clean(Deno.env.get("VERBATIM_RATE_LIMIT_STRICT")) === "1") {
      return { allowed: false, retryAfterSeconds: 60 };
    }
  }

  return checkMemoryRateLimit(input);
}

function checkMemoryRateLimit(input: {
  functionName: string;
  limiterKind: string;
  limiterKey: string;
  limit: number;
  windowSeconds: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const windowMs = input.windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `${input.functionName}:${input.limiterKind}:${input.limiterKey}:${windowStart}`;
  const current = memoryRateLimits.get(key);
  const next = current && current.resetAt > now
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: windowStart + windowMs };
  memoryRateLimits.set(key, next);
  pruneMemoryRateLimits(now);
  return {
    allowed: next.count <= input.limit,
    retryAfterSeconds: Math.ceil((next.resetAt - now) / 1000),
  };
}

function pruneMemoryRateLimits(now: number): void {
  if (memoryRateLimits.size < 5000) return;
  for (const [key, value] of memoryRateLimits) {
    if (value.resetAt <= now) memoryRateLimits.delete(key);
  }
}

function callerIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    forwarded ||
    "unknown"
  );
}

async function hashIp(ip: string): Promise<string> {
  const salt = clean(Deno.env.get("VERBATIM_RATE_LIMIT_IP_HASH_SALT")) ?? "verbatim-ai-edge";
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeJwtPayload(token: string): { sub?: string; role?: string } {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json) as { sub?: unknown; role?: unknown };
    return {
      sub: typeof parsed.sub === "string" ? parsed.sub : undefined,
      role: typeof parsed.role === "string" ? parsed.role : undefined,
    };
  } catch {
    return {};
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
