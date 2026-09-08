import { NextResponse } from "next/server";
import { hasValidCsrfToken, readSession } from "@/lib/server/session";
import { applyOverride, validateRange } from "@/lib/metrics";
import type { ForecastRow, OverridePreset, OverrideSpec, RangeValues } from "@/lib/types";
import { store } from "@/lib/server/store";

export const runtime = "nodejs";

type OverrideRequest = {
  factor?: number;
  workloadFactor?: number;
  preset?: OverridePreset;
  inactive?: boolean;
  exclude?: boolean;
  defensePreset?: boolean;
  analystProjection?: number;
  edits?: Partial<RangeValues>;
  reason?: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function isFiniteOptional(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isBooleanOptional(value: unknown) {
  return value === undefined || typeof value === "boolean";
}

function rowForOverride(run: NonNullable<Awaited<ReturnType<typeof store.getRun>>>, stablePlayerId: string): ForecastRow | null {
  const resultRow = run.result?.rows.find((row) => row.stablePlayerId === stablePlayerId);
  if (!resultRow) return null;
  return {
    id: resultRow.stablePlayerId,
    name: resultRow.playerName,
    position: resultRow.position,
    team: resultRow.team,
    opponent: resultRow.opponent,
    game: `${resultRow.team} vs ${resultRow.opponent}`,
    sourceProjection: resultRow.average,
    average: resultRow.average,
    csvProjection: resultRow.csvProjection,
    originalAverage: resultRow.average,
    original: { floor: resultRow.floor, median: resultRow.median, ceiling: resultRow.ceiling },
    nSimulations: run.simulationCount,
    hasDraws: true,
  };
}

function parseOverride(value: unknown) {
  if (!value || typeof value !== "object") return { error: "The override body must be an object." } as const;
  const body = value as OverrideRequest;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length > 500) return { error: "The override reason must be 500 characters or fewer." } as const;
  if (!isFiniteOptional(body.factor) || !isFiniteOptional(body.workloadFactor) || !isFiniteOptional(body.analystProjection)) return { error: "Override numeric fields must be finite." } as const;
  if (!isBooleanOptional(body.inactive) || !isBooleanOptional(body.exclude) || !isBooleanOptional(body.defensePreset)) return { error: "Override state fields must be boolean." } as const;
  if (body.factor !== undefined && body.workloadFactor !== undefined && body.factor !== body.workloadFactor) return { error: "Use one workload factor value." } as const;
  if (body.factor !== undefined && (body.factor < 0 || body.factor > 2)) return { error: "The workload factor must be from 0 through 2." } as const;
  if (body.workloadFactor !== undefined && (body.workloadFactor < 0 || body.workloadFactor > 2)) return { error: "The workload factor must be from 0 through 2." } as const;
  if (body.preset !== undefined && !["full", "half", "quarter", "reduced_role"].includes(body.preset)) return { error: "The named preset is unsupported." } as const;
  if (body.edits !== undefined) {
    if (!body.edits || typeof body.edits !== "object" || Array.isArray(body.edits)) return { error: "Direct range edits must be an object." } as const;
    for (const [field, valueForField] of Object.entries(body.edits)) {
      if (!["floor", "median", "ceiling"].includes(field) || typeof valueForField !== "number" || !Number.isFinite(valueForField) || valueForField < 0) return { error: "Direct range edits must use finite non-negative floor, median, and ceiling values." } as const;
    }
  }
  return {
    value: {
      factor: body.factor ?? body.workloadFactor ?? 1,
      workloadFactor: body.workloadFactor ?? body.factor ?? 1,
      preset: body.preset,
      inactive: Boolean(body.inactive),
      exclude: Boolean(body.exclude),
      defensePreset: Boolean(body.defensePreset),
      analystProjection: body.analystProjection,
      edits: body.edits ?? {},
      reason,
      savedAt: "",
      revision: 0,
    } satisfies OverrideSpec,
  } as const;
}

export async function PUT(request: Request, context: { params: Promise<{ runId: string; stablePlayerId: string }> }) {
  const session = await readSession();
  if (!session) return jsonError("The temporary session is missing or expired.", 401);
  if (!await hasValidCsrfToken(request)) return jsonError("The request token is missing or invalid.", 403);
  const { runId, stablePlayerId } = await context.params;
  const run = await store.getRun(session.workspaceId, runId);
  if (!run) return jsonError("The run was not found in this session.", 404);
  if (run.state !== "Complete" || !run.result) return jsonError("Save overrides after the model result is complete.", 409);
  const row = rowForOverride(run, stablePlayerId);
  if (!row) return jsonError("The stable player ID is not part of this run.", 404);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("The override request must contain valid JSON.");
  }
  const parsed = parseOverride(body);
  if (!("value" in parsed) || !parsed.value) return jsonError(parsed.error ?? "The override is invalid.");
  const override = parsed.value;
  const adjusted = applyOverride(row, override);
  const rangeError = validateRange(adjusted);
  if (rangeError) return jsonError(rangeError);
  const overrideSet = await store.saveOverride(run, stablePlayerId, override);
  return NextResponse.json({ overrideSet, adjusted }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request, context: { params: Promise<{ runId: string; stablePlayerId: string }> }) {
  const session = await readSession();
  if (!session) return jsonError("The temporary session is missing or expired.", 401);
  if (!await hasValidCsrfToken(request)) return jsonError("The request token is missing or invalid.", 403);
  const { runId, stablePlayerId } = await context.params;
  const run = await store.getRun(session.workspaceId, runId);
  if (!run) return jsonError("The run was not found in this session.", 404);
  if (run.state !== "Complete" || !run.result) return jsonError("Reset overrides after the model result is complete.", 409);
  if (!run.result.rows.some((row) => row.stablePlayerId === stablePlayerId)) return jsonError("The stable player ID is not part of this run.", 404);
  const overrideSet = await store.resetOverride(run, stablePlayerId);
  return NextResponse.json({ overrideSet }, { headers: { "Cache-Control": "no-store" } });
}
