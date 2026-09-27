import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { destinationFor } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { WelcomeFlow } from "./WelcomeFlow";

export const metadata: Metadata = { title: "أهلاً بك | عقدي" };

export default async function WelcomePage() {
  const { account } = await requireUser();
  const home = destinationFor({
    role: account.role,
    hasOffice: account.officeId !== null,
  });
  if (home !== "/welcome") redirect(home);

  // An office that stopped before naming its office continues from that step.
  return <WelcomeFlow initialStep={account.role === "office" ? "office" : "choose"} />;
}
