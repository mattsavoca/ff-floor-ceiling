import type { Position, UploadReport } from "./types";

const supportedPositions = new Set<Position>(["QB", "RB", "WR", "TE"]);
export const MAX_UPLOAD_ROWS = 50_000;

export type ProjectionCsvOptions = {
  selectedSetId?: string;
  selectedSetName?: string;
};

export type ParsedProjectionRow = {
  raw: Record<string, string>;
  stablePlayerId: string;
  playerName: string;
  position: Exclude<Position, "DST">;
  team: string;
  ecr: number;
  csvProjection: number;
  sourceRowOrder: number;
  selectedSetId: string;
  selectedSetName: string;
};

export type ParsedUpload = {
  report: UploadReport;
  rows: Array<Record<string, string>>;
  acceptedRows: ParsedProjectionRow[];
  headers: string[];
  selectedSetId: string;
  selectedSetName: string;
};

type CsvRecord = {
  cells: string[];
  line: number;
};

export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const pushCell = () => {
    cells.push(cell.trim());
    cell = "";
  };
  const pushRecord = () => {
    pushCell();
    if (cells.some((value) => value.length > 0)) records.push({ cells, line: recordLine });
    cells = [];
    recordLine = line;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      pushCell();
    } else if (character === "\n" && !quoted) {
      pushRecord();
      line += 1;
      recordLine = line;
    } else if (character === "\r" && !quoted) {
      if (next !== "\n") {
        pushRecord();
        line += 1;
        recordLine = line;
      }
    } else {
      cell += character;
    }
  }
  if (cell.length > 0 || cells.length > 0) pushRecord();
  return records;
}

export function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function valueFor(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return "";
}

function numberFor(row: Record<string, string>, keys: string[]) {
  const value = valueFor(row, keys);
  if (!value) return 0;
  return Number(value);
}

const statAliases = {
  passYards: ["pass_yds", "pass_yards"],
  passTouchdowns: ["pass_td", "pass_touchdowns"],
  interceptions: ["pass_int", "interceptions"],
  passTwoPoint: ["pass_2pt", "pass_two_point"],
  rushYards: ["rush_yds", "rush_yards"],
  rushTouchdowns: ["rush_td", "rush_touchdowns"],
  rushTwoPoint: ["rush_2pt", "rush_two_point"],
  receivingYards: ["rec_yds", "rec_yards"],
  receivingTouchdowns: ["rec_td", "rec_touchdowns"],
  receivingTwoPoint: ["rec_2pt", "rec_two_point"],
  receptions: ["rec_rec", "receptions", "rec"],
  fumblesLost: ["fum_lost", "fumbles_lost"],
} as const;

export const PPR_STAT_FIELDS = Object.values(statAliases).flat();

export function calculatePprProjection(row: Record<string, string>) {
  const value =
    numberFor(row, [...statAliases.passYards]) / 25
    + numberFor(row, [...statAliases.passTouchdowns]) * 4
    - numberFor(row, [...statAliases.interceptions])
    + numberFor(row, [...statAliases.passTwoPoint]) * 2
    + numberFor(row, [...statAliases.rushYards]) / 10
    + numberFor(row, [...statAliases.rushTouchdowns]) * 6
    + numberFor(row, [...statAliases.rushTwoPoint]) * 2
    + numberFor(row, [...statAliases.receivingYards]) / 10
    + numberFor(row, [...statAliases.receivingTouchdowns]) * 6
    + numberFor(row, [...statAliases.receivingTwoPoint]) * 2
    + numberFor(row, [...statAliases.receptions])
    - numberFor(row, [...statAliases.fumblesLost]) * 2;
  return value;
}

function setInfo(row: Record<string, string>) {
  const id = valueFor(row, ["set_id", "setid"]) || "uploaded_set";
  const label = valueFor(row, ["set_name", "setname", "set", "projection_set"]) || "Uploaded projection set";
  return { id, label };
}

function makeRawRow(headers: string[], cells: string[]) {
  return headers.reduce<Record<string, string>>((record, header, index) => {
    record[header] = (cells[index] ?? "").trim();
    return record;
  }, {});
}

function chooseSet(
  groups: Array<{ id: string; label: string; rows: Array<{ raw: Record<string, string>; line: number }> }>,
  options: ProjectionCsvOptions,
) {
  if (!groups.length) return null;
  if (options.selectedSetId) return groups.find((group) => group.id === options.selectedSetId) ?? null;
  if (options.selectedSetName) {
    const named = groups.filter((group) => group.label.toLowerCase() === options.selectedSetName!.trim().toLowerCase());
    if (named.length) return [...named].sort((left, right) => right.rows.length - left.rows.length)[0];
  }
  const consensus = groups.filter((group) => group.label.toLowerCase() === "projections consensus");
  if (consensus.length) return [...consensus].sort((left, right) => right.rows.length - left.rows.length)[0];
  return [...groups].sort((left, right) => right.rows.length - left.rows.length)[0];
}

export function parseProjectionCsv(text: string, fileName: string, options: ProjectionCsvOptions = {}): ParsedUpload {
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""));
  const rawHeaders = records[0]?.cells ?? [];
  const headers = rawHeaders.map(normalizeHeader);
  const errors: UploadReport["errors"] = [];
  const totalRows = Math.max(0, records.length - 1);
  const rows = records.slice(1, MAX_UPLOAD_ROWS + 1).map((record) => makeRawRow(headers, record.cells));

  const uniqueHeaders = new Set(headers);
  const hasId = headers.some((header) => ["id", "player_id", "fbg_id", "stable_player_id"].includes(header));
  const hasName = headers.some((header) => ["player_name", "name", "player"].includes(header));
  const hasPosition = headers.some((header) => ["position", "pos"].includes(header));
  const hasTeam = headers.some((header) => ["team", "team_abbr", "team_alias", "tm"].includes(header));
  if (headers.length === 0) errors.push({ row: 1, field: "file", message: "The file needs a header row." });
  if (uniqueHeaders.size !== headers.length) errors.push({ row: 1, field: "header", message: "The file contains duplicate column names." });
  if (!hasId) errors.push({ row: 1, field: "id", message: "The file needs a stable player ID field." });
  if (!hasName) errors.push({ row: 1, field: "player_name", message: "The file needs a player name field." });
  if (!hasPosition) errors.push({ row: 1, field: "position", message: "The file needs a position field." });
  if (!hasTeam) errors.push({ row: 1, field: "team", message: "The file needs a team field." });
  if (totalRows > MAX_UPLOAD_ROWS) errors.push({ row: 0, field: "file", message: `The file has ${totalRows.toLocaleString()} rows. The limit is ${MAX_UPLOAD_ROWS.toLocaleString()}.` });

  const grouped = new Map<string, { id: string; label: string; rows: Array<{ raw: Record<string, string>; line: number }> }>();
  rows.forEach((raw, index) => {
    const info = setInfo(raw);
    const key = `${info.id}\u0000${info.label}`;
    const group = grouped.get(key) ?? { ...info, rows: [] };
    group.rows.push({ raw, line: records[index + 1]?.line ?? index + 2 });
    grouped.set(key, group);
  });
  const groups = Array.from(grouped.values());
  const selected = chooseSet(groups, options);
  if (!selected && groups.length) {
    errors.push({ row: 0, field: "set-id", message: `The selected projection set was not found: ${options.selectedSetId}.` });
  }
  const selectedSetId = selected?.id ?? options.selectedSetId ?? "uploaded_set";
  const selectedSetName = selected?.label ?? options.selectedSetName ?? "Uploaded projection set";
  const selectedRows = selected?.rows ?? [];
  const sourceOrderUsed = !headers.some((header) => ["rank", "ecr", "consensus_rank", "positional_rank", "pos_rank"].includes(header));
  const explicitRankHeader = headers.some((header) => ["rank", "ecr", "consensus_rank", "positional_rank", "pos_rank"].includes(header));
  const seenIds = new Set<string>();
  const acceptedRows: ParsedProjectionRow[] = [];
  const positionCounts: UploadReport["positionCounts"] = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const rankCounts = new Map<string, number>();

  selectedRows.forEach(({ raw, line }) => {
    const stablePlayerId = valueFor(raw, ["id", "player_id", "fbg_id", "stable_player_id"]);
    const playerName = valueFor(raw, ["player_name", "name", "player"]);
    const position = valueFor(raw, ["position", "pos"]).toUpperCase() as Position;
    const team = valueFor(raw, ["team", "team_abbr", "team_alias", "tm"]).toUpperCase();
    if (!stablePlayerId) {
      errors.push({ row: line, field: "id", message: "The stable player ID is empty." });
      return;
    }
    if (!playerName) {
      errors.push({ row: line, field: "player_name", message: "The player name is empty." });
      return;
    }
    if (!supportedPositions.has(position)) {
      errors.push({ row: line, field: "position", message: "The position is outside QB, RB, WR, and TE.", value: position });
      return;
    }
    if (!team || team === "FA") {
      errors.push({ row: line, field: "team", message: "The team is missing or marked FA.", value: team });
      return;
    }
    if (seenIds.has(stablePlayerId)) {
      errors.push({ row: line, field: "id", message: "The stable player ID is duplicated.", value: stablePlayerId });
      return;
    }
    seenIds.add(stablePlayerId);

    for (const field of PPR_STAT_FIELDS) {
      const value = raw[field];
      if (value !== undefined && value !== "" && !Number.isFinite(Number(value))) {
        errors.push({ row: line, field, message: "The projection field must be numeric.", value });
        return;
      }
    }

    const explicitRank = valueFor(raw, ["rank", "ecr", "consensus_rank", "positional_rank", "pos_rank"]);
    const hasExplicitRank = Boolean(explicitRankHeader && explicitRank);
    const rank = hasExplicitRank ? Number(explicitRank) : (rankCounts.get(position) ?? 0) + 1;
    if (!Number.isFinite(rank) || rank < 1) {
      errors.push({ row: line, field: "rank", message: "The positional rank must be a positive number.", value: explicitRank });
      return;
    }
    const sourceRowOrder = line;
    rankCounts.set(position, Math.max(rankCounts.get(position) ?? 0, rank));
    positionCounts[position as keyof typeof positionCounts] += 1;
    acceptedRows.push({
      raw,
      stablePlayerId,
      playerName,
      position: position as Exclude<Position, "DST">,
      team,
      ecr: rank,
      csvProjection: calculatePprProjection(raw),
      sourceRowOrder,
      selectedSetId,
      selectedSetName,
    });
  });

  const sourceTimestamp = valueFor(rows[0] ?? {}, ["as_of", "scrape_date", "date", "datetime"]) || "Not found in file";
  const sets = groups.map((group) => ({ id: group.id, label: group.label, rows: group.rows.length }));
  return {
    rows,
    acceptedRows,
    headers,
    selectedSetId,
    selectedSetName,
    report: {
      fileName,
      sourceTimestamp,
      rows: totalRows,
      accepted: acceptedRows.length,
      excluded: Math.max(0, selectedRows.length - acceptedRows.length),
      unresolved: 0,
      positionCounts,
      selectedSet: selectedSetId,
      selectedSetId,
      selectedSetLabel: selectedSetName,
      sets,
      errors,
      sourceOrderUsed,
    },
  };
}

export function escapeCsvCell(value: string | number | boolean | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function buildCsv<T extends Record<string, unknown>>(rows: T[], columns: Array<keyof T>) {
  const header = columns.map((column) => escapeCsvCell(String(column))).join(",");
  const body = rows.map((row) => columns.map((column) => escapeCsvCell(row[column] as string | number | boolean | null | undefined)).join(","));
  return [header, ...body].join("\n");
}

export function downloadText(fileName: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
