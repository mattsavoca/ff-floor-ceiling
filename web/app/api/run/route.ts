import { NextResponse } from "next/server";
import { hasValidCsrfToken, readSession } from "@/lib/server/session";

const MAX_ROWS = 50_000;
const MAX_SIMULATIONS = 1_000;
const queuedRuns = new Map<string, { runId: string; createdAt: string; state: "Queued" }>();

type RunRequest = {
  season?: number;
  week?: number;
  metricDefinitionVersion?: string;
  simulationCount?: number;
  acceptedRows?: number;
  inputRevision?: string;
  submissionToken?: string;
};

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return badRequest("The temporary session is missing or expired.", 401);
  if (!await hasValidCsrfToken(request)) return badRequest("The request token is missing or invalid.", 403);

  let body: RunRequest;
  try {
    body = await request.json() as RunRequest;
  } catch {
    return badRequest("The run request must contain valid JSON.");
  }

  const season = Number(body.season);
  const week = Number(body.week);
  const simulationCount = Number(body.simulationCount);
  const acceptedRows = Number(body.acceptedRows);
  if (!Number.isInteger(season) || season < 2020 || season > 2100) return badRequest("Select a supported season.");
  if (!Number.isInteger(week) || week < 1 || week > 18) return badRequest("Select a week from 1 through 18.");
  if (![100, MAX_SIMULATIONS].includes(simulationCount)) return badRequest("Use the 100-simulation preview or the 1,000-simulation standard run.");
  if (!Number.isInteger(acceptedRows) || acceptedRows < 1 || acceptedRows > MAX_ROWS) return badRequest("The upload must contain between 1 and 50,000 accepted rows.");
  if (!body.metricDefinitionVersion || body.metricDefinitionVersion.length > 80) return badRequest("The metric definition version is required.");
  if (!body.inputRevision || body.inputRevision.length > 128) return badRequest("The input revision is required.");
  if (!body.submissionToken || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.submissionToken)) return badRequest("The submission token is invalid.");

  const idempotencyKey = `${session.workspaceId}:${body.submissionToken}`;
  const previous = queuedRuns.get(idempotencyKey);
  if (previous) return NextResponse.json({ ...previous, idempotent: true }, { headers: { "Cache-Control": "no-store" } });
  const activeJobs = Array.from(queuedRuns.keys()).filter((key) => key.startsWith(`${session.workspaceId}:`)).length;
  if (activeJobs >= 2) return badRequest("This temporary session already has two active jobs. Wait for one to finish before starting another.", 429);

  const run = { runId: `run_${season}_w${week}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, createdAt: new Date().toISOString(), state: "Queued" as const };
  queuedRuns.set(idempotencyKey, run);
  return NextResponse.json({
    ...run,
    modelVersion: "sim-2026.1",
    simulationCount,
    boundary: "demo-queue",
    message: "The request passed the web boundary. A persistent model worker is required for production inference.",
  }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
