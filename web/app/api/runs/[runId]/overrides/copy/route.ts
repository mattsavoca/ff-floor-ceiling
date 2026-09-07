import { NextResponse } from "next/server";
import { hasValidCsrfToken, readSession } from "@/lib/server/session";
import { store } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "The temporary session is missing or expired." }, { status: 401 });
  if (!await hasValidCsrfToken(request)) return NextResponse.json({ error: "The request token is missing or invalid." }, { status: 403 });
  const { runId } = await context.params;
  const target = await store.getRun(session.workspaceId, runId);
  if (!target || target.state !== "Complete" || !target.result) return NextResponse.json({ error: "The target run is not complete in this session." }, { status: 409 });
  let body: { sourceRunId?: string };
  try {
    body = await request.json() as { sourceRunId?: string };
  } catch {
    return NextResponse.json({ error: "The copy request must contain valid JSON." }, { status: 400 });
  }
  if (!body.sourceRunId || body.sourceRunId === runId) return NextResponse.json({ error: "Choose a different source run." }, { status: 400 });
  const source = await store.getRun(session.workspaceId, body.sourceRunId);
  if (!source || source.state !== "Complete" || !source.result) return NextResponse.json({ error: "The source run is not complete in this session." }, { status: 404 });
  const result = await store.copyOverrides(source, target);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

