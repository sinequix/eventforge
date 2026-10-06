import { hashToken } from "./auth.js";

export function allowedBrowserOrigin(origin: string, environment: string): boolean {
  if (origin === "https://eventforge.dev") return true;
  if (environment === "production") return false;
  return (
    origin === "https://dev.eventforge.dev" ||
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
  );
}

// One atomic upsert per key: concurrent requests cannot all read the same count.
// Fixed windows expire logically; the scheduled handler prunes old buckets.
export async function consumePublicLimit(
  env: { CONTROL_DB: D1Database; ENVIRONMENT: string; WAITLIST_RATE_LIMIT_SECRET?: string },
  scope: string,
  subject: string,
  limit: number,
  seconds = 3600,
): Promise<boolean> {
  const secret =
    env.WAITLIST_RATE_LIMIT_SECRET ||
    (env.ENVIRONMENT === "development" ? "local-development" : undefined);
  if (!secret) throw new Error("public rate limiting is not configured");
  const key = await hashToken(`${secret}:${scope}:${subject}`);
  const window = Math.floor(Date.now() / (seconds * 1000));
  const result = await env.CONTROL_DB.prepare(
    "insert into public_request_limits (key, window, count, expires_at) values (?, ?, 1, ?) on conflict(key) do update set window = excluded.window, count = case when public_request_limits.window = excluded.window then public_request_limits.count + 1 else 1 end, expires_at = excluded.expires_at where public_request_limits.window <> excluded.window or public_request_limits.count < ? returning count",
  )
    .bind(key, window, (window + 1) * seconds * 1000, limit)
    .first<{ count: number }>();
  return result !== null;
}
