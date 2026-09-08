import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ForecastModelStatus, ForecastResult, ForecastResultRowV3 } from "../types";
import { FEATURE_VERSION, MODEL_ARTIFACT_VERSION, MODEL_ENDPOINT_PATH, MODEL_OBJECTIVE, MODEL_POSITIONS, MODEL_TARGET, MODEL_TRAINING_SEASONS, MODEL_VALIDATION_RESULT, METRIC_DEFINITION_VERSION, QUANTILE_LEVELS, RANGE_POLICY_VERSION, RESULT_SCHEMA_VERSION, SCORING_CONTRACT_VERSION, SCORING_FORMAT, XGBOOST_VERSION, MODEL_RELEASE } from "../model-release";
import { buildFeatureRowsV2, groupServingFeaturesV2, MissingFeatureError, type ServingFeatureRowV2 } from "./features-v2";
import { joinRankUncertainty, loadRankReferenceSnapshot, type RankedProjectionRow } from "./rank-reference";
import { attachOpponents, canonicalTeam } from "./schedule";
import { type ExternalModelCall, store, type RunFailure, type RunRecord } from "./store";

export { FEATURE_VERSION, MODEL_ARTIFACT_VERSION, MODEL_ENDPOINT_PATH, MODEL_OBJECTIVE, MODEL_POSITIONS, MODEL_TARGET, MODEL_TRAINING_SEASONS, MODEL_VALIDATION_RESULT, METRIC_DEFINITION_VERSION, QUANTILE_LEVELS, RANGE_POLICY_VERSION, RESULT_SCHEMA_VERSION, SCORING_CONTRACT_VERSION, SCORING_FORMAT, XGBOOST_VERSION, MODEL_RELEASE };
export const MAX_SERVICE_RETRIES = 2;

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

type PredictionResponseV2 = {
  schema_version: "model-prediction.v2";
  model_release: string;
  feature_version: string;
  scoring_contract_version: string;
  quantile_output_columns: { "0": "p15"; "1": "p50"; "2": "p85" };
  prediction_call_count: number;
  quantile_crossing_count: number;
  quantile_crossing_player_ids: string[];
  position: string;
  season: number;
  week: number;
  model_target_season: number;
  model_artifact_version: string;
  feature_names: string[];
  prediction_count: number;
  negative_prediction_count: number;
  negative_prediction_player_ids: string[];
  predictions: Array<{ stable_player_id: string; p15: number; p50: number; p85: number }>;
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
  } catch {
    throw new ForecastError(`${label} returned invalid JSON.`, { serviceResponse: output.slice(-2000), nextAction: "Retry after checking the producer logs." });
  }
}

function inferenceServiceBaseUrl() {
  return (process.env.INFERENCE_SERVICE_URL ?? process.env.MODEL_SERVICE_URL)?.replace(/\/$/, "");
}

function inferenceHeaders() {
  const token = process.env.INFERENCE_SERVICE_TOKEN ?? process.env.MODEL_SERVICE_TOKEN;
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
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

function validateFfsimulator(response: FfsimulatorResponse, rows: RankedProjectionRow[], simulationCount: number, week: number, seed: number) {
  if (response.schema_version !== "ffsimulator-prediction.v1") throw new ForecastError("The ffsimulator response schema is unsupported.");
  if (response.week !== week || response.seed !== seed) throw new ForecastError("The ffsimulator response context does not match the run.", { nextAction: "Retry after checking the simulator arguments and output." });
  if (response.simulation_count !== simulationCount || response.rows.length !== rows.length) {
    throw new ForecastError("The ffsimulator output count does not match the accepted input count.", { nextAction: "Retry after checking the simulator output." });
  }
  const expected = new Set(rows.map((row) => row.stablePlayerId));
  const seen = new Set<string>();
  for (const result of response.rows) {
    if (!expected.has(result.stable_player_id)) throw new ForecastError(`The ffsimulator returned an unknown player ID: ${result.stable_player_id}.`, { affectedPlayerIds: [result.stable_player_id] });
    if (seen.has(result.stable_player_id)) throw new ForecastError(`The ffsimulator returned a duplicate player ID: ${result.stable_player_id}.`, { affectedPlayerIds: [result.stable_player_id] });
    seen.add(result.stable_player_id);
    const scoreValues = [result.mean, result.median, result.p15, result.p50, result.p85];
    const probabilityValues = [result.probability_zero, result.probability_active];
    if (scoreValues.some((value) => !Number.isFinite(value)) || probabilityValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1) || result.n_simulations !== simulationCount) {
      throw new ForecastError(`The ffsimulator returned invalid values for ${result.stable_player_id}.`, { affectedPlayerIds: [result.stable_player_id] });
    }
    if (result.p15 > result.p50 || result.p50 > result.p85) throw new ForecastError(`The ffsimulator percentile order is invalid for ${result.stable_player_id}.`, { affectedPlayerIds: [result.stable_player_id] });
  }
  const missing = rows.map((row) => row.stablePlayerId).filter((id) => !seen.has(id));
  if (missing.length) throw new ForecastError("The ffsimulator omitted accepted player IDs.", { affectedPlayerIds: missing });
}

function validateModelResponse(response: PredictionResponseV2, expectedRows: ServingFeatureRowV2[], position: string, season: number, week: number) {
  const expectedFeatures = Object.keys(expectedRows[0]?.features ?? {});
  if (response.schema_version !== "model-prediction.v2" || response.model_release !== MODEL_RELEASE || response.model_artifact_version !== MODEL_ARTIFACT_VERSION || response.feature_version !== FEATURE_VERSION || response.scoring_contract_version !== SCORING_CONTRACT_VERSION) {
    throw new ForecastError("The model response metadata does not match the requested v2 release.", { affectedPosition: position, serviceResponse: response, nextAction: "Deploy the matching model release and retry." });
  }
  if (response.position !== position || response.season !== season || response.week !== week || response.prediction_call_count !== 1) {
    throw new ForecastError("The model response context or prediction-call contract does not match the run.", { affectedPosition: position, serviceResponse: response });
  }
  if (JSON.stringify(response.quantile_output_columns) !== JSON.stringify({ "0": "p15", "1": "p50", "2": "p85" }) || JSON.stringify(response.feature_names) !== JSON.stringify(expectedFeatures)) {
    throw new ForecastError("The model response feature or quantile columns do not match the v2 contract.", { affectedPosition: position, serviceResponse: response, nextAction: "Deploy the matching feature metadata and retry." });
  }
  if (response.prediction_count !== expectedRows.length || response.predictions.length !== expectedRows.length) {
    throw new ForecastError("The model response count does not match the request.", { affectedPosition: position, serviceResponse: response });
  }
  if (response.quantile_crossing_count !== 0 || response.quantile_crossing_player_ids.length > 0) {
    throw new ForecastError("The v2 model returned a quantile crossing.", { affectedPlayerIds: response.quantile_crossing_player_ids, affectedPosition: position, serviceResponse: response, nextAction: "Review the raw quantile output before retrying the run." });
  }
  if (response.negative_prediction_count !== 0 || response.negative_prediction_player_ids.length > 0) {
    throw new ForecastError("The v2 model returned a negative prediction.", { affectedPlayerIds: response.negative_prediction_player_ids, affectedPosition: position, serviceResponse: response, nextAction: "Review the raw model output before retrying the run." });
  }
  const expected = new Set(expectedRows.map((row) => row.stablePlayerId));
  const seen = new Set<string>();
  for (const prediction of response.predictions) {
    if (!expected.has(prediction.stable_player_id)) throw new ForecastError(`The model returned an unknown player ID: ${prediction.stable_player_id}.`, { affectedPlayerIds: [prediction.stable_player_id], affectedPosition: position, serviceResponse: response });
    if (seen.has(prediction.stable_player_id)) throw new ForecastError(`The model returned a duplicate player ID: ${prediction.stable_player_id}.`, { affectedPlayerIds: [prediction.stable_player_id], affectedPosition: position, serviceResponse: response });
    seen.add(prediction.stable_player_id);
    const values = [prediction.p15, prediction.p50, prediction.p85];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new ForecastError(`The model returned an invalid non-negative quantile set for ${prediction.stable_player_id}.`, { affectedPlayerIds: [prediction.stable_player_id], affectedPosition: position, serviceResponse: response });
    if (prediction.p15 > prediction.p50 || prediction.p50 > prediction.p85) throw new ForecastError(`The model returned an out-of-order quantile set for ${prediction.stable_player_id}.`, { affectedPlayerIds: [prediction.stable_player_id], affectedPosition: position, serviceResponse: response });
  }
  const missing = expectedRows.map((row) => row.stablePlayerId).filter((id) => !seen.has(id));
  if (missing.length) throw new ForecastError("The model omitted accepted player IDs.", { affectedPlayerIds: missing, affectedPosition: position, serviceResponse: response });
}

async function callModelService(position: string, season: number, week: number, rows: ServingFeatureRowV2[], run: RunRecord, calls: ExternalModelCall[]) {
  const startedAt = Date.now();
  const baseUrl = inferenceServiceBaseUrl();
  const endpoint = baseUrl ? `${baseUrl}${MODEL_ENDPOINT_PATH}` : `local://services/model-worker/predict_service_v2.py${MODEL_ENDPOINT_PATH}`;
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
      let response: PredictionResponseV2;
      if (baseUrl) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
          const httpResponse = await fetch(endpoint, { method: "POST", headers: inferenceHeaders(), body: requestBody, signal: controller.signal });
          const body = await httpResponse.json() as PredictionResponseV2 | Record<string, unknown>;
          if (!httpResponse.ok) throw new ForecastError("The v2 model service rejected the request.", { affectedPosition: position, serviceResponse: body, retryable: httpResponse.status === 408 || httpResponse.status === 429 || httpResponse.status >= 500, nextAction: "Retry the run after checking the model service response." });
          response = body as PredictionResponseV2;
        } catch (error) {
          if (error instanceof ForecastError) throw error;
          throw new ForecastError("The v2 model service could not be reached.", { affectedPosition: position, serviceResponse: String(error), retryable: true, nextAction: "Retry the run. If the timeout repeats, inspect the model service." });
        } finally {
          clearTimeout(timeout);
        }
      } else {
        const root = projectRoot();
        const python = process.env.PYTHON_EXECUTABLE ?? (process.platform === "win32" ? "python" : "python3");
        const script = path.resolve(root, "services", "model-worker", "predict_service_v2.py");
        const modelRoot = path.resolve(root, "backtest_fbg_2023_2025", "outputs", "xgb_v2_quantile_projection");
        const output = await spawnProcess(python, [script, "--model-root", modelRoot, "--release", MODEL_RELEASE, "--once"], { cwd: root, input: requestBody, timeoutMs: 45_000 });
        response = parseJsonOutput<PredictionResponseV2>(output.stdout, "v2 model service");
      }
      validateModelResponse(response, rows, position, season, week);
      const call: ExternalModelCall = { model: "xgb_multi_quantile", position: position as "QB" | "RB" | "WR" | "TE", endpoint, attempts, status: "complete", elapsedMs: Date.now() - startedAt, predictionCount: response.predictions.length };
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
  const finalError = lastError instanceof ForecastError ? lastError : new ForecastError("The v2 model service failed.", { affectedPosition: position, serviceResponse: String(lastError), nextAction: "Retry the run after checking the model service." });
  const call: ExternalModelCall = { model: "xgb_multi_quantile", position: position as "QB" | "RB" | "WR" | "TE", endpoint, attempts, status: "failed", elapsedMs: Date.now() - startedAt };
  calls.push(call);
  await store.updateRun(run.workspaceId, run.runId, { externalModelCalls: calls.slice() });
  throw finalError;
}

async function runFfsimulator(rows: RankedProjectionRow[], run: RunRecord, temporaryDirectory: string) {
  const baseUrl = inferenceServiceBaseUrl();
  if (baseUrl) {
    const endpoint = `${baseUrl}/v1/ffsimulator/predict`;
    const requestBody = JSON.stringify({
      schema_version: "ffsimulator-request.v1",
      week: run.week,
      seed: run.seed,
      simulation_count: run.simulationCount,
      rows: rows.map((row) => ({
        stable_player_id: row.stablePlayerId,
        position: row.position,
        rank: row.ecr,
        rank_uncertainty: row.rankSd,
        source_order: row.sourceRowOrder,
      })),
    });
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_SERVICE_RETRIES; attempt += 1) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        try {
          const httpResponse = await fetch(endpoint, { method: "POST", headers: inferenceHeaders(), body: requestBody, signal: controller.signal });
          const responseText = await httpResponse.text();
          const body = parseJsonOutput<FfsimulatorResponse>(responseText, "ffsimulator service");
          if (!httpResponse.ok) {
            throw new ForecastError("The ffsimulator service rejected the request.", {
              serviceResponse: body,
              retryable: httpResponse.status === 408 || httpResponse.status === 429 || httpResponse.status >= 500,
              nextAction: "Retry the run after checking the ffsimulator service response.",
            });
          }
          return body;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ForecastError && error.retryable;
        if (attempt < MAX_SERVICE_RETRIES && retryable) continue;
        if (error instanceof ForecastError) throw error;
        throw new ForecastError("The ffsimulator service could not be reached.", {
          serviceResponse: String(error),
          retryable: true,
          nextAction: "Retry the run. If the timeout repeats, inspect the ffsimulator service.",
        });
      }
    }
    throw lastError instanceof ForecastError ? lastError : new ForecastError("The ffsimulator service failed.", { serviceResponse: String(lastError) });
  }

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

function modelStatus(status: ForecastModelStatus["status"], release?: string, featureVersion?: string, predictionCount?: number, error?: string, details: Partial<ForecastModelStatus> = {}): ForecastModelStatus {
  return { status, release, featureVersion, predictionCount, error, ...details };
}

function makeCombinedRows(rows: RankedProjectionRow[], ffsim: FfsimulatorResponse, predictions: Map<string, { p15: number; p50: number; p85: number }>, run: RunRecord, opponentByTeam: Map<string, { opponent: string; gameId: string }>) {
  const ffsimById = new Map(ffsim.rows.map((row) => [row.stable_player_id, row]));
  return rows.map((row) => {
    const simulation = ffsimById.get(row.stablePlayerId);
    if (!simulation) throw new ForecastError(`The combined result is missing ffsimulator output for ${row.stablePlayerId}.`, { affectedPlayerIds: [row.stablePlayerId] });
    const matchup = opponentByTeam.get(canonicalTeam(row.team));
    if (!matchup) throw new ForecastError(`The combined result is missing the approved matchup for ${row.stablePlayerId}.`, { affectedPlayerIds: [row.stablePlayerId] });
    const modelValues = predictions.get(row.stablePlayerId);
    const floor = modelValues?.p15 ?? Number.NaN;
    const average = row.csvProjection;
    const median = modelValues?.p50 ?? Number.NaN;
    const ceiling = modelValues?.p85 ?? Number.NaN;
    if (![floor, average, median, ceiling].every((value) => Number.isFinite(value))) {
      throw new ForecastError(`The combined result is incomplete for ${row.stablePlayerId}.`, { affectedPlayerIds: [row.stablePlayerId] });
    }
    if ((floor as number) > median || median > (ceiling as number)) {
      throw new ForecastError(`The combined range order is invalid for ${row.stablePlayerId}: floor=${floor}, median=${median}, ceiling=${ceiling}.`, { affectedPlayerIds: [row.stablePlayerId] });
    }
    const result: ForecastResultRowV3 = {
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
      xgbP15: modelValues?.p15 ?? 0,
      xgbP50: modelValues?.p50 ?? 0,
      xgbP85: modelValues?.p85 ?? 0,
      floor: floor as number,
      average: average as number,
      median,
      ceiling: ceiling as number,
      rangeWidth: (ceiling as number) - (floor as number),
      valueSources: { floor: "XGBoost p15", average: "CSV PPR projection", median: "XGBoost p50", ceiling: "XGBoost p85" },
    };
    return result;
  });
}

function validateCombinedRows(rows: ForecastResultRowV3[], acceptedRows: RankedProjectionRow[]) {
  const acceptedIds = acceptedRows.map((row) => row.stablePlayerId);
  if (rows.length !== acceptedRows.length) throw new ForecastError("The combined output count does not match the accepted input count.");
  if (new Set(rows.map((row) => row.stablePlayerId)).size !== rows.length) throw new ForecastError("The combined output contains duplicate player IDs.");
  const outputIds = rows.map((row) => row.stablePlayerId);
  if (outputIds.some((id, index) => id !== acceptedIds[index])) throw new ForecastError("The combined output changed the uploaded source order.");
  for (const row of rows) {
    if (![row.floor, row.average, row.median, row.ceiling, row.xgbP15, row.xgbP50, row.xgbP85].every((value) => Number.isFinite(value) && value >= 0) || row.floor > row.median || row.median > row.ceiling || row.xgbP15 > row.xgbP50 || row.xgbP50 > row.xgbP85) {
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
    console.info("[forecast] stage", { runId, workspaceId, stage });
    await store.updateRun(workspaceId, runId, { state: "Running", stage, externalModelCalls: calls.slice(), runtime: { wallMs: Date.now() - started, peakMemoryBytes } });
  };
  console.info("[forecast] run started", { runId, workspaceId, season: run.season, week: run.week, simulationCount: run.simulationCount });
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
    validateFfsimulator(ffsimulator, rankedRows, run.simulationCount, run.week, run.seed);
    await updateStage("building_model_features");
    const servingRows = buildFeatureRowsV2(rankedRows, run.week);
    const predictions = new Map<string, { p15: number; p50: number; p85: number }>();
    const groups = groupServingFeaturesV2(servingRows);
    for (const position of MODEL_POSITIONS) {
      const positionRows = groups.get(position) ?? [];
      if (!positionRows.length) continue;
      await updateStage(`running_xgb_multi_quantile_${position.toLowerCase()}`);
      const response = await callModelService(position, run.season, run.week, positionRows, run, calls);
      for (const prediction of response.predictions) {
        predictions.set(prediction.stable_player_id, { p15: prediction.p15, p50: prediction.p50, p85: prediction.p85 });
      }
    }
    await updateStage("validating_combined_result");
    const combinedRows = makeCombinedRows(rankedRows, ffsimulator, predictions, run, opponentByTeam);
    validateCombinedRows(combinedRows, rankedRows);
    const completedAt = new Date().toISOString();
    const xgbCount = combinedRows.length;
    const result: ForecastResult = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      runId,
      uploadId: run.uploadId,
      state: "Complete",
      metadata: {
        season: run.season,
        week: run.week,
        scoringFormat: SCORING_FORMAT,
        scoringContractVersion: run.scoringContractVersion,
        metricDefinitionVersion: run.metricDefinitionVersion,
        simulationCount: run.simulationCount,
        seed: run.seed,
        modelRelease: run.modelRelease,
        featureVersion: FEATURE_VERSION,
        modelTarget: MODEL_TARGET,
        modelObjective: MODEL_OBJECTIVE,
        xgboostVersion: XGBOOST_VERSION,
        modelArtifactVersion: MODEL_ARTIFACT_VERSION,
        modelTrainingSeasons: MODEL_TRAINING_SEASONS,
        validationResult: MODEL_VALIDATION_RESULT,
        predictionCallCount: calls.filter((call) => call.model === "xgb_multi_quantile" && call.status === "complete").length,
        quantileCrossingCount: 0,
        quantileCrossingPlayerIds: [],
        negativePredictionCount: 0,
        negativePredictionPlayerIds: [],
        quantileLevels: QUANTILE_LEVELS,
        rangePolicyVersion: RANGE_POLICY_VERSION,
        inferenceEndpoint: MODEL_ENDPOINT_PATH,
        rankReferenceSnapshot: rankSnapshot.snapshotId,
        sourceInputRevision: run.sourceInputRevision,
        createdAt: run.createdAt,
        completedAt,
        acceptedRowCount: upload.report.accepted,
        excludedRowCount: upload.report.excluded,
        positionCounts: upload.report.positionCounts,
        outputRowCount: combinedRows.length,
        rankRule: upload.report.sourceOrderUsed ? "positional source order from selected projection set" : "uploaded rank or ECR field",
        rankSourceOrder: "preserved",
      },
      modelStatus: {
        ffsimulator: modelStatus("complete", `ffsimulator-${ffsimulator.package_version}`, undefined, combinedRows.length),
        xgb: modelStatus("complete", MODEL_RELEASE, FEATURE_VERSION, xgbCount, undefined, {
          predictionCallCount: calls.filter((call) => call.model === "xgb_multi_quantile" && call.status === "complete").length,
          quantileCrossingCount: 0,
          quantileCrossingPlayerIds: [],
          negativePredictionCount: 0,
          negativePredictionPlayerIds: [],
        }),
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
    console.error("[forecast] run failed", { runId, workspaceId, stage, message: failureError.message, affectedPlayerIds: failureError.affectedPlayerIds, affectedPosition: failureError.affectedPosition });
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
    await store.updateRun(workspaceId, runId, { state: "Failed", stage, failure, externalModelCalls: calls.slice(), runtime: { wallMs: Date.now() - started, peakMemoryBytes } });
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
