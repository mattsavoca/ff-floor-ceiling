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
  const lastComplete = await store.getLastCompleteRun(session.workspaceId);
  return NextResponse.json({
    runId: run.runId,
    uploadId: run.uploadId,
    state: run.state,
    stage: run.stage,
    season: run.season,
    week: run.week,
    simulationCount: run.simulationCount,
    seed: run.seed,
    modelRelease: run.modelRelease,
    scoringContractVersion: run.scoringContractVersion,
    metricDefinitionVersion: run.metricDefinitionVersion,
    sourceInputRevision: run.sourceInputRevision,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    failure: run.failure,
    externalModelCalls: run.externalModelCalls,
    runtime: run.runtime,
    positionCounts: run.result?.metadata.positionCounts ?? null,
    resultSchemaVersion: run.result?.schemaVersion ?? null,
    lastCompleteRunId: lastComplete?.runId ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}
