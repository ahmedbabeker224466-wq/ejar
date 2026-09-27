import { toWesternDigits } from "@/lib/phone";
import type { Role } from "@/lib/auth/roles";

/** Invite row fields needed to decide a redemption. */
export type InviteForRedemption = {
  id: string;
  kind: "landlord" | "tenant";
  landlord_id: string | null;
  contract_id: string | null;
  used_by: string | null;
  expires_at: string;
};

export type RedeemError =
  | "invalid_format"
  | "not_found"
  | "expired"
  | "used"
  | "already_registered"
  | "landlord_taken";

export type RedeemDecision =
  | { ok: false; error: RedeemError }
  | { ok: true; role: "landlord"; inviteId: string; landlordId: string }
  | { ok: true; role: "tenant"; inviteId: string; contractId: string };

export const redeemErrorMessages: Record<RedeemError, string> = {
  invalid_format: "الكود يتكون من 8 حروف وأرقام، تأكد منه وحاول مرة أخرى",
  not_found: "الكود غير صحيح، تأكد منه أو اطلب كوداً جديداً من مكتب العقار",
  expired: "انتهت صلاحية هذا الكود، اطلب كوداً جديداً من مكتب العقار",
  used: "هذا الكود مستخدم من قبل، اطلب كوداً جديداً من مكتب العقار",
  already_registered: "حسابك مفعّل مسبقاً ولا يحتاج كود دعوة",
  landlord_taken: "هذا المؤجر مرتبط بحساب آخر، تواصل مع مكتب العقار",
};

const CODE_PATTERN = /^[A-HJKMNP-Z2-9]{8}$/;

/**
 * Cleans what the user typed: removes spaces and dashes, converts Arabic
 * digits and upper-cases letters. Returns null if it cannot be a valid code.
 */
export function normalizeInviteCode(input: string): string | null {
  const code = toWesternDigits(input).replace(/[\s-]/g, "").toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** Decides whether the current user may redeem the invite, and what it grants. */
export function decideRedemption(input: {
  invite: InviteForRedemption | null;
  currentRole: Role | null;
  now: Date;
}): RedeemDecision {
  const { invite, currentRole, now } = input;

  if (currentRole) return { ok: false, error: "already_registered" };
  if (!invite) return { ok: false, error: "not_found" };
  if (invite.used_by) return { ok: false, error: "used" };
  if (new Date(invite.expires_at).getTime() <= now.getTime()) {
    return { ok: false, error: "expired" };
  }

  if (invite.kind === "landlord" && invite.landlord_id) {
    return {
      ok: true,
      role: "landlord",
      inviteId: invite.id,
      landlordId: invite.landlord_id,
    };
  }
  if (invite.kind === "tenant" && invite.contract_id) {
    return {
      ok: true,
      role: "tenant",
      inviteId: invite.id,
      contractId: invite.contract_id,
    };
  }
  // The database constraints make this unreachable; treat it as unknown.
  return { ok: false, error: "not_found" };
}
