import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ParsedProjectionRow } from "../csv";
import type {
  ForecastResult,
  OverrideHistoryEntry,
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

function dataDirectory() {
  const configured = process.env.FC_DATA_DIR;
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), ".forecast-data");
}

function statePath() {
  return path.join(dataDirectory(), "state.json");
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
  state.uploads = state.uploads.filter((item) => activeWorkspaces.has(item.workspaceId));
  state.runs = state.runs.filter((item) => activeWorkspaces.has(item.workspaceId));
  state.overrideSets = state.overrideSets.filter((item) => activeWorkspaces.has(item.workspaceId));
}

async function loadState() {
  await mkdir(dataDirectory(), { recursive: true });
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const state: PersistedState = {
      uploads: Array.isArray(parsed.uploads) ? parsed.uploads : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      overrideSets: Array.isArray(parsed.overrideSets) ? parsed.overrideSets : [],
    };
    cleanExpired(state);
    return state;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return emptyState();
    throw error;
  }
}

let statePromise: Promise<PersistedState> | undefined;
let writeQueue: Promise<void> = Promise.resolve();

async function getState() {
  statePromise ??= loadState();
  const state = await statePromise;
  cleanExpired(state);
  return state;
}

async function persist(state: PersistedState) {
  const serialized = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    await mkdir(dataDirectory(), { recursive: true });
    const temporaryPath = `${statePath()}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, serialized, "utf8");
    await rm(statePath(), { force: true });
    await rename(temporaryPath, statePath());
  });
  return writeQueue;
}

function findWorkspaceItem<T extends { workspaceId: string }>(items: T[], workspaceId: string, id: string, key: keyof T) {
  return items.find((item) => item.workspaceId === workspaceId && item[key] === id);
}

export function createSourceInputRevision(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const store = {
  async createUpload(input: Omit<UploadRecord, "uploadId" | "createdAt">) {
    const state = await getState();
    const upload: UploadRecord = { ...input, uploadId: `upload_${randomUUID()}`, createdAt: nowIso() };
    state.uploads.push(upload);
    await persist(state);
    return clone(upload);
  },

  async getUpload(workspaceId: string, uploadId: string) {
    const state = await getState();
    const upload = findWorkspaceItem(state.uploads, workspaceId, uploadId, "uploadId");
    return upload ? clone(upload) : null;
  },

  async createRun(input: Omit<RunRecord, "runId" | "createdAt" | "externalModelCalls">) {
    const state = await getState();
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
    const state = await getState();
    const run = findWorkspaceItem(state.runs, workspaceId, runId, "runId");
    return run ? clone(run) : null;
  },

  async listRuns(workspaceId: string) {
    const state = await getState();
    return clone(state.runs.filter((run) => run.workspaceId === workspaceId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  },

  async updateRun(workspaceId: string, runId: string, update: Partial<RunRecord>) {
    const state = await getState();
    const index = state.runs.findIndex((run) => run.workspaceId === workspaceId && run.runId === runId);
    if (index < 0) return null;
    state.runs[index] = { ...state.runs[index], ...update };
    await persist(state);
    return clone(state.runs[index]);
  },

  async getLastCompleteRun(workspaceId: string) {
    const state = await getState();
    const runs = state.runs
      .filter((run) => run.workspaceId === workspaceId && run.state === "Complete")
      .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt));
    return runs[0] ? clone(runs[0]) : null;
  },

  async getOverrideSet(workspaceId: string, runId: string) {
    const state = await getState();
    const set = state.overrideSets.find((item) => item.workspaceId === workspaceId && item.runId === runId);
    return set ? clone(set) : null;
  },

  async ensureOverrideSet(run: RunRecord) {
    const state = await getState();
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
    const state = await getState();
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
    const state = await getState();
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
    const state = await getState();
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
