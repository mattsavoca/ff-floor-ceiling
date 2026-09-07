import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ParsedProjectionRow } from "../csv";
import type { ForecastResult, ForecastResultRow, ForecastModelStatus } from "../types";
import { buildFeatureRows, FEATURE_VERSION, groupServingFeatures, MissingFeatureError, MODEL_POSITIONS, type ServingFeatureRow } from "./features";
import { joinRankUncertainty, loadRankReferenceSnapshot, type RankedProjectionRow } from "./rank-reference";
import { attachOpponents, canonicalTeam } from "./schedule";
import { type ExternalModelCall, store, type RunFailure, type RunRecord } from "./store";

export const SCORING_CONTRACT_VERSION = "ppr_v1";
export const METRIC_DEFINITION_VERSION = "ppr_v1_projection_formula";
export const MODEL_RELEASE = "forecast-ppr-v1";
export const MAX_SERVICE_RETRIES = 2;

type Quantile = "p15" | "p85";

type FfsimulatorRow = {
  stable_player_id: string;
  mean: number;
  median: number;
  p15: number;
  p50: number;
  p85: number;
  probability_zero: number;
  probability_active: number;
  n_simulations: number;
};

type FfsimulatorResponse = {
  schema_version: string;
  week: number;
  seed: number;
  simulation_count: number;
  package_version: string;
  rows: FfsimulatorRow[];
};

type PredictionResponse = {
  model_release: string;
  feature_version: string;
  scoring_contract_version: string;
  quantile: Quantile;
  position: string;
  season: number;
  week: number;
  prediction_count: number;
  predictions: Array<{ stable_player_id: string; p15?: number; p85?: number }>;
};

class ForecastError extends Error {
  readonly affectedPlayerIds: string[];
  readonly affectedPosition?: string;
  readonly serviceResponse?: unknown;
  readonly nextAction: string;
  readonly retryable: boolean;

  constructor(message: string, options: { affectedPlayerIds?: string[]; affectedPosition?: string; serviceResponse?: unknown; nextAction?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "ForecastError";
    this.affectedPlayerIds = options.affectedPlayerIds ?? [];
    this.affectedPosition = options.affectedPosition;
    this.serviceResponse = options.serviceResponse;
    this.nextAction = options.nextAction ?? "Correct the reported issue and start a new run.";
    this.retryable = options.retryable ?? (!options.serviceResponse || typeof options.serviceResponse === "string");
  }
}

function projectRoot() {
  const candidates = [process.env.FC_PROJECT_ROOT, process.cwd(), path.resolve(process.cwd(), "..")].filter((value): value is string => Boolean(value));
  const root = candidates.find((candidate) => existsSync(path.resolve(candidate, "services", "model-worker", "predict_service.py")) && existsSync(path.resolve(candidate, "backtest_fbg_2023_2025")));
  return root ?? candidates[0] ?? process.cwd();
}

function rscriptPath() {
  return process.env.RSCRIPT_EXECUTABLE ?? (process.platform === "win32" ? "C:\\Program Files\\R\\R-4.4.2\\bin\\Rscript.exe" : "Rscript");
}

function outcomePoolPath(root: string) {
  const configured = process.env.FC_OUTCOME_POOL;
  if (configured) return path.resolve(configured);
  const candidates = [
    path.resolve(root, "..", "ffsimulator", "inst", "cache", "adp_outcomes.rds"),
    path.resolve(root, "..", "ffsimulator", "inst", "cache", "adp_outcomes_week.rds"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rankingsCsv(rows: RankedProjectionRow[]) {
  const headers = ["player_id", "player_name", "position", "team", "rank", "rank_uncertainty", "source_order"];
  const lines = rows.map((row) => [
    row.stablePlayerId,
    row.playerName,
    row.position,
    canonicalTeam(row.team),
    row.ecr,
    row.rankSd,
    row.sourceRowOrder,
  ].map(csvCell).join(","));
  return `${headers.join(",")}\n${lines.join("\n")}\n`;
}

function parseJsonOutput<T>(output: string, label: string) {
  try {
    return JSON.parse(output.trim()) as T;
  } catch (error) {
    throw new ForecastError(`${label} returned invalid JSON.`, { serviceResponse: output.slice(-2000), nextAction: "Retry after checking the producer logs." });
  }
}

function spawnProcess(command: string, args: string[], options: { cwd: string; input?: string; timeoutMs: number }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new ForecastError(`${path.basename(command)} timed out.`, { nextAction: "Retry the run. If the timeout repeats, inspect the producer process." }));
      }
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new ForecastError(`Could not start ${path.basename(command)}: ${error.message}`, { nextAction: "Check the local producer installation." }));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const serviceResponse = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").slice(-4000);
        reject(new ForecastError(`${path.basename(command)} failed with exit code ${code}.`, { serviceResponse, nextAction: "Review the producer error and retry after the input or environment is corrected." }));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

function validateFfsimulator(response: FfsimulatorResponse, rows: RankedProjectionRow[], simulationCount: number) {
  if (response.schema_version !== "ffsimulator-prediction.v1") throw new ForecastError("The ffsimulator response schema is unsupported.");
  if (response.simulation_count !== simulationCount || response.rows.length !== rows.length) {
    throw new ForecastError("The ffsimulator output count does not match the accepted input count.", { nextAction: "Retry after checking the simulator output." });
  }
  const expected = new Set(rows.map((row) => row.stablePlayerId));
  const seen = new Set<string>();
  for (const result of response.rows) {
    if (!expected.has(result.stable_player_id)) throw new ForecastError(`The ffsimulator returned an unknown player ID: ${result.stable_player_id}.`, { affectedPlayerIds: [result.stable_player_id] });
    if (seen.has(result.stable_player_id)) throw new ForecastError(`The ffsimulator returned a duplicate player ID: ${result.stable_player_id}.`, { affectedPlayerIds: [result.stable_player_id] });
    seen.add(result.stable_player_id);
    const values = [result.mean, result.median, result.p15, result.p50, result.p85, result.probability_zero, result.probability_active];
    if (values.some((value) => !Number.isFinite(value)) || result.n_simulations !== simulationCount) {
      throw new ForecastError(`The ffsimulator returned invalid values for ${result.stable_player_id}.`, { affectedPlayerIds: [result.stable_player_id] });
    }
    if (result.p15 > result.p50 || result.p50 > result.p85) throw new ForecastError(`The ffsimulator percentile order is invalid for ${result.stable_player_id}.`, { affectedPlayerIds: [result.stable_player_id] });
  }
  const missing = rows.map((row) => row.stablePlayerId).filter((id) => !seen.has(id));
  if (missing.length) throw new ForecastError("The ffsimulator omitted accepted player IDs.", { affectedPlayerIds: missing });
}

function validateModelResponse(response: PredictionResponse, expectedRows: ServingFeatureRow[], quantile: Quantile, position: string, season: number, week: number) {
  if (response.model_release !== MODEL_RELEASE || response.feature_version !== FEATURE_VERSION || response.scoring_contract_version !== SCORING_CONTRACT_VERSION) {
    throw new ForecastError("The model response metadata does not match the requested release.", { affectedPosition: position, serviceResponse: response, nextAction: "Deploy the matching model release and retry." });
  }
  if (response.quantile !== quantile || response.position !== position || response.season !== season || response.week !== week) {
    throw new ForecastError("The model response context does not match the run.", { affectedPosition: position, serviceResponse: response });
  }
  if (response.prediction_count !== expectedRows.length || response.predictions.length !== expectedRows.length) {
    throw new ForecastError("The model response count does not match the request.", { affectedPosition: position, serviceResponse: response });
  }
  const expected = new Set(expectedRows.map((row) => row.stablePlayerId));
  const seen = new Set<string>();
  for (const prediction of response.predictions) {
    if (!expected.has(prediction.stable_player_id)) throw new ForecastError(`The model returned an unknown player ID: ${prediction.stable_player_id}.`, { affectedPlayerIds: [prediction.stable_player_id], affectedPosition: position, serviceResponse: response });
    if (seen.has(prediction.stable_player_id)) throw new ForecastError(`The model returned a duplicate player ID: ${prediction.stable_player_id}.`, { affectedPlayerIds: [prediction.stable_player_id], affectedPosition: position, serviceResponse: response });
    seen.add(prediction.stable_player_id);
    const value = prediction[quantile];
    if (!Number.isFinite(value)) throw new ForecastError(`The model returned no finite ${quantile} value for ${prediction.stable_player_id}.`, { affectedPlayerIds: [prediction.stable_player_id], affectedPosition: position, serviceResponse: response });
  }
  const missing = expectedRows.map((row) => row.stablePlayerId).filter((id) => !seen.has(id));
  if (missing.length) throw new ForecastError("The model omitted accepted player IDs.", { affectedPlayerIds: missing, affectedPosition: position, serviceResponse: response });
}

async function callModelService(quantile: Quantile, position: string, season: number, week: number, rows: ServingFeatureRow[], run: RunRecord, calls: ExternalModelCall[]) {
  const startedAt = Date.now();
  const baseUrl = process.env.MODEL_SERVICE_URL?.replace(/\/$/, "");
  const endpoint = baseUrl ? `${baseUrl}/v1/models/${quantile}/predict` : `local://services/model-worker/predict_service.py/v1/models/${quantile}/predict`;
  let attempts = 0;
  let lastError: unknown;
  const requestBody = JSON.stringify({
    model_release: MODEL_RELEASE,
    feature_version: FEATURE_VERSION,
    scoring_contract_version: SCORING_CONTRACT_VERSION,
    position,
    season,
    week,
    rows: rows.map((row) => ({ stable_player_id: row.stablePlayerId, features: row.features })),
  });
  for (let attempt = 0; attempt <= MAX_SERVICE_RETRIES; attempt += 1) {
    attempts = attempt + 1;
    try {
      let response: PredictionResponse;
      if (baseUrl) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
          const httpResponse = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: requestBody, signal: controller.signal });
          const body = await httpResponse.json() as PredictionResponse | Record<string, unknown>;
          if (!httpResponse.ok) throw new ForecastError(`The ${quantile} model service rejected the request.`, { affectedPosition: position, serviceResponse: body, retryable: httpResponse.status === 408 || httpResponse.status === 429 || httpResponse.status >= 500, nextAction: "Retry the run after checking the model service response." });
          response = body as PredictionResponse;
        } catch (error) {
          if (error instanceof ForecastError) throw error;
          throw new ForecastError(`The ${quantile} model service could not be reached.`, { affectedPosition: position, serviceResponse: String(error), retryable: true, nextAction: "Retry the run. If the timeout repeats, inspect the model service." });
        } finally {
          clearTimeout(timeout);
        }
      } else {
        const root = projectRoot();
        const python = process.env.PYTHON_EXECUTABLE ?? (process.platform === "win32" ? "python" : "python3");
        const script = path.resolve(root, "services", "model-worker", "predict_service.py");
        const modelRoot = path.resolve(root, "backtest_fbg_2023_2025", "outputs", `xgb_${quantile}_projection`);
        const output = await spawnProcess(python, [script, "--quantile", quantile, "--once", "--release", MODEL_RELEASE, "--model-root", modelRoot], { cwd: root, input: requestBody, timeoutMs: 45_000 });
        response = parseJsonOutput<PredictionResponse>(output.stdout, `${quantile} model service`);
      }
      validateModelResponse(response, rows, quantile, position, season, week);
      const call: ExternalModelCall = { model: quantile === "p15" ? "xgb_p15" : "xgb_p85", position: position as "RB" | "WR" | "TE", endpoint, attempts, status: "complete", elapsedMs: Date.now() - startedAt, predictionCount: response.predictions.length };
      calls.push(call);
      await store.updateRun(run.workspaceId, run.runId, { externalModelCalls: calls.slice() });
      return response;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ForecastError && error.retryable;
      if (attempt < MAX_SERVICE_RETRIES && retryable) continue;
      break;
    }
  }
  const finalError = lastError instanceof ForecastError ? lastError : new ForecastError(`${quantile} model service failed.`, { affectedPosition: position, serviceResponse: String(lastError), nextAction: "Retry the run after checking the model service." });
  const call: ExternalModelCall = { model: quantile === "p15" ? "xgb_p15" : "xgb_p85", position: position as "RB" | "WR" | "TE", endpoint, attempts, status: "failed", elapsedMs: Date.now() - startedAt };
  calls.push(call);
  await store.updateRun(run.workspaceId, run.runId, { externalModelCalls: calls.slice() });
  throw finalError;
}

async function runFfsimulator(rows: RankedProjectionRow[], run: RunRecord, temporaryDirectory: string) {
  const root = projectRoot();
  const rankingsPath = path.join(temporaryDirectory, "rankings.csv");
  const outputPath = path.join(temporaryDirectory, "ffsimulator.json");
  await writeFile(rankingsPath, rankingsCsv(rows), "utf8");
  const script = path.resolve(root, "services", "model-worker", "run_ffsimulator.R");
  const output = await spawnProcess(rscriptPath(), [
    "--vanilla",
    "--slave",
    script,
    `--rankings=${rankingsPath}`,
    `--out=${outputPath}`,
    `--outcome-pool=${outcomePoolPath(root)}`,
    `--n-simulations=${run.simulationCount}`,
    `--week=${run.week}`,
    `--seed=${run.seed}`,
  ], { cwd: root, timeoutMs: 120_000 });
  void output;
  return parseJsonOutput<FfsimulatorResponse>(await readFile(outputPath, "utf8"), "ffsimulator");
}

function modelStatus(status: ForecastModelStatus["status"], release?: string, featureVersion?: string, predictionCount?: number, error?: string): ForecastModelStatus {
  return { status, release, featureVersion, predictionCount, error };
}

function makeCombinedRows(rows: RankedProjectionRow[], ffsim: FfsimulatorResponse, predictions: Map<string, { p15: number; p85: number }>, run: RunRecord, opponentByTeam: Map<string, { opponent: string; gameId: string }>, rankSnapshotId: string) {
  const ffsimById = new Map(ffsim.rows.map((row) => [row.stable_player_id, row]));
  return rows.map((row) => {
    const simulation = ffsimById.get(row.stablePlayerId);
    if (!simulation) throw new ForecastError(`The combined result is missing ffsimulator output for ${row.stablePlayerId}.`, { affectedPlayerIds: [row.stablePlayerId] });
    const matchup = opponentByTeam.get(canonicalTeam(row.team));
    if (!matchup) throw new ForecastError(`The combined result is missing the approved matchup for ${row.stablePlayerId}.`, { affectedPlayerIds: [row.stablePlayerId] });
    const modelValues = predictions.get(row.stablePlayerId);
    const floor = row.position === "QB" ? simulation.p15 : modelValues?.p15;
    const average = row.position === "QB" ? simulation.mean : row.csvProjection;
    const median = simulation.p50;
    const ceiling = row.position === "QB" ? simulation.p85 : modelValues?.p85;
    if (![floor, average, median, ceiling].every((value) => Number.isFinite(value))) {
      throw new ForecastError(`The combined result is incomplete for ${row.stablePlayerId}.`, { affectedPlayerIds: [row.stablePlayerId] });
    }
    if ((floor as number) > median || median > (ceiling as number)) {
      throw new ForecastError(`The combined range order is invalid for ${row.stablePlayerId}.`, { affectedPlayerIds: [row.stablePlayerId] });
    }
    const result: ForecastResultRow = {
      stablePlayerId: row.stablePlayerId,
      playerName: row.playerName,
      position: row.position,
      team: canonicalTeam(row.team),
      opponent: matchup.opponent,
      gameId: matchup.gameId,
      season: run.season,
      week: run.week,
      sourceRowOrder: row.sourceRowOrder,
      ecr: row.ecr,
      rankSd: row.rankSd,
      rankSdMatch: row.rankSdMatch,
      csvProjection: row.csvProjection,
      rawProjection: row.raw,
      ffsimMean: simulation.mean,
      ffsimP15: simulation.p15,
      ffsimP50: simulation.p50,
      ffsimP85: simulation.p85,
      ffsimZeroRate: simulation.probability_zero,
      ffsimActiveRate: simulation.probability_active,
      xgbP15: row.position === "QB" ? null : modelValues?.p15 ?? null,
      xgbP85: row.position === "QB" ? null : modelValues?.p85 ?? null,
      floor: floor as number,
      average: average as number,
      median,
      ceiling: ceiling as number,
      rangeWidth: (ceiling as number) - (floor as number),
      valueSources: row.position === "QB"
        ? { floor: "ffsimulator p15", average: "ffsimulator mean", median: "ffsimulator p50", ceiling: "ffsimulator p85" }
        : { floor: "XGBoost p15", average: "CSV PPR projection", median: "ffsimulator p50", ceiling: "XGBoost p85" },
    };
    void rankSnapshotId;
    return result;
  });
}

function validateCombinedRows(rows: ForecastResultRow[], acceptedRows: RankedProjectionRow[]) {
  const acceptedIds = acceptedRows.map((row) => row.stablePlayerId);
  if (rows.length !== acceptedRows.length) throw new ForecastError("The combined output count does not match the accepted input count.");
  if (new Set(rows.map((row) => row.stablePlayerId)).size !== rows.length) throw new ForecastError("The combined output contains duplicate player IDs.");
  const outputIds = rows.map((row) => row.stablePlayerId);
  if (outputIds.some((id, index) => id !== acceptedIds[index])) throw new ForecastError("The combined output changed the uploaded source order.");
  for (const row of rows) {
    if (!Number.isFinite(row.floor) || !Number.isFinite(row.average) || !Number.isFinite(row.median) || !Number.isFinite(row.ceiling) || row.floor > row.median || row.median > row.ceiling) {
      throw new ForecastError(`The combined output has an invalid range for ${row.stablePlayerId}.`, { affectedPlayerIds: [row.stablePlayerId] });
    }
  }
}

export async function processRun(runId: string, workspaceId: string) {
  const run = await store.getRun(workspaceId, runId);
  if (!run || (run.state !== "Queued" && run.state !== "Running")) return;
  const started = Date.now();
  let peakMemoryBytes = process.memoryUsage().rss;
  let stage = "checking_upload";
  const calls: ExternalModelCall[] = [];
  const updateStage = async (nextStage: string) => {
    stage = nextStage;
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
    await store.updateRun(workspaceId, runId, { state: "Running", stage, externalModelCalls: calls.slice(), runtime: { wallMs: Date.now() - started, peakMemoryBytes } });
  };
  await store.updateRun(workspaceId, runId, { state: "Running", startedAt: new Date().toISOString(), stage, externalModelCalls: [] });
  let temporaryDirectory: string | undefined;
  try {
    const upload = await store.getUpload(workspaceId, run.uploadId);
    if (!upload || upload.sourceInputRevision !== run.sourceInputRevision) throw new ForecastError("The upload is missing or its input revision changed.", { nextAction: "Upload the source file again and start a new run." });
    if (!upload.acceptedRows.length) throw new ForecastError("The upload has no accepted QB, RB, WR, or TE rows.", { nextAction: "Fix the upload report and start a new run." });
    await updateStage("loading_rank_snapshot");
    const rankSnapshot = await loadRankReferenceSnapshot();
    await updateStage("joining_rank_uncertainty");
    const rankedRows = joinRankUncertainty(upload.acceptedRows, rankSnapshot.rows);
    await updateStage("checking_schedule");
    const opponentByTeam = attachOpponents(run.season, run.week, rankedRows.map((row) => row.team));
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fc-forecast-"));
    await updateStage("running_ffsimulator");
    const ffsimulator = await runFfsimulator(rankedRows, run, temporaryDirectory);
    validateFfsimulator(ffsimulator, rankedRows, run.simulationCount);
    await updateStage("building_model_features");
    const servingRows = buildFeatureRows(rankedRows, run.week);
    const predictions = new Map<string, { p15: number; p85: number }>();
    const groups = groupServingFeatures(servingRows);
    for (const position of MODEL_POSITIONS) {
      const positionRows = groups.get(position) ?? [];
      if (!positionRows.length) continue;
      await updateStage(`running_xgb_p15_${position.toLowerCase()}`);
      const p15Response = await callModelService("p15", position, run.season, run.week, positionRows, run, calls);
      await updateStage(`running_xgb_p85_${position.toLowerCase()}`);
      const p85Response = await callModelService("p85", position, run.season, run.week, positionRows, run, calls);
      const p85ById = new Map(p85Response.predictions.map((prediction) => [prediction.stable_player_id, prediction.p85 as number]));
      for (const prediction of p15Response.predictions) {
        const p85 = p85ById.get(prediction.stable_player_id);
        if (!Number.isFinite(prediction.p15) || !Number.isFinite(p85)) throw new ForecastError(`The XGBoost result is incomplete for ${prediction.stable_player_id}.`, { affectedPlayerIds: [prediction.stable_player_id], affectedPosition: position });
        predictions.set(prediction.stable_player_id, { p15: prediction.p15 as number, p85: p85 as number });
      }
    }
    await updateStage("validating_combined_result");
    const combinedRows = makeCombinedRows(rankedRows, ffsimulator, predictions, run, opponentByTeam, rankSnapshot.snapshotId);
    validateCombinedRows(combinedRows, rankedRows);
    const completedAt = new Date().toISOString();
    const xgbCount = combinedRows.filter((row) => row.position !== "QB").length;
    const result: ForecastResult = {
      schemaVersion: "forecast-result.v2",
      runId,
      uploadId: run.uploadId,
      state: "Complete",
      metadata: {
        season: run.season,
        week: run.week,
        scoringContractVersion: run.scoringContractVersion,
        metricDefinitionVersion: run.metricDefinitionVersion,
        simulationCount: run.simulationCount,
        seed: run.seed,
        modelRelease: run.modelRelease,
        rankReferenceSnapshot: rankSnapshot.snapshotId,
        sourceInputRevision: run.sourceInputRevision,
        createdAt: run.createdAt,
        completedAt,
        acceptedRowCount: upload.report.accepted,
        excludedRowCount: upload.report.excluded,
        outputRowCount: combinedRows.length,
        rankRule: upload.report.sourceOrderUsed ? "positional source order from selected projection set" : "uploaded rank or ECR field",
        rankSourceOrder: "preserved",
      },
      modelStatus: {
        ffsimulator: modelStatus("complete", `ffsimulator-${ffsimulator.package_version}`, undefined, combinedRows.length),
        xgbP85: modelStatus("complete", MODEL_RELEASE, FEATURE_VERSION, xgbCount),
        xgbP15: modelStatus("complete", MODEL_RELEASE, FEATURE_VERSION, xgbCount),
      },
      rows: combinedRows,
    };
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
    await store.updateRun(workspaceId, runId, { state: "Complete", stage: "complete", completedAt, result, externalModelCalls: calls.slice(), runtime: { wallMs: Date.now() - started, peakMemoryBytes } });
  } catch (error) {
    const failureError = error instanceof ForecastError
      ? error
      : error instanceof MissingFeatureError
        ? new ForecastError(error.message, { affectedPlayerIds: [error.stablePlayerId], nextAction: "Add the missing source feature and start a new run." })
        : new ForecastError(error instanceof Error ? error.message : String(error));
    const failure: RunFailure = { stage, message: failureError.message, affectedPlayerIds: failureError.affectedPlayerIds, affectedPosition: failureError.affectedPosition, serviceResponse: failureError.serviceResponse, nextAction: failureError.nextAction };
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
    await store.updateRun(workspaceId, runId, { state: "Failed", stage, failure, externalModelCalls: calls.slice(), runtime: { wallMs: Date.now() - started, peakMemoryBytes } });
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
