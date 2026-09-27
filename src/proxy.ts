import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { loadAccount } from "@/lib/auth/account";
import { areaForPath, destinationFor } from "@/lib/auth/roles";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Refreshes the Supabase session on every request and keeps users inside
 * their own role area. Role layouts check again on render.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        Object.entries(headers).forEach(([key, value]) =>
          response.headers.set(key, value),
        );
      },
    },
  });

  // Validates the token with Supabase and refreshes it when needed.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const area = areaForPath(pathname);
  const needsUser = area !== null || pathname === "/welcome";

  if (!user) {
    return needsUser ? redirectTo(request, response, "/login") : response;
  }

  if (pathname === "/login") return redirectTo(request, response, "/");

  if (needsUser) {
    const account = await loadAccount(supabase, user.id);
    const home = destinationFor({
      role: account.role,
      hasOffice: account.officeId !== null,
    });
    if (area !== null && home !== `/${area}`) {
      return redirectTo(request, response, home);
    }
    if (pathname === "/welcome" && home !== "/welcome") {
      return redirectTo(request, response, home);
    }
  }

  return response;
}

/** Redirect that keeps any refreshed session cookies. */
function redirectTo(request: NextRequest, from: NextResponse, path: string) {
  const redirect = NextResponse.redirect(new URL(path, request.url));
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api/|icons/|sw\\.js|manifest\\.webmanifest|icon\\.png|apple-icon\\.png).*)",
  ],
};
