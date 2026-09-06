import type { Position, UploadReport } from "./types";

const supportedPositions = new Set<Position>(["QB", "RB", "WR", "TE"]);
export const MAX_UPLOAD_ROWS = 50_000;

export type ParsedUpload = {
  report: UploadReport;
  rows: Array<Record<string, string>>;
};

function parseLine(line: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function valueFor(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

export function parseProjectionCsv(text: string, fileName: string): ParsedUpload {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  const totalRows = Math.max(0, lines.length - 1);
  const rawHeaders = lines.length ? parseLine(lines[0]) : [];
  const headers = rawHeaders.map(normalizeHeader);
  const parsedRows = lines.slice(1, MAX_UPLOAD_ROWS + 1).map((line) => {
    const values = parseLine(line);
    return headers.reduce<Record<string, string>>((record, header, index) => {
      record[header] = values[index] ?? "";
      return record;
    }, {});
  });

  const errors: UploadReport["errors"] = [];
  const hasName = headers.some((header) => ["player_name", "name", "player"].includes(header));
  const hasPosition = headers.some((header) => ["position", "pos"].includes(header));
  const hasTeam = headers.some((header) => ["team", "team_abbr", "team_alias"].includes(header));
  if (!hasName) errors.push({ row: 1, field: "player_name", message: "The file needs a player name field." });
  if (!hasPosition) errors.push({ row: 1, field: "position", message: "The file needs a position field." });
  if (!hasTeam) errors.push({ row: 1, field: "team", message: "The file needs a team field." });
  if (totalRows > MAX_UPLOAD_ROWS) errors.push({ row: 0, field: "file", message: `The file has ${totalRows.toLocaleString()} rows. The limit is ${MAX_UPLOAD_ROWS.toLocaleString()}.` });

  let accepted = 0;
  let excluded = 0;
  let unresolved = 0;
  const seenKeys = new Set<string>();
  parsedRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const position = valueFor(row, ["position", "pos"]).toUpperCase() as Position;
    const name = valueFor(row, ["player_name", "name", "player"]);
    const team = valueFor(row, ["team", "team_abbr", "team_alias"]).toUpperCase();
    if (!name) {
      errors.push({ row: rowNumber, field: "player_name", message: "The player name is empty." });
      excluded += 1;
      return;
    }
    if (!supportedPositions.has(position)) {
      errors.push({ row: rowNumber, field: "position", message: "The position is outside QB, RB, WR, and TE.", value: position });
      excluded += 1;
      return;
    }
    if (!team || team === "FA") {
      errors.push({ row: rowNumber, field: "team", message: "The team is missing or marked FA.", value: team });
      excluded += 1;
      return;
    }
    const identityKey = `${name.toLowerCase()}|${position}|${team}`;
    if (seenKeys.has(identityKey)) {
      errors.push({ row: rowNumber, field: "player_name", message: "This player, position, and team key is duplicated.", value: name });
      excluded += 1;
      return;
    }
    seenKeys.add(identityKey);
    const projectionValue = valueFor(row, ["projected_points", "projection", "outcome_projection", "points"]);
    if (projectionValue && !Number.isFinite(Number(projectionValue))) {
      errors.push({ row: rowNumber, field: "projected_points", message: "The projection must be numeric.", value: projectionValue });
      excluded += 1;
      return;
    }
    if (!valueFor(row, ["rank", "ecr", "consensus_rank"])) {
      unresolved += 0;
    }
    accepted += 1;
  });

  const setName = valueFor(parsedRows[0] ?? {}, ["set", "set_name", "projection_set"]) || "Uploaded projection set";
  const sourceOrderUsed = !headers.some((header) => ["rank", "ecr", "consensus_rank"].includes(header));
  return {
    rows: parsedRows,
    report: {
      fileName,
      sourceTimestamp: "Not found in file",
      rows: totalRows,
      accepted,
      excluded,
      unresolved,
      selectedSet: setName,
      sets: [{ id: "uploaded_set", label: setName, rows: totalRows }],
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
