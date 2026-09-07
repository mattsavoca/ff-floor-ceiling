import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";
import type { ParsedProjectionRow } from "../csv";
import type {
  ForecastResult,
  OverrideSet,
  OverrideSpec,
  UploadReport,
} from "../types";

export type UploadRecord = {
  uploadId: string;
  workspaceId: string;
  workspaceExpiresAtMs: number;
  fileName: string;
  sourceInputRevision: string;
  selectedSetId: string;
  selectedSetName: string;
  report: UploadReport;
  headers: string[];
  rows: Array<Record<string, string>>;
  acceptedRows: ParsedProjectionRow[];
  createdAt: string;
};
export type RunFailure = {
  stage: string;
  message: string;
  affectedPlayerIds: string[];
  affectedPosition?: string;
  serviceResponse?: unknown;
  nextAction: string;
};

export type ExternalModelCall = {
  model: "xgb_p15" | "xgb_p85";
  position: "RB" | "WR" | "TE";
  endpoint: string;
  attempts: number;
  status: "complete" | "failed";
  elapsedMs: number;
  predictionCount?: number;
};

export type RunRecord = {
  runId: string;
  workspaceId: string;
  workspaceExpiresAtMs: number;
  uploadId: string;
  sourceInputRevision: string;
  season: number;
  week: number;
  scoringContractVersion: string;
  metricDefinitionVersion: string;
  modelRelease: string;
  simulationCount: number;
  seed: number;
  state: "Queued" | "Running" | "Complete" | "Failed";
  stage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: ForecastResult;
  failure?: RunFailure;
  externalModelCalls: ExternalModelCall[];
  runtime?: {
    wallMs: number;
    peakMemoryBytes: number;
  };
};

type PersistedState = {
  uploads: UploadRecord[];
  runs: RunRecord[];
  overrideSets: OverrideSet[];
};

export type OverrideCopyReport = {
  copiedPlayerIds: string[];
  unmatchedPlayerIds: string[];
  sourceRunId: string;
  targetRunId: string;
};

const emptyState = (): PersistedState => ({ uploads: [], runs: [], overrideSets: [] });

type StateStorage = {
  key: string;
  workspaceId?: string;
  backend: "file" | "blob";
  etag?: string;
};

const stateMetadata = new WeakMap<PersistedState, StateStorage>();
const statePromises = new Map<string, Promise<PersistedState>>();
const writeQueues = new Map<string, Promise<void>>();

function dataDirectory() {
  const configured = process.env.FC_DATA_DIR;
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), ".forecast-data");
}

function statePath() {
  return path.join(dataDirectory(), "state.json");
}

function hasBlobState() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function storageKey(workspaceId?: string) {
  return hasBlobState() ? `blob:${workspaceId ?? "anonymous"}` : "file";
}

function blobPath(workspaceId: string) {
  return `forecast-state/${encodeURIComponent(workspaceId)}.json`;
}

export function storageBackend() {
  if (hasBlobState()) return "vercel-blob";
  return process.env.NODE_ENV === "production" ? "missing-vercel-blob" : "local-file";
}

export function persistentStorageConfigured() {
  return hasBlobState();
}

function nowIso() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanExpired(state: PersistedState) {
  const now = Date.now();
  const activeWorkspaces = new Set(
    [...state.uploads, ...state.runs]
      .filter((item) => item.workspaceExpiresAtMs > now)
      .map((item) => item.workspaceId),
  );
  const uploads = state.uploads.filter((item) => activeWorkspaces.has(item.workspaceId));
  const runs = state.runs.filter((item) => activeWorkspaces.has(item.workspaceId));
  const overrideSets = state.overrideSets.filter((item) => activeWorkspaces.has(item.workspaceId));
  const changed = uploads.length !== state.uploads.length || runs.length !== state.runs.length || overrideSets.length !== state.overrideSets.length;
  state.uploads = uploads;
  state.runs = runs;
  state.overrideSets = overrideSets;
  return changed;
}

function parseState(raw: string) {
  const parsed = JSON.parse(raw) as Partial<PersistedState>;
  return {
    uploads: Array.isArray(parsed.uploads) ? parsed.uploads : [],
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    overrideSets: Array.isArray(parsed.overrideSets) ? parsed.overrideSets : [],
  } satisfies PersistedState;
}

function isBlobPreconditionFailure(error: unknown) {
  return error instanceof Error && /precondition failed|etag mismatch/i.test(error.message);
}

function mergeBlobStates(local: PersistedState, latest: PersistedState): PersistedState {
  const mergeRecords = <T>(latestRecords: T[], localRecords: T[], getId: (record: T) => string) => {
    const records = new Map(latestRecords.map((record) => [getId(record), record]));
    for (const record of localRecords) records.set(getId(record), record);
    return Array.from(records.values());
  };
  return {
    uploads: mergeRecords(latest.uploads, local.uploads, (record) => record.uploadId),
    runs: mergeRecords(latest.runs, local.runs, (record) => record.runId),
    overrideSets: mergeRecords(latest.overrideSets, local.overrideSets, (record) => `${record.workspaceId}:${record.runId}`),
  };
}

async function loadState(workspaceId?: string) {
  const key = storageKey(workspaceId);
  if (process.env.NODE_ENV === "production" && !hasBlobState()) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required in production for durable forecast state.");
  }
  if (hasBlobState()) {
    if (!workspaceId) throw new Error("A workspace ID is required for Blob state.");
    const result = await get(blobPath(workspaceId), { access: "private", useCache: false });
    if (!result) {
      const state = emptyState();
      stateMetadata.set(state, { key, workspaceId, backend: "blob" });
      return state;
    }
    const state = parseState(await new Response(result.stream).text());
    stateMetadata.set(state, { key, workspaceId, backend: "blob", etag: result.blob.etag });
    return state;
  }

  await mkdir(dataDirectory(), { recursive: true });
  try {
    const state = parseState(await readFile(statePath(), "utf8"));
    stateMetadata.set(state, { key, backend: "file" });
    return state;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      const state = emptyState();
      stateMetadata.set(state, { key, backend: "file" });
      return state;
    }
    throw error;
  }
}

async function getState(workspaceId: string) {
  const key = storageKey(workspaceId);
  const statePromise = hasBlobState()
    ? loadState(workspaceId)
    : statePromises.get(key) ?? loadState(workspaceId);
  if (!hasBlobState()) statePromises.set(key, statePromise);
  const state = await statePromise;
  if (cleanExpired(state)) await persist(state);
  return state;
}

async function persist(state: PersistedState) {
  const serialized = JSON.stringify(state, null, 2);
  const metadata = stateMetadata.get(state);
  if (!metadata) throw new Error("State metadata is missing.");
  const previous = writeQueues.get(metadata.key) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (metadata.backend === "blob") {
      if (!metadata.workspaceId) throw new Error("Blob state metadata is missing a workspace ID.");
      const pathname = blobPath(metadata.workspaceId);
      const putOptions = {
        access: "private" as const,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: 0,
      };
      try {
        const result = await put(pathname, serialized, {
          ...putOptions,
          ...(metadata.etag ? { ifMatch: metadata.etag } : {}),
        });
        metadata.etag = result.etag;
      } catch (error) {
        if (!isBlobPreconditionFailure(error)) throw error;
        const latest = await loadState(metadata.workspaceId);
        const merged = mergeBlobStates(state, latest);
        const result = await put(pathname, JSON.stringify(merged, null, 2), putOptions);
        metadata.etag = result.etag;
        console.warn("[forecast] recovered a stale Blob state write", { key: metadata.key });
      }
      return;
    }
    await mkdir(dataDirectory(), { recursive: true });
    const temporaryPath = `${statePath()}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, serialized, "utf8");
    await rm(statePath(), { force: true });
    await rename(temporaryPath, statePath());
  });
  writeQueues.set(metadata.key, next.catch(() => undefined));
  return next;
}

function findWorkspaceItem<T extends { workspaceId: string }>(items: T[], workspaceId: string, id: string, key: keyof T) {
  return items.find((item) => item.workspaceId === workspaceId && item[key] === id);
}

export function createSourceInputRevision(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const store = {
  async createUpload(input: Omit<UploadRecord, "uploadId" | "createdAt">) {
    const state = await getState(input.workspaceId);
    const upload: UploadRecord = { ...input, uploadId: `upload_${randomUUID()}`, createdAt: nowIso() };
    state.uploads.push(upload);
    await persist(state);
    return clone(upload);
  },

  async getUpload(workspaceId: string, uploadId: string) {
    const state = await getState(workspaceId);
    const upload = findWorkspaceItem(state.uploads, workspaceId, uploadId, "uploadId");
    return upload ? clone(upload) : null;
  },

  async createRun(input: Omit<RunRecord, "runId" | "createdAt" | "externalModelCalls">) {
    const state = await getState(input.workspaceId);
    const run: RunRecord = {
      ...input,
      runId: `run_${randomUUID()}`,
      createdAt: nowIso(),
      externalModelCalls: [],
    };
    state.runs.push(run);
    await persist(state);
    return clone(run);
  },

  async getRun(workspaceId: string, runId: string) {
    const state = await getState(workspaceId);
    const run = findWorkspaceItem(state.runs, workspaceId, runId, "runId");
    return run ? clone(run) : null;
  },

  async listRuns(workspaceId: string) {
    const state = await getState(workspaceId);
    return clone(state.runs.filter((run) => run.workspaceId === workspaceId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  },

  async updateRun(workspaceId: string, runId: string, update: Partial<RunRecord>) {
    const state = await getState(workspaceId);
    const index = state.runs.findIndex((run) => run.workspaceId === workspaceId && run.runId === runId);
    if (index < 0) return null;
    state.runs[index] = { ...state.runs[index], ...update };
    await persist(state);
    return clone(state.runs[index]);
  },

  async getLastCompleteRun(workspaceId: string) {
    const state = await getState(workspaceId);
    const runs = state.runs
      .filter((run) => run.workspaceId === workspaceId && run.state === "Complete")
      .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt));
    return runs[0] ? clone(runs[0]) : null;
  },

  async getOverrideSet(workspaceId: string, runId: string) {
    const state = await getState(workspaceId);
    const set = state.overrideSets.find((item) => item.workspaceId === workspaceId && item.runId === runId);
    return set ? clone(set) : null;
  },

  async ensureOverrideSet(run: RunRecord) {
    const state = await getState(run.workspaceId);
    let set = state.overrideSets.find((item) => item.workspaceId === run.workspaceId && item.runId === run.runId);
    if (!set) {
      set = {
        overrideSetId: `overrides_${randomUUID()}`,
        runId: run.runId,
        uploadId: run.uploadId,
        sourceInputRevision: run.sourceInputRevision,
        workspaceId: run.workspaceId,
        records: {},
        history: [],
      };
      state.overrideSets.push(set);
      await persist(state);
    }
    return clone(set);
  },

  async saveOverride(run: RunRecord, stablePlayerId: string, specification: OverrideSpec) {
    const state = await getState(run.workspaceId);
    let set = state.overrideSets.find((item) => item.workspaceId === run.workspaceId && item.runId === run.runId);
    if (!set) {
      set = {
        overrideSetId: `overrides_${randomUUID()}`,
        runId: run.runId,
        uploadId: run.uploadId,
        sourceInputRevision: run.sourceInputRevision,
        workspaceId: run.workspaceId,
        records: {},
        history: [],
      };
      state.overrideSets.push(set);
    }
    const previous = set.records[stablePlayerId];
    const savedAt = nowIso();
    const record: OverrideSpec = {
      ...specification,
      savedAt,
      revision: (previous?.revision ?? 0) + 1,
      overrideSetId: set.overrideSetId,
      runId: run.runId,
      uploadId: run.uploadId,
      sourceInputRevision: run.sourceInputRevision,
      stablePlayerId,
      workspaceId: run.workspaceId,
    };
    set.records[stablePlayerId] = record;
    set.history.unshift({
      id: `history_${randomUUID()}`,
      action: "save",
      stablePlayerId,
      label: "Override saved",
      detail: record.reason,
      time: savedAt,
      tone: "blue",
    });
    await persist(state);
    return clone(set);
  },

  async resetOverride(run: RunRecord, stablePlayerId: string) {
    const state = await getState(run.workspaceId);
    const set = state.overrideSets.find((item) => item.workspaceId === run.workspaceId && item.runId === run.runId);
    if (!set) return this.ensureOverrideSet(run);
    const previous = set.records[stablePlayerId];
    if (previous) {
      delete set.records[stablePlayerId];
      set.history.unshift({
        id: `history_${randomUUID()}`,
        action: "reset",
        stablePlayerId,
        label: "Override reset",
        detail: "The original model values are active.",
        time: nowIso(),
        tone: "gray",
      });
      await persist(state);
    }
    return clone(set);
  },

  async copyOverrides(source: RunRecord, target: RunRecord) {
    const state = await getState(source.workspaceId);
    const sourceSet = state.overrideSets.find((item) => item.workspaceId === source.workspaceId && item.runId === source.runId);
    const targetSet: OverrideSet = {
      overrideSetId: `overrides_${randomUUID()}`,
      runId: target.runId,
      uploadId: target.uploadId,
      sourceInputRevision: target.sourceInputRevision,
      workspaceId: target.workspaceId,
      records: {},
      history: [],
    };
    const targetIds = new Set(target.result?.rows.map((row) => row.stablePlayerId) ?? []);
    const copiedPlayerIds: string[] = [];
    const unmatchedPlayerIds: string[] = [];
    for (const [stablePlayerId, record] of Object.entries(sourceSet?.records ?? {})) {
      if (!targetIds.has(stablePlayerId)) {
        unmatchedPlayerIds.push(stablePlayerId);
        continue;
      }
      targetSet.records[stablePlayerId] = {
        ...record,
        overrideSetId: targetSet.overrideSetId,
        runId: target.runId,
        uploadId: target.uploadId,
        sourceInputRevision: target.sourceInputRevision,
        workspaceId: target.workspaceId,
        savedAt: nowIso(),
        revision: 1,
      };
      copiedPlayerIds.push(stablePlayerId);
    }
    targetSet.history.unshift({
      id: `history_${randomUUID()}`,
      action: "copy",
      label: "Overrides copied",
      detail: `${copiedPlayerIds.length} matched, ${unmatchedPlayerIds.length} unmatched.`,
      time: nowIso(),
      tone: "orange",
    });
    state.overrideSets = state.overrideSets.filter((item) => !(item.workspaceId === target.workspaceId && item.runId === target.runId));
    state.overrideSets.push(targetSet);
    await persist(state);
    return { set: clone(targetSet), report: { copiedPlayerIds, unmatchedPlayerIds, sourceRunId: source.runId, targetRunId: target.runId } satisfies OverrideCopyReport };
  },
};
