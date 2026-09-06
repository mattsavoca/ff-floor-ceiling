import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  readSession,
} from "@/lib/server/session";

export async function GET() {
  const current = await readSession();
  const response = NextResponse.json({
    workspaceId: current?.workspaceId ?? null,
    expiresAt: current ? new Date(current.expiresAtMs).toISOString() : null,
    temporary: true,
  });

  if (!current) {
    const session = createSession();
    response.cookies.set({ name: SESSION_COOKIE, value: session.token, ...cookieOptions(true) });
    response.cookies.set({ name: CSRF_COOKIE, value: session.csrfToken, ...cookieOptions(false) });
  } else {
    const cookieStore = await cookies();
    if (!cookieStore.get(CSRF_COOKIE)?.value) {
      response.cookies.set({ name: CSRF_COOKIE, value: crypto.randomUUID().replaceAll("-", ""), ...cookieOptions(false) });
    }
  }

  response.headers.set("Cache-Control", "no-store");
  return response;
}
