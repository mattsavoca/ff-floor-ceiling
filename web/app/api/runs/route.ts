import { randomInt } from "node:crypto";
import { after, NextResponse } from "next/server";
import { hasValidCsrfToken, readSession } from "@/lib/server/session";
import { DEFAULT_SIMULATION_COUNT, isValidSimulationCount, MAX_SIMULATIONS, MIN_SIMULATIONS, SIMULATION_STEP } from "@/lib/simulation-config";
import { processRun } from "@/lib/server/forecast";
import { store } from "@/lib/server/store";
import { METRIC_DEFINITION_VERSION, MODEL_RELEASE, SCORING_CONTRACT_VERSION } from "@/lib/model-release";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ROWS = 50_000;

type RunRequest = {
  uploadId?: string;
  season?: number;
  week?: number;
  metricDefinitionVersion?: string;
  scoringContractVersion?: string;
  simulationCount?: number;
  inputRevision?: string;
  seed?: number;
  submissionToken?: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const session = await readSession();
  if (!session) return jsonError("The temporary session is missing or expired.", 401);
  const runs = await store.listRuns(session.workspaceId);
  const lastComplete = runs.find((run) => run.state === "Complete");
  return NextResponse.json({
    runs: runs.map((run) => ({
      runId: run.runId,
      uploadId: run.uploadId,
      state: run.state,
      stage: run.stage,
      season: run.season,
      week: run.week,
      simulationCount: run.simulationCount,
      seed: run.seed,
      scoringContractVersion: run.scoringContractVersion,
      metricDefinitionVersion: run.metricDefinitionVersion,
      modelRelease: run.modelRelease,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      failure: run.failure,
      runtime: run.runtime,
    })),
    lastCompleteRunId: lastComplete?.runId ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return jsonError("The temporary session is missing or expired.", 401);
  if (!await hasValidCsrfToken(request)) return jsonError("The request token is missing or invalid.", 403);
  let body: RunRequest;
  try {
    body = await request.json() as RunRequest;
  } catch {
    return jsonError("The run request must contain valid JSON.");
  }
  if (!body.uploadId || !/^upload_[a-z0-9-]+$/i.test(body.uploadId)) return jsonError("The upload ID is required.");
  const upload = await store.getUpload(session.workspaceId, body.uploadId);
  if (!upload) return jsonError("The upload was not found in this session.", 404);
  const season = Number(body.season);
  const week = Number(body.week);
  const simulationCount = body.simulationCount === undefined ? DEFAULT_SIMULATION_COUNT : Number(body.simulationCount);
  if (!Number.isInteger(season) || season < 2020 || season > 2100) return jsonError("Select a supported season.");
  if (!Number.isInteger(week) || week < 1 || week > 18) return jsonError("Select a week from 1 through 18.");
  if (!isValidSimulationCount(simulationCount)) return jsonError(`Use an integer from ${MIN_SIMULATIONS.toLocaleString()} to ${MAX_SIMULATIONS.toLocaleString()} in steps of ${SIMULATION_STEP}.`);
  if (!Number.isInteger(upload.report.accepted) || upload.report.accepted < 1 || upload.report.accepted > MAX_ROWS) return jsonError("The upload must contain at least one accepted row.");
  if (body.metricDefinitionVersion !== METRIC_DEFINITION_VERSION) return jsonError("The metric definition version is unsupported.");
  if (body.scoringContractVersion !== SCORING_CONTRACT_VERSION) return jsonError("The scoring contract is unsupported.");
  if (body.inputRevision !== upload.sourceInputRevision) return jsonError("The input revision does not match the uploaded file.");
  if (body.submissionToken && !/^[a-zA-Z0-9_-]{8,128}$/.test(body.submissionToken)) return jsonError("The submission token is invalid.");
  if (body.seed !== undefined && (!Number.isSafeInteger(body.seed) || body.seed < 0 || body.seed > 2_147_483_647)) return jsonError("The seed must be a non-negative 32-bit integer.");
  const runs = await store.listRuns(session.workspaceId);
  const activeJobs = runs.filter((run) => run.state === "Queued" || run.state === "Running");
  if (activeJobs.length >= 2) return jsonError("This temporary session already has two active jobs. Wait for one to finish before starting another.", 429);
  const seed = body.seed ?? randomInt(0, 2_147_483_647);
  const run = await store.createRun({
    workspaceId: session.workspaceId,
    workspaceExpiresAtMs: session.expiresAtMs,
    uploadId: upload.uploadId,
    sourceInputRevision: upload.sourceInputRevision,
    season,
    week,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    modelRelease: MODEL_RELEASE,
    simulationCount,
    seed,
    state: "Queued",
  });
  after(async () => {
    try {
      await processRun(run.runId, session.workspaceId);
    } catch (error) {
      console.error("[forecast] background run failed before state update", {
        runId: run.runId,
        workspaceId: session.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return NextResponse.json({
    runId: run.runId,
    uploadId: run.uploadId,
    state: run.state,
    season: run.season,
    week: run.week,
    simulationCount: run.simulationCount,
    seed: run.seed,
    modelRelease: run.modelRelease,
  }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
