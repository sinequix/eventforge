import { describe, expect, it } from "vitest";
import {
  createReactionEnvelope,
  reserveReaction,
  type ReactionAuthority,
} from "../src/reaction-worker.js";

const now = new Date("2026-07-22T12:00:00.000Z");
const base = createReactionEnvelope({
  id: "00000000-0000-4000-8000-000000000020",
  workspaceId: "ws-a",
  installationId: "gh-1",
  provider: "github",
  resource: "sinequix/eventforge#20",
  action: { type: "github.comment", content: "Investigating." },
  policyVersion: 2,
  policyRule: "comment-only",
  approvalId: "00000000-0000-4000-8000-000000000021",
  approvalVersion: 1,
  approverId: "owner-a",
  expiresAt: "2026-07-22T12:05:00.000Z",
  budgetClass: "github_comment",
  idempotencyKey: "event:20:comment",
});
const authority: ReactionAuthority = {
  available: true,
  policyVersion: 2,
  allowedResources: [base.resource],
  allowedActionTypes: ["github.comment"],
  killEpochAt: now,
  credentialActive: true,
  budgetAvailable: true,
  resourceSlotsAvailable: true,
  workspaceSlotsAvailable: true,
};
const approval = {
  approvalId: base.approvalId,
  approvalVersion: 1,
  approverId: "owner-a",
  expiresAt: base.expiresAt,
  hash: base.hash,
  active: true,
  used: false,
};

describe("reaction worker reservation", () => {
  it("binds an approval to normalized exact content and rejects substitution", () => {
    const changed = { ...base, action: { type: "github.comment" as const, content: "Different." } };
    expect(reserveReaction({ envelope: changed, approval, authority, now })).toEqual({
      allowed: false,
      reason: "envelope_hash_mismatch",
    });
  });
  it("fails closed for stale approval, tenant scope, kill cache, and budget", () => {
    expect(
      reserveReaction({ envelope: base, approval: { ...approval, used: true }, authority, now })
        .allowed,
    ).toBe(false);
    expect(
      reserveReaction({
        envelope: base,
        approval,
        authority: { ...authority, allowedResources: ["other"] },
        now,
      }).allowed,
    ).toBe(false);
    expect(
      reserveReaction({
        envelope: base,
        approval,
        authority: { ...authority, killEpochAt: new Date(now.getTime() - 30_001) },
        now,
      }).allowed,
    ).toBe(false);
    expect(
      reserveReaction({
        envelope: base,
        approval,
        authority: { ...authority, budgetAvailable: false },
        now,
      }),
    ).toEqual({ allowed: false, reason: "budget_exhausted" });
    expect(
      reserveReaction({ envelope: { ...base, provider: "linear" }, approval, authority, now }),
    ).toEqual({ allowed: false, reason: "envelope_hash_mismatch" });
  });
  it("denies a kill cache dated in the future instead of trusting unbounded skew", () => {
    // A one-sided freshness check treats a future timestamp as maximally fresh, so a skewed
    // or forged killEpochAt would defeat the kill switch entirely rather than fail closed.
    for (const killEpochAt of [
      new Date(now.getTime() + 30_001),
      new Date(now.getTime() + 86_400_000),
      new Date(Number.NaN),
    ]) {
      expect(
        reserveReaction({
          envelope: base,
          approval,
          authority: { ...authority, killEpochAt },
          now,
        }),
      ).toEqual({
        allowed: false,
        reason: "kill_state_unavailable",
      });
    }
  });
  it("denies a malformed envelope instead of throwing past the guard", () => {
    // The guard must report a denial. Throwing is a fail-open in any caller that catches,
    // and it makes the rejection unobservable through the documented return type.
    const unnormalized = { ...base, resource: "  padded  " };
    expect(reserveReaction({ envelope: unnormalized, approval, authority, now })).toEqual({
      allowed: false,
      reason: "envelope_invalid",
    });
    const selfConflicting = {
      ...base,
      action: { type: "github.labels" as const, add: ["bug"], remove: ["bug"] },
    };
    expect(reserveReaction({ envelope: selfConflicting, approval, authority, now })).toEqual({
      allowed: false,
      reason: "envelope_invalid",
    });
  });
  it("permits only the exact active approval and preserves a single business identity", () => {
    expect(reserveReaction({ envelope: base, approval, authority, now })).toEqual({
      allowed: true,
      businessId: "event:20:comment",
    });
  });
});
