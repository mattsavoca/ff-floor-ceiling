import { NextResponse } from "next/server";
import { MAX_UPLOAD_ROWS, parseProjectionCsv } from "@/lib/csv";
import { hasValidCsrfToken, readSession } from "@/lib/server/session";
import { createSourceInputRevision, store } from "@/lib/server/store";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return jsonError("The temporary session is missing or expired.", 401);
  if (!await hasValidCsrfToken(request)) return jsonError("The request token is missing or invalid.", 403);
  const form = await request.formData();
  const fileValue = form.get("file");
  if (!(fileValue instanceof File)) return jsonError("Choose a CSV file before uploading.");
  if (fileValue.size > MAX_UPLOAD_BYTES) return jsonError(`The CSV file must be ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`);
  const selectedSetId = String(form.get("selectedSetId") ?? "").trim() || undefined;
  const selectedSetName = String(form.get("selectedSetName") ?? "").trim() || undefined;
  let text: string;
  try {
    text = await fileValue.text();
  } catch {
    return jsonError("The CSV file could not be read.");
  }
  if (!text.trim()) return jsonError("The CSV file is empty.");
  const parsed = parseProjectionCsv(text, fileValue.name || "upload.csv", { selectedSetId, selectedSetName });
  if (parsed.report.rows > MAX_UPLOAD_ROWS) return jsonError(`The file cannot contain more than ${MAX_UPLOAD_ROWS.toLocaleString()} rows.`);
  const upload = await store.createUpload({
    workspaceId: session.workspaceId,
    workspaceExpiresAtMs: session.expiresAtMs,
    fileName: fileValue.name || "upload.csv",
    sourceInputRevision: createSourceInputRevision(text),
    selectedSetId: parsed.selectedSetId,
    selectedSetName: parsed.selectedSetName,
    report: parsed.report,
    headers: parsed.headers,
    rows: parsed.rows,
    acceptedRows: parsed.acceptedRows,
  });
  return NextResponse.json({
    uploadId: upload.uploadId,
    fileName: upload.fileName,
    sourceInputRevision: upload.sourceInputRevision,
    selectedSetId: upload.selectedSetId,
    selectedSetName: upload.selectedSetName,
    report: upload.report,
  }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

