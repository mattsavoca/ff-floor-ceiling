import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "fc_session";
export const CSRF_COOKIE = "fc_csrf";
export const SESSION_AGE_SECONDS = 60 * 60 * 24;
const localSecret = "floor-ceiling-local-development-secret";

type SessionToken = {
  workspaceId: string;
  expiresAtMs: number;
  token: string;
};

function secret() {
  return process.env.FC_SESSION_SECRET ?? localSecret;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function makeToken(workspaceId: string, expiresAtMs: number) {
  const payload = `${workspaceId}.${expiresAtMs}`;
  return `${payload}.${sign(payload)}`;
}

function validSignature(signature: string, expected: string) {
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseToken(token: string): SessionToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [workspaceId, expiresAtText, signature] = parts;
  const expiresAtMs = Number(expiresAtText);
  if (!/^ws_[a-z0-9]{12}$/.test(workspaceId) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) return null;
  const payload = `${workspaceId}.${expiresAtMs}`;
  if (!validSignature(signature, sign(payload))) return null;
  return { workspaceId, expiresAtMs, token };
}

export async function readSession() {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE)?.value;
  return rawToken ? parseToken(rawToken) : null;
}

export function createSession() {
  const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const expiresAtMs = Date.now() + SESSION_AGE_SECONDS * 1000;
  return {
    workspaceId,
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    token: makeToken(workspaceId, expiresAtMs),
    csrfToken: crypto.randomUUID().replaceAll("-", ""),
  };
}

export function cookieOptions(httpOnly: boolean) {
  return {
    httpOnly,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_AGE_SECONDS,
  };
}

export async function hasValidCsrfToken(request: Request) {
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(CSRF_COOKIE)?.value;
  const headerToken = request.headers.get("x-csrf-token");
  return Boolean(cookieToken && headerToken && cookieToken === headerToken);
}
