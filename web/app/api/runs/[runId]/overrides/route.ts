import { NextResponse } from "next/server";
import { readSession } from "@/lib/server/session";
import { store } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "The temporary session is missing or expired." }, { status: 401 });
  const { runId } = await context.params;
  const run = await store.getRun(session.workspaceId, runId);
  if (!run) return NextResponse.json({ error: "The run was not found in this session." }, { status: 404 });
  if (run.state !== "Complete" || !run.result) return NextResponse.json({ error: "Overrides are available after a complete model result." }, { status: 409 });
  const overrideSet = await store.ensureOverrideSet(run);
  return NextResponse.json({ overrideSet }, { headers: { "Cache-Control": "no-store" } });
}

