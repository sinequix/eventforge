import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  captchaRequired,
  PBKDF2_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  constantTimeEqual,
  hashPassword,
  lockStateFor,
  nextFailureState,
  passwordComplaint,
  verifyPassword,
  verifyTurnstile,
} from "../src/passwords.js";

describe("password hashing", () => {
  it("round-trips a password and rejects the wrong one", async () => {
    const record = await hashPassword("correct horse battery staple");
    expect(record.iterations).toBe(PBKDF2_ITERATIONS);
    expect(record.algorithm).toBe("pbkdf2-sha256");
    await expect(verifyPassword("correct horse battery staple", record)).resolves.toBe(true);
    await expect(verifyPassword("Correct horse battery staple", record)).resolves.toBe(false);
    await expect(verifyPassword("", record)).resolves.toBe(false);
  });

  it("never configures more iterations than workerd supports", () => {
    // workerd rejects PBKDF2 above 100k at runtime:
    //   "Pbkdf2 failed: iteration counts above 100000 are not supported"
    // Configuring more does not fail the build — it 500s every sign-in, which is
    // exactly how this was found. This test is the build-time guard.
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(PBKDF2_MAX_ITERATIONS);
    expect(PBKDF2_MAX_ITERATIONS).toBe(100_000);
  });

  it("refuses a stored row above the platform cap instead of throwing", async () => {
    // Rows written before the cap was known would otherwise crash the request.
    const record = await hashPassword("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", { ...record, iterations: 210_000 }),
    ).resolves.toBe(false);
  });

  it("salts every hash so identical passwords do not collide", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same-password-12"),
      hashPassword("same-password-12"),
    ]);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("fails closed on an unknown algorithm or a weakened iteration count", async () => {
    const record = await hashPassword("correct horse battery staple");
    // A downgraded algorithm must not fall through to a default verifier.
    await expect(
      verifyPassword("correct horse battery staple", { ...record, algorithm: "md5" }),
    ).resolves.toBe(false);
    // Someone lowering iterations in the database must not weaken verification.
    await expect(
      verifyPassword("correct horse battery staple", { ...record, iterations: 1 }),
    ).resolves.toBe(false);
    await expect(
      verifyPassword("correct horse battery staple", { ...record, salt: "not-hex" }),
    ).resolves.toBe(false);
  });

  it("compares without short-circuiting on length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("requires a length floor rather than character classes", () => {
    expect(passwordComplaint("short")).toContain("12");
    expect(passwordComplaint("            ")).toBeDefined();
    expect(passwordComplaint("a-long-enough-passphrase")).toBeUndefined();
  });
});

describe("login lockout", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z");

  it("does not lock a fresh account", () => {
    expect(lockStateFor(null, now).locked).toBe(false);
    expect(
      lockStateFor({ failed_count: 2, first_failed_at: null, locked_until: null }, now).locked,
    ).toBe(false);
  });

  it("stays locked until the lock expires", () => {
    const locked = lockStateFor(
      {
        failed_count: MAX_ATTEMPTS,
        first_failed_at: new Date(now - 1000).toISOString(),
        locked_until: new Date(now + 60_000).toISOString(),
      },
      now,
    );
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("treats an unparseable lock expiry as still locked, not as expired", () => {
    // The Date.parse NaN family again: `NaN > now` is false, so a naive check
    // would read a corrupt lock as released and reopen the account.
    const locked = lockStateFor(
      { failed_count: MAX_ATTEMPTS, first_failed_at: null, locked_until: "whenever" },
      now,
    );
    expect(locked.locked).toBe(true);
  });

  it("releases the lock once it has passed", () => {
    expect(
      lockStateFor(
        {
          failed_count: MAX_ATTEMPTS,
          first_failed_at: null,
          locked_until: new Date(now - 1).toISOString(),
        },
        now,
      ).locked,
    ).toBe(false);
  });

  it("locks after the configured number of failures and restarts a stale window", () => {
    let state = nextFailureState(null, now);
    expect(state.failedCount).toBe(1);
    expect(state.lockedUntil).toBeNull();

    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt += 1) {
      state = nextFailureState(
        { failed_count: state.failedCount, first_failed_at: state.firstFailedAt },
        now,
      );
      expect(state.lockedUntil, `attempt ${attempt} must not lock yet`).toBeNull();
    }
    state = nextFailureState(
      { failed_count: state.failedCount, first_failed_at: state.firstFailedAt },
      now,
    );
    expect(state.failedCount).toBe(MAX_ATTEMPTS);
    expect(state.lockedUntil).not.toBeNull();

    // A failure long after the window restarts the count rather than accumulating
    // forever, so an occasional typo cannot eventually lock a real user out.
    const stale = nextFailureState(
      { failed_count: 7, first_failed_at: new Date(now - 5 * 60 * 60_000).toISOString() },
      now,
    );
    expect(stale.failedCount).toBe(1);
    expect(stale.lockedUntil).toBeNull();
  });
});

describe("captcha requirement", () => {
  it("requires a captcha by default", () => {
    expect(captchaRequired({})).toBe(true);
    expect(captchaRequired({ ENVIRONMENT: "preview" })).toBe(true);
    expect(captchaRequired({ ENVIRONMENT: "production" })).toBe(true);
  });

  it("can be disabled only on a non-production surface", () => {
    expect(captchaRequired({ ENVIRONMENT: "preview", AUTH_CAPTCHA_DISABLED: "true" })).toBe(false);
    expect(captchaRequired({ ENVIRONMENT: "development", AUTH_CAPTCHA_DISABLED: "true" })).toBe(
      false,
    );
  });

  it("CANNOT be disabled in production even when the flag is set", () => {
    // The whole point of the two-condition check: a stray variable in the
    // production config must not silently remove the control.
    expect(captchaRequired({ ENVIRONMENT: "production", AUTH_CAPTCHA_DISABLED: "true" })).toBe(
      true,
    );
  });

  it('only accepts the exact string "true" as an opt-out', () => {
    // A truthy-ish value must not disable a security control by accident.
    for (const value of ["1", "yes", "TRUE", "True", "on", " true", "true ", ""])
      expect(
        captchaRequired({ ENVIRONMENT: "preview", AUTH_CAPTCHA_DISABLED: value }),
        `${JSON.stringify(value)} must not disable the captcha`,
      ).toBe(true);
  });

  it("a missing secret still does not disable the captcha", async () => {
    // Losing the secret must not be mistaken for a deliberate opt-out: the
    // requirement stays on and verifyTurnstile fails closed.
    expect(captchaRequired({ ENVIRONMENT: "preview" })).toBe(true);
    await expect(verifyTurnstile(undefined, "token", undefined)).resolves.toEqual({
      ok: false,
      reason: "captcha_unconfigured",
    });
  });
});

describe("turnstile verification", () => {
  const ok = async () => new Response(JSON.stringify({ success: true }));

  it("fails closed when no secret is configured", async () => {
    // Otherwise a missing secret would silently disable the captcha entirely.
    await expect(verifyTurnstile(undefined, "token", undefined, ok as never)).resolves.toEqual({
      ok: false,
      reason: "captcha_unconfigured",
    });
  });

  it("fails closed when the client sends no token", async () => {
    await expect(verifyTurnstile("secret", undefined, undefined, ok as never)).resolves.toEqual({
      ok: false,
      reason: "captcha_missing",
    });
  });

  it("accepts only a siteverify success", async () => {
    await expect(verifyTurnstile("secret", "token", "1.2.3.4", ok as never)).resolves.toEqual({
      ok: true,
    });
    const rejected = async () =>
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }));
    await expect(verifyTurnstile("secret", "token", undefined, rejected as never)).resolves.toEqual(
      {
        ok: false,
        reason: "invalid-input-response",
      },
    );
  });

  it("fails closed when siteverify is unreachable", async () => {
    const boom = async () => {
      throw new Error("network down");
    };
    await expect(verifyTurnstile("secret", "token", undefined, boom as never)).resolves.toEqual({
      ok: false,
      reason: "captcha_unavailable",
    });
  });
});
