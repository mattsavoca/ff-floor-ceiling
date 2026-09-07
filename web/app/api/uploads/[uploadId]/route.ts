import { NextResponse } from "next/server";
import { readSession } from "@/lib/server/session";
import { store } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "The temporary session is missing or expired." }, { status: 401 });
  const { uploadId } = await context.params;
  const upload = await store.getUpload(session.workspaceId, uploadId);
  if (!upload) return NextResponse.json({ error: "The upload was not found in this session." }, { status: 404 });
  return NextResponse.json({
    uploadId: upload.uploadId,
    fileName: upload.fileName,
    sourceInputRevision: upload.sourceInputRevision,
    selectedSetId: upload.selectedSetId,
    selectedSetName: upload.selectedSetName,
    report: upload.report,
  }, { headers: { "Cache-Control": "no-store" } });
}

