import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ParsedProjectionRow } from "@/lib/csv";

export type RankReferenceRow = {
  position: string;
  rank: number;
  rankSd: number;
};

export type RankedProjectionRow = ParsedProjectionRow & {
  rankSd: number;
  rankSdMatch: "exact" | "nearest";
};

export type RankReferenceSnapshot = {
  snapshotId: string;
  csvPath: string;
  metadataPath: string;
  rows: RankReferenceRow[];
  metadata: Record<string, unknown>;
};

function projectRootCandidates() {
  const cwd = process.cwd();
  return [
    process.env.FC_PROJECT_ROOT,
    cwd,
    path.resolve(cwd, ".."),
  ].filter((value): value is string => Boolean(value));
}

function candidatePaths(relativePath: string) {
  return projectRootCandidates().map((root) => path.resolve(root, relativePath));
}

async function firstExistingPath(relativePath: string) {
  for (const candidate of candidatePaths(relativePath)) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function parseSnapshotCsv(text: string): RankReferenceRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const cleanCell = (value: string) => value.trim().replace(/^"(.*)"$/, "$1").replaceAll('""', '"');
  const headers = lines[0].split(",").map((value) => cleanCell(value).toLowerCase());
  const positionIndex = headers.indexOf("position");
  const rankIndex = headers.indexOf("rank");
  const sdIndex = headers.indexOf("rank_sd");
  if (positionIndex < 0 || rankIndex < 0 || sdIndex < 0) {
    throw new Error("The rank reference snapshot must contain position, rank, and rank_sd columns.");
  }
  return lines.slice(1).flatMap((line) => {
    const cells = line.split(",").map(cleanCell);
    const position = cells[positionIndex]?.toUpperCase();
    const rank = Number(cells[rankIndex]);
    const rankSd = Number(cells[sdIndex]);
    if (!position || !Number.isFinite(rank) || !Number.isFinite(rankSd) || rank < 1 || rankSd < 0) return [];
    return [{ position, rank, rankSd }];
  });
}

export async function loadRankReferenceSnapshot(): Promise<RankReferenceSnapshot> {
  const csvPath = process.env.FC_RANK_REFERENCE_CSV
    ? path.resolve(process.env.FC_RANK_REFERENCE_CSV)
    : await firstExistingPath("data/ffsimulator/ffs_latest_rankings_week.csv")
      ?? await firstExistingPath("artifacts/ffsimulator/ffs_latest_rankings_week.csv");
  const metadataPath = process.env.FC_RANK_REFERENCE_METADATA
    ? path.resolve(process.env.FC_RANK_REFERENCE_METADATA)
    : await firstExistingPath("data/ffsimulator/ffs_latest_rankings_week.metadata.json")
      ?? await firstExistingPath("artifacts/ffsimulator/ffs_latest_rankings_week.metadata.json");
  if (!csvPath || !metadataPath) {
    throw new Error("The local ffsimulator weekly ranking snapshot is missing. Run scripts/create_ffsimulator_snapshot.R first.");
  }
  const [csv, metadataText] = await Promise.all([readFile(csvPath, "utf8"), readFile(metadataPath, "utf8")]);
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(metadataText) as Record<string, unknown>;
  } catch {
    throw new Error("The rank reference metadata is not valid JSON.");
  }
  const rows = parseSnapshotCsv(csv);
  if (!rows.length) throw new Error("The rank reference snapshot has no usable rows.");
  return {
    snapshotId: String(metadata.snapshot_id ?? path.basename(csvPath)),
    csvPath,
    metadataPath,
    rows,
    metadata,
  };
}

export function joinRankUncertainty(rows: ParsedProjectionRow[], referenceRows: RankReferenceRow[]): RankedProjectionRow[] {
  const byPosition = new Map<string, RankReferenceRow[]>();
  for (const reference of referenceRows) {
    const position = reference.position.toUpperCase();
    if (!Number.isFinite(reference.rank) || !Number.isFinite(reference.rankSd) || reference.rankSd < 0) continue;
    const values = byPosition.get(position) ?? [];
    values.push({ ...reference, position });
    byPosition.set(position, values);
  }
  byPosition.forEach((values) => values.sort((left, right) => left.rank - right.rank));

  const missingPositions = Array.from(new Set(rows.map((row) => row.position))).filter((position) => !(byPosition.get(position)?.length));
  if (missingPositions.length) throw new Error(`The rank reference has no usable uncertainty for: ${missingPositions.join(", ")}.`);

  return rows.map((row) => {
    const values = byPosition.get(row.position)!;
    const exact = values.find((value) => value.rank === row.ecr);
    const nearest = exact ?? values.reduce((best, value) => {
      const distance = Math.abs(value.rank - row.ecr);
      const bestDistance = Math.abs(best.rank - row.ecr);
      return distance < bestDistance || (distance === bestDistance && value.rank < best.rank) ? value : best;
    });
    const rankSd = Math.max(0.5, nearest.rankSd);
    if (!Number.isFinite(rankSd)) throw new Error(`The rank reference produced no usable uncertainty for ${row.stablePlayerId}.`);
    return {
      ...row,
      rankSd,
      rankSdMatch: exact ? "exact" : "nearest",
    };
  });
}
