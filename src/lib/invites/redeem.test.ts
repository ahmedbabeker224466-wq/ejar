import { describe, expect, it } from "vitest";
import {
  decideRedemption,
  normalizeInviteCode,
  type InviteForRedemption,
} from "./redeem";

const now = new Date("2026-09-27T12:00:00Z");

function invite(overrides: Partial<InviteForRedemption> = {}): InviteForRedemption {
  return {
    id: "invite-1",
    kind: "tenant",
    landlord_id: null,
    contract_id: "contract-1",
    used_by: null,
    expires_at: "2026-10-27T12:00:00Z",
    ...overrides,
  };
}

describe("normalizeInviteCode", () => {
  it("accepts a clean code", () => {
    expect(normalizeInviteCode("JC7CQFTA")).toBe("JC7CQFTA");
  });

  it("upper-cases and removes spaces and dashes", () => {
    expect(normalizeInviteCode(" jc7c-qfta ")).toBe("JC7CQFTA");
  });

  it("converts Arabic digits", () => {
    expect(normalizeInviteCode("JC٧CQFTA")).toBe("JC7CQFTA");
  });

  it("rejects look-alike characters that codes never contain", () => {
    for (const bad of ["JC0CQFTA", "JCOCQFTA", "JC1CQFTA", "JCICQFTA", "JCLCQFTA"]) {
      expect(normalizeInviteCode(bad)).toBeNull();
    }
  });

  it("rejects the wrong length", () => {
    expect(normalizeInviteCode("JC7CQFT")).toBeNull();
    expect(normalizeInviteCode("JC7CQFTAA")).toBeNull();
    expect(normalizeInviteCode("")).toBeNull();
  });
});

describe("decideRedemption", () => {
  it("grants the tenant role and the contract for a tenant invite", () => {
    expect(decideRedemption({ invite: invite(), currentRole: null, now })).toEqual({
      ok: true,
      role: "tenant",
      inviteId: "invite-1",
      contractId: "contract-1",
    });
  });

  it("grants the landlord role and the landlord row for a landlord invite", () => {
    const landlordInvite = invite({
      kind: "landlord",
      landlord_id: "landlord-1",
      contract_id: null,
    });
    expect(
      decideRedemption({ invite: landlordInvite, currentRole: null, now }),
    ).toEqual({
      ok: true,
      role: "landlord",
      inviteId: "invite-1",
      landlordId: "landlord-1",
    });
  });

  it("rejects a code that does not exist", () => {
    expect(decideRedemption({ invite: null, currentRole: null, now })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("rejects a used code", () => {
    expect(
      decideRedemption({ invite: invite({ used_by: "someone" }), currentRole: null, now }),
    ).toEqual({ ok: false, error: "used" });
  });

  it("rejects an expired code", () => {
    expect(
      decideRedemption({
        invite: invite({ expires_at: "2026-09-01T00:00:00Z" }),
        currentRole: null,
        now,
      }),
    ).toEqual({ ok: false, error: "expired" });
  });

  it("treats a code expiring exactly now as expired", () => {
    expect(
      decideRedemption({
        invite: invite({ expires_at: now.toISOString() }),
        currentRole: null,
        now,
      }),
    ).toEqual({ ok: false, error: "expired" });
  });

  it("reports a used code before an expired one", () => {
    expect(
      decideRedemption({
        invite: invite({ used_by: "someone", expires_at: "2026-09-01T00:00:00Z" }),
        currentRole: null,
        now,
      }),
    ).toEqual({ ok: false, error: "used" });
  });

  it("rejects users who already have a role", () => {
    for (const role of ["office", "landlord", "tenant"] as const) {
      expect(decideRedemption({ invite: invite(), currentRole: role, now })).toEqual({
        ok: false,
        error: "already_registered",
      });
    }
  });

  it("rejects a malformed invite row instead of granting access", () => {
    expect(
      decideRedemption({
        invite: invite({ kind: "landlord", landlord_id: null }),
        currentRole: null,
        now,
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });
});
