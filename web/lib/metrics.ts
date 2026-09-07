import type { ForecastRow, OverridePreset, OverrideSpec, RangeValues } from "./types";

export function clampFactor(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0, value));
}

export function applyOverride(row: ForecastRow, override?: OverrideSpec): RangeValues {
  if (!override) return row.original;
  if (override.inactive) return { floor: 0, median: 0, ceiling: 0 };

  const factor = clampFactor(override.workloadFactor ?? override.factor);
  const scaled: RangeValues = {
    floor: row.original.floor * factor,
    median: row.original.median * factor,
    ceiling: row.original.ceiling * factor,
  };

  const presetFactors: Record<OverridePreset, number> = {
    full: 1,
    half: 0.5,
    quarter: 0.25,
    reduced_role: 0.75,
  };
  const preset = override.preset;
  const presetSupported = preset !== "reduced_role" || ["RB", "WR", "TE"].includes(row.position);
  const presetFactor = preset && presetSupported ? presetFactors[preset] : 1;
  scaled.floor *= presetFactor;
  scaled.median *= presetFactor;
  scaled.ceiling *= presetFactor;

  if (override.defensePreset && row.position === "DST") {
    const reference = override.analystProjection ?? row.sourceProjection;
    if (reference > 0 && scaled.ceiling < 1.25 * reference) scaled.ceiling *= 2.5;
  }

  return {
    floor: override.edits.floor ?? scaled.floor,
    median: override.edits.median ?? scaled.median,
    ceiling: override.edits.ceiling ?? scaled.ceiling,
  };
}

export function validateRange(values: RangeValues) {
  const invalidField = Object.entries(values).find(([, value]) => !Number.isFinite(value))?.[0];
  if (invalidField) return `Enter a finite value for the ${invalidField}.`;
  if (values.floor > values.median) return "The floor cannot be greater than the median.";
  if (values.median > values.ceiling) return "The median cannot be greater than the ceiling.";
  return null;
}

export function formatNumber(value: number, digits = 1) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function formatPercent(value: number, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

export function quantileLoss(actual: number, prediction: number, quantile: number) {
  const error = actual - prediction;
  return Math.max(quantile * error, (quantile - 1) * error);
}

export function calculateDemoSummary(rows: ForecastRow[], overrides: Record<string, OverrideSpec>) {
  const adjusted = rows.map((row) => applyOverride(row, overrides[row.id]));
  const averageWidth = adjusted.reduce((sum, value) => sum + value.ceiling - value.floor, 0) / Math.max(adjusted.length, 1);
  const averageMedian = adjusted.reduce((sum, value) => sum + value.median, 0) / Math.max(adjusted.length, 1);
  return { averageWidth, averageMedian, adjustedCount: Object.keys(overrides).length };
}
