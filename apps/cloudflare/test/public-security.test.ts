import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { readJson } from "../src/http.js";
import { allowedBrowserOrigin, consumePublicLimit } from "../src/public-security.js";
import { SessionAuthority } from "../src/session-authority.js";

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(
      new URL("../migrations/control/0007_public_request_limits.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(
    "create table waitlist_signups(id text, email text unique, source text, consent_at text, ip_hash text, created_at text)",
  );
  const CONTROL_DB = {
    prepare(query: string) {
      return {
        bind(...values: Array<string | number>) {
          return {
            async first() {
              return sql.prepare(query).get(...values) ?? null;
            },
            async run() {
              return { meta: { changes: Number(sql.prepare(query).run(...values).changes) } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { sql, env: { CONTROL_DB, ENVIRONMENT: "development" } as unknown as Env };
}

describe("public request boundaries", () => {
  it("bounds actual streamed bytes even without Content-Length", async () => {
    const result = await readJson(
      new Request("https://test/", {
        method: "POST",
        body: JSON.stringify({ text: "é".repeat(20) }),
      }),
      32,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("does not allow a development origin to submit to production", () => {
    expect(allowedBrowserOrigin("http://localhost:5174", "development")).toBe(true);
    expect(allowedBrowserOrigin("http://localhost:5174", "production")).toBe(false);
    expect(allowedBrowserOrigin("https://dev.eventforge.dev", "production")).toBe(false);
    expect(allowedBrowserOrigin("https://eventforge.dev.evil.test", "production")).toBe(false);
  });

  it("allows at most five concurrent attempts and stores no raw email", async () => {
    const { sql, env } = fixture();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => consumePublicLimit(env, "email", "private@example.test", 5)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(5);
    expect(JSON.stringify(sql.prepare("select * from public_request_limits").all())).not.toContain(
      "private@",
    );
    await expect(
      consumePublicLimit({ ...env, ENVIRONMENT: "production" }, "email", "x", 5),
    ).rejects.toThrow("not configured");
    sql.close();
  });

  it("rejects null/array bodies before database access on waitlist and auth", async () => {
    for (const path of ["/v1/waitlist", "/api/auth/request", "/api/auth/login", "/api/auth/verify"])
      for (const body of ["null", "[]", "false"])
        expect(
          (
            await worker.fetch(
              new Request(`https://api.eventforge.dev${path}`, { method: "POST", body }),
              { ENVIRONMENT: "production" } as Env,
            )
          ).status,
        ).toBe(400);
  });

  it("does not expose existing waitlist addresses and counts duplicate attempts", async () => {
    const { sql, env } = fixture();
    const submit = () =>
      worker.fetch(
        new Request("https://api.eventforge.dev/v1/waitlist", {
          method: "POST",
          headers: { origin: "http://localhost:5174" },
          body: JSON.stringify({ email: "test@example.test", consent: true }),
        }),
        env,
      );
    for (let i = 0; i < 5; i++) {
      const response = await submit();
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true });
    }
    expect((await submit()).status).toBe(429);
    expect(sql.prepare("select count(*) as n from waitlist_signups").get()?.n).toBe(1);
    sql.close();
  });

  it("rejects login CSRF before credential work", async () => {
    const response = await worker.fetch(
      new Request("https://api.eventforge.dev/api/auth/login", {
        method: "POST",
        headers: { origin: "https://evil.test" },
        body: "{}",
      }),
      { ENVIRONMENT: "production" } as Env,
    );
    expect(response.status).toBe(403);
  });
});

it("expires sessions on the server and denies unknown/revoked IDs without throwing", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    "create table authority_meta(key text primary key,value text); insert into authority_meta values ('blocked','0'),('quarantined','0'),('epoch','0'); create table sessions(id text, request_token text, membership_version integer, created_at text, last_used_at text, user_agent_label text, ip_label text)",
  );
  const ctx = {
    blockConcurrencyWhile() {},
    storage: {
      sql: {
        exec(query: string, ...values: Array<string | number>) {
          const rows = sql.prepare(query).all(...values);
          return {
            toArray: () => rows,
            one: () => {
              if (rows.length !== 1) throw new Error("Expected one row");
              return rows[0];
            },
          };
        },
      },
    },
  } as unknown as DurableObjectState;
  const authority = new SessionAuthority(ctx, {} as Env);
  expect((await authority.validate("missing", "token", 1)).ok).toBe(false);
  for (const createdAt of [
    new Date().toISOString(),
    new Date(Date.now() - 12 * 3600_000).toISOString(),
    "invalid",
  ]) {
    sql.prepare("delete from sessions").run();
    sql
      .prepare("insert into sessions values ('s','token',1,?,'','desktop','unknown')")
      .run(createdAt);
    expect((await authority.validate("s", "token", 1)).ok).toBe(
      createdAt !== "invalid" && Date.now() - Date.parse(createdAt) < 12 * 3600_000,
    );
  }
  sql.close();
});
