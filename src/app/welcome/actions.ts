"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type OfficeFormState = { error: string | null };

/** Makes the signed-in user an office owner and creates their office. */
export async function createOffice(
  _prev: OfficeFormState,
  formData: FormData,
): Promise<OfficeFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2 || name.length > 80) {
    return { error: "اكتب اسم المكتب (من حرفين إلى 80 حرفاً)" };
  }

  // Roles are only ever set here, on the server, with the service role key.
  const admin = createAdminClient();
  try {
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (profile?.role && profile.role !== "office") {
      return { error: "حسابك مسجّل بنوع آخر، لا يمكن تحويله إلى مكتب" };
    }

    const { error: upsertError } = await admin
      .from("profiles")
      .upsert({ id: user.id, role: "office", phone: user.phone ?? null });
    if (upsertError) throw upsertError;

    const { data: existing, error: existingError } = await admin
      .from("offices")
      .select("id")
      .eq("owner_id", user.id)
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;

    if (!existing) {
      const { error: insertError } = await admin
        .from("offices")
        .insert({ owner_id: user.id, name });
      if (insertError) throw insertError;
    }
  } catch {
    return { error: "تعذّر حفظ المكتب، حاول مرة أخرى" };
  }

  redirect("/office");
}
