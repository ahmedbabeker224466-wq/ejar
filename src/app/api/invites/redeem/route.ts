import { NextResponse } from "next/server";
import { isRole } from "@/lib/auth/roles";
import {
  decideRedemption,
  normalizeInviteCode,
  redeemErrorMessages,
  type InviteForRedemption,
  type RedeemError,
} from "@/lib/invites/redeem";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const GENERIC_ERROR = "تعذّر تفعيل الكود الآن، حاول مرة أخرى";

function fail(error: RedeemError, status = 400) {
  return NextResponse.json({ error: redeemErrorMessages[error] }, { status });
}

/**
 * Redeems an invite code for the signed-in user. The decision is made by the
 * pure decideRedemption(); this handler only loads data and applies it.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "سجّل الدخول أولاً" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const code = normalizeInviteCode(typeof body?.code === "string" ? body.code : "");
  if (!code) return fail("invalid_format");

  const admin = createAdminClient();
  const now = new Date();

  try {
    const [{ data: profile, error: profileError }, { data: invite, error: inviteError }] =
      await Promise.all([
        admin.from("profiles").select("role").eq("id", user.id).maybeSingle(),
        admin
          .from("invites")
          .select("id, kind, landlord_id, contract_id, used_by, expires_at")
          .eq("code", code)
          .maybeSingle<InviteForRedemption>(),
      ]);
    if (profileError) throw profileError;
    if (inviteError) throw inviteError;

    const decision = decideRedemption({
      invite,
      currentRole: isRole(profile?.role) ? profile.role : null,
      now,
    });
    if (!decision.ok) return fail(decision.error);

    // Claim the invite atomically: only one request can flip used_by from null.
    const { data: claimed, error: claimError } = await admin
      .from("invites")
      .update({ used_by: user.id, used_at: now.toISOString() })
      .eq("id", decision.inviteId)
      .is("used_by", null)
      .gt("expires_at", now.toISOString())
      .select("id");
    if (claimError) throw claimError;
    if (!claimed?.length) return fail("used");

    const release = async () => {
      await admin
        .from("invites")
        .update({ used_by: null, used_at: null })
        .eq("id", decision.inviteId);
      await admin.from("profiles").update({ role: null }).eq("id", user.id);
    };

    const { error: upsertError } = await admin
      .from("profiles")
      .upsert({ id: user.id, role: decision.role, phone: user.phone ?? null });
    if (upsertError) {
      await release();
      throw upsertError;
    }

    if (decision.role === "landlord") {
      const { data: linked, error: linkError } = await admin
        .from("landlords")
        .update({ user_id: user.id })
        .eq("id", decision.landlordId)
        .is("user_id", null)
        .select("id");
      if (linkError || !linked?.length) {
        await release();
        if (linkError) throw linkError;
        return fail("landlord_taken", 409);
      }
    } else {
      const { error: memberError } = await admin
        .from("contract_members")
        .upsert(
          { contract_id: decision.contractId, user_id: user.id, role: "tenant" },
          { onConflict: "contract_id,user_id", ignoreDuplicates: true },
        );
      if (memberError) {
        await release();
        throw memberError;
      }
    }

    return NextResponse.json({ redirect: `/${decision.role}` });
  } catch {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
