"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  Download,
  Eye,
  FileText,
  Gauge,
  GitBranch,
  Info,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Play,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Target,
  Upload,
  UserRound,
  Users,
  X,
  Zap,
} from "lucide-react";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { buildCsv, downloadText, parseProjectionCsv } from "@/lib/csv";
import { EChart } from "@/components/EChart";
import {
  calibrationBinMinimum,
  calibrationModel,
  oosSeasonPositionMetrics,
  oosWeeklyPositionMetrics,
  oosWeeklySummaries,
  floorOosWeeklyPositionMetrics,
  floorOosWeeklySummaries,
  positionModelSelections,
  scoringContract,
  selectedCalibrationBins,
  selectedModelByPosition,
  selectedPortfolioOverall,
  floorCalibrationBinMinimum,
  floorCalibrationModel,
  floorScoringContract,
  floorSelectedCalibrationBins,
  floorSelectedModelByPosition,
  floorSelectedPortfolioOverall,
  floorOosSeasonPositionMetrics,
  floorPositionModelSelections,
  floorModelFits,
  floorFeatureFamilies,
  ffsimulatorModel,
  scorecardMetrics,
} from "@/lib/calibration-data";
import {
  demoForecasts,
  demoUploadReport,
} from "@/lib/project-data";
import { applyOverride, calculateDemoSummary, clampFactor, formatNumber, validateRange } from "@/lib/metrics";
import { DEFAULT_SIMULATION_COUNT, MAX_SIMULATIONS, MIN_SIMULATIONS, SIMULATION_STEP, isValidSimulationCount } from "@/lib/simulation-config";
import type { ForecastResult, ForecastRow, OverrideHistoryEntry, OverridePreset, OverrideSet, OverrideSpec, RangeValues, RunState, TabId, UploadReport, ViewMode } from "@/lib/types";
import type { EChartsOption } from "echarts";

const navItems: Array<{ id: TabId; label: string; description: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", description: "Weekly monitoring", icon: LayoutDashboard },
  { id: "methodology", label: "Methodology", description: "How ranges are derived", icon: GitBranch },
  { id: "calibration", label: "Calibration", description: "Compare with past scores", icon: Target },
  { id: "projection", label: "Forecast workflow", description: "Upload and run", icon: Zap },
  { id: "overrides", label: "Manual overrides", description: "Record judgment", icon: SlidersHorizontal },
];

const positionOptions = ["All", "QB", "RB", "WR", "TE"] as const;
const monitoringSeasonOptions = ["2026", "2025"] as const;
const monitoringWeekOptions = ["1", "14", "15", "16", "17"] as const;
const monitoringPositionOrder = ["QB", "RB", "WR", "TE"] as const;
const monitoringPositionColors: Record<(typeof monitoringPositionOrder)[number], string> = {
  QB: "#7C5BAA",
  RB: "#1264A3",
  WR: "#2E8B73",
  TE: "#D87945",
};
const positionDisplayNames: Record<(typeof monitoringPositionOrder)[number], string> = {
  QB: "Quarterback",
  RB: "Running back",
  WR: "Wide receiver",
  TE: "Tight end",
};
const runStates: RunState[] = ["Empty", "Checking upload", "Ready", "Queued", "Running", "Complete", "Failed", "Canceled"];

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function forecastRowsFromResult(result: ForecastResult): ForecastRow[] {
  return result.rows.map((row) => ({
    id: row.stablePlayerId,
    name: row.playerName,
    position: row.position,
    team: row.team,
    opponent: row.opponent,
    game: `${row.team} vs ${row.opponent}`,
    sourceProjection: row.average,
    average: row.average,
    csvProjection: row.csvProjection,
    rank: row.ecr,
    sourceRowOrder: row.sourceRowOrder,
    rankSd: row.rankSd,
    rankSdMatch: row.rankSdMatch,
    season: row.season,
    week: row.week,
    inputRevision: result.metadata.sourceInputRevision,
    runId: result.runId,
    modelRelease: result.metadata.modelRelease,
    originalAverage: row.average,
    rawProjection: row.rawProjection,
    ffsim: {
      mean: row.ffsimMean,
      p15: row.ffsimP15,
      p50: row.ffsimP50,
      p85: row.ffsimP85,
      zeroRate: row.ffsimZeroRate,
      activeRate: row.ffsimActiveRate,
    },
    xgbP15: row.xgbP15 ?? undefined,
    xgbP85: row.xgbP85 ?? undefined,
    valueSources: row.valueSources,
    original: { floor: row.floor, median: row.median, ceiling: row.ceiling },
    nSimulations: result.metadata.simulationCount,
    hasDraws: true,
  }));
}

function browserCookie(name: string) {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  return document.cookie.split("; ").find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function iconForStatus(status: string) {
  if (status === "good" || status === "Complete" || status === "Ready") return <CheckCircle2 size={15} />;
  if (status === "warn" || status === "Needs review" || status === "Limited sample") return <AlertTriangle size={15} />;
  if (status === "Pending" || status === "Results pending") return <Clock3 size={15} />;
  return <Info size={15} />;
}

function StatusPill({ label, tone = "neutral", icon = true }: { label: string; tone?: "good" | "warn" | "neutral" | "blue" | "dark"; icon?: boolean }) {
  return <span className={cx("status-pill", `status-${tone}`)}>{icon ? iconForStatus(tone === "good" ? "good" : tone === "warn" ? "warn" : label) : null}{label}</span>;
}

function MetricCard({ label, value, detail, tone = "neutral", icon }: { label: string; value: string; detail: string; tone?: "good" | "warn" | "neutral"; icon: React.ReactNode }) {
  return (
    <article className="metric-card">
      <div className="metric-card-top"><span className="metric-icon">{icon}</span><span className="metric-label">{label}</span><MoreHorizontal size={16} className="muted" /></div>
      <div className={cx("metric-value", tone === "warn" && "metric-warn")}>{value}</div>
      <div className="metric-detail">{detail}</div>
    </article>
  );
}

function Panel({ children, className, title, eyebrow, action }: { children: React.ReactNode; className?: string; title?: string; eyebrow?: string; action?: React.ReactNode }) {
  return (
    <section className={cx("panel", className)}>
      {(title || eyebrow || action) && (
        <div className="panel-header">
          <div>
            {eyebrow ? <div className="panel-eyebrow">{eyebrow}</div> : null}
            {title ? <h2 className="panel-title">{title}</h2> : null}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function FilterSelect({ label, value, options, onChange, compact = false }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void; compact?: boolean }) {
  return (
    <label className={cx("filter-control", compact && "filter-compact")}>
      <span>{label}</span>
      <span className="select-wrap"><select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select><ChevronDown size={14} /></span>
    </label>
  );
}

function SearchField({ value, onChange, placeholder = "Search players" }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="search-field"><Search size={16} /><span className="sr-only">{placeholder}</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function Button({ children, onClick, variant = "secondary", disabled = false, type = "button", className, icon }: { children: React.ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "quiet" | "danger"; disabled?: boolean; type?: "button" | "submit"; className?: string; icon?: React.ReactNode }) {
  return <button type={type} disabled={disabled} onClick={onClick} className={cx("button", `button-${variant}`, className)}>{icon}{children}</button>;
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <label className={cx("toggle-control", disabled && "toggle-disabled")}><span>{label}</span><button type="button" aria-pressed={checked} disabled={disabled} className={cx("toggle", checked && "toggle-on")} onClick={() => onChange(!checked)}><span /></button></label>;
}

function Explainer({ children }: { children: React.ReactNode }) {
  return <div className="explainer"><Info size={15} /><span>{children}</span></div>;
}

function EmptyState({ icon = <Table2 size={24} />, title, body, action }: { icon?: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

function DataTable<T extends object>({ data, columns, empty = "No rows match these filters.", onRowClick }: { data: T[]; columns: ColumnDef<T, unknown>[]; empty?: string; onRowClick?: (row: T) => void }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({ data, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr>{table.getHeaderGroups().map((headerGroup) => headerGroup.headers.map((header) => <th key={header.id} className={header.column.getIsSorted() ? "sorted" : ""}>{header.isPlaceholder ? null : <button type="button" className="table-sort" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() ? (header.column.getIsSorted() === "asc" ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />) : null}</button>}</th>))}</tr></thead>
        <tbody>
          {table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => <tr key={row.id} onClick={() => onRowClick?.(row.original)} className={onRowClick ? "clickable-row" : ""}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>) : <tr><td colSpan={columns.length}><EmptyState title="No matching rows" body={empty} /></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ContextStrip({ season, week, metricDefinition, onSeason, onWeek, onMetricDefinition, onNavigateOverview }: { season: string; week: string; metricDefinition: string; onSeason: (value: string) => void; onWeek: (value: string) => void; onMetricDefinition: (value: string) => void; onNavigateOverview: () => void }) {
  return (
    <div className="context-strip" role="link" tabIndex={0} aria-label="Open Overview model performance" title="Open Overview model performance" onClick={(event) => { const target = event.target as HTMLElement; if (target.closest?.("label")) return; onNavigateOverview(); }} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onNavigateOverview(); } }}>
      <FilterSelect label="Season" value={season} options={monitoringSeasonOptions} onChange={onSeason} compact />
      <FilterSelect label="Week" value={week} options={monitoringWeekOptions} onChange={onWeek} compact />
      <FilterSelect label="Metric" value={metricDefinition} options={["Outcome metric v1.0"]} onChange={onMetricDefinition} compact />
      <div className="context-divider" />
      <div className="context-meta"><span className="live-dot" /> Source refresh <strong>Aug 31, 2026</strong></div>
      <div className="context-meta">Forecast created <strong>Aug 31, 2026</strong></div>
      <StatusPill label="Bundled output" tone="blue" />
    </div>
  );
}

function SectionIntro({ eyebrow, title, children, status, action }: { eyebrow: string; title: string; children: React.ReactNode; status?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="section-intro"><div><div className="eyebrow">{eyebrow}</div><div className="title-row"><h1>{title}</h1>{status}</div><p>{children}</p></div>{action}</div>;
}

function ForecastRange({ row, override, onSelect }: { row: ForecastRow; override?: OverrideSpec; onSelect: (row: ForecastRow) => void }) {
  const values = applyOverride(row, override);
  const min = Math.min(0, values.floor);
  const max = Math.max(values.ceiling, 35);
  const scale = (value: number) => `${Math.max(1, Math.min(99, ((value - min) / (max - min)) * 100))}%`;
  return <button type="button" className="range-row" onClick={() => onSelect(row)}><span className="range-name"><strong>{row.name}</strong><small>{row.position} · {row.team} vs {row.opponent}</small></span><span className="range-visual"><span className="range-track" /><span className="range-line" style={{ left: scale(values.floor), width: `calc(${scale(values.ceiling)} - ${scale(values.floor)})` }} /><span className="range-dot" style={{ left: scale(values.median) }} /><span className="range-floor-label" style={{ left: scale(values.floor) }}>{formatNumber(values.floor)}</span><span className="range-ceiling-label" style={{ left: scale(values.ceiling) }}>{formatNumber(values.ceiling)}</span></span><span className="range-status">{override?.inactive ? <span className="tag tag-gray">Inactive</span> : override ? <span className="tag tag-orange">Adjusted</span> : <span className="tag tag-blue">Original</span>}</span></button>;
}

export function FloorCeilingApp() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [season, setSeason] = useState("2026");
  const [week, setWeek] = useState("1");
  const [metricDefinition, setMetricDefinition] = useState("Outcome metric v1.0");
  const [workspaceId, setWorkspaceId] = useState("ws_w1_2026_7f3a1c");
  const [expiresAt, setExpiresAt] = useState("2026-09-07T10:00:00.000Z");
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [upload, setUpload] = useState<UploadReport>(demoUploadReport);
  const [runState, setRunState] = useState<RunState>("Complete");
  const [runId, setRunId] = useState("run_w1_2026_7f3a");
  const [activeRunId, setActiveRunId] = useState("");
  const [resultRunId, setResultRunId] = useState("");
  const [dataMode, setDataMode] = useState<"demo" | "live">("demo");
  const [liveRows, setLiveRows] = useState<ForecastRow[]>([]);
  const [liveUploadId, setLiveUploadId] = useState("");
  const [sourceInputRevision, setSourceInputRevision] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [liveOverrideSet, setLiveOverrideSet] = useState<OverrideSet | null>(null);
  const [runFailure, setRunFailure] = useState<{ stage?: string; message?: string; nextAction?: string } | null>(null);
  const [simulationCount, setSimulationCount] = useState(String(DEFAULT_SIMULATION_COUNT));
  const [viewMode, setViewMode] = useState<ViewMode>("original");
  const [projectionSearch, setProjectionSearch] = useState("");
  const [projectionPosition, setProjectionPosition] = useState("All");
  const [projectionTeam, setProjectionTeam] = useState("All");
  const [projectionSort, setProjectionSort] = useState("ceiling");
  const [selectedPlayerId, setSelectedPlayerId] = useState(demoForecasts[0]?.id ?? "");
  const [overrides, setOverrides] = useState<Record<string, OverrideSpec>>({});
  const [overrideHistory, setOverrideHistory] = useState<OverrideHistoryEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<UploadReport["errors"]>([]);

  const activeRows = dataMode === "live" ? liveRows : demoForecasts;
  const activeOverrides = dataMode === "live" ? (liveOverrideSet?.records ?? {}) : overrides;
  const activeHistory = dataMode === "live" ? (liveOverrideSet?.history ?? []) : overrideHistory;
  const selectedRow = activeRows.find((row) => row.id === selectedPlayerId) ?? activeRows[0];
  const teams = useMemo(() => ["All", ...Array.from(new Set(activeRows.map((row) => row.team))).sort()], [activeRows]);
  const filteredForecasts = useMemo(() => {
    const filtered = activeRows.filter((row) => {
      const matchesSearch = !projectionSearch || `${row.name} ${row.team}`.toLowerCase().includes(projectionSearch.toLowerCase());
      const matchesPosition = projectionPosition === "All" || row.position === projectionPosition;
      const matchesTeam = projectionTeam === "All" || row.team === projectionTeam;
      return matchesSearch && matchesPosition && matchesTeam;
    });
    return [...filtered].sort((left, right) => {
      const leftValues = viewMode === "adjusted" ? applyOverride(left, activeOverrides[left.id]) : left.original;
      const rightValues = viewMode === "adjusted" ? applyOverride(right, activeOverrides[right.id]) : right.original;
      if (projectionSort === "name") return left.name.localeCompare(right.name);
      if (projectionSort === "median") return rightValues.median - leftValues.median;
      if (projectionSort === "floor") return rightValues.floor - leftValues.floor;
      return rightValues.ceiling - leftValues.ceiling;
    });
  }, [activeOverrides, activeRows, projectionPosition, projectionSearch, projectionSort, projectionTeam, viewMode]);

  useEffect(() => {
    let cancelled = false;
    async function restoreWorkspace() {
      const storedWorkspace = window.sessionStorage.getItem("fc-workspace-id");
      if (storedWorkspace) setWorkspaceId(storedWorkspace);
      const storedDemoOverrides = window.sessionStorage.getItem("fc-demo-overrides");
      if (storedDemoOverrides) {
        try { setOverrides(JSON.parse(storedDemoOverrides) as Record<string, OverrideSpec>); } catch { window.sessionStorage.removeItem("fc-demo-overrides"); }
      }
      const sessionResponse = await fetch("/api/session").catch(() => null);
      if (!sessionResponse?.ok || cancelled) return;
      const sessionData = await sessionResponse.json() as { workspaceId?: string; expiresAt?: string };
      if (sessionData.workspaceId) { setWorkspaceId(sessionData.workspaceId); window.sessionStorage.setItem("fc-workspace-id", sessionData.workspaceId); }
      if (sessionData.expiresAt) setExpiresAt(sessionData.expiresAt);
      async function restoreUpload(uploadId: string) {
        if (!uploadId) return;
        const uploadResponse = await fetch(`/api/uploads/${uploadId}`).catch(() => null);
        if (!uploadResponse?.ok || cancelled) return;
        const uploadData = await uploadResponse.json() as { uploadId?: string; sourceInputRevision?: string; report?: UploadReport };
        if (!uploadData.uploadId || !uploadData.report || cancelled) return;
        setUpload(uploadData.report);
        setUploadErrors(uploadData.report.errors);
        setLiveUploadId(uploadData.uploadId);
        setSourceInputRevision(uploadData.sourceInputRevision ?? "");
      }
      const runsResponse = await fetch("/api/runs").catch(() => null);
      if (!runsResponse?.ok || cancelled) return;
      const runsData = await runsResponse.json() as { runs?: Array<{ runId: string; state: string; uploadId: string; season: number; week: number; lastCompleteRunId?: string }>; lastCompleteRunId?: string };
      const storedRunId = window.sessionStorage.getItem("fc-active-run-id");
      const active = runsData.runs?.find((run) => run.runId === storedRunId && (run.state === "Queued" || run.state === "Running"));
      const lastComplete = runsData.lastCompleteRunId;
      if (active) {
        setDataMode("live");
        setActiveRunId(active.runId);
        setLiveUploadId(active.uploadId);
        setSeason(String(active.season));
        setWeek(String(active.week));
      setRunId(active.runId);
      setRunState(active.state === "Running" ? "Running" : "Queued");
      if (lastComplete && lastComplete !== active.runId) {
        const resultResponse = await fetch(`/api/runs/${lastComplete}/result`).catch(() => null);
        const resultData = resultResponse?.ok ? await resultResponse.json() as { result?: ForecastResult } : null;
        if (resultData?.result && !cancelled) {
          setResultRunId(lastComplete);
          setLiveRows(forecastRowsFromResult(resultData.result));
          setSourceInputRevision(resultData.result.metadata.sourceInputRevision);
        }
        const overrideResponse = await fetch(`/api/runs/${lastComplete}/overrides`).catch(() => null);
        const overrideData = overrideResponse?.ok ? await overrideResponse.json() as { overrideSet?: OverrideSet } : null;
        if (overrideData?.overrideSet && !cancelled) setLiveOverrideSet(overrideData.overrideSet);
        await restoreUpload(active.uploadId);
      }
      } else if (lastComplete) {
        setDataMode("live");
        setResultRunId(lastComplete);
        const completeRun = runsData.runs?.find((run) => run.runId === lastComplete);
        if (completeRun) { setRunId(completeRun.runId); setLiveUploadId(completeRun.uploadId); setSeason(String(completeRun.season)); setWeek(String(completeRun.week)); setRunState("Complete"); }
        const resultResponse = await fetch(`/api/runs/${lastComplete}/result`);
        const resultData = await resultResponse.json() as { result?: ForecastResult };
        if (resultData.result) { setLiveRows(forecastRowsFromResult(resultData.result)); setSourceInputRevision(resultData.result.metadata.sourceInputRevision); }
        const overrideResponse = await fetch(`/api/runs/${lastComplete}/overrides`);
        const overrideData = await overrideResponse.json() as { overrideSet?: OverrideSet };
        if (overrideData.overrideSet) setLiveOverrideSet(overrideData.overrideSet);
        await restoreUpload(completeRun?.uploadId ?? "");
      }
    }
    void restoreWorkspace();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    window.sessionStorage.setItem("fc-demo-overrides", JSON.stringify(overrides));
  }, [overrides]);

  useEffect(() => {
    if (!selectedRow) return;
    if (selectedPlayerId !== selectedRow.id) setSelectedPlayerId(selectedRow.id);
  }, [selectedPlayerId, selectedRow]);

  useEffect(() => {
    if (dataMode !== "live" || !activeRunId) return;
    let cancelled = false;
    let timer: number | undefined;
    async function pollRun() {
      const response = await fetch(`/api/runs/${activeRunId}`).catch(() => null);
      if (!response?.ok || cancelled) return;
      const run = await response.json() as { state: string; stage?: string; season: number; week: number; uploadId: string; failure?: { stage?: string; message?: string; nextAction?: string }; lastCompleteRunId?: string };
      if (cancelled) return;
      setSeason(String(run.season));
      setWeek(String(run.week));
      setLiveUploadId(run.uploadId);
      if (run.state === "Queued" || run.state === "Running") {
        setRunState(run.state as RunState);
        timer = window.setTimeout(() => void pollRun(), 900);
        return;
      }
      if (run.state === "Failed") {
        setRunFailure(run.failure ?? { stage: run.stage, message: "The run failed.", nextAction: "Review the run details and retry." });
        setRunState("Failed");
        if (run.lastCompleteRunId) {
          const resultResponse = await fetch(`/api/runs/${run.lastCompleteRunId}/result`);
          const resultData = await resultResponse.json() as { result?: ForecastResult };
          if (resultData.result && !cancelled) { setResultRunId(run.lastCompleteRunId); setLiveRows(forecastRowsFromResult(resultData.result)); setSourceInputRevision(resultData.result.metadata.sourceInputRevision); }
          const overrideResponse = await fetch(`/api/runs/${run.lastCompleteRunId}/overrides`);
          const overrideData = await overrideResponse.json() as { overrideSet?: OverrideSet };
          if (overrideData.overrideSet && !cancelled) setLiveOverrideSet(overrideData.overrideSet);
        }
        return;
      }
      if (run.state === "Complete") {
        const resultResponse = await fetch(`/api/runs/${activeRunId}/result`);
        const resultData = await resultResponse.json() as { result?: ForecastResult };
        if (resultData.result && !cancelled) { setResultRunId(activeRunId); setRunId(activeRunId); setLiveRows(forecastRowsFromResult(resultData.result)); setSourceInputRevision(resultData.result.metadata.sourceInputRevision); }
        const overrideResponse = await fetch(`/api/runs/${activeRunId}/overrides`);
        const overrideData = await overrideResponse.json() as { overrideSet?: OverrideSet };
        if (overrideData.overrideSet && !cancelled) setLiveOverrideSet(overrideData.overrideSet);
        if (!cancelled) { setRunState("Complete"); setToast("The real inference run completed. The result is ready to inspect."); }
      }
    }
    void pollRun();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [activeRunId, dataMode]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function navigate(nextTab: TabId) {
    setActiveTab(nextTab);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateContextSeason(value: string) {
    setSeason(value);
    if (activeTab !== "overview") navigate("overview");
  }

  function updateContextWeek(value: string) {
    setWeek(value);
    if (activeTab !== "overview") navigate("overview");
  }

  function updateContextMetric(value: string) {
    setMetricDefinition(value);
    if (activeTab !== "overview") navigate("overview");
  }

  function resetWorkspace() {
    setOverrides({});
    setOverrideHistory([]);
    setLiveOverrideSet(null);
    setLiveRows([]);
    setLiveUploadId("");
    setSourceInputRevision("");
    setSourceFile(null);
    setActiveRunId("");
    setResultRunId("");
    setRunFailure(null);
    setDataMode("demo");
    setUpload(demoUploadReport);
    setUploadErrors([]);
    setRunState("Complete");
    setRunId("run_w1_2026_7f3a");
    window.sessionStorage.removeItem("fc-active-run-id");
    setSimulationCount(String(DEFAULT_SIMULATION_COUNT));
    setProjectionSearch("");
    setToast("The temporary workspace now shows the public demonstration.");
    setSessionMenuOpen(false);
  }

  async function handleFile(file: File, selectedSetId?: string) {
    if (file.size > 10 * 1024 * 1024) {
      setUploadErrors([{ row: 0, field: "file", message: "The file is larger than the 10 MB upload limit." }]);
      setRunState("Failed");
      return;
    }
    setDataMode("live");
    setSourceFile(file);
    setRunState("Checking upload");
    setLiveRows([]);
    setLiveOverrideSet(null);
    setRunFailure(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (selectedSetId) form.set("selectedSetId", selectedSetId);
      const response = await fetch("/api/uploads", { method: "POST", headers: { "x-csrf-token": browserCookie("fc_csrf") }, body: form });
      const data = await response.json().catch(() => null) as { error?: string; uploadId?: string; sourceInputRevision?: string; report?: UploadReport } | null;
      if (!response.ok || !data?.uploadId || !data.report) {
        setRunState("Failed");
        setToast(data?.error ?? "The upload could not be checked.");
        return;
      }
      setUpload(data.report);
      setUploadErrors(data.report.errors);
      setLiveUploadId(data.uploadId);
      setSourceInputRevision(data.sourceInputRevision ?? "");
      setActiveRunId("");
      setResultRunId("");
      setRunId("pending");
      setRunState(data.report.accepted > 0 ? "Ready" : "Failed");
      setToast(data.report.accepted > 0 ? `Accepted ${data.report.accepted.toLocaleString()} rows. Row exclusions remain visible in the report.` : "The upload has no accepted player rows.");
    } catch {
      setRunState("Failed");
      setToast("The upload request failed. Check the session and try again.");
    }
  }

  function handleSetChange(selectedSetId: string) {
    if (!sourceFile) {
      setToast("Choose a projection file before selecting a projection set.");
      return;
    }
    void handleFile(sourceFile, selectedSetId);
  }

  function activateDemoSample() {
    setDataMode("demo");
    setLiveRows([]);
    setLiveOverrideSet(null);
    setLiveUploadId("");
    setSourceInputRevision("");
    setSourceFile(null);
    setActiveRunId("");
    setResultRunId("");
    setRunFailure(null);
    setUpload(demoUploadReport);
    setUploadErrors([]);
    setRunState("Complete");
    setRunId("run_w1_2026_7f3a");
    setToast("The bundled demonstration is active. Live runs start after a CSV upload.");
  }

  function resetUpload() {
    activateDemoSample();
    setToast("The workflow reset to the explicit bundled demonstration. Prior live runs stay available.");
  }

  async function startRun() {
    if (runState === "Queued" || runState === "Running" || runState === "Checking upload") {
      setToast("This submission already has an active job.");
      return;
    }
    if (dataMode !== "live" || !liveUploadId || !sourceInputRevision) {
      setToast("Upload a CSV to start a real inference run. The bundled sample is a separate demonstration.");
      return;
    }
    if (upload.accepted === 0) {
      setToast("The upload has no accepted player rows.");
      return;
    }
    const numericSimulationCount = Number(simulationCount);
    if (!isValidSimulationCount(numericSimulationCount)) {
      setToast(`Enter a simulation count from ${MIN_SIMULATIONS.toLocaleString()} to ${MAX_SIMULATIONS.toLocaleString()} in steps of ${SIMULATION_STEP}.`);
      return;
    }
    setRunState("Checking upload");
    setLiveRows([]);
    setLiveOverrideSet(null);
    const numericWeek = Number.parseInt(week, 10) || 1;
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": browserCookie("fc_csrf") },
        body: JSON.stringify({
          season: Number(season),
          week: numericWeek,
          metricDefinitionVersion: "ppr_v1_projection_formula",
          scoringContractVersion: "ppr_v1",
          simulationCount: numericSimulationCount,
          uploadId: liveUploadId,
          inputRevision: sourceInputRevision,
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        setRunState("Failed");
        setToast(error?.error ?? "The server could not accept this run.");
        return;
      }
      const data = await response.json() as { runId?: string };
      const nextRunId = data.runId ?? "";
      if (!nextRunId) throw new Error("The server did not return a run ID.");
      setRunId(nextRunId);
      setActiveRunId(nextRunId);
      setResultRunId("");
      setLiveRows([]);
      setLiveOverrideSet(null);
      setRunFailure(null);
      setRunState("Queued");
      window.sessionStorage.setItem("fc-active-run-id", nextRunId);
    } catch {
      setRunState("Failed");
      setToast("The run request failed. Check the session and try again.");
      return;
    }
  }

  function exportForecasts(rows: ForecastRow[], scope: "filtered" | "all") {
    const exportRows = rows.filter((row) => scope === "all" || !activeOverrides[row.id]?.exclude).map((row) => {
      const override = activeOverrides[row.id];
      const adjusted = applyOverride(row, override);
      return {
        stable_player_id: row.id,
        player_name: row.name,
        position: row.position,
        team: row.team,
        opponent: row.opponent,
        season: row.season ?? Number(season),
        week: row.week ?? Number(week),
        scoring_contract_version: dataMode === "live" ? "ppr_v1" : "demo",
        metric_definition_version: dataMode === "live" ? "ppr_v1_projection_formula" : metricDefinition,
        model_release: row.modelRelease ?? "demo-bundled-output",
        run_id: row.runId ?? runId,
        input_revision: row.inputRevision ?? "demo",
        source_row_order: row.sourceRowOrder ?? "",
        source_projection: row.sourceProjection,
        csv_projection: row.csvProjection ?? row.sourceProjection,
        ffsim_mean: row.ffsim?.mean ?? "",
        ffsim_p15: row.ffsim?.p15 ?? "",
        ffsim_p50: row.ffsim?.p50 ?? row.original.median,
        ffsim_p85: row.ffsim?.p85 ?? "",
        xgb_p15: row.xgbP15 ?? "",
        xgb_p85: row.xgbP85 ?? "",
        original_floor: row.original.floor,
        original_average: row.originalAverage ?? row.average ?? row.sourceProjection,
        original_median: row.original.median,
        original_ceiling: row.original.ceiling,
        adjusted_floor: adjusted.floor,
        adjusted_average: row.average ?? row.sourceProjection,
        adjusted_median: adjusted.median,
        adjusted_ceiling: adjusted.ceiling,
        adjusted_width: adjusted.ceiling - adjusted.floor,
        value_source_floor: row.valueSources?.floor ?? "bundled output",
        value_source_average: row.valueSources?.average ?? "bundled output",
        value_source_median: row.valueSources?.median ?? "bundled output",
        value_source_ceiling: row.valueSources?.ceiling ?? "bundled output",
        override_reason: override?.reason ?? "",
        exclusion_state: override?.exclude ? "excluded" : "active",
        override_revision: override?.revision ?? 0,
      };
    });
    const columns = Object.keys(exportRows[0] ?? {}) as Array<keyof (typeof exportRows)[number]>;
    downloadText(`floor-ceiling-${scope}-${season}-week-${week}.csv`, buildCsv(exportRows, columns));
    setToast(`Downloaded ${exportRows.length.toLocaleString()} ${scope} rows${scope === "filtered" ? ". Excluded rows stay out of the active export." : "."}`);
  }

  function addHistory(label: string, detail: string, tone: "blue" | "orange" | "gray" = "blue", values?: Pick<OverrideHistoryEntry, "previous" | "next">) {
    const action: OverrideHistoryEntry["action"] = label.toLowerCase().includes("reset") ? "reset" : label.toLowerCase().includes("copied") ? "copy" : "save";
    setOverrideHistory((history) => [{ id: `${Date.now()}-${label}`, action, label, detail, time: new Date().toISOString(), tone, ...values }, ...history]);
  }

  async function saveOverride(spec: OverrideSpec) {
    if (!selectedRow) return;
    const values = applyOverride(selectedRow, spec);
    const validationError = validateRange(values);
    if (validationError) { setToast(validationError); return; }
    if (dataMode === "live" && resultRunId) {
      const response = await fetch(`/api/runs/${resultRunId}/overrides/${encodeURIComponent(selectedRow.id)}`, { method: "PUT", headers: { "Content-Type": "application/json", "x-csrf-token": browserCookie("fc_csrf") }, body: JSON.stringify(spec) });
      const data = await response.json().catch(() => null) as { error?: string; overrideSet?: OverrideSet } | null;
      if (!response.ok || !data?.overrideSet) { setToast(data?.error ?? "The override could not be saved."); return; }
      setLiveOverrideSet(data.overrideSet);
      setToast(`${selectedRow.name}'s adjustment is saved. Original model values remain unchanged.`);
      return;
    }
    const previous = applyOverride(selectedRow, overrides[selectedRow.id]);
    setOverrides((current) => ({ ...current, [selectedRow.id]: spec }));
    addHistory(`Saved ${selectedRow.name}`, spec.reason, spec.inactive ? "gray" : "orange", { previous, next: values });
    setToast(`${selectedRow.name}'s demonstration adjustment is saved.`);
  }

  async function resetPlayer(row: ForecastRow) {
    if (dataMode === "live" && resultRunId) {
      const response = await fetch(`/api/runs/${resultRunId}/overrides/${encodeURIComponent(row.id)}`, { method: "DELETE", headers: { "x-csrf-token": browserCookie("fc_csrf") } });
      const data = await response.json().catch(() => null) as { error?: string; overrideSet?: OverrideSet } | null;
      if (!response.ok || !data?.overrideSet) { setToast(data?.error ?? "The override could not be reset."); return; }
      setLiveOverrideSet(data.overrideSet);
      setToast(`${row.name} now uses the original model range.`);
      return;
    }
    if (!overrides[row.id]) { setToast(`${row.name} has no saved adjustment.`); return; }
    const previous = applyOverride(row, overrides[row.id]);
    setOverrides((current) => { const next = { ...current }; delete next[row.id]; return next; });
    addHistory(`Reset ${row.name}`, "Restored original simulation values.", "gray", { previous, next: row.original });
    setToast(`${row.name} now uses the original range.`);
  }

  async function resetAllOverrides() {
    const count = Object.keys(activeOverrides).length;
    if (!count) { setToast("There are no saved adjustments to reset."); return; }
    if (dataMode === "live" && resultRunId) {
      for (const stablePlayerId of Object.keys(activeOverrides)) {
        await fetch(`/api/runs/${resultRunId}/overrides/${encodeURIComponent(stablePlayerId)}`, { method: "DELETE", headers: { "x-csrf-token": browserCookie("fc_csrf") } });
      }
      const response = await fetch(`/api/runs/${resultRunId}/overrides`);
      const data = await response.json().catch(() => null) as { overrideSet?: OverrideSet } | null;
      if (data?.overrideSet) setLiveOverrideSet(data.overrideSet);
      setToast(`Restored ${count} player adjustments. The reset is recorded in history.`);
      return;
    }
    setOverrides({});
    addHistory("Reset all overrides", `Restored ${count} saved player adjustments.`, "gray");
    setToast(`Restored ${count} player adjustments. The reset is recorded in history.`);
  }

  return (
    <div className="app-shell">
      <aside className={cx("sidebar", mobileNavOpen && "sidebar-open")}>
        <div className="brand-block"><div className="brand-mark"><span>F</span><span>C</span></div><div><div className="brand-name">Floor &amp; Ceiling</div><div className="brand-subtitle">Model monitoring</div></div><button type="button" className="mobile-close" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
        <div className="sidebar-label">Workspace</div>
        <nav className="primary-nav" aria-label="Primary navigation">{navItems.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} onClick={() => navigate(item.id)} className={cx("nav-item", activeTab === item.id && "nav-item-active")}><Icon size={18} /><span><strong>{item.label}</strong><small>{item.description}</small></span>{activeTab === item.id ? <ChevronRight size={16} className="nav-arrow" /> : null}</button>; })}</nav>
        <div className="sidebar-divider" />
        <div className="sidebar-label">{activeTab === "calibration" ? "Calibration" : "Current run"}</div>
        {activeTab === "calibration" ? <div className="sidebar-run-card calibration-sidebar-card"><div className="run-card-top"><span className="run-dot run-dot-good" />Past results<MoreHorizontal size={15} /></div><strong>{calibrationModel.shortName}</strong><span>{calibrationModel.oosRows.toLocaleString()} scores checked</span><span className="sidebar-run-id">2024 · 2025</span></div> : <div className="sidebar-run-card"><div className="run-card-top"><span className={cx("run-dot", runState === "Complete" ? "run-dot-good" : runState === "Failed" ? "run-dot-warn" : "run-dot-blue")} />{runState}<MoreHorizontal size={15} /></div><strong>Week {week} · {season}</strong><span>{upload.accepted.toLocaleString()} accepted rows</span><span className="sidebar-run-id">{shortId(runId)}</span></div>}
        <div className="sidebar-spacer" />
        <div className="sidebar-footer"><div className="owner-row"><span className="owner-avatar">MS</span><span><strong>Matt Savoca</strong><small>Owner workspace</small></span><Settings2 size={16} /></div><div className="privacy-note"><LockKeyhole size={13} /> Temporary data stays in this browser.</div></div>
      </aside>
      {mobileNavOpen ? <button className="nav-scrim" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" /> : null}
      <main className="main-area">
        <header className={cx("topbar", activeTab === "projection" && "projection-topbar")}><div className="mobile-brand"><button type="button" className="menu-button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><span>Floor &amp; Ceiling</span></div><div className="topbar-context"><span className="topbar-kicker">{activeTab === "calibration" ? "Calibration" : "Forecast workspace"}</span><span className="topbar-separator">/</span><strong>{activeTab === "calibration" ? calibrationModel.shortName : `${season} · Week ${week}`}</strong></div><div className="topbar-actions"><span className="saved-state"><span className="saved-dot" /> Saved locally</span><button type="button" className="session-button" onClick={() => setSessionMenuOpen((open) => !open)}><span className="session-avatar"><UserRound size={14} /></span><span>{shortId(workspaceId)}</span><ChevronDown size={14} /></button>{sessionMenuOpen ? <div className="session-menu"><div className="session-menu-heading"><span className="session-avatar large"><UserRound size={16} /></span><div><strong>Temporary workspace</strong><span>{shortId(workspaceId)}</span></div></div><div className="session-menu-row"><Clock3 size={15} /><span>Expires {formatRelativeTime(expiresAt)}</span></div><div className="session-menu-row"><ShieldCheck size={15} /><span>Private to this browser</span></div><div className="session-menu-divider" /><Button variant="quiet" onClick={resetWorkspace} icon={<RotateCcw size={15} />}>Reset workspace</Button><p>Download work before the session expires. Lost or expired data cannot be recovered.</p></div> : null}</div></header>
        {activeTab !== "calibration" && activeTab !== "projection" ? <ContextStrip season={season} week={week} metricDefinition={metricDefinition} onSeason={updateContextSeason} onWeek={updateContextWeek} onMetricDefinition={updateContextMetric} onNavigateOverview={() => navigate("overview")} /> : null}
        <div className="page-content">
          {activeTab === "overview" ? <OverviewPage navigate={navigate} season={season} week={week} onWeekChange={setWeek} /> : null}
          {activeTab === "methodology" ? <MethodologyPage navigate={navigate} /> : null}
          {activeTab === "calibration" ? <CalibrationPage /> : null}
          {activeTab === "projection" ? <ForecastProjectionPage upload={upload} uploadErrors={uploadErrors} runState={runState} runId={runId} season={season} week={week} onSeason={setSeason} onWeek={setWeek} runFailure={runFailure} simulationCount={simulationCount} onSimulationCount={setSimulationCount} viewMode={viewMode} onViewMode={setViewMode} rows={filteredForecasts} allRows={activeRows} overrides={activeOverrides} search={projectionSearch} position={projectionPosition} team={projectionTeam} sort={projectionSort} teams={teams} onSearch={setProjectionSearch} onPosition={setProjectionPosition} onTeam={setProjectionTeam} onSort={setProjectionSort} onFile={handleFile} onSetChange={handleSetChange} onUseDemo={activateDemoSample} onResetUpload={resetUpload} onStartRun={startRun} onExport={(scope) => exportForecasts(scope === "filtered" ? filteredForecasts : activeRows, scope)} onSelectPlayer={(row) => setSelectedPlayerId(row.id)} onOpenOverrides={(row) => { setSelectedPlayerId(row.id); setActiveTab("overrides"); }} /> : null}
          {activeTab === "overrides" ? <OverridesPage runLabel={shortId(resultRunId || runId)} rows={activeRows} overrides={activeOverrides} history={activeHistory} selectedRow={selectedRow} selectedPlayerId={selectedPlayerId} onSelectRow={(row) => setSelectedPlayerId(row.id)} onSave={saveOverride} onResetPlayer={resetPlayer} onResetAll={resetAllOverrides} onCopy={async () => {
            if (dataMode !== "live" || !resultRunId) { setToast("Copy is available for a complete live result. Choose the source run explicitly."); return; }
            const sourceRunId = window.prompt("Enter the complete source run ID to copy overrides from:");
            if (!sourceRunId) return;
            const response = await fetch(`/api/runs/${resultRunId}/overrides/copy`, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": browserCookie("fc_csrf") }, body: JSON.stringify({ sourceRunId: sourceRunId.trim() }) });
            const data = await response.json().catch(() => null) as { error?: string; report?: { copiedPlayerIds: string[]; unmatchedPlayerIds: string[] }; set?: OverrideSet } | null;
            if (!response.ok || !data?.set) { setToast(data?.error ?? "The override copy failed."); return; }
            setLiveOverrideSet(data.set);
            const unmatched = data.report?.unmatchedPlayerIds ?? [];
            setToast(`Copied ${data.report?.copiedPlayerIds.length ?? 0} overrides. ${unmatched.length} source IDs were unmatched${unmatched.length ? `: ${unmatched.slice(0, 8).join(", ")}${unmatched.length > 8 ? ", ..." : ""}` : ""}.`);
          }} /> : null}
        </div>
        <footer className="app-footer"><span><Database size={14} /> Public evidence build · v0.1</span><span>Last data check Aug 31, 2026</span><a href="#methodology" onClick={(event) => { event.preventDefault(); navigate("methodology"); }}>How to read this site <ChevronRight size={13} /></a></footer>
      </main>
      {toast ? <div className="toast" role="status"><CheckCircle2 size={17} /><span>{toast}</span><button type="button" onClick={() => setToast(null)} aria-label="Dismiss message"><X size={15} /></button></div> : null}
    </div>
  );
}

function OverviewPage({ navigate, season, week, onWeekChange }: { navigate: (tab: TabId) => void; season: string; week: string; onWeekChange: (value: string) => void }) {
  const selectedSeason = Number(season);
  const selectedWeek = Number(week);
  const selectedSummary = oosWeeklySummaries.find((row) => row.season === selectedSeason && row.week === selectedWeek);
  const selectedFloorSummary = floorOosWeeklySummaries.find((row) => row.season === selectedSeason && row.week === selectedWeek);
  const selectedPositionRows = monitoringPositionOrder
    .map((position) => oosWeeklyPositionMetrics.find((row) => row.season === selectedSeason && row.week === selectedWeek && row.position === position))
    .filter((row): row is (typeof oosWeeklyPositionMetrics)[number] => Boolean(row));
  const selectedFloorPositionRows = monitoringPositionOrder
    .map((position) => floorOosWeeklyPositionMetrics.find((row) => row.season === selectedSeason && row.week === selectedWeek && row.position === position))
    .filter((row): row is (typeof floorOosWeeklyPositionMetrics)[number] => Boolean(row));

  const coverageOption = useMemo<EChartsOption>(() => ({
    animation: false,
    grid: { left: 46, right: 16, top: 40, bottom: 48, containLabel: true },
    legend: { top: 0, textStyle: { color: "#50687A", fontSize: 10 } },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: oosWeeklySummaries.filter((row) => row.season === selectedSeason).map((row) => `Week ${row.week}`),
      axisLabel: { color: "#73889A", fontSize: 10 },
      axisLine: { lineStyle: { color: "#CBD7DE" } },
    },
    yAxis: {
      type: "value",
      name: "Coverage",
      nameLocation: "middle",
      nameGap: 34,
      min: 0.7,
      max: 1,
      interval: 0.05,
      axisLabel: { color: "#73889A", fontSize: 9, formatter: (value: number) => Math.round(value * 100) + "%" },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    series: [
      {
        name: "Selected model mix",
        type: "line",
        symbol: "circle",
        symbolSize: 7,
        smooth: false,
        emphasis: { focus: "series" },
        lineStyle: { color: "#1264A3", width: 2.5 },
        itemStyle: { color: "#1264A3" },
        data: oosWeeklySummaries.filter((row) => row.season === selectedSeason).map((row) => ({
          value: row.coverage,
          symbolSize: row.week === selectedWeek ? 10 : 7,
          itemStyle: { color: row.week === selectedWeek ? "#1264A3" : "#75AFCB", borderColor: "#fff", borderWidth: 2 },
        })),
      },
      {
        name: "85% target",
        type: "line",
        data: oosWeeklySummaries.filter((row) => row.season === selectedSeason).map(() => 0.85),
        symbol: "none",
        lineStyle: { color: "#D87945", type: "dashed", width: 2 },
      },
    ],
  }), [selectedSeason, selectedWeek]);

  const positionCoverageOption = useMemo<EChartsOption>(() => {
    const weeks = oosWeeklySummaries.filter((row) => row.season === selectedSeason);
    return {
      animation: false,
      grid: { left: 52, right: 16, top: 40, bottom: 48, containLabel: true },
      legend: { top: 0, data: [...monitoringPositionOrder], selectedMode: "multiple", textStyle: { color: "#50687A", fontSize: 10 } },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: weeks.map((row) => `Week ${row.week}`),
        axisLabel: { color: "#73889A", fontSize: 10 },
        axisLine: { lineStyle: { color: "#CBD7DE" } },
      },
      yAxis: {
        type: "value",
        name: "Coverage",
        nameLocation: "middle",
        nameGap: 40,
        min: 0.7,
        max: 1,
        interval: 0.05,
        axisLabel: { color: "#73889A", fontSize: 9, formatter: (value: number) => Math.round(value * 100) + "%" },
        splitLine: { lineStyle: { color: "#E8EEF2" } },
      },
      series: monitoringPositionOrder.map((position) => {
        const color = monitoringPositionColors[position];
        return {
          name: position,
          type: "line",
          symbol: "circle",
          symbolSize: 6,
          smooth: false,
          emphasis: { focus: "series" },
          lineStyle: { color, width: 2 },
          itemStyle: { color },
          data: weeks.map((weekRow) => {
            const row = oosWeeklyPositionMetrics.find((metric) => metric.season === selectedSeason && metric.week === weekRow.week && metric.position === position);
            return {
              value: row?.coverage ?? null,
              symbolSize: weekRow.week === selectedWeek ? 9 : 6,
              itemStyle: { color, borderColor: "#fff", borderWidth: weekRow.week === selectedWeek ? 2 : 1 },
            };
          }),
        };
      }),
    };
  }, [selectedSeason, selectedWeek]);

  const floorCoverageOption = useMemo<EChartsOption>(() => ({
    animation: false,
    grid: { left: 46, right: 16, top: 40, bottom: 48, containLabel: true },
    legend: { top: 0, textStyle: { color: "#50687A", fontSize: 10 } },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: floorOosWeeklySummaries.filter((row) => row.season === selectedSeason).map((row) => `Week ${row.week}`),
      axisLabel: { color: "#73889A", fontSize: 10 },
      axisLine: { lineStyle: { color: "#CBD7DE" } },
    },
    yAxis: {
      type: "value",
      name: "Coverage",
      nameLocation: "middle",
      nameGap: 34,
      min: 0,
      max: 0.5,
      interval: 0.1,
      axisLabel: { color: "#73889A", fontSize: 9, formatter: (value: number) => Math.round(value * 100) + "%" },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    series: [
      {
        name: "Selected model mix",
        type: "line",
        symbol: "circle",
        symbolSize: 7,
        smooth: false,
        emphasis: { focus: "series" },
        lineStyle: { color: "#7C5BAA", width: 2.5 },
        itemStyle: { color: "#7C5BAA" },
        data: floorOosWeeklySummaries.filter((row) => row.season === selectedSeason).map((row) => ({
          value: row.coverage,
          symbolSize: row.week === selectedWeek ? 10 : 7,
          itemStyle: { color: row.week === selectedWeek ? "#7C5BAA" : "#B5A2D0", borderColor: "#fff", borderWidth: 2 },
        })),
      },
      {
        name: "15% target",
        type: "line",
        data: floorOosWeeklySummaries.filter((row) => row.season === selectedSeason).map(() => 0.15),
        symbol: "none",
        lineStyle: { color: "#D87945", type: "dashed", width: 2 },
      },
    ],
  }), [selectedSeason, selectedWeek]);

  const floorPositionCoverageOption = useMemo<EChartsOption>(() => {
    const weeks = floorOosWeeklySummaries.filter((row) => row.season === selectedSeason);
    return {
      animation: false,
      grid: { left: 52, right: 16, top: 40, bottom: 48, containLabel: true },
      legend: { top: 0, data: [...monitoringPositionOrder], selectedMode: "multiple", textStyle: { color: "#50687A", fontSize: 10 } },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: weeks.map((row) => `Week ${row.week}`),
        axisLabel: { color: "#73889A", fontSize: 10 },
        axisLine: { lineStyle: { color: "#CBD7DE" } },
      },
      yAxis: {
        type: "value",
        name: "Coverage",
        nameLocation: "middle",
        nameGap: 40,
        min: 0,
        max: 0.5,
        interval: 0.1,
        axisLabel: { color: "#73889A", fontSize: 9, formatter: (value: number) => Math.round(value * 100) + "%" },
        splitLine: { lineStyle: { color: "#E8EEF2" } },
      },
      series: monitoringPositionOrder.map((position) => {
        const color = monitoringPositionColors[position];
        return {
          name: position,
          type: "line",
          symbol: "circle",
          symbolSize: 6,
          smooth: false,
          emphasis: { focus: "series" },
          lineStyle: { color, width: 2 },
          itemStyle: { color },
          data: weeks.map((weekRow) => {
            const row = floorOosWeeklyPositionMetrics.find((metric) => metric.season === selectedSeason && metric.week === weekRow.week && metric.position === position);
            return {
              value: row?.coverage ?? null,
              symbolSize: weekRow.week === selectedWeek ? 9 : 6,
              itemStyle: { color, borderColor: "#fff", borderWidth: weekRow.week === selectedWeek ? 2 : 1 },
            };
          }),
        };
      }),
    };
  }, [selectedSeason, selectedWeek]);

  const handlePositionCoverageClick = useMemo(() => ({ dataIndex }: { dataIndex?: number }) => {
    if (dataIndex === undefined) return;
    const clickedWeek = oosWeeklySummaries.filter((row) => row.season === selectedSeason)[dataIndex]?.week;
    if (clickedWeek !== undefined) onWeekChange(String(clickedWeek));
  }, [onWeekChange, selectedSeason]);

  if (!selectedSummary || !selectedFloorSummary || selectedPositionRows.length !== monitoringPositionOrder.length || selectedFloorPositionRows.length !== monitoringPositionOrder.length) {
    return <EmptyState icon={<Database size={22} />} title="No OOS results for this filter" body="Choose one of the available 2025 weeks from the context strip." />;
  }

  const selectedCoverage = formatCalibrationPercent(selectedSummary.coverage);
  const selectedFloorCoverage = formatCalibrationPercent(selectedFloorSummary.coverage);
  const selectedCoverageError = `${selectedSummary.coverage - 0.85 >= 0 ? "+" : ""}${((selectedSummary.coverage - 0.85) * 100).toFixed(1)}%`;
  const floorCoverageError = `${selectedFloorSummary.coverage - 0.15 >= 0 ? "+" : ""}${((selectedFloorSummary.coverage - 0.15) * 100).toFixed(1)}%`;
  const selectedMissRate = formatCalibrationPercent(selectedSummary.highSideMissRate);
  const selectedFloorMissRate = formatCalibrationPercent(selectedFloorSummary.lowSideMissRate);
  const bestCeilingPosition = selectedPositionRows.reduce((best, row) => row.coverage > best.coverage ? row : best);
  const closestFloorPosition = selectedFloorPositionRows.reduce((closest, row) => Math.abs(row.coverage - 0.15) < Math.abs(closest.coverage - 0.15) ? row : closest);

  return (
    <>
      <SectionIntro eyebrow="Weekly monitoring" title={`${season} · Week ${week} model performance`} status={<StatusPill label="OOS results" tone="good" />} action={<Button variant="secondary" onClick={() => navigate("calibration")} icon={<Target size={15} />}>Review model selection</Button>}>This view uses completed out-of-sample scores. Change the week above to compare the fixed best model for each position.</SectionIntro>
      <div className="overview-hero-grid">
        <Panel className="next-forecast-panel" eyebrow="Ceiling model mix" title="Fixed by position"><div className="weekly-model-list">{selectedPositionRows.map((row) => <div className="weekly-model-row" key={row.position}><div className="weekly-model-position"><span className="position-chip">{row.position}</span><span>{positionDisplayNames[row.position]}</span></div><span className={cx("methodology-model-badge", row.model === "ffsimulator" ? "methodology-model-badge-simulation" : "methodology-model-badge-xgboost")}>{row.model}</span></div>)}</div><Explainer>QB uses ffsimulator. RB, WR, and TE use XGBoost.</Explainer></Panel>
        <Panel className="next-forecast-panel" eyebrow="Floor model mix" title="Fixed by position"><div className="weekly-model-list">{selectedFloorPositionRows.map((row) => <div className="weekly-model-row" key={row.position}><div className="weekly-model-position"><span className="position-chip">{row.position}</span><span>{positionDisplayNames[row.position]}</span></div><span className={cx("methodology-model-badge", row.model === "ffsimulator" ? "methodology-model-badge-simulation" : "methodology-model-badge-xgboost")}>{row.model}</span></div>)}</div><Explainer>Serving contract: QB floor uses ffsimulator p15. RB, WR, and TE floor use the released XGBoost p15 service.</Explainer></Panel>
      </div>
      <div className="metric-grid"><MetricCard label="Scores at or below ceiling" value={selectedCoverage} detail="Target: about 85 of 100 scores" tone="good" icon={<Target size={17} />} /><MetricCard label="Scores above ceiling" value={selectedMissRate} detail="The final score beat p85" tone="warn" icon={<ArrowUpRight size={17} />} /><MetricCard label="Ceiling model pinball loss" value={formatCalibrationMetric(selectedSummary.pinballLoss)} detail="Lower is better" tone="good" icon={<Gauge size={17} />} /><MetricCard label="Ceiling model mean absolute error" value={formatCalibrationMetric(selectedSummary.p85Mae)} detail="Average distance from the final score" tone="neutral" icon={<Activity size={17} />} /><MetricCard label="Rank correlation" value={selectedSummary.rankSpearman.toFixed(2)} detail="Forecast order versus final score order" tone="neutral" icon={<Link2 size={17} />} /></div>
       <div className="metric-grid"><MetricCard label="Scores at or below floor" value={selectedFloorCoverage} detail="Target: about 15 of 100 scores" tone="good" icon={<Target size={17} />} /><MetricCard label="Scores below floor" value={selectedFloorMissRate} detail="The final score fell below p15" tone="warn" icon={<ArrowDownRight size={17} />} /><MetricCard label="Floor model pinball loss" value={formatCalibrationMetric(selectedFloorSummary.pinballLoss)} detail="Lower is better" tone="good" icon={<Gauge size={17} />} /><MetricCard label="Floor model mean absolute error" value={formatCalibrationMetric(selectedFloorSummary.p15Mae)} detail="Average distance from the final score" tone="neutral" icon={<Activity size={17} />} /><MetricCard label="Rank correlation" value={selectedFloorSummary.rankSpearman.toFixed(2)} detail="Forecast order versus final score order" tone="neutral" icon={<Link2 size={17} />} /></div>
      <div className="two-column-grid overview-main-grid">
        <Panel className="chart-panel" eyebrow="Last 4 Weeks" title="Ceiling Model Calibration, Last 4 Weeks"><EChart option={coverageOption} height={300} ariaLabel="Ceiling model calibration coverage across the last four 2025 out-of-sample weeks" /><Explainer>The line tracks the selected best-model mix. The dashed line marks the 85% ceiling target.</Explainer></Panel>
        <Panel className="chart-panel position-chart-panel" eyebrow="Position coverage" title="Best model P85 coverage"><EChart option={positionCoverageOption} height={300} ariaLabel="Best model P85 coverage by position across the last four 2025 out-of-sample weeks" onClick={handlePositionCoverageClick} /><Explainer>Each line shows one position. Hover for the weekly value, use the legend to focus the chart, or click a point to select that week.</Explainer></Panel>
      </div>
      <div className="two-column-grid overview-main-grid">
        <Panel className="chart-panel" eyebrow="Last 4 Weeks" title="Floor Model Calibration, Last 4 Weeks"><EChart option={floorCoverageOption} height={300} ariaLabel="Floor model calibration coverage across the last four 2025 out-of-sample weeks" /><Explainer>The line tracks the selected best-model mix. The dashed line marks the 15% floor target.</Explainer></Panel>
        <Panel className="chart-panel position-chart-panel" eyebrow="Position coverage" title="Best model P15 coverage"><EChart option={floorPositionCoverageOption} height={300} ariaLabel="Best model P15 coverage by position across the last four 2025 out-of-sample weeks" onClick={handlePositionCoverageClick} /><Explainer>Each line shows one position. Hover for the weekly value, use the legend to focus the chart, or click a point to select that week.</Explainer></Panel>
      </div>
      <Panel className="input-change-panel" eyebrow="Ceiling Model Calibration by Position" title={`Best model results for ${season} · Week ${week}`} action={<span className="calibration-panel-note">Weekly Observations: {selectedSummary.n.toLocaleString()}</span>}><div className="table-scroll"><table className="weekly-metrics-table"><thead><tr><th scope="col">Position</th><th scope="col">Selected model</th><th scope="col">P85 coverage</th><th scope="col">P85 loss</th><th scope="col">P85 MAE</th><th scope="col">Scores</th></tr></thead><tbody>{selectedPositionRows.map((row) => <tr key={row.position}><th scope="row"><span className="position-chip">{row.position}</span><span>{positionDisplayNames[row.position]}</span></th><td><span className={cx("methodology-model-badge", row.model === "ffsimulator" ? "methodology-model-badge-simulation" : "methodology-model-badge-xgboost")}>{row.model}</span></td><td>{formatCalibrationPercent(row.coverage)}</td><td>{formatCalibrationMetric(row.pinballLoss)}</td><td>{formatCalibrationMetric(row.p85Mae)}</td><td>{row.n.toLocaleString()}</td></tr>)}</tbody></table></div><Explainer>P85 Coverage: percentage of position who scored at or below the predicted 85th percentile outcome. A perfectly calibrated model would hit exactly 85% (the model target).</Explainer></Panel>
      <Panel className="input-change-panel" eyebrow="Floor Model Calibration by Position" title={`Best model results for ${season} · Week ${week}`} action={<span className="calibration-panel-note">Weekly Observations: {selectedFloorSummary.n.toLocaleString()}</span>}><div className="table-scroll"><table className="weekly-metrics-table"><thead><tr><th scope="col">Position</th><th scope="col">Selected model</th><th scope="col">P15 coverage</th><th scope="col">P15 loss</th><th scope="col">P15 MAE</th><th scope="col">Scores</th></tr></thead><tbody>{selectedFloorPositionRows.map((row) => <tr key={row.position}><th scope="row"><span className="position-chip">{row.position}</span><span>{positionDisplayNames[row.position]}</span></th><td><span className={cx("methodology-model-badge", row.model === "ffsimulator" ? "methodology-model-badge-simulation" : "methodology-model-badge-xgboost")}>{row.model}</span></td><td>{formatCalibrationPercent(row.coverage)}</td><td>{formatCalibrationMetric(row.pinballLoss)}</td><td>{formatCalibrationMetric(row.p15Mae)}</td><td>{row.n.toLocaleString()}</td></tr>)}</tbody></table></div><Explainer>P15 Coverage: percentage of position who scored at or below the predicted 15th percentile outcome. A perfectly calibrated model would hit exactly 15% (the model target).</Explainer></Panel>
      <div className="two-column-grid lower-overview-grid"><Panel eyebrow="Weekly Results at a Glance" title={`Week ${week}`}><div className="weekly-readout-grid"><div><span>Best ceiling position</span><strong>{formatCalibrationPercent(bestCeilingPosition.coverage)}</strong><small>{bestCeilingPosition.position} had the highest P85 coverage.</small></div><div><span>Closest floor position</span><strong>{formatCalibrationPercent(closestFloorPosition.coverage)}</strong><small>{closestFloorPosition.position} was closest to the 15% P15 target.</small></div><div><span>Ceiling coverage error</span><strong>{selectedCoverageError}</strong><small>Difference from the 85% model target.</small></div><div><span>Floor coverage error</span><strong>{floorCoverageError}</strong><small>Difference from the 15% model target.</small></div></div><Explainer>Model drift is the distance between weekly coverage and each model target.</Explainer></Panel></div>
    </>
  );
}


type MethodologyPageProps = { navigate: (tab: TabId) => void };

const p85ModelTrainingRows = [
  { targetSeason: 2024, trainingSeasons: "2023", trainingRows: 3988, heldOutRows: 4580 },
  { targetSeason: 2025, trainingSeasons: "2023, 2024", trainingRows: 8568, heldOutRows: 4810 },
] as const;

const p85ModelSettings = [
  { targetSeason: 2024, position: "QB", trainingRows: 457, maxDepth: 4, minChildWeight: 15, subsample: 0.9, colsample: 0.7, learningRate: 0.03, regLambda: 1, rounds: 414 },
  { targetSeason: 2024, position: "RB", trainingRows: 984, maxDepth: 2, minChildWeight: 5, subsample: 0.7, colsample: 1, learningRate: 0.03, regLambda: 1, rounds: 325 },
  { targetSeason: 2024, position: "WR", trainingRows: 1488, maxDepth: 2, minChildWeight: 1, subsample: 0.9, colsample: 1, learningRate: 0.03, regLambda: 1, rounds: 575 },
  { targetSeason: 2024, position: "TE", trainingRows: 1059, maxDepth: 2, minChildWeight: 1, subsample: 0.9, colsample: 0.7, learningRate: 0.06, regLambda: 1, rounds: 159 },
  { targetSeason: 2025, position: "QB", trainingRows: 940, maxDepth: 2, minChildWeight: 5, subsample: 0.9, colsample: 0.7, learningRate: 0.06, regLambda: 5, rounds: 271 },
  { targetSeason: 2025, position: "RB", trainingRows: 2175, maxDepth: 2, minChildWeight: 1, subsample: 0.7, colsample: 1, learningRate: 0.06, regLambda: 1, rounds: 380 },
  { targetSeason: 2025, position: "WR", trainingRows: 3236, maxDepth: 2, minChildWeight: 1, subsample: 0.7, colsample: 0.7, learningRate: 0.06, regLambda: 1, rounds: 485 },
  { targetSeason: 2025, position: "TE", trainingRows: 2217, maxDepth: 3, minChildWeight: 1, subsample: 0.7, colsample: 1, learningRate: 0.06, regLambda: 1, rounds: 467 },
] as const;

const p85FeatureSets = [
  {
    label: "QB models, 21 features",
    fields: "week, ecr, rank_sd, n_projectors, rank_min, rank_max, consensus_rank, consensus_projected_score, pass-att, pass-cmp, pass-1d, pass-int, pass-sck, pass-td, pass-yds, rush-car, rush-1d, rush-td, rush-yds, fum-lost, projection_fpts",
  },
  {
    label: "RB, WR, and TE models, 18 features",
    fields: "week, ecr, rank_sd, n_projectors, rank_min, rank_max, consensus_rank, consensus_projected_score, rush-car, rush-1d, rush-td, rush-yds, rec-rec, rec-tgt, rec-td, rec-yds, fum-lost, projection_fpts",
  },
] as const;

const p85OverallPerformance = {
  rows: 9390,
  baselineCoverage: 0.8805111821086262,
  xgbCoverage: 0.8413205537806177,
  baselineLoss: 1.8256161608093715,
  xgbLoss: 1.637125402586459,
  baselineRankSpearman: 0.5395841437158123,
  xgbRankSpearman: 0.6288275947096983,
} as const;

const ffsimulatorQbEvaluationRows = scorecardMetrics
  .filter((row) => row.model === "ffsimulator" && row.position === "QB" && row.season !== null)
  .sort((left, right) => Number(left.season) - Number(right.season));

const ffsimulatorQbCurrentAggregate = positionModelSelections.find((row) => row.position === "QB");

function formatMaybePercent(value: number | null | undefined) {
  return value == null ? "n/a" : formatCalibrationPercent(value);
}

function formatMaybeMetric(value: number | null | undefined) {
  return value == null ? "n/a" : formatCalibrationMetric(value);
}

function FfsimulatorQbModelCard() {
  return (
    <details className="methodology-model-card-panel methodology-model-card-panel-simulation">
      <summary className="methodology-model-card-summary">
        <div className="methodology-model-icon methodology-model-icon-simulation"><GitBranch size={19} /></div>
        <div>
          <span className="panel-eyebrow">Model card</span>
          <h2><code>ffsimulator</code> floor and ceiling model</h2>
          <p>Using positional consensus rank, historical outputs, and random sampling to sim ranges of outcome</p>
        </div>
        <StatusPill label="Active QB path" tone="good" />
        <ChevronDown size={18} aria-hidden="true" />
      </summary>

      <div className="methodology-model-card-body">
        <div className="model-card-intro">
          <div>
            <span className="methodology-detail-label">Summary</span>
            <p><code>ffsimulator</code> samples historical weekly PPR outcomes near a player&apos;s expected rank. It creates one score distribution for each QB player-week.</p>
            <p>The combined forward range uses the distribution for QB p15, p50, and p85. The percentiles describe possible scores. They do not set a hard minimum or maximum.</p>
          </div>
          <div className="model-card-facts">
            <div><span>Status</span><strong>Active QB path</strong><small>Full range output</small></div>
            <div><span>Model type</span><strong>Rank-conditioned</strong><small>Historical outcome sampling</small></div>
            <div><span>Output</span><strong>p15, p50, p85</strong><small>Weekly PPR points</small></div>
            <div><span>Scoring</span><strong>PPR, <code>ppr_v1</code></strong><small>1 point per reception</small></div>
            <div><span>Backtest draws</span><strong>{ffsimulatorModel.simulations.toLocaleString()}</strong><small>Per player-week</small></div>
            <div><span>Package</span><strong><code>ffsimulator</code> 1.2.3.02</strong><small>MIT license</small></div>
          </div>
        </div>

        <section className="model-card-section" aria-labelledby="ffsimulator-qb-model-details-title">
          <h3 id="ffsimulator-qb-model-details-title">Model details</h3>
          <ul className="methodology-data-list">
            <li>Developer: Matt Savoca for <code>fffloorceiling</code>. The underlying package is maintained by ffverse.</li>
            <li>The model has no fitted tree, neural network, or regression weights.</li>
            <li>For each draw, sample an integer rank around the expected rank with half of the supplied rank standard deviation.</li>
            <li>Use the sampled position and rank to select a historical weekly PPR score.</li>
            <li>Repeat the draw, then calculate p15, p50, and p85 with type 7 quantiles.</li>
            <li>Source paths: <code>R/01_rankings.R</code>, <code>R/02_ffsimulator.R</code>, and <code>backtest_fbg_2023_2025/R/simulation.R</code>.</li>
          </ul>
        </section>

        <div className="model-card-section-grid">
          <section className="model-card-section" aria-labelledby="ffsimulator-qb-intended-use-title">
            <h3 id="ffsimulator-qb-intended-use-title">Intended use</h3>
            <ul className="methodology-data-list">
              <li>Estimate a QB&apos;s weekly PPR range before the game.</li>
              <li>Show a lower marker, median, and upper marker for one player-week.</li>
              <li>Give analysts a rank-based baseline for model comparison.</li>
            </ul>
            <h3 className="model-card-subheading">Out of scope</h3>
            <ul className="methodology-data-list">
              <li>Do not use the range as a health, talent, or contract decision.</li>
              <li>Do not use it as a causal explanation or financial guarantee.</li>
              <li>Do not use independent player draws as a shared game-state forecast.</li>
            </ul>
          </section>
          <section className="model-card-section" aria-labelledby="ffsimulator-qb-factors-title">
            <h3 id="ffsimulator-qb-factors-title">Factors</h3>
            <ul className="methodology-data-list">
              <li>Expected rank and rank uncertainty control the sampled rank.</li>
              <li>Position, target week, target season, scoring rules, and history control the outcome pool.</li>
              <li>Footballguys consensus rows supply the current rank input.</li>
              <li>Injury news, starter status, matchup, weather, scheme, and game state have no separate feature.</li>
              <li>No demographic or protected-group labels are used or evaluated.</li>
            </ul>
          </section>
        </div>

        <section className="model-card-section" aria-labelledby="ffsimulator-qb-metrics-title">
          <h3 id="ffsimulator-qb-metrics-title">Metrics</h3>
          <p>Coverage checks whether the final score falls at or below a forecast percentile. Pinball loss measures percentile error. Lower loss is better.</p>
          <div className="model-card-table-wrap">
            <table className="model-card-table">
              <caption className="sr-only">Metrics and targets for the ffsimulator quarterback model</caption>
              <thead><tr><th scope="col">Metric</th><th scope="col">Definition</th><th scope="col">Target</th></tr></thead>
              <tbody>
                <tr><th scope="row">p15 coverage</th><td>Final score at or below p15</td><td>15%</td></tr>
                <tr><th scope="row">p50 coverage</th><td>Final score at or below p50</td><td>50%</td></tr>
                <tr><th scope="row">p85 coverage</th><td>Final score at or below p85</td><td>85%</td></tr>
                <tr><th scope="row">p15 to p85 coverage</th><td>Final score inside the range</td><td>70%</td></tr>
                <tr><th scope="row">p85 pinball loss</th><td>Weighted p85 error</td><td>Lower is better</td></tr>
              </tbody>
            </table>
          </div>
          <p className="model-card-result-note">The extended 2023 through 2025 card uses a 2,000-resample row bootstrap. Approximate 95% intervals are 83.6% to 87.3% for p85 coverage and 61.2% to 66.2% for p15 to p85 coverage. These intervals do not account for player, week, or season dependence.</p>
        </section>

        <section className="model-card-section" aria-labelledby="ffsimulator-qb-evaluation-data-title">
          <h3 id="ffsimulator-qb-evaluation-data-title">Evaluation data</h3>
          <p>The backtest joins Footballguys weekly Projections Consensus rows to <code>nflreadr</code> regular-season outcomes.</p>
          <ul className="methodology-data-list">
            <li>Target seasons: 2023, 2024, and 2025.</li>
            <li>Eligible rows: 13,378 across QB, RB, WR, and TE. The QB slice has 1,444 rows.</li>
            <li>Filters: matched identity, non-free-agent team, at least 3 projectors, finite rank values, and a final weekly score.</li>
            <li>Label: <code>actual_score</code>, the realized weekly PPR score.</li>
            <li>Future-data check: each target season uses earlier history only.</li>
          </ul>
        </section>

        <section className="model-card-section" aria-labelledby="ffsimulator-qb-training-data-title">
          <h3 id="ffsimulator-qb-training-data-title">Training data</h3>
          <p>This model has no supervised training step. Its reference data is a target-season-safe pool of historical weekly scores grouped by position and rank.</p>
          <div className="model-card-table-wrap">
            <table className="model-card-table">
              <caption className="sr-only">Historical reference data for each target season</caption>
              <thead><tr><th scope="col">Target season</th><th scope="col">History</th><th scope="col">Rows</th><th scope="col">Latest season</th></tr></thead>
              <tbody>
                <tr><th scope="row">2023</th><td>2012 to 2022</td><td>59,572</td><td>2022</td></tr>
                <tr><th scope="row">2024</th><td>2012 to 2023</td><td>65,036</td><td>2023</td></tr>
                <tr><th scope="row">2025</th><td>2012 to 2024</td><td>70,557</td><td>2024</td></tr>
              </tbody>
            </table>
          </div>
          <p>The weekly pool uses historical weeks 1 through 16. The backtest scores target weeks 1 through 17.</p>
        </section>

        <section className="model-card-section" aria-labelledby="ffsimulator-qb-analysis-title">
          <h3 id="ffsimulator-qb-analysis-title">Quantitative analyses</h3>
          <p>The current web calibration artifact reports 2024 and 2025 held-out rows. The full 2023 through 2025 table is in <code>docs/model_card_ffsimulator_qb.md</code>.</p>
          <div className="model-card-table-wrap">
            <table className="model-card-table model-card-results-table">
              <caption className="sr-only">Held-out ffsimulator quarterback results by target season</caption>
              <thead><tr><th scope="col">Season</th><th scope="col">Rows</th><th scope="col">p15 coverage</th><th scope="col">p50 coverage</th><th scope="col">p85 coverage</th><th scope="col">70% interval</th><th scope="col">p85 loss</th><th scope="col">Rank rho</th></tr></thead>
              <tbody>{ffsimulatorQbEvaluationRows.map((row) => <tr key={String(row.season)}><th scope="row">{row.season}</th><td>{row.sampleCount.toLocaleString()}</td><td>{formatMaybePercent(row.p15Coverage)}</td><td>{formatMaybePercent(row.p50Coverage)}</td><td>{formatMaybePercent(row.p85Coverage)}</td><td>{formatMaybePercent(row.p15ToP85IntervalCoverage)}</td><td>{formatMaybeMetric(row.p85PinballLoss)}</td><td>{formatMaybeMetric(row.rankSpearman)}</td></tr>)}</tbody>
            </table>
          </div>
          {ffsimulatorQbCurrentAggregate ? <p className="model-card-result-note">The web artifact combines {ffsimulatorQbCurrentAggregate.n.toLocaleString()} QB rows from 2024 and 2025. Its p85 coverage is {formatMaybePercent(ffsimulatorQbCurrentAggregate.selectedCoverage)}, and its p85 pinball loss is {formatMaybeMetric(ffsimulatorQbCurrentAggregate.selectedPinballLoss)}.</p> : null}
        </section>

        <section className="model-card-section" aria-labelledby="ffsimulator-qb-ethics-title">
          <h3 id="ffsimulator-qb-ethics-title">Ethical considerations</h3>
          <ul className="methodology-data-list">
            <li>The output can affect lineup choices, contest entries, and money. Keep a user in the decision loop.</li>
            <li>Names, player IDs, teams, ranks, and football outcomes support joins and forecasts. The model does not infer health, ability, intent, or protected traits.</li>
            <li>Historical outcomes can carry changes in role, injury, team, and scoring environment into a new forecast.</li>
            <li>No protected-group or intersectional analysis is available for this model.</li>
          </ul>
        </section>

        <section className="model-card-section" aria-labelledby="ffsimulator-qb-caveats-title">
          <h3 id="ffsimulator-qb-caveats-title">Caveats and recommendations</h3>
          <ul className="methodology-data-list">
            <li>Use at least 10,000 draws for a published snapshot. More draws reduce simulation noise. They do not fix a biased outcome pool.</li>
            <li>Monitor p15, p50, p85, interval coverage, and pinball loss by season, week, rank band, and starter status.</li>
            <li>Keep team and game outputs outside this player model. Independent player draws do not create one shared game state.</li>
            <li>The generated floor comparison currently records XGBoost as the selected historical p15 reference for QB. The combined forward range describes <code>ffsimulator</code> as the QB p15 path. Reconcile this selector with the serving contract before the next release.</li>
          </ul>
          <div className="methodology-limit model-card-inline-limit"><Info size={16} /><div><strong>Recommendation</strong><p>Keep <code>ffsimulator</code> as the QB baseline until a replacement passes the same walk-forward scorecard. Treat this card as model evidence, not as a full audit or deployment approval.</p></div></div>
        </section>
      </div>
    </details>
  );
}

function P85ModelCard() {
  return (
    <details className="methodology-model-card-panel">
      <summary className="methodology-model-card-summary">
        <div className="methodology-model-icon methodology-model-icon-xgboost"><FileText size={19} /></div>
        <div>
          <span className="panel-eyebrow">Model card</span>
          <h2>Direct XGBoost p85 ceiling</h2>
          <p>Purpose, training data, held-out evidence, and known limits for the direct ceiling candidate.</p>
        </div>
        <StatusPill label="Candidate" tone="warn" />
        <ChevronDown size={18} aria-hidden="true" />
      </summary>

      <div className="methodology-model-card-body">
        <div className="model-card-intro">
          <div>
            <span className="methodology-detail-label">Summary</span>
            <p>This model estimates a player&apos;s 85th-percentile weekly fantasy score in points per reception scoring. The output is a ceiling estimate, not a hard upper limit.</p>
            <p>The model predicts p85 only. The combined workflow gets p15 from the floor model and p50 from <code>ffsimulator</code>.</p>
          </div>
          <div className="model-card-facts">
            <div><span>Status</span><strong>Candidate</strong><small>Historical comparison only</small></div>
            <div><span>Model family</span><strong>8 models</strong><small>One per position and target season</small></div>
            <div><span>Objective</span><strong>Quantile regression</strong><small><code>reg:quantileerror</code>, alpha 0.85</small></div>
            <div><span>Scoring</span><strong>PPR, <code>ppr_v1</code></strong><small>Weekly player points</small></div>
            <div><span>Framework</span><strong>XGBoost 3.4.1</strong><small>Python 3.12</small></div>
            <div><span>Run</span><strong>{calibrationModel.runDate}</strong><small>Artifact version {calibrationModel.version}</small></div>
          </div>
        </div>

        <div className="model-card-section-grid">
          <section className="model-card-section" aria-labelledby="p85-model-card-use-title">
            <h3 id="p85-model-card-use-title">Intended use</h3>
            <ul className="methodology-data-list">
              <li>Estimate weekly player upside before kickoff.</li>
              <li>Rank players by projected ceiling.</li>
              <li>Compare direct projection models with the simulation baseline.</li>
            </ul>
          </section>
          <section className="model-card-section" aria-labelledby="p85-model-card-out-title">
            <h3 id="p85-model-card-out-title">Out of scope</h3>
            <ul className="methodology-data-list">
              <li>Do not use the output as a maximum score.</li>
              <li>Do not use it to create a complete player range by itself.</li>
              <li>Do not use it as a causal explanation or a profit forecast.</li>
            </ul>
          </section>
        </div>

        <section className="model-card-section" aria-labelledby="p85-model-card-data-title">
          <h3 id="p85-model-card-data-title">Training data and target</h3>
          <p>The experiment uses Footballguys Projections Consensus rows from the 2023 through 2025 backtest seasons. It joins projection rows with rank summaries and realized weekly outcomes.</p>
          <ul className="methodology-data-list">
            <li>14,985 projection rows matched through a one-to-one join.</li>
            <li>13,378 eligible rows after identity, projector-count, outcome, and projection checks.</li>
            <li>Target: <code>actual_score</code>, the realized weekly PPR score.</li>
            <li>Eligibility requires a matched player identity, at least 3 projectors, and a non-free-agent team.</li>
          </ul>
          <div className="model-card-table-wrap">
            <table className="model-card-table">
              <caption className="sr-only">Training and held-out rows by target season</caption>
              <thead><tr><th scope="col">Target season</th><th scope="col">Training seasons</th><th scope="col">Training rows</th><th scope="col">Held-out rows</th></tr></thead>
              <tbody>{p85ModelTrainingRows.map((row) => <tr key={row.targetSeason}><th scope="row">{row.targetSeason}</th><td>{row.trainingSeasons}</td><td>{row.trainingRows.toLocaleString()}</td><td>{row.heldOutRows.toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="model-card-section" aria-labelledby="p85-model-card-features-title">
          <h3 id="p85-model-card-features-title">Input features</h3>
          <p>The model uses rank summaries, raw stat projections, and one derived PPR projection score. Player identifiers, names, teams, target outcomes, and future-season rows stay out of the feature set.</p>
          <div className="model-card-feature-list">{p85FeatureSets.map((featureSet) => <div key={featureSet.label}><strong>{featureSet.label}</strong><code>{featureSet.fields}</code></div>)}</div>
          <div className="methodology-limit model-card-inline-limit"><Info size={16} /><div><strong>Duplicate projection inputs</strong><p><code>consensus_projected_score</code> and <code>projection_fpts</code> match exactly. Interpret their importance as one combined signal.</p></div></div>
        </section>

        <section className="model-card-section" aria-labelledby="p85-model-card-method-title">
          <h3 id="p85-model-card-method-title">Training method</h3>
          <ol className="methodology-step-list">
            <li><span>01</span><div><strong>Split by season</strong><p>Train on seasons before the target season.</p></div></li>
            <li><span>02</span><div><strong>Choose settings</strong><p>Test 144 parameter combinations on weeks 14 through 17 of the latest training season.</p></div></li>
            <li><span>03</span><div><strong>Refit the model</strong><p>Fit the selected settings on all earlier rows.</p></div></li>
            <li><span>04</span><div><strong>Score the next season</strong><p>Clip negative predictions to zero and store the result as <code>xgb_p85</code>.</p></div></li>
          </ol>
          <div className="model-card-table-wrap">
            <table className="model-card-table model-card-settings-table">
              <caption className="sr-only">Selected XGBoost settings by target season and position</caption>
              <thead><tr><th scope="col">Season</th><th scope="col">Position</th><th scope="col">Rows</th><th scope="col">Depth</th><th scope="col">Child weight</th><th scope="col">Row sample</th><th scope="col">Feature sample</th><th scope="col">Rate</th><th scope="col">Lambda</th><th scope="col">Rounds</th></tr></thead>
              <tbody>{p85ModelSettings.map((row) => <tr key={`${row.targetSeason}-${row.position}`}><th scope="row">{row.targetSeason}</th><td>{row.position}</td><td>{row.trainingRows.toLocaleString()}</td><td>{row.maxDepth}</td><td>{row.minChildWeight}</td><td>{row.subsample.toFixed(2)}</td><td>{row.colsample.toFixed(2)}</td><td>{row.learningRate.toFixed(2)}</td><td>{row.regLambda.toFixed(1)}</td><td>{row.rounds}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="model-card-section" aria-labelledby="p85-model-card-results-title">
          <h3 id="p85-model-card-results-title">Held-out performance</h3>
          <p>Coverage measures the share of rows where the actual score is at or below p85. A calibrated p85 targets about 85% coverage. Pinball loss is the primary error score, and lower is better.</p>
          <div className="model-card-table-wrap">
            <table className="model-card-table model-card-results-table">
              <caption className="sr-only">Held-out p85 comparison by position</caption>
              <thead><tr><th scope="col">Position</th><th scope="col">Rows</th><th scope="col">Baseline coverage</th><th scope="col">XGBoost coverage</th><th scope="col">Baseline loss</th><th scope="col">XGBoost loss</th><th scope="col">Baseline rank rho</th><th scope="col">XGBoost rank rho</th></tr></thead>
              <tbody>
                <tr><th scope="row">All</th><td>{p85OverallPerformance.rows.toLocaleString()}</td><td>{formatCalibrationPercent(p85OverallPerformance.baselineCoverage)}</td><td>{formatCalibrationPercent(p85OverallPerformance.xgbCoverage)}</td><td>{p85OverallPerformance.baselineLoss.toFixed(3)}</td><td>{p85OverallPerformance.xgbLoss.toFixed(3)}</td><td>{p85OverallPerformance.baselineRankSpearman.toFixed(3)}</td><td>{p85OverallPerformance.xgbRankSpearman.toFixed(3)}</td></tr>
                {positionModelSelections.map((row) => <tr key={row.position}><th scope="row">{row.position}</th><td>{row.n.toLocaleString()}</td><td>{formatCalibrationPercent(row.ffsimulatorCoverage)}</td><td>{formatCalibrationPercent(row.xgbCoverage)}</td><td>{row.ffsimulatorPinballLoss.toFixed(3)}</td><td>{row.xgbPinballLoss.toFixed(3)}</td><td>{row.ffsimulatorRankSpearman.toFixed(3)}</td><td>{row.xgbRankSpearman.toFixed(3)}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="model-card-result-note">The direct model improves pinball loss for RB, WR, and TE. QB coverage is 77.7%, below the 85% target, and its pinball loss is worse than the baseline.</p>
        </section>

        <div className="model-card-section-grid">
          <section className="model-card-section" aria-labelledby="p85-model-card-explain-title">
            <h3 id="p85-model-card-explain-title">Explainability</h3>
            <p>Tree SHAP explains raw p85 output for 8 models and 9,390 held-out rows. The maximum additivity error was 0.00003052 points.</p>
            <ul className="methodology-data-list">
              <li>RB: consensus projected score and rushing yards.</li>
              <li>TE: receiving yards and targets.</li>
              <li>WR: receiving yards, receptions, and consensus projected score.</li>
              <li>QB: consensus projected score, projected sacks, and rank features.</li>
            </ul>
            <p>SHAP values show model association. They do not establish causation.</p>
          </section>
          <section className="model-card-section" aria-labelledby="p85-model-card-limits-title">
            <h3 id="p85-model-card-limits-title">Limitations and monitoring</h3>
            <ul className="methodology-data-list">
              <li>Evaluation covers only 2024 and 2025.</li>
              <li>The model supports PPR QB, RB, WR, and TE forecasts only.</li>
              <li>Projection source changes can create input drift.</li>
              <li>Coverage can vary by position, season, rank, and data quality.</li>
              <li>No protected-group analysis was performed.</li>
              <li>Monitor coverage, pinball loss, high-side miss rate, and rank correlation by position and recent week.</li>
            </ul>
          </section>
        </div>

        <div className="methodology-limit model-card-recommendation"><Info size={16} /><div><strong>Recommendation</strong><p>Use the direct p85 model for RB, WR, and TE with the implemented p15 floor model and <code>ffsimulator</code> p50. Keep the complete QB range on <code>ffsimulator</code>. Review the combined interval as its own model release.</p></div></div>
      </div>
    </details>
  );
}

function P15ModelCard() {
  return (
    <details className="methodology-model-card-panel methodology-model-card-panel-floor">
      <summary className="methodology-model-card-summary">
        <div className="methodology-model-icon methodology-model-icon-floor"><FileText size={19} /></div>
        <div>
          <span className="panel-eyebrow">Model card</span>
          <h2>Direct XGBoost p15 floor</h2>
          <p>Purpose, training data, held-out evidence, and limits for the implemented lower-tail model.</p>
        </div>
        <StatusPill label="Implemented" tone="good" />
        <ChevronDown size={18} aria-hidden="true" />
      </summary>

      <div className="methodology-model-card-body">
        <div className="model-card-intro">
          <div>
            <span className="methodology-detail-label">Summary</span>
            <p>This model estimates a player&apos;s 15th-percentile weekly fantasy score in points per reception scoring. The output is a floor estimate, not a guaranteed minimum.</p>
            <p>The model is implemented in the XGBoost artifact path and is available to the forecast backend. The workflow uses it for RB, WR, and TE. QB uses <code>ffsimulator</code> p15.</p>
          </div>
          <div className="model-card-facts">
            <div><span>Status</span><strong>Implemented</strong><small>Available to the forecast workflow</small></div>
            <div><span>Model family</span><strong>{floorModelFits.length} models</strong><small>One per position and target season</small></div>
            <div><span>Objective</span><strong>Quantile regression</strong><small><code>reg:quantileerror</code>, alpha 0.15</small></div>
            <div><span>Scoring</span><strong>PPR, <code>ppr_v1</code></strong><small>Weekly player points</small></div>
            <div><span>Framework</span><strong>XGBoost 3.4.1</strong><small>Python 3.12</small></div>
            <div><span>Run</span><strong>{floorCalibrationModel.runDate}</strong><small>Artifact version {floorCalibrationModel.version}</small></div>
          </div>
        </div>

        <div className="model-card-section-grid">
          <section className="model-card-section" aria-labelledby="p15-model-card-use-title">
            <h3 id="p15-model-card-use-title">Intended use</h3>
            <ul className="methodology-data-list">
              <li>Estimate the lower end of weekly player outcomes before kickoff.</li>
              <li>Supply the p15 floor for RB, WR, and TE in the combined forecast range.</li>
              <li>Compare a direct lower-tail model with the <code>ffsimulator</code> baseline.</li>
            </ul>
          </section>
          <section className="model-card-section" aria-labelledby="p15-model-card-out-title">
            <h3 id="p15-model-card-out-title">Out of scope</h3>
            <ul className="methodology-data-list">
              <li>Do not use the output as a hard minimum.</li>
              <li>Do not use it as the QB floor in the forecast workflow.</li>
              <li>Do not use it to supply the median or a complete range by itself.</li>
            </ul>
          </section>
        </div>

        <section className="model-card-section" aria-labelledby="p15-model-card-data-title">
          <h3 id="p15-model-card-data-title">Training data and target</h3>
          <p>The experiment uses Footballguys projection rows joined with rank summaries and realized weekly PPR outcomes. Each target-season fit uses earlier seasons only.</p>
          <ul className="methodology-data-list">
            <li>Held-out target seasons: {floorCalibrationModel.oosSeasons}.</li>
            <li>{floorCalibrationModel.oosRows.toLocaleString()} matched player-week rows used for out-of-sample checks.</li>
            <li>Target: <code>actual_score</code>, the realized weekly PPR score.</li>
            <li>Metric: <code>{floorCalibrationModel.metric}</code>.</li>
            <li>Maximum historical season used: {floorCalibrationModel.maxHistoricalSeasonUsed}.</li>
          </ul>
        </section>

        <section className="model-card-section" aria-labelledby="p15-model-card-features-title">
          <h3 id="p15-model-card-features-title">Input features</h3>
          <p>The model uses rank summaries, raw stat projections, and one derived PPR projection score. Player identifiers, names, teams, target outcomes, and future-season rows stay out of the feature set.</p>
          <div className="model-card-feature-list">{floorFeatureFamilies.map((featureSet) => <div key={featureSet.name}><strong>{featureSet.name}</strong><code>{featureSet.detail}</code></div>)}</div>
          <div className="methodology-limit model-card-inline-limit"><Info size={16} /><div><strong>Shared projection inputs</strong><p><code>consensus_projected_score</code> and <code>projection_fpts</code> match exactly in the training data. Treat them as one combined signal.</p></div></div>
        </section>

        <section className="model-card-section" aria-labelledby="p15-model-card-method-title">
          <h3 id="p15-model-card-method-title">Training method</h3>
          <ol className="methodology-step-list">
            <li><span>01</span><div><strong>Split by season</strong><p>Train on seasons before the target season.</p></div></li>
            <li><span>02</span><div><strong>Choose settings</strong><p>Test 144 parameter combinations on weeks 14 through 17 of the latest training season with p15 pinball loss.</p></div></li>
            <li><span>03</span><div><strong>Refit the model</strong><p>Fit the selected settings on all eligible earlier rows.</p></div></li>
            <li><span>04</span><div><strong>Score the next season</strong><p>Clip negative predictions to zero and store the result as <code>xgb_p15</code>.</p></div></li>
          </ol>
          <div className="model-card-table-wrap">
            <table className="model-card-table model-card-settings-table">
              <caption className="sr-only">Selected XGBoost p15 settings by target season and position</caption>
              <thead><tr><th scope="col">Season</th><th scope="col">Position</th><th scope="col">Rows</th><th scope="col">Features</th><th scope="col">Depth</th><th scope="col">Child weight</th><th scope="col">Row sample</th><th scope="col">Rate</th><th scope="col">Rounds</th></tr></thead>
              <tbody>{floorModelFits.map((row) => <tr key={`${row.targetSeason}-${row.position}`}><th scope="row">{row.targetSeason}</th><td>{row.position}</td><td>{row.trainingRows.toLocaleString()}</td><td>{row.featureCount}</td><td>{row.maxDepth}</td><td>{row.minChildWeight}</td><td>{row.subsample.toFixed(2)}</td><td>{row.learningRate.toFixed(2)}</td><td>{row.rounds}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="model-card-section" aria-labelledby="p15-model-card-results-title">
          <h3 id="p15-model-card-results-title">Held-out performance</h3>
          <p>Coverage measures the share of rows where the actual score is at or below p15. A calibrated p15 targets about 15% coverage. Pinball loss is the primary error score, and lower is better.</p>
          <div className="model-card-table-wrap">
            <table className="model-card-table model-card-results-table">
              <caption className="sr-only">Held-out p15 comparison by position</caption>
              <thead><tr><th scope="col">Position</th><th scope="col">Rows</th><th scope="col">Baseline coverage</th><th scope="col">XGBoost coverage</th><th scope="col">Baseline loss</th><th scope="col">XGBoost loss</th><th scope="col">Selected</th></tr></thead>
              <tbody>
                <tr><th scope="row">Selected mix</th><td>{floorSelectedPortfolioOverall.n.toLocaleString()}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>{formatCalibrationPercent(floorSelectedPortfolioOverall.coverage)}</td></tr>
                {floorPositionModelSelections.map((row) => <tr key={row.position}><th scope="row">{row.position}</th><td>{row.n.toLocaleString()}</td><td>{formatCalibrationPercent(row.ffsimulatorCoverage)}</td><td>{formatCalibrationPercent(row.xgbCoverage)}</td><td>{row.ffsimulatorPinballLoss.toFixed(3)}</td><td>{row.xgbPinballLoss.toFixed(3)}</td><td>{row.selectedModel === "ffsimulator" ? "ffsimulator" : "XGBoost"}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="model-card-result-note">The implemented p15 path has a {formatCalibrationPercent(floorSelectedPortfolioOverall.coverage)} coverage result for the selected mix against a 15% target. Keep this lower-tail calibration gap visible when the model is used.</p>
        </section>

        <div className="model-card-section-grid">
          <section className="model-card-section" aria-labelledby="p15-model-card-explain-title">
            <h3 id="p15-model-card-explain-title">Explainability</h3>
            <p>Tree SHAP explains the p15 output for {floorModelFits.length} models and {floorCalibrationModel.oosRows.toLocaleString()} held-out rows. SHAP values show model association. They do not establish causation.</p>
            <p>Saved explanations live under <code>outputs/xgb_p15_projection/shap</code>.</p>
          </section>
          <section className="model-card-section" aria-labelledby="p15-model-card-limits-title">
            <h3 id="p15-model-card-limits-title">Limitations and monitoring</h3>
            <ul className="methodology-data-list">
              <li>Evaluation covers only {floorCalibrationModel.oosSeasons}.</li>
              <li>The model supports PPR QB, RB, WR, and TE artifacts. The workflow assigns the p15 output to RB, WR, and TE.</li>
              <li>Coverage can vary by position, season, rank, and input quality.</li>
              <li>Monitor p15 coverage, pinball loss, lower-side miss rate, and rank correlation.</li>
            </ul>
          </section>
        </div>

        <div className="methodology-limit model-card-recommendation"><Info size={16} /><div><strong>Recommendation</strong><p>Use the implemented p15 model for RB, WR, and TE. Use <code>ffsimulator</code> p15 for QB, p50 for the median, and the direct p85 model for the skill-position ceiling. The combined result needs its own model release and interval checks.</p></div></div>
      </div>
    </details>
  );
}

function MethodologyPage({ navigate }: MethodologyPageProps) {
  const [choiceView, setChoiceView] = useState<"ceiling" | "floor">("ceiling");
  const choiceIsCeiling = choiceView === "ceiling";
  const choiceRows = choiceIsCeiling ? positionModelSelections : floorPositionModelSelections;
  const choicePercentile = choiceIsCeiling ? "p85" : "p15";
  const choiceCoverageRange = choiceIsCeiling ? "80% to 90%" : "10% to 20%";
  const choiceEstimate = choiceIsCeiling ? "ceiling" : "floor";
  const choiceMissDirection = choiceIsCeiling ? "low" : "high";
  const choiceOtherDirection = choiceIsCeiling ? "high" : "low";
  const outputModelRows = [
    { position: "QB", floor: "ffsimulator", median: "ffsimulator", ceiling: "ffsimulator" },
    { position: "RB", floor: "XGBoost", median: "ffsimulator", ceiling: "XGBoost" },
    { position: "WR", floor: "XGBoost", median: "ffsimulator", ceiling: "XGBoost" },
    { position: "TE", floor: "XGBoost", median: "ffsimulator", ceiling: "XGBoost" },
  ] as const;
  const modelBadge = (model: "ffsimulator" | "XGBoost") => <span className={cx("methodology-model-badge", model === "ffsimulator" ? "methodology-model-badge-simulation" : "methodology-model-badge-xgboost")}>{model}</span>;

  return (
    <>
      <SectionIntro eyebrow="Methodology" title="How each model builds a range" status={<StatusPill label="Two model paths" tone="blue" />} action={<Button variant="secondary" onClick={() => navigate("calibration")} icon={<Target size={15} />}>View calibration</Button>}>Every floor and ceiling here comes from one of two engines: a rank-based simulation in R, or a quantile model in Python. Both score in weekly PPR, 1 point per reception, no tight-end bonus. We grade both on player-weeks they never saw in training.</SectionIntro>

      <div className="methodology-range-markers" role="group" aria-label="Forecast range markers">
        <div className="methodology-range-marker methodology-range-marker-floor"><strong>p15</strong><span>Floor</span><small>A bad week, not the worst week. About 15 games in 100 finish under it.</small></div>
        <div className="methodology-range-marker methodology-range-marker-middle"><strong>p50</strong><span>Median</span><small>The coin-flip line. Half of outcomes land above.</small></div>
        <div className="methodology-range-marker methodology-range-marker-ceiling"><strong>p85</strong><span>Ceiling</span><small>A good week, not the best week. About 15 games in 100 finish over it.</small></div>
      </div>
      <p className="methodology-range-caveat">Those are the rates the model claims. Whether it hits them is what the calibration tab measures.</p>

      <FfsimulatorQbModelCard />

      <div className="methodology-model-grid">
        <article className="methodology-model-card methodology-model-card-simulation">
          <div className="methodology-model-heading">
            <div className="methodology-model-icon methodology-model-icon-simulation"><GitBranch size={21} /></div>
            <div><span className="panel-eyebrow">Path 1 · R</span><h2>ffsimulator rank-conditioned simulation</h2><p>Builds the full range by sampling historical weekly scores for players at nearby ranks.</p></div>
          </div>
          <p className="methodology-path-summary">Find players who were ranked where this one is ranked. Look at what they actually scored. Read the range off that pile.</p>
          <div className="methodology-detail-block"><span className="methodology-detail-label">Stack</span><div className="methodology-pill-list"><span>R</span><span>fffloorceiling</span><span>ffsimulator</span><span>data.table</span><span>arrow</span><span>nflreadr</span><span>ggplot2</span><span>testthat</span></div></div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">Data used</span><ul className="methodology-data-list"><li>Footballguys Projections Consensus. The source row order within each position becomes the player rank after free-agent rows are removed.</li><li>Historical FantasyPros weekly rank variation. The median standard deviation by position and rank supplies rank uncertainty.</li><li>Prior-season `nflreadr` weekly PPR scores. The history cutoff is strictly before the target season.</li></ul></div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">How one prediction is derived</span><ol className="methodology-step-list"><li><span>01</span><div><strong>Normalize the ranking row</strong><p>Keep the stable player ID, position, team, source rank, and rank uncertainty together.</p></div></li><li><span>02</span><div><strong>Draw a nearby rank</strong><p>Draw a rank near the projected one. Use a wider spread where rankers disagree more. The backtest sets the spread to 0.5 times the mapped rank SD.</p></div></li><li><span>03</span><div><strong>Sample a historical score</strong><p>Use the sampled position and rank to select a weekly PPR outcome from the `ffsimulator` pool. Repeat for every simulation.</p></div></li><li><span>04</span><div><strong>Read the percentiles</strong><p>Take the 15th, 50th, and 85th percentiles of the simulated scores. Those values become p15, p50, and p85.</p></div></li></ol></div>
          <div className="methodology-output-box"><span>Current output</span><strong>Full p15 / p50 / p85 range</strong><small>The backtest uses 1,000 simulations per player-week. The Week 1 FBG snapshot uses 100.</small></div>
          <div className="explainer methodology-path-explainer"><Info size={15} /><span>More simulations reduce random sampling noise. They do not fix a biased outcome pool.</span></div>
        </article>

        <article className="methodology-model-card methodology-model-card-xgboost">
          <div className="methodology-model-heading">
            <div className="methodology-model-icon methodology-model-icon-xgboost"><Activity size={21} /></div>
            <div><span className="panel-eyebrow">Path 2 · Python</span><h2>XGBoost direct p85 model</h2><p>Predicts the ceiling from the projection fields themselves instead of sampling a historical outcome pool.</p></div>
          </div>
          <p className="methodology-path-summary">Skip the history pile. Learn the ceiling straight from the projection numbers.</p>
          <div className="methodology-detail-block"><span className="methodology-detail-label">Stack</span><div className="methodology-pill-list"><span>Python 3.12</span><span>XGBoost</span><span>pandas</span><span>NumPy</span><span>PyArrow</span><span>SHAP</span><span>matplotlib</span></div></div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">Data used</span><ul className="methodology-data-list"><li>Footballguys weekly Projections Consensus rows from the 2023 through 2025 backtest seasons.</li><li>Rank features such as week, ECR, rank SD, projector count, rank range, consensus rank, and consensus projected score.</li><li>Raw projected passing, rushing, receiving, and fumble statistics, plus one derived PPR projection score.</li><li>Actual weekly PPR points from `nflreadr` are the training label. They never enter the feature columns. The `ffsimulator` output is a comparison baseline, not an XGBoost feature.</li></ul></div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">How one prediction is derived</span><ol className="methodology-step-list"><li><span>01</span><div><strong>Build one player-week row</strong><p>Join the rank summary, raw projection fields, derived PPR projection, and final PPR score for each historical row.</p></div></li><li><span>02</span><div><strong>Fit one model per position</strong><p>Train separate QB, RB, WR, and TE models with XGBoost&apos;s `reg:quantileerror` objective and `quantile_alpha = 0.85`.</p></div></li><li><span>03</span><div><strong>Tune on the latest prior weeks</strong><p>Test 144 bounded parameter settings on weeks 14 through 17 of the latest training season. Choose the setting with the lowest p85 pinball loss, then refit on all earlier seasons.</p></div></li><li><span>04</span><div><strong>Score the next season</strong><p>Pass only pre-kickoff features to the position model. Clamp a negative prediction to zero and store the result as `xgb_p85`.</p></div></li></ol></div>
          <div className="methodology-output-box"><span>Current output</span><strong>Direct p85 ceiling only</strong><small>This model returns one number, the ceiling. The floor comes from a separate p15 model. Neither produces a median.</small></div>
        </article>
      </div>

      <P85ModelCard />
      <P15ModelCard />

      <Panel className="methodology-output-map-panel" eyebrow="Model output" title="Which model supplies each number?">
        <div className="methodology-output-map-wrap"><table className="methodology-output-map"><caption className="sr-only">Model source for each range marker by position</caption><thead><tr><th scope="col">Position</th><th scope="col">Floor p15</th><th scope="col">Median p50</th><th scope="col">Ceiling p85</th></tr></thead><tbody>{outputModelRows.map((row) => <tr key={row.position}><th scope="row"><span className="position-chip">{row.position}</span></th><td>{modelBadge(row.floor)}</td><td>{modelBadge(row.median)}</td><td>{modelBadge(row.ceiling)}</td></tr>)}</tbody></table></div>
        <Explainer>For RB, WR, and TE, the CSV projection remains a separate average. It does not fill the p50 column.</Explainer>
      </Panel>

      <Panel className="methodology-choice-panel" eyebrow="Model choice" title="How each position gets its model" action={<Button variant="secondary" onClick={() => navigate("calibration")} icon={<Target size={15} />}>Open held-out results</Button>}>
        <div className="methodology-choice-copy"><p>Each position picks its own model. Both candidates run on the same 9,390 player-weeks from 2024 and 2025, with predictions locked before kickoff.</p><ol className="methodology-choice-rules"><li><strong>Coverage first.</strong> A candidate survives only if {choiceCoverageRange} of actual scores land at or below its {choicePercentile}.</li><li><strong>Then pinball loss.</strong> Lowest wins. The loss punishes a {choiceEstimate} set too {choiceMissDirection} harder than one set too {choiceOtherDirection}, which is what you want from a {choiceEstimate}.</li></ol></div>
        <div className="calibration-subnav methodology-choice-toggle" role="tablist" aria-label="Model choice estimate"><button type="button" role="tab" aria-selected={choiceIsCeiling} className={cx(choiceIsCeiling && "active")} onClick={() => setChoiceView("ceiling")}>Ceiling / P85</button><button type="button" role="tab" aria-selected={!choiceIsCeiling} className={cx(!choiceIsCeiling && "active")} onClick={() => setChoiceView("floor")}>Floor / P15</button></div>
        <div className="methodology-choice-table-wrap"><table className="methodology-choice-table"><caption className="sr-only">Held-out {choicePercentile} coverage and pinball loss by position</caption><thead><tr><th rowSpan={2}>Position</th><th colSpan={2}>ffsimulator</th><th colSpan={2}>XGBoost</th><th rowSpan={2}>Selected</th></tr><tr><th>Coverage</th><th>Loss</th><th>Coverage</th><th>Loss</th></tr></thead><tbody>{choiceRows.map((row) => <tr key={row.position}><th scope="row"><span className="position-chip">{row.position}</span></th><td>{formatCalibrationPercent(row.ffsimulatorCoverage)}</td><td>{formatCalibrationMetric(row.ffsimulatorPinballLoss)}</td><td>{formatCalibrationPercent(row.xgbCoverage)}</td><td>{formatCalibrationMetric(row.xgbPinballLoss)}</td><td>{modelBadge(row.selectedModel)}</td></tr>)}</tbody></table></div>
        <Explainer>Held-out results, not this week&apos;s forecast. A new completed season can change a pick. Until then it&apos;s frozen.</Explainer>
      </Panel>

      <div id="methodology-source-map"><Panel className="methodology-sources-panel" eyebrow="Source map" title="Where to inspect the implementation"><div className="methodology-source-grid"><div><strong>Ranked simulation</strong><code>R/01_rankings.R</code><code>R/02_ffsimulator.R</code><code>R/03_summaries.R</code><small>Ranking normalization, draws, and percentiles.</small></div><div><strong>Direct XGBoost</strong><code>scripts/08_xgb_p85_projection_experiment.py</code><code>scripts/08_xgb_p15_projection_experiment.py</code><code>scripts/10_build_calibration_page_data.py</code><small>Feature construction, walk-forward fits, and p85 and p15 comparison data.</small></div><div><strong>Historical evidence</strong><code>backtest_fbg_2023_2025/README.md</code><code>backtest_fbg_2023_2025/outputs/player_backtest_metadata.json</code><code>outputs/xgb_p85_projection/metadata.json</code><code>outputs/xgb_p15_projection/metadata.json</code><code>docs/model_card_ffsimulator_qb.md</code><small>Source choices, cutoffs, scoring rules, model settings, and the quarterback model card.</small></div></div><Explainer>Private uploads and temporary session records do not enter the published calibration data.</Explainer></Panel></div>
    </>
  );
}

const calibrationSeasonOptions = ["All test seasons", "2024", "2025"] as const;
const calibrationPositionOptions = ["All positions", "QB", "RB", "WR", "TE"] as const;
const calibrationPositionOrder = ["QB", "RB", "WR", "TE"] as const;
const calibrationPositionColors: Record<(typeof calibrationPositionOrder)[number], string> = {
  QB: "#7C5BAA",
  RB: "#1264A3",
  WR: "#2E8B73",
  TE: "#D87945",
};

function formatCalibrationPercent(value: number, digits = 1) {
  return (value * 100).toFixed(digits) + "%";
}

function formatCalibrationMetric(value: number) {
  return value.toFixed(2);
}

type CalibrationMethodologyRow = { position: keyof typeof positionDisplayNames; method: string };

function CalibrationMethodologyPanel({ rows, estimate }: { rows: CalibrationMethodologyRow[]; estimate: "high" | "low" }) {
  return (
    <Panel className="calibration-methodology-panel" eyebrow="Current Best Performing Methodology" title="By position">
      <div className="calibration-methodology-table-wrap">
        <table className="calibration-methodology-table">
          <caption className="sr-only">Current best performing methodology by position</caption>
          <thead><tr><th scope="col">Position</th><th scope="col">Methodology</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.position}><th scope="row"><span className="position-chip">{row.position}</span><span>{positionDisplayNames[row.position]}</span></th><td><strong>{row.method}</strong></td></tr>)}</tbody>
        </table>
      </div>
      <div className="calibration-methodology-definitions">
        <div><strong>Simulation</strong><span>Uses earlier PPR scores to build the low, middle, and high estimates.</span></div>
        <div><strong>Projection model</strong><span>Uses projection inputs to estimate the {estimate} score.</span></div>
      </div>
    </Panel>
  );
}

function CalibrationPage() {
  const [view, setView] = useState<"ceiling" | "floor">("ceiling");
  return (
    <>
      <div className="calibration-subnav" role="tablist" aria-label="Model calibration views">
        <button type="button" role="tab" aria-selected={view === "ceiling"} className={cx(view === "ceiling" && "active")} onClick={() => setView("ceiling")}>Ceiling / P85</button>
        <button type="button" role="tab" aria-selected={view === "floor"} className={cx(view === "floor" && "active")} onClick={() => setView("floor")}>Floor / P15</button>
      </div>
      {view === "ceiling" ? <CeilingCalibrationPage /> : <FloorCalibrationPage />}
    </>
  );
}

function CeilingCalibrationPage() {
  const [seasonFilter, setSeasonFilter] = useState<string>("All test seasons");
  const [positionFilter, setPositionFilter] = useState<string>("All positions");

  const filteredBins = useMemo(
    () => selectedCalibrationBins.filter((row) => {
      const matchesSeason = seasonFilter === "All test seasons" || row.season === Number(seasonFilter);
      const matchesPosition = positionFilter === "All positions" || row.position === positionFilter;
      return matchesSeason && matchesPosition;
    }),
    [positionFilter, seasonFilter],
  );

  const chartGroups = useMemo(() => {
    const groups = new Map<string, { position: (typeof calibrationPositionOrder)[number]; label: string; rows: Array<(typeof selectedCalibrationBins)[number]> }>();
    filteredBins.forEach((row) => {
      const groupKey = row.position;
      const current = groups.get(groupKey);
      if (current) {
        current.rows.push(row);
      } else {
        groups.set(groupKey, { position: row.position, label: row.position + " · " + (row.model === "ffsimulator" ? "Simulation" : "Projection model"), rows: [row] });
      }
    });
    return calibrationPositionOrder
      .map((position) => groups.get(position))
      .filter((group): group is NonNullable<typeof group> => Boolean(group));
  }, [filteredBins]);

  const chartBounds = useMemo(() => {
    const values = filteredBins.flatMap((row) => [row.predicted, row.observed]);
    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 0);
    const maxPadding = Math.max(1, maxValue * 0.08);
    return {
      min: minValue <= 0 ? Math.min(-1, Math.floor(minValue)) : 0,
      max: Math.max(30, Math.ceil((maxValue + maxPadding) / 5) * 5),
    };
  }, [filteredBins]);

  const reliabilityOption = useMemo<EChartsOption>(() => ({
    animation: false,
    grid: { left: 52, right: 18, top: 42, bottom: 48, containLabel: true },
    legend: { top: 0, type: "scroll", textStyle: { color: "#50687A", fontSize: 10 } },
    tooltip: { trigger: "item" },
    xAxis: {
      type: "value",
      min: chartBounds.min,
      max: chartBounds.max,
      name: "High estimate",
      nameLocation: "middle",
      nameGap: 30,
      nameTextStyle: { color: "#50687A", fontSize: 10 },
      axisLabel: { color: "#73889A", fontSize: 9 },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    yAxis: {
      type: "value",
      min: chartBounds.min,
      max: chartBounds.max,
      name: "High estimate from final scores",
      nameLocation: "middle",
      nameGap: 38,
      nameTextStyle: { color: "#50687A", fontSize: 10 },
      axisLabel: { color: "#73889A", fontSize: 9 },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    series: [
      {
        name: "Perfect match",
        type: "line",
        data: [[chartBounds.min, chartBounds.min], [chartBounds.max, chartBounds.max]],
        symbol: "none",
        lineStyle: { color: "#A8B7C2", type: "dashed", width: 1.5 },
      },
      ...chartGroups.map((group) => ({
        name: group.label,
        type: "scatter" as const,
        data: group.rows.map((row) => [row.predicted, row.observed, row.n]),
        symbolSize: 10,
        itemStyle: {
          color: calibrationPositionColors[group.position],
          opacity: 0.88,
        },
      })),
    ],
  }), [chartBounds, chartGroups]);

  const coverageRows = useMemo(
    () => oosSeasonPositionMetrics
      .filter((row) => {
        const matchesSeason = seasonFilter === "All test seasons" || row.season === Number(seasonFilter);
        const matchesPosition = positionFilter === "All positions" || row.position === positionFilter;
        return matchesSeason && matchesPosition;
      })
      .map((row) => ({
        ...row,
        selectedModel: selectedModelByPosition[row.position],
        coverage: row.selectedCoverage,
        pinballLoss: row.selectedPinballLoss,
        rankSpearman: row.selectedRankSpearman,
      })),
    [positionFilter, seasonFilter],
  );

  const coverageOption = useMemo<EChartsOption>(() => ({
    animation: false,
    color: ["#1264A3", "#D87945"],
    grid: { left: 46, right: 16, top: 40, bottom: 52, containLabel: true },
    legend: { top: 0, textStyle: { color: "#50687A", fontSize: 10 } },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: coverageRows.map((row) => row.position + " · " + row.season),
      axisLabel: { color: "#73889A", fontSize: 9, interval: 0 },
      axisLine: { lineStyle: { color: "#CBD7DE" } },
    },
    yAxis: {
      type: "value",
      min: 0.6,
      max: 1,
      axisLabel: { color: "#73889A", fontSize: 9, formatter: (value: number) => Math.round(value * 100) + "%" },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    series: [
      {
        name: "Scores at or below ceiling",
        type: "bar",
        data: coverageRows.map((row) => ({
          value: row.coverage,
          itemStyle: { color: row.selectedModel === "ffsimulator" ? "#7C5BAA" : "#1264A3" },
        })),
        barMaxWidth: 28,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      },
      {
        name: "85% target",
        type: "line",
        data: coverageRows.map(() => 0.85),
        symbol: "none",
        lineStyle: { color: "#D87945", type: "dashed", width: 2 },
      },
    ],
  }), [coverageRows]);

  const selectedPositionRows = positionModelSelections.map((row) => ({
    ...row,
    method: row.selectedModel === "ffsimulator" ? "Simulation" : "Projection model",
  }));

  const chartScope = [
    seasonFilter === "All test seasons" ? "2024 and 2025" : seasonFilter,
    positionFilter === "All positions" ? "all positions" : positionFilter,
  ].join(" · ");

  return (
    <>
      <SectionIntro eyebrow="Calibration" title="Do the high estimates match past scores?" status={<StatusPill label="Near target" tone="good" />} action={<StatusPill label="PPR scoring" tone="blue" />}>We compare each high estimate with the final score from past weeks. The target is for about 85 of 100 scores to stay at or below the estimate.</SectionIntro>

      <section className="calibration-model-card">
        <div className="calibration-model-main">
          <div className="calibration-model-heading">
            <div className="model-symbol"><Activity size={21} /></div>
            <div>
              <div className="panel-eyebrow">The short answer</div>
              <h2>The high estimate is close to its target</h2>
              <p>We choose the method separately for each position. The result below combines those choices.</p>
            </div>
            <StatusPill label="Past results" tone="blue" />
          </div>
          <div className="calibration-model-result">
            <span className="calibration-result-icon"><CheckCircle2 size={17} /></span>
            <div><strong>{formatCalibrationPercent(selectedPortfolioOverall.coverage)} of final scores stayed at or below the ceiling</strong><span>The target is 85%. This result uses 2024 and 2025 scores that the models did not see during training.</span></div>
          </div>
        </div>
        <div className="calibration-model-meta">
          <div><span>Test period</span><strong>{calibrationModel.oosSeasons}</strong></div>
          <div><span>Scores checked</span><strong>Past final scores</strong></div>
          <div><span>Positions</span><strong>QB, RB, WR, TE</strong></div>
          <div><span>Scoring</span><strong>{calibrationModel.scoringFormat}</strong></div>
        </div>
      </section>

      <div className="calibration-model-note"><Info size={15} /><span>Scoring used here: {scoringContract.format}. Each reception is 1 point. This check adds no tight-end reception bonus and no receiving first-down points.</span></div>

      <div className="calibration-summary-grid">
        <MetricCard label="Scores at or below ceiling" value={formatCalibrationPercent(selectedPortfolioOverall.coverage)} detail="Goal: about 85 of 100 final scores" tone="good" icon={<Target size={17} />} />
        <MetricCard label="Scores above ceiling" value={formatCalibrationPercent(selectedPortfolioOverall.highSideMissRate)} detail="The final score beat the high estimate" tone="warn" icon={<ArrowUpRight size={17} />} />
        <MetricCard label="Typical gap" value={formatCalibrationMetric(selectedPortfolioOverall.p85Mae) + " pts"} detail="Average distance between estimate and final score" tone="neutral" icon={<Activity size={17} />} />
        <MetricCard label="High-estimate miss score" value={formatCalibrationMetric(selectedPortfolioOverall.pinballLoss)} detail="Weighted error for the high estimate. Lower is better." tone="good" icon={<Gauge size={17} />} />
      </div>

      <CalibrationMethodologyPanel rows={selectedPositionRows} estimate="high" />

      <Panel className="calibration-scorecard-panel" eyebrow="Method by position" title="Which method do we use?" action={<span className="calibration-panel-note">85% target</span>}>
        <DataTable
          data={selectedPositionRows}
          columns={[
            { accessorKey: "position", header: "Position", cell: (info) => <span className="position-chip">{info.getValue<string>()}</span> },
            { accessorKey: "method", header: "Method", cell: (info) => <strong>{info.getValue<string>()}</strong> },
            { accessorKey: "selectedCoverage", header: "At or below ceiling", cell: (info) => <strong>{formatCalibrationPercent(info.getValue<number>())}</strong> },
            { accessorKey: "selectedP85Mae", header: "Typical gap", cell: (info) => formatCalibrationMetric(info.getValue<number>()) + " pts" },
            { accessorKey: "selectedHighSideMissRate", header: "Above ceiling", cell: (info) => formatCalibrationPercent(info.getValue<number>()) },
            { accessorKey: "selectedPinballLoss", header: "Miss score", cell: (info) => formatCalibrationMetric(info.getValue<number>()) },
          ]}
        />
        <Explainer>At or below ceiling should be near 85%. Typical gap is the average distance between estimate and final score. Miss score gives more weight to scores above the ceiling. Lower is better.</Explainer>
      </Panel>

      <div className="calibration-visual-toolbar">
        <div><div className="panel-eyebrow">Past results</div><strong>Check the result by season or position</strong><span>Both charts use the selected method for each position.</span></div>
        <div className="calibration-visual-filters">
          <FilterSelect label="Test season" value={seasonFilter} options={calibrationSeasonOptions} onChange={setSeasonFilter} compact />
          <FilterSelect label="Position" value={positionFilter} options={calibrationPositionOptions} onChange={setPositionFilter} compact />
        </div>
      </div>

      <div className="calibration-chart-grid calibration-oos-charts">
        <Panel className="calibration-chart-large" eyebrow="Estimate vs final score" title="Do high estimates match final scores?" action={<span className="calibration-panel-note">{chartScope}</span>}>
          {filteredBins.length ? <EChart option={reliabilityOption} height={330} ariaLabel="Past result comparison for the selected models" /> : <EmptyState icon={<Database size={22} />} title="No chart data" body="This filter has no position and season groups with enough past results." />}
          <Explainer>Each dot groups past results with similar high estimates. Points near the diagonal mean the estimate and final-score result are similar. Each group has at least {calibrationBinMinimum} final scores.</Explainer>
        </Panel>
        <Panel eyebrow="Ceiling check" title="How often did scores stay at or below the ceiling?" action={<span className="calibration-panel-note">85% target</span>}>
          {coverageRows.length ? <EChart option={coverageOption} height={330} ariaLabel="Past score coverage at or below the ceiling for the selected models" /> : <EmptyState icon={<Database size={22} />} title="No coverage data" body="This filter has no past scores to compare." />}
          <Explainer>A bar near 85% means about 85 of 100 final scores stayed at or below the high estimate.</Explainer>
        </Panel>
      </div>

      <div className="two-column-grid calibration-policy-grid">
        <Panel eyebrow="Test basis" title="Where does this result come from?">
          <div className="calibration-data-facts calibration-evidence-summary">
            <div><strong>{calibrationModel.oosSeasons}</strong><span>Test seasons</span></div>
            <div><strong>{calibrationModel.positionModels}</strong><span>Positions</span></div>
          </div>
          <p className="calibration-copy">Each test season uses only earlier seasons for model history. A result enters the check only when the forecast and final score belong to the same player and game.</p>
          <Explainer>This check uses {calibrationModel.oosRows.toLocaleString()} matched forecast rows. Review the result again as more seasons finish.</Explainer>
        </Panel>
        <Panel eyebrow="Use this result" title="What should you take away?">
          <ul className="calibration-list">
            <li>The high estimate is a ceiling for a group of players. It is not an exact-score prediction.</li>
            <li>The combined result is close to the 85% target. One player can still fall above or below it.</li>
            <li>The 70% full-range check is separate because the projection model supplies only the high estimate.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}

function FloorCalibrationPage() {
  const [seasonFilter, setSeasonFilter] = useState<string>("All test seasons");
  const [positionFilter, setPositionFilter] = useState<string>("All positions");

  const filteredBins = useMemo(
    () => floorSelectedCalibrationBins.filter((row) => {
      const matchesSeason = seasonFilter === "All test seasons" || row.season === Number(seasonFilter);
      const matchesPosition = positionFilter === "All positions" || row.position === positionFilter;
      return matchesSeason && matchesPosition;
    }),
    [positionFilter, seasonFilter],
  );

  const chartGroups = useMemo(() => {
    const groups = new Map<string, { position: (typeof calibrationPositionOrder)[number]; label: string; rows: Array<(typeof floorSelectedCalibrationBins)[number]> }>();
    filteredBins.forEach((row) => {
      const groupKey = row.position;
      const current = groups.get(groupKey);
      if (current) {
        current.rows.push(row);
      } else {
        groups.set(groupKey, { position: row.position, label: row.position + " · " + (row.model === "ffsimulator" ? "Simulation" : "Projection model"), rows: [row] });
      }
    });
    return calibrationPositionOrder
      .map((position) => groups.get(position))
      .filter((group): group is NonNullable<typeof group> => Boolean(group));
  }, [filteredBins]);

  const chartBounds = useMemo(() => {
    const values = filteredBins.flatMap((row) => [row.predicted, row.observed]);
    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 0);
    const maxPadding = Math.max(1, maxValue * 0.08);
    return {
      min: minValue <= 0 ? Math.min(-1, Math.floor(minValue)) : 0,
      max: Math.max(30, Math.ceil((maxValue + maxPadding) / 5) * 5),
    };
  }, [filteredBins]);

  const reliabilityOption = useMemo<EChartsOption>(() => ({
    animation: false,
    grid: { left: 52, right: 18, top: 42, bottom: 48, containLabel: true },
    legend: { top: 0, type: "scroll", textStyle: { color: "#50687A", fontSize: 10 } },
    tooltip: { trigger: "item" },
    xAxis: {
      type: "value",
      min: chartBounds.min,
      max: chartBounds.max,
      name: "Low estimate",
      nameLocation: "middle",
      nameGap: 30,
      nameTextStyle: { color: "#50687A", fontSize: 10 },
      axisLabel: { color: "#73889A", fontSize: 9 },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    yAxis: {
      type: "value",
      min: chartBounds.min,
      max: chartBounds.max,
      name: "Low estimate from final scores",
      nameLocation: "middle",
      nameGap: 38,
      nameTextStyle: { color: "#50687A", fontSize: 10 },
      axisLabel: { color: "#73889A", fontSize: 9 },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    series: [
      {
        name: "Perfect match",
        type: "line",
        data: [[chartBounds.min, chartBounds.min], [chartBounds.max, chartBounds.max]],
        symbol: "none",
        lineStyle: { color: "#A8B7C2", type: "dashed", width: 1.5 },
      },
      ...chartGroups.map((group) => ({
        name: group.label,
        type: "scatter" as const,
        data: group.rows.map((row) => [row.predicted, row.observed, row.n]),
        symbolSize: 10,
        itemStyle: {
          color: calibrationPositionColors[group.position],
          opacity: 0.88,
        },
      })),
    ],
  }), [chartBounds, chartGroups]);

  const coverageRows = useMemo(
    () => floorOosSeasonPositionMetrics
      .filter((row) => {
        const matchesSeason = seasonFilter === "All test seasons" || row.season === Number(seasonFilter);
        const matchesPosition = positionFilter === "All positions" || row.position === positionFilter;
        return matchesSeason && matchesPosition;
      })
      .map((row) => ({
        ...row,
        selectedModel: floorSelectedModelByPosition[row.position],
        coverage: row.selectedCoverage,
        pinballLoss: row.selectedPinballLoss,
        rankSpearman: row.selectedRankSpearman,
      })),
    [positionFilter, seasonFilter],
  );

  const coverageOption = useMemo<EChartsOption>(() => ({
    animation: false,
    color: ["#1264A3", "#D87945"],
    grid: { left: 46, right: 16, top: 40, bottom: 52, containLabel: true },
    legend: { top: 0, textStyle: { color: "#50687A", fontSize: 10 } },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: coverageRows.map((row) => row.position + " · " + row.season),
      axisLabel: { color: "#73889A", fontSize: 9, interval: 0 },
      axisLine: { lineStyle: { color: "#CBD7DE" } },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 0.4,
      axisLabel: { color: "#73889A", fontSize: 9, formatter: (value: number) => Math.round(value * 100) + "%" },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    series: [
      {
        name: "Scores at or below floor",
        type: "bar",
        data: coverageRows.map((row) => ({
          value: row.coverage,
          itemStyle: { color: row.selectedModel === "ffsimulator" ? "#7C5BAA" : "#1264A3" },
        })),
        barMaxWidth: 28,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      },
      {
        name: "15% target",
        type: "line",
        data: coverageRows.map(() => 0.15),
        symbol: "none",
        lineStyle: { color: "#D87945", type: "dashed", width: 2 },
      },
    ],
  }), [coverageRows]);

  const selectedPositionRows = floorPositionModelSelections.map((row) => ({
    ...row,
    method: row.selectedModel === "ffsimulator" ? "Simulation" : "Projection model",
  }));

  const chartScope = [
    seasonFilter === "All test seasons" ? "2024 and 2025" : seasonFilter,
    positionFilter === "All positions" ? "all positions" : positionFilter,
  ].join(" · ");

  return (
    <>
      <SectionIntro eyebrow="Calibration" title="Do the low estimates match past scores?" status={<StatusPill label="Review target" tone="warn" />} action={<StatusPill label="PPR scoring" tone="blue" />}>We compare each low estimate with the final score from past weeks. The target is for about 15 of 100 scores to stay at or below the estimate.</SectionIntro>

      <section className="calibration-model-card">
        <div className="calibration-model-main">
          <div className="calibration-model-heading">
            <div className="model-symbol"><Activity size={21} /></div>
            <div>
              <div className="panel-eyebrow">The short answer</div>
              <h2>The low estimate needs calibration review</h2>
              <p>We choose the method separately for each position. The result below combines those choices.</p>
            </div>
            <StatusPill label="Past results" tone="blue" />
          </div>
          <div className="calibration-model-result">
            <span className="calibration-result-icon"><CheckCircle2 size={17} /></span>
            <div><strong>{formatCalibrationPercent(floorSelectedPortfolioOverall.coverage)} of final scores stayed at or below the floor</strong><span>The target is 15%. This result uses 2024 and 2025 scores that the models did not see during training.</span></div>
          </div>
        </div>
        <div className="calibration-model-meta">
          <div><span>Test period</span><strong>{floorCalibrationModel.oosSeasons}</strong></div>
          <div><span>Scores checked</span><strong>Past final scores</strong></div>
          <div><span>Positions</span><strong>QB, RB, WR, TE</strong></div>
          <div><span>Scoring</span><strong>{floorCalibrationModel.scoringFormat}</strong></div>
        </div>
      </section>

      <div className="calibration-model-note"><Info size={15} /><span>Scoring used here: {floorScoringContract.format}. Each reception is 1 point. This check adds no tight-end reception bonus and no receiving first-down points.</span></div>

      <div className="calibration-summary-grid">
        <MetricCard label="Scores at or below floor" value={formatCalibrationPercent(floorSelectedPortfolioOverall.coverage)} detail="Goal: about 15 of 100 final scores" tone="good" icon={<Target size={17} />} />
        <MetricCard label="Scores below floor" value={formatCalibrationPercent(floorSelectedPortfolioOverall.lowSideMissRate)} detail="The final score fell below the low estimate" tone="warn" icon={<ArrowDownRight size={17} />} />
        <MetricCard label="Typical gap" value={formatCalibrationMetric(floorSelectedPortfolioOverall.p15Mae) + " pts"} detail="Average distance between estimate and final score" tone="neutral" icon={<Activity size={17} />} />
        <MetricCard label="Floor miss score" value={formatCalibrationMetric(floorSelectedPortfolioOverall.pinballLoss)} detail="Weighted error for the low estimate. Lower is better." tone="good" icon={<Gauge size={17} />} />
      </div>

      <CalibrationMethodologyPanel rows={selectedPositionRows} estimate="low" />

      <Panel className="calibration-scorecard-panel" eyebrow="Method by position" title="Which method do we use?" action={<span className="calibration-panel-note">15% target</span>}>
        <DataTable
          data={selectedPositionRows}
          columns={[
            { accessorKey: "position", header: "Position", cell: (info) => <span className="position-chip">{info.getValue<string>()}</span> },
            { accessorKey: "method", header: "Method", cell: (info) => <strong>{info.getValue<string>()}</strong> },
            { accessorKey: "selectedCoverage", header: "At or below floor", cell: (info) => <strong>{formatCalibrationPercent(info.getValue<number>())}</strong> },
            { accessorKey: "selectedP15Mae", header: "Typical gap", cell: (info) => formatCalibrationMetric(info.getValue<number>()) + " pts" },
            { accessorKey: "selectedLowSideMissRate", header: "Below floor", cell: (info) => formatCalibrationPercent(info.getValue<number>()) },
            { accessorKey: "selectedPinballLoss", header: "Miss score", cell: (info) => formatCalibrationMetric(info.getValue<number>()) },
          ]}
        />
        <Explainer>At or below floor should be near 15%. Typical gap is the average distance between estimate and final score. Miss score gives more weight to scores below the floor. Lower is better.</Explainer>
      </Panel>

      <div className="calibration-visual-toolbar">
        <div><div className="panel-eyebrow">Past results</div><strong>Check the result by season or position</strong><span>Both charts use the selected method for each position.</span></div>
        <div className="calibration-visual-filters">
          <FilterSelect label="Test season" value={seasonFilter} options={calibrationSeasonOptions} onChange={setSeasonFilter} compact />
          <FilterSelect label="Position" value={positionFilter} options={calibrationPositionOptions} onChange={setPositionFilter} compact />
        </div>
      </div>

      <div className="calibration-chart-grid calibration-oos-charts">
        <Panel className="calibration-chart-large" eyebrow="Estimate vs final score" title="Do low estimates match final scores?" action={<span className="calibration-panel-note">{chartScope}</span>}>
          {filteredBins.length ? <EChart option={reliabilityOption} height={330} ariaLabel="Past result comparison for the selected floor models" /> : <EmptyState icon={<Database size={22} />} title="No chart data" body="This filter has no position and season groups with enough past results." />}
          <Explainer>Each dot groups past results with similar low estimates. Points near the diagonal mean the estimate and final-score result are similar. Each group has at least {floorCalibrationBinMinimum} final scores.</Explainer>
        </Panel>
        <Panel className="calibration-floor-check-panel" eyebrow="Floor check" title="How often did scores stay at or below the floor?" action={<span className="calibration-panel-note">15% target</span>}>
          {coverageRows.length ? <EChart option={coverageOption} height={330} ariaLabel="Past score coverage at or below the floor for the selected models" /> : <EmptyState icon={<Database size={22} />} title="No coverage data" body="This filter has no past scores to compare." />}
          <Explainer>A bar near 15% means about 15 of 100 final scores stayed at or below the low estimate.</Explainer>
        </Panel>
      </div>

      <div className="two-column-grid calibration-policy-grid">
        <Panel eyebrow="Test basis" title="Where does this result come from?">
          <div className="calibration-data-facts calibration-evidence-summary">
            <div><strong>{floorCalibrationModel.oosSeasons}</strong><span>Test seasons</span></div>
            <div><strong>{floorCalibrationModel.positionModels}</strong><span>Positions</span></div>
          </div>
          <p className="calibration-copy">Each test season uses only earlier seasons for model history. A result enters the check only when the forecast and final score belong to the same player and game.</p>
          <Explainer>This check uses {floorCalibrationModel.oosRows.toLocaleString()} matched forecast rows. Review the result again as more seasons finish.</Explainer>
        </Panel>
        <Panel eyebrow="Use this result" title="What should you take away?">
          <ul className="calibration-list">
            <li>The low estimate is a floor for a group of players. It is an estimate of the lower end, not an exact-score prediction.</li>
            <li>The combined result is above the 15% target in this backtest. Treat the floor as a conservative estimate until more seasons are tested.</li>
            <li>The 70% full-range check is separate because the projection model supplies only the low estimate.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}

type ProjectionPageProps = {
  upload: UploadReport;
  uploadErrors: UploadReport["errors"];
  runState: RunState;
  runId: string;
  season: string;
  week: string;
  onSeason: (value: string) => void;
  onWeek: (value: string) => void;
  runFailure: { stage?: string; message?: string; nextAction?: string } | null;
  simulationCount: string;
  onSimulationCount: (value: string) => void;
  viewMode: ViewMode;
  onViewMode: (value: ViewMode) => void;
  rows: ForecastRow[];
  allRows: ForecastRow[];
  overrides: Record<string, OverrideSpec>;
  search: string;
  position: string;
  team: string;
  sort: string;
  teams: string[];
  onSearch: (value: string) => void;
  onPosition: (value: string) => void;
  onTeam: (value: string) => void;
  onSort: (value: string) => void;
  onFile: (file: File) => void;
  onSetChange?: (setId: string) => void;
  onUseDemo: () => void;
  onResetUpload: () => void;
  onStartRun: () => void;
  onExport: (scope: "filtered" | "all") => void;
  onSelectPlayer: (row: ForecastRow) => void;
  onOpenOverrides: (row: ForecastRow) => void;
};

function ProjectionPage({ upload, uploadErrors, runState, runId, season, week, onSeason, onWeek, runFailure, simulationCount, onSimulationCount, viewMode, onViewMode, rows, allRows, overrides, search, position, team, sort, teams, onSearch, onPosition, onTeam, onSort, onFile, onUseDemo, onResetUpload, onStartRun, onExport, onSelectPlayer, onOpenOverrides }: ProjectionPageProps) {
  const [detailRow, setDetailRow] = useState<ForecastRow | null>(null);
  const inputId = "projection-csv-input";
  const progress = runState === "Checking upload" ? 20 : runState === "Queued" ? 42 : runState === "Running" ? 72 : runState === "Complete" ? 100 : runState === "Ready" ? 8 : 0;
  const numericSimulationCount = Number(simulationCount);
  const simulationCountValid = isValidSimulationCount(numericSimulationCount);
  const simulationProfile = numericSimulationCount === MIN_SIMULATIONS ? "Preview" : "Standard";
  const simulationCountDisabled = runState === "Checking upload" || runState === "Queued" || runState === "Running";
  const hasCompletedResult = runState === "Complete" || (runState === "Failed" && rows.length > 0);
  const statusTone = runState === "Complete" ? "good" : runState === "Failed" ? "warn" : runState === "Ready" ? "blue" : "neutral";
  const fatalUploadError = uploadErrors.some((error) => error.row === 0 || (error.row === 1 && ["file", "header", "id", "player_name", "position", "team"].includes(error.field)));
  const uploadBlocked = upload.accepted === 0 || fatalUploadError;
  const activeFilteredCount = rows.filter((row) => !overrides[row.id]?.exclude).length;
  const forecastTableRows = rows.map((row) => {
    const values = viewMode === "adjusted" ? applyOverride(row, overrides[row.id]) : row.original;
    return { ...row, ...values, width: values.ceiling - values.floor, adjustment: overrides[row.id]?.inactive ? "Inactive" : overrides[row.id] ? "Adjusted" : "Original" };
  });
  const columns: ColumnDef<(typeof forecastTableRows)[number], unknown>[] = [
    { accessorKey: "name", header: "Player", cell: (info) => <span className="table-player"><strong>{info.getValue<string>()}</strong><small>{info.row.original.game}</small></span> },
    { accessorKey: "position", header: "Pos", cell: (info) => <span className="position-chip">{info.getValue<string>()}</span> },
    { accessorKey: "team", header: "Team", cell: (info) => <strong className="team-code">{info.getValue<string>()}</strong> },
    { accessorKey: "opponent", header: "Opp", cell: (info) => <span className="team-code muted">{info.getValue<string>()}</span> },
    { accessorKey: "average", header: "Average", cell: (info) => <strong>{formatNumber(info.getValue<number>())}</strong> },
    { accessorKey: "floor", header: "Floor", cell: (info) => formatNumber(info.getValue<number>()) },
    { accessorKey: "median", header: "Median", cell: (info) => <strong>{formatNumber(info.getValue<number>())}</strong> },
    { accessorKey: "ceiling", header: "Ceiling", cell: (info) => formatNumber(info.getValue<number>()) },
    { accessorKey: "width", header: "Width", cell: (info) => <span className="text-blue">{formatNumber(info.getValue<number>())}</span> },
    { accessorKey: "sourceProjection", header: "Mean output", cell: (info) => formatNumber(info.getValue<number>()) },
    { accessorKey: "adjustment", header: "View", cell: (info) => <span className={cx("tag", info.getValue<string>() === "Original" ? "tag-blue" : info.getValue<string>() === "Inactive" ? "tag-gray" : "tag-orange")}>{info.getValue<string>()}</span> },
  ];
  function selectPlayer(row: ForecastRow) {
    setDetailRow(row);
    onSelectPlayer(row);
  }

  return (
    <>
      <SectionIntro eyebrow="Projection to sim" title="Turn a projection file into ranges" status={<StatusPill label={runState} tone={statusTone as "good" | "warn" | "neutral" | "blue"} />} action={<div className="action-group"><Button variant="secondary" onClick={onResetUpload} icon={<RotateCcw size={15} />}>Reset upload</Button><Button variant="quiet" icon={<CircleHelp size={15} />}>Input guide</Button></div>}>The real run uses the approved rank snapshot, ffsimulator, and released P15 and P85 services. Uploads do not train a model. Every run stores its input revision, seed, count, metric definition, and model release.</SectionIntro>
      <div className="projection-workflow-grid"><Panel className="upload-panel" eyebrow="1 · Upload and preview" title="Player outcome projections" action={<StatusPill label={`${upload.accepted.toLocaleString()} accepted`} tone={uploadErrors.length ? "warn" : "good"} />}><div className="upload-dropzone"><div className="upload-icon"><Upload size={20} /></div><div><strong>Drop a CSV here, or browse</strong><span>10 MB maximum · 50,000 rows · QB, RB, WR, TE</span></div><label htmlFor={inputId} className="button button-secondary">Browse file<input id={inputId} type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); event.currentTarget.value = ""; }} /></label></div><button type="button" className="sample-link" onClick={onUseDemo}><Sparkles size={14} /> Use the bundled Week 1 output</button><div className="upload-file-card"><div className="file-icon"><FileText size={17} /></div><div className="file-copy"><strong>{upload.fileName}</strong><span>Loaded {upload.sourceTimestamp === demoUploadReport.sourceTimestamp ? "Aug 31, 2026 at 09:14 ET" : "just now"}</span></div><StatusPill label={uploadErrors.length ? "Needs review" : "Checked"} tone={uploadErrors.length ? "warn" : "good"} /></div><div className="upload-stats"><div><span>Rows</span><strong>{upload.rows.toLocaleString()}</strong></div><div><span>Accepted</span><strong className="text-green">{upload.accepted.toLocaleString()}</strong></div><div><span>Excluded</span><strong className={upload.excluded ? "text-orange" : ""}>{upload.excluded.toLocaleString()}</strong></div><div><span>Unresolved</span><strong className={upload.unresolved ? "text-orange" : ""}>{upload.unresolved.toLocaleString()}</strong></div></div><div className="set-select-row"><FilterSelect label="Projection set" value={upload.sets.find((set) => set.id === upload.selectedSet)?.label ?? upload.selectedSet} options={upload.sets.map((set) => set.label)} onChange={() => undefined} /><span className="set-note"><Info size={13} /> {upload.sets.find((set) => set.id === upload.selectedSet)?.rows ?? upload.rows} rows in selected set</span></div>{upload.sourceOrderUsed ? <Explainer>The file has no explicit rank field. The adapter preserves source order within each position.</Explainer> : null}{uploadErrors.length ? <div className="error-report"><div className="error-report-title"><AlertTriangle size={15} /><strong>Row report</strong><span>{uploadErrors.length} errors</span></div><div className="error-list">{uploadErrors.slice(0, 5).map((error) => <div key={`${error.row}-${error.field}-${error.message}`}><code>Row {error.row || "file"}</code><span><strong>{error.field}</strong> {error.message}</span></div>)}</div>{uploadErrors.length > 5 ? <small>Showing 5 of {uploadErrors.length} errors.</small> : null}</div> : null}</Panel><Panel className="run-panel" eyebrow="2 · Run the baseline" title="Update Floor/Ceiling" action={<span className="run-version">sim-2026.1</span>}><div className="run-model-card"><div className="model-symbol"><Activity size={20} /></div><div><strong>Independent rank-conditioned simulation</strong><span>Complete p15, p50, and p85 range · Baseline</span></div><StatusPill label="Available" tone="good" /></div><div className="run-settings"><label className="run-setting-input"><span>Simulation count</span><span className="simulation-count-field"><input type="number" min={MIN_SIMULATIONS} max={MAX_SIMULATIONS} step={SIMULATION_STEP} value={simulationCount} onChange={(event) => onSimulationCount(event.target.value)} disabled={simulationCountDisabled} aria-label="Simulation count" aria-invalid={!simulationCountValid} aria-describedby="simulation-count-help" /><em>sims</em></span></label><div><span>Run profile</span><strong>{simulationCountValid ? simulationProfile : "Check count"}</strong></div><div><span>Seed policy</span><strong>Stored per run</strong></div><div><span>Input checks</span><strong>Pass <Check size={14} className="text-green" /></strong></div></div><div id="simulation-count-help" className="run-setting-help">Use 100 to 1,000 simulations in steps of 100. A 100-simulation run is a preview; higher counts are standard runs.</div><div className="run-action"><Button variant="primary" onClick={onStartRun} disabled={runState === "Checking upload" || runState === "Queued" || runState === "Running" || uploadErrors.length > 0 || upload.accepted === 0 || !simulationCountValid} className="full-width" icon={runState === "Running" ? <RefreshCcw size={15} className="spin" /> : <Play size={15} />}>{runState === "Complete" ? "Run again" : runState === "Failed" ? "Retry run" : runState === "Running" ? "Simulation running" : "Update Floor/Ceiling"}</Button><span>Repeat clicks return the active job. A changed upload or simulation count creates a new run.</span></div>{runState !== "Empty" && runState !== "Ready" && runState !== "Complete" ? <div className="run-progress"><div className="run-progress-top"><span>{runState}</span><strong>{progress}%</strong></div><span className="progress-track"><span style={{ width: `${progress}%` }} /></span><small>Job {shortId(runId)} · {numericSimulationCount.toLocaleString()} simulations · The page can be refreshed while the worker runs.</small></div> : null}<div className="run-state-row">{runStates.map((state) => <span key={state} className={cx(runState === state && "run-state-active", runState === "Failed" && state === "Failed" && "run-state-failed")}>{runState === state ? <Check size={12} /> : null}{state}</span>)}</div><Explainer>Counts from 100 to 1,000 reduce random sampling noise. The 100-simulation option remains a preview.</Explainer></Panel></div>
      <Panel className="forecast-output-panel" eyebrow="3 · Inspect the result" title="Player ranges" action={<div className="panel-actions"><div className="view-toggle"><button type="button" className={viewMode === "original" ? "active" : ""} onClick={() => onViewMode("original")}>Original</button><button type="button" className={viewMode === "adjusted" ? "active" : ""} onClick={() => onViewMode("adjusted")}>Adjusted {Object.keys(overrides).length ? `(${Object.keys(overrides).length})` : ""}</button></div><StatusPill label={`${rows.length} shown`} tone="neutral" /></div>}>{hasCompletedResult ? <><div className="projection-toolbar"><SearchField value={search} onChange={onSearch} placeholder="Search by player or team" /><FilterSelect label="Position" value={position} options={positionOptions} onChange={onPosition} compact /><FilterSelect label="Team" value={team} options={teams} onChange={onTeam} compact /><FilterSelect label="Sort by" value={sort} options={["ceiling", "median", "floor", "name"]} onChange={onSort} compact /><div className="toolbar-spacer" /><div className="download-menu"><Button variant="secondary" icon={<Download size={15} />} onClick={() => onExport("filtered")}>Download filtered ({activeFilteredCount})</Button><Button variant="quiet" onClick={() => onExport("all")}>All {allRows.length}</Button></div></div><div className="range-chart-card"><div className="range-chart-header"><div><strong>Floor to ceiling</strong><span>Showing the first 25 rows · select a player for details</span></div><div className="range-chart-legend"><span><i className="legend-floor" /> Floor</span><span><i className="legend-median" /> Median</span><span><i className="legend-ceiling" /> Ceiling</span></div></div><div className="range-list">{rows.length ? rows.slice(0, 25).map((row) => <ForecastRange key={row.id} row={row} override={viewMode === "adjusted" ? overrides[row.id] : undefined} onSelect={selectPlayer} />) : <EmptyState icon={<Search size={24} />} title="No matching players" body="Change the search or filters to restore rows." />}</div><div className="range-chart-footer"><span>Player count limit: 25 of {rows.length}</span><span>Values display one decimal. Sorting and exports use full precision.</span></div></div><div className="linked-chart-grid"><Panel eyebrow="Median vs ceiling" title="Where is the upside?" className="small-range-panel"><div className="median-ceiling-chart">{rows.slice(0, 12).map((row, index) => { const values = viewMode === "adjusted" ? applyOverride(row, overrides[row.id]) : row.original; return <button type="button" className="median-ceiling-dot" key={row.id} style={{ left: `${Math.min(93, (values.median / 35) * 100)}%`, bottom: `${Math.min(86, (values.ceiling / 40) * 100)}%`, background: ["#1264A3", "#2E8B73", "#D87945", "#7C5BAA"][index % 4] }} onClick={() => selectPlayer(row)} aria-label={`Open ${row.name}`} />; })}<span className="axis-label-x">Median</span><span className="axis-label-y">Ceiling</span></div><Explainer>The dot uses the same player selection as the range chart and table.</Explainer></Panel><Panel eyebrow="Source and range" title="Current output"><div className="output-summary-list"><div><span>Average median</span><strong>{formatNumber(calculateDemoSummary(rows, overrides).averageMedian)}</strong></div><div><span>Average range width</span><strong>{formatNumber(calculateDemoSummary(rows, overrides).averageWidth)}</strong></div><div><span>Model version</span><strong>sim-2026.1</strong></div><div><span>Run ID</span><strong className="mono">{shortId(runId)}</strong></div></div><Explainer>The bar runs from the estimated floor to the ceiling. The dot marks the median. Observed outcomes can fall outside the range.</Explainer></Panel></div><DataTable data={forecastTableRows} columns={columns} onRowClick={selectPlayer} /></> : <EmptyState icon={runState === "Failed" ? <AlertTriangle size={24} /> : <Play size={15} />} title={runState === "Failed" ? "The run needs attention" : runState === "Ready" ? "Ready to run" : "Waiting for a result"} body={runState === "Failed" ? "Read the row report above, correct the input, and retry the same submission." : runState === "Ready" ? "The upload passed the baseline input checks. Start a simulation to create ranges." : "The worker result will appear here when the run completes."} action={runState === "Ready" ? <Button variant="primary" onClick={onStartRun} icon={<Play size={15} />}>Update Floor/Ceiling</Button> : undefined} />}</Panel>
      <div className="projection-footnotes"><span><LockKeyhole size={14} /> Raw source uploads remain private and expire with this temporary workspace.</span><span><Database size={14} /> Results use Outcome metric v1.0 · {runId}</span></div>
      <PlayerDetailDrawerV2 row={detailRow} override={detailRow ? overrides[detailRow.id] : undefined} onClose={() => setDetailRow(null)} onOpenOverrides={() => { if (detailRow) onOpenOverrides(detailRow); setDetailRow(null); }} />
    </>
  );
}

function ForecastProjectionPage({ upload, uploadErrors, runState, runId, season, week, onSeason, onWeek, runFailure, simulationCount, onSimulationCount, viewMode, onViewMode, rows, allRows, overrides, search, position, team, sort, teams, onSearch, onPosition, onTeam, onSort, onFile, onSetChange, onUseDemo, onResetUpload, onStartRun, onExport, onSelectPlayer, onOpenOverrides }: ProjectionPageProps) {
  const [detailRow, setDetailRow] = useState<ForecastRow | null>(null);
  const numericSimulationCount = Number(simulationCount);
  const simulationCountValid = isValidSimulationCount(numericSimulationCount);
  const simulationProfile = numericSimulationCount === MIN_SIMULATIONS ? "Preview" : "Standard";
  const simulationCountDisabled = runState === "Checking upload" || runState === "Queued" || runState === "Running";
  const hasResult = runState === "Complete" || (runState === "Failed" && rows.length > 0);
  const progress = runState === "Checking upload" ? 20 : runState === "Queued" ? 42 : runState === "Running" ? 72 : runState === "Complete" ? 100 : runState === "Ready" ? 8 : 0;
  const statusTone = runState === "Complete" ? "good" : runState === "Failed" ? "warn" : runState === "Ready" ? "blue" : "neutral";
  const fatalUploadError = uploadErrors.some((error) => error.row === 0 || (error.row === 1 && ["file", "header", "id", "player_name", "position", "team"].includes(error.field)));
  const uploadBlocked = upload.accepted === 0 || fatalUploadError;
  const filteredCount = rows.filter((row) => !overrides[row.id]?.exclude).length;
  const displayRows = rows.map((row) => {
    const values = viewMode === "adjusted" ? applyOverride(row, overrides[row.id]) : row.original;
    return { ...row, ...values, average: row.average ?? row.sourceProjection, width: values.ceiling - values.floor, adjustment: overrides[row.id]?.inactive ? "Inactive" : overrides[row.id] ? "Adjusted" : "Original" };
  });
  const columns: ColumnDef<(typeof displayRows)[number], unknown>[] = [
    { accessorKey: "name", header: "Player", cell: (info) => <span className="table-player"><strong>{info.getValue<string>()}</strong><small>{info.row.original.game}</small></span> },
    { accessorKey: "position", header: "Pos", cell: (info) => <span className="position-chip">{info.getValue<string>()}</span> },
    { accessorKey: "team", header: "Team", cell: (info) => <strong className="team-code">{info.getValue<string>()}</strong> },
    { accessorKey: "average", header: "Average", cell: (info) => <strong>{formatNumber(info.getValue<number>())}</strong> },
    { accessorKey: "floor", header: "Floor", cell: (info) => formatNumber(info.getValue<number>()) },
    { accessorKey: "median", header: "Median", cell: (info) => <strong>{formatNumber(info.getValue<number>())}</strong> },
    { accessorKey: "ceiling", header: "Ceiling", cell: (info) => formatNumber(info.getValue<number>()) },
    { accessorKey: "width", header: "Width", cell: (info) => <span className="text-blue">{formatNumber(info.getValue<number>())}</span> },
    { accessorKey: "adjustment", header: "View", cell: (info) => <span className={cx("tag", info.getValue<string>() === "Original" ? "tag-blue" : info.getValue<string>() === "Inactive" ? "tag-gray" : "tag-orange")}>{info.getValue<string>()}</span> },
  ];
  function selectPlayer(row: ForecastRow) {
    setDetailRow(row);
    onSelectPlayer(row);
  }
  const selectedSet = upload.sets.find((set) => set.id === upload.selectedSet);
  const seasonOptions = ["2026"];
  const weekOptions = ["1"];
  return (
    <>
      <SectionIntro eyebrow="Projection to sim" title="Turn a projection file into ranges" status={<StatusPill label={runState} tone={statusTone as "good" | "warn" | "neutral" | "blue"} />} action={<div className="action-group"><Button variant="secondary" onClick={onResetUpload} icon={<RotateCcw size={15} />}>Reset upload</Button><Button variant="quiet" icon={<CircleHelp size={15} />}>Input guide</Button></div>}>The real run uses the approved rank snapshot, ffsimulator, and released P15 and P85 services. Uploads do not train a model. Every run stores its input revision, seed, count, metric definition, and model release.</SectionIntro>
      <div className="projection-workflow-grid">
        <Panel className="upload-panel" eyebrow="1 · Upload and preview" title="Player outcome projections" action={<StatusPill label={`${upload.accepted.toLocaleString()} accepted`} tone={uploadErrors.length ? "warn" : "good"} />}>
          <div className="upload-dropzone"><div className="upload-icon"><Upload size={20} /></div><div><strong>Choose a projection CSV</strong><span>20 MB maximum · QB, RB, WR, TE</span></div><label htmlFor="real-projection-csv-input" className="button button-secondary">Browse file<input id="real-projection-csv-input" type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); event.currentTarget.value = ""; }} /></label></div>
          <button type="button" className="sample-link" onClick={onUseDemo}><Sparkles size={14} /> Use the bundled demonstration</button>
          <div className="upload-file-card"><div className="file-icon"><FileText size={17} /></div><div className="file-copy"><strong>{upload.fileName}</strong><span>{upload.sourceTimestamp === demoUploadReport.sourceTimestamp ? "Bundled public output" : "Stored in this workspace"}</span></div><StatusPill label={uploadErrors.length ? "Needs review" : "Checked"} tone={uploadErrors.length ? "warn" : "good"} /></div>
          <div className="upload-stats"><div><span>Rows</span><strong>{upload.rows.toLocaleString()}</strong></div><div><span>Accepted</span><strong className="text-green">{upload.accepted.toLocaleString()}</strong></div><div><span>Excluded</span><strong className={upload.excluded ? "text-orange" : ""}>{upload.excluded.toLocaleString()}</strong></div><div><span>Unresolved</span><strong className={upload.unresolved ? "text-orange" : ""}>{upload.unresolved.toLocaleString()}</strong></div></div>
          <div className="set-select-row"><FilterSelect label="Projection set" value={selectedSet?.label ?? upload.selectedSet} options={upload.sets.map((set) => set.label)} onChange={(label) => { const nextSet = upload.sets.find((set) => set.label === label); if (nextSet) onSetChange?.(nextSet.id); }} /><span className="set-note"><Info size={13} /> {selectedSet?.rows ?? upload.rows} rows in selected set</span></div>
          {upload.sourceOrderUsed ? <Explainer>The file has no explicit rank field. The adapter uses source order within each position.</Explainer> : null}
          {uploadErrors.length ? <div className="error-report"><div className="error-report-title"><AlertTriangle size={15} /><strong>Row report</strong><span>{uploadErrors.length} findings</span></div><div className="error-list">{uploadErrors.slice(0, 5).map((error) => <div key={`${error.row}-${error.field}-${error.message}`}><code>Row {error.row || "file"}</code><span><strong>{error.field}</strong> {error.message}</span></div>)}</div>{uploadErrors.length > 5 ? <small>Showing 5 of {uploadErrors.length} findings.</small> : null}</div> : null}
        </Panel>
        <Panel className="run-panel" eyebrow="2 · Run the baseline" title="Real inference" action={<span className="run-version">forecast-ppr-v1</span>}>
          <div className="run-model-card"><div className="model-symbol"><Activity size={20} /></div><div><strong>ffsimulator plus quantile services</strong><span>QB from simulation · RB, WR, and TE from XGBoost p15 and p85</span></div><StatusPill label="Available" tone="good" /></div>
          <div className="run-settings"><div><span>Forecast context</span><div className="run-context-selects"><FilterSelect label="Season" value={season} options={seasonOptions} onChange={onSeason} compact /><FilterSelect label="Week" value={week} options={weekOptions} onChange={onWeek} compact /></div></div><label className="run-setting-input"><span>Simulation count</span><span className="simulation-count-field"><input type="number" min={MIN_SIMULATIONS} max={MAX_SIMULATIONS} step={SIMULATION_STEP} value={simulationCount} onChange={(event) => onSimulationCount(event.target.value)} disabled={simulationCountDisabled} aria-label="Simulation count" aria-invalid={!simulationCountValid} /><em>sims</em></span></label><div><span>Run profile</span><strong>{simulationCountValid ? simulationProfile : "Check count"}</strong></div><div><span>Input checks</span><strong>{uploadBlocked ? "Review report" : <>Pass <Check size={14} className="text-green" /></>}</strong></div></div>
          <div className="run-setting-help">Use 100 to 1,000 simulations in steps of 100. The seed is stored with the run.</div>
          <div className="run-action"><Button variant="primary" onClick={onStartRun} disabled={runState === "Checking upload" || runState === "Queued" || runState === "Running" || uploadBlocked || !simulationCountValid} className="full-width" icon={runState === "Running" ? <RefreshCcw size={15} className="spin" /> : <Play size={15} />}>{runState === "Running" ? "Inference running" : runState === "Queued" ? "Queued" : "Run real inference"}</Button><span>A new source revision creates a separate durable run.</span></div>
          {runState !== "Empty" && runState !== "Ready" && runState !== "Complete" ? <div className="run-progress"><div className="run-progress-top"><span>{runState}</span><strong>{progress}%</strong></div><span className="progress-track"><span style={{ width: `${progress}%` }} /></span><small>Job {shortId(runId)} · {numericSimulationCount.toLocaleString()} simulations</small></div> : null}
          <div className="run-state-row">{runStates.map((state) => <span key={state} className={cx(runState === state && "run-state-active", runState === "Failed" && state === "Failed" && "run-state-failed")}>{runState === state ? <Check size={12} /> : null}{state}</span>)}</div>
        </Panel>
      </div>
      {runFailure ? <div className="run-failure-banner"><AlertTriangle size={18} /><div><strong>{runFailure.stage ?? "Run failure"}</strong><span>{runFailure.message ?? "The run failed before a complete result was published."}</span><small>{runFailure.nextAction ?? "Review the failure and retry after correction."}</small></div></div> : null}
      <Panel className="forecast-output-panel" eyebrow="3 · Inspect the result" title="Player ranges" action={<div className="panel-actions"><div className="view-toggle"><button type="button" className={viewMode === "original" ? "active" : ""} onClick={() => onViewMode("original")}>Original</button><button type="button" className={viewMode === "adjusted" ? "active" : ""} onClick={() => onViewMode("adjusted")}>Adjusted {Object.keys(overrides).length ? `(${Object.keys(overrides).length})` : ""}</button></div><StatusPill label={`${rows.length} shown`} tone="neutral" /></div>}>
        {hasResult ? <><div className="projection-toolbar"><SearchField value={search} onChange={onSearch} placeholder="Search by player or team" /><FilterSelect label="Position" value={position} options={positionOptions} onChange={onPosition} compact /><FilterSelect label="Team" value={team} options={teams} onChange={onTeam} compact /><FilterSelect label="Sort by" value={sort} options={["ceiling", "median", "floor", "name"]} onChange={onSort} compact /><div className="toolbar-spacer" /><div className="download-menu"><Button variant="secondary" icon={<Download size={15} />} onClick={() => onExport("filtered")}>Download filtered ({filteredCount})</Button><Button variant="quiet" onClick={() => onExport("all")}>All {allRows.length}</Button></div></div><div className="range-chart-card"><div className="range-chart-header"><div><strong>Floor to ceiling</strong><span>Showing the first 25 rows · select a player for details</span></div><div className="range-chart-legend"><span><i className="legend-floor" /> Floor</span><span><i className="legend-median" /> Median</span><span><i className="legend-ceiling" /> Ceiling</span></div></div><div className="range-list">{rows.length ? rows.slice(0, 25).map((row) => <ForecastRange key={row.id} row={row} override={viewMode === "adjusted" ? overrides[row.id] : undefined} onSelect={selectPlayer} />) : <EmptyState icon={<Search size={24} />} title="No matching players" body="Change the search or filters to restore rows." />}</div><div className="range-chart-footer"><span>Player count limit: 25 of {rows.length}</span><span>Average uses the declared source policy. Range values use full precision.</span></div></div><div className="linked-chart-grid"><Panel eyebrow="Median vs ceiling" title="Where is the upside?" className="small-range-panel"><div className="median-ceiling-chart">{rows.slice(0, 12).map((row, index) => { const values = viewMode === "adjusted" ? applyOverride(row, overrides[row.id]) : row.original; return <button type="button" className="median-ceiling-dot" key={row.id} style={{ left: `${Math.min(93, (values.median / 35) * 100)}%`, bottom: `${Math.min(86, (values.ceiling / 40) * 100)}%`, background: ["#1264A3", "#2E8B73", "#D87945", "#7C5BAA"][index % 4] }} onClick={() => selectPlayer(row)} aria-label={`Open ${row.name}`} />; })}<span className="axis-label-x">Median</span><span className="axis-label-y">Ceiling</span></div><Explainer>The dot uses the same player selection as the range chart and table.</Explainer></Panel><Panel eyebrow="Source and range" title="Current output"><div className="output-summary-list"><div><span>Average median</span><strong>{formatNumber(calculateDemoSummary(rows, overrides).averageMedian)}</strong></div><div><span>Average range width</span><strong>{formatNumber(calculateDemoSummary(rows, overrides).averageWidth)}</strong></div><div><span>Model release</span><strong>{rows[0]?.modelRelease ?? "demo-bundled-output"}</strong></div><div><span>Run ID</span><strong className="mono">{shortId(runId)}</strong></div></div><Explainer>Original model values stay available when adjusted values are shown.</Explainer></Panel></div><DataTable data={displayRows} columns={columns} onRowClick={selectPlayer} /></> : <EmptyState icon={runState === "Failed" ? <AlertTriangle size={24} /> : <Play size={15} />} title={runState === "Failed" ? "The run needs attention" : runState === "Ready" ? "Ready to run" : "Waiting for a result"} body={runState === "Failed" ? "The last complete result stays visible when one exists. Correct the issue and retry." : runState === "Ready" ? "The upload passed the baseline input checks. Start real inference to create ranges." : "The server result will appear here when the run completes."} action={runState === "Ready" ? <Button variant="primary" onClick={onStartRun} icon={<Play size={15} />}>Run real inference</Button> : undefined} />}
      </Panel>
      <div className="projection-footnotes"><span><LockKeyhole size={14} /> Raw source uploads remain private and expire with this temporary workspace.</span><span><Database size={14} /> Results use ppr_v1 · {runId}</span></div>
      <PlayerDetailDrawerV2 row={detailRow} override={detailRow ? overrides[detailRow.id] : undefined} onClose={() => setDetailRow(null)} onOpenOverrides={() => { if (detailRow) onOpenOverrides(detailRow); setDetailRow(null); }} />
    </>
  );
}

function PlayerDetailDrawer({ row, override, onClose, onOpenOverrides }: { row: ForecastRow | null; override?: OverrideSpec; onClose: () => void; onOpenOverrides: () => void }) {
  useEffect(() => {
    if (!row) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, row]);
  if (!row) return null;
  const adjusted = applyOverride(row, override);
  return <div className="drawer-backdrop" role="presentation" onClick={onClose}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="player-detail-title" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className="panel-eyebrow">Player detail</span><h2 id="player-detail-title">{row.name}</h2><span>{row.position} · {row.team} vs {row.opponent} · {row.id}</span></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close player detail"><X size={18} /></button></div><div className="drawer-actions"><Button variant="primary" onClick={onOpenOverrides} icon={<SlidersHorizontal size={15} />}>Open manual override</Button><StatusPill label={override ? "Adjusted view" : "Original view"} tone={override ? "warn" : "blue"} /></div><div className="drawer-value-grid"><div><span>Floor</span><strong>{formatNumber(adjusted.floor)}</strong><small>Original {formatNumber(row.original.floor)}</small></div><div><span>Median</span><strong>{formatNumber(adjusted.median)}</strong><small>Original {formatNumber(row.original.median)}</small></div><div><span>Ceiling</span><strong>{formatNumber(adjusted.ceiling)}</strong><small>Original {formatNumber(row.original.ceiling)}</small></div></div><div className="drawer-source"><div><span>Mean output</span><strong>{formatNumber(row.sourceProjection)}</strong></div><div><span>Simulation count</span><strong>{row.nSimulations.toLocaleString()}</strong></div></div><div className="drawer-draws"><div className="panel-eyebrow">Stored simulation data</div>{row.hasDraws ? <div className="draws-placeholder">Draw data is available for this run.</div> : <div className="drawer-empty"><Info size={18} /><div><strong>No raw draws in this artifact</strong><p>The saved artifact contains quantiles only. The site does not invent a histogram from three edited values.</p></div></div>}</div><div className="drawer-explainer"><Info size={15} /> The bar runs from the estimated floor to the ceiling. The dot marks the median. Observed outcomes can fall outside the range.</div></aside></div>;
}

function PlayerDetailDrawerV2({ row, override, onClose, onOpenOverrides }: { row: ForecastRow | null; override?: OverrideSpec; onClose: () => void; onOpenOverrides: () => void }) {
  useEffect(() => {
    if (!row) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, row]);
  if (!row) return null;
  const adjusted = applyOverride(row, override);
  const sources = row.valueSources;
  return <div className="drawer-backdrop" role="presentation" onClick={onClose}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="player-detail-title-v2" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className="panel-eyebrow">Player detail</span><h2 id="player-detail-title-v2">{row.name}</h2><span>{row.position} · {row.team} vs {row.opponent} · {row.id}</span></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close player detail"><X size={18} /></button></div><div className="drawer-actions"><Button variant="primary" onClick={onOpenOverrides} icon={<SlidersHorizontal size={15} />}>Open manual override</Button><StatusPill label={override ? "Adjusted view" : "Original view"} tone={override ? "warn" : "blue"} /></div><div className="drawer-value-grid"><div><span>Average</span><strong>{formatNumber(row.average ?? row.sourceProjection)}</strong><small>{sources?.average ?? "Source projection"}</small></div><div><span>Floor</span><strong>{formatNumber(adjusted.floor)}</strong><small>{sources?.floor ?? "Model output"}</small></div><div><span>Median</span><strong>{formatNumber(adjusted.median)}</strong><small>{sources?.median ?? "Model output"}</small></div><div><span>Ceiling</span><strong>{formatNumber(adjusted.ceiling)}</strong><small>{sources?.ceiling ?? "Model output"}</small></div></div><div className="drawer-source"><div><span>CSV PPR projection</span><strong>{formatNumber(row.csvProjection ?? row.sourceProjection)}</strong></div><div><span>Simulation count</span><strong>{row.nSimulations.toLocaleString()}</strong></div><div><span>Rank uncertainty</span><strong>{row.rankSd === undefined ? "Stored" : formatNumber(row.rankSd)}</strong></div></div><div className="drawer-draws"><div className="panel-eyebrow">Producer values</div>{row.ffsim ? <div className="draws-placeholder">ffsimulator p15 {formatNumber(row.ffsim.p15)} · p50 {formatNumber(row.ffsim.p50)} · p85 {formatNumber(row.ffsim.p85)}. {row.position === "QB" ? "These values define the full QB range." : `XGBoost p15 ${formatNumber(row.xgbP15 ?? 0)} and p85 ${formatNumber(row.xgbP85 ?? 0)} define the skill range.`}</div> : <div className="drawer-empty"><Info size={18} /><div><strong>Producer details are not in the bundled artifact</strong><p>Run real inference to view producer-level values.</p></div></div>}</div><div className="drawer-explainer"><Info size={15} /> Original model values stay unchanged when a manual override is saved.</div></aside></div>;
}

type OverridesPageProps = {
  runLabel: string;
  rows: ForecastRow[];
  overrides: Record<string, OverrideSpec>;
  history: OverrideHistoryEntry[];
  selectedRow?: ForecastRow;
  selectedPlayerId: string;
  onSelectRow: (row: ForecastRow) => void;
  onSave: (spec: OverrideSpec) => void;
  onResetPlayer: (row: ForecastRow) => void;
  onResetAll: () => void;
  onCopy: () => void;
};

function OverridesPage({ runLabel, rows, overrides, history, selectedRow, selectedPlayerId, onSelectRow, onSave, onResetPlayer, onResetAll, onCopy }: OverridesPageProps) {
  const [rosterSearch, setRosterSearch] = useState("");
  const [rosterPosition, setRosterPosition] = useState("All");
  const filteredRows = rows.filter((row) => (!rosterSearch || row.name.toLowerCase().includes(rosterSearch.toLowerCase())) && (rosterPosition === "All" || row.position === rosterPosition));
  return (
    <>
      <SectionIntro eyebrow="Manual overrides" title="Record judgment without rewriting the model" status={<StatusPill label={`${Object.keys(overrides).length} saved`} tone={Object.keys(overrides).length ? "warn" : "neutral"} />} action={<div className="action-group"><Button variant="secondary" onClick={onCopy} icon={<CopyIcon />}>Copy prior overrides</Button><Button variant="quiet" onClick={onResetAll} icon={<RotateCcw size={15} />}>Reset all</Button></div>}>One explicit override layer sits over the selected run. Original simulation values stay intact. Adjusted values flow to the table, range charts, and exports together.</SectionIntro>
      <div className="override-policy-strip"><div><ShieldCheck size={18} /><strong>Original model evaluation stays unchanged</strong><span>Manual adjustments get a separate evaluation view.</span></div><div><LockKeyhole size={18} /><strong>Session-only edits</strong><span>These changes expire with the temporary workspace.</span></div><div><FileText size={18} /><strong>Reason required</strong><span>Every saved revision records why it changed.</span></div></div>
      <div className="override-layout"><Panel className="roster-panel" eyebrow={`Selected run · ${runLabel}`} title="Players" action={<span className="table-count">{filteredRows.length} shown</span>}><div className="roster-filters"><SearchField value={rosterSearch} onChange={setRosterSearch} placeholder="Find a player" /><FilterSelect label="Position" value={rosterPosition} options={positionOptions} onChange={setRosterPosition} compact /></div><div className="roster-list">{filteredRows.map((row) => { const saved = overrides[row.id]; const adjusted = applyOverride(row, saved); return <button type="button" className={cx("roster-item", selectedPlayerId === row.id && "roster-item-active")} key={row.id} onClick={() => onSelectRow(row)}><span className="roster-avatar">{row.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span><span className="roster-copy"><strong>{row.name}</strong><small>{row.position} · {row.team} vs {row.opponent}</small></span><span className="roster-values"><strong>{formatNumber(adjusted.median)}</strong><small>{saved?.inactive ? "Inactive" : saved ? "Adjusted" : "Original"}</small></span>{saved ? <span className={cx("override-indicator", saved.inactive && "override-indicator-gray")} /> : null}</button>; })}</div><div className="roster-foot"><span>Stable player IDs match overrides.</span><span>Sorted by source rank</span></div></Panel><OverrideEditor row={selectedRow} override={selectedRow ? overrides[selectedRow.id] : undefined} onSave={onSave} onReset={() => selectedRow && onResetPlayer(selectedRow)} /></div>
      <div className="two-column-grid override-lower"><Panel eyebrow="Override precedence" title="The saved order is fixed"><div className="precedence-list"><div className="precedence-step"><span>01</span><strong>Workload factor</strong><small>Full 1.0, half 0.5, quarter 0.25, or a custom factor from 0 to 2.</small></div><ChevronRight size={15} /><div className="precedence-step"><span>02</span><strong>Defense preset</strong><small>Optional DST ceiling uplift when the ceiling is below 1.25× point projection.</small></div><ChevronRight size={15} /><div className="precedence-step"><span>03</span><strong>Direct edits</strong><small>Explicit floor, median, or ceiling values win last.</small></div></div><Explainer>Mark inactive takes priority and sets all three adjusted values to zero. Export exclusion stays independent.</Explainer></Panel><Panel eyebrow="Revision history" title="What changed" action={<span className="table-count">{history.length} revisions</span>}>{history.length ? <div className="history-list">{history.slice(0, 7).map((item) => <div className="history-item" key={item.id}><span className={cx("history-dot", `history-${item.tone}`)} /> <div><strong>{item.label}</strong><small>{item.detail}</small>{item.previous && item.next ? <code className="history-values">{formatNumber(item.previous.floor)} / {formatNumber(item.previous.median)} / {formatNumber(item.previous.ceiling)} → {formatNumber(item.next.floor)} / {formatNumber(item.next.median)} / {formatNumber(item.next.ceiling)}</code> : null}</div><time>{formatRelativeTime(item.time)}</time></div>)}</div> : <EmptyState icon={<Clock3 size={22} />} title="No saved revisions" body="Preview and save a player adjustment to start the history." />}</Panel></div>
      <div className="override-limit"><Info size={16} /><span>Arbitrary edits do not change original draws, team aggregates, trained models, or the official model evaluation.</span></div>
    </>
  );
}

function CopyIcon() {
  return <span className="copy-icon"><FileText size={14} /><FileText size={11} /></span>;
}

function OverrideEditor({ row, override, onSave, onReset }: { row?: ForecastRow; override?: OverrideSpec; onSave: (spec: OverrideSpec) => void; onReset: () => void }) {
  const [factor, setFactor] = useState("1");
  const [preset, setPreset] = useState<OverridePreset | undefined>(undefined);
  const [inactive, setInactive] = useState(false);
  const [exclude, setExclude] = useState(false);
  const [defensePreset, setDefensePreset] = useState(false);
  const [analystProjection, setAnalystProjection] = useState("");
  const [floor, setFloor] = useState("");
  const [median, setMedian] = useState("");
  const [ceiling, setCeiling] = useState("");
  const [reason, setReason] = useState("");
  const [previewed, setPreviewed] = useState(false);

  useEffect(() => {
    setFactor(String(override?.factor ?? 1));
    setPreset(override?.preset);
    setInactive(override?.inactive ?? false);
    setExclude(override?.exclude ?? false);
    setDefensePreset(override?.defensePreset ?? false);
    setAnalystProjection(override?.analystProjection === undefined ? "" : String(override.analystProjection));
    setFloor(override?.edits.floor === undefined ? "" : String(override.edits.floor));
    setMedian(override?.edits.median === undefined ? "" : String(override.edits.median));
    setCeiling(override?.edits.ceiling === undefined ? "" : String(override.edits.ceiling));
    setReason(override?.reason ?? "");
    setPreviewed(false);
  }, [row?.id, override]);

  const draft = useMemo<OverrideSpec>(() => ({
    factor: clampFactor(Number(factor)),
    preset,
    inactive,
    exclude,
    defensePreset,
    analystProjection: analystProjection.trim() === "" ? undefined : Number(analystProjection),
    edits: {
      ...(floor.trim() === "" ? {} : { floor: Number(floor) }),
      ...(median.trim() === "" ? {} : { median: Number(median) }),
      ...(ceiling.trim() === "" ? {} : { ceiling: Number(ceiling) }),
    },
    reason: reason.trim(),
    savedAt: new Date().toISOString(),
    revision: (override?.revision ?? 0) + 1,
  }), [analystProjection, ceiling, defensePreset, exclude, factor, floor, inactive, median, override?.revision, preset, reason]);

  const previewValues = row ? applyOverride(row, draft) : { floor: 0, median: 0, ceiling: 0 };
  const validationError = row ? validateRange(previewValues) : null;
  const delta = row ? { floor: previewValues.floor - row.original.floor, median: previewValues.median - row.original.median, ceiling: previewValues.ceiling - row.original.ceiling } : { floor: 0, median: 0, ceiling: 0 };
  const defenseAvailable = row?.position === "DST";

  function handleSave() {
    if (!row) return;
    if (!reason.trim()) return;
    onSave(draft);
    setPreviewed(false);
  }

  if (!row) return <Panel className="editor-panel" eyebrow="Adjustment editor" title="Select a player"><EmptyState icon={<Users size={23} />} title="Choose a player" body="Select a player from the list to edit the saved range." /></Panel>;

  return <Panel className="editor-panel" eyebrow="Adjustment editor" title={row.name} action={<div className="editor-actions"><StatusPill label={override ? `Revision ${override.revision}` : "Original"} tone={override ? "warn" : "neutral"} /><button type="button" className="icon-button" aria-label="More player actions"><MoreHorizontal size={18} /></button></div>}><div className="editor-player-meta"><span className="position-chip">{row.position}</span><strong>{row.team} vs {row.opponent}</strong><span>Source projection {formatNumber(row.sourceProjection)}</span><span className="mono">{row.id}</span></div><div className="value-compare"><div className="value-compare-head"><span>Original simulation</span><span>Adjusted preview</span></div><div className="compare-row"><span><small>Floor</small><strong>{formatNumber(row.original.floor)}</strong></span><ArrowUpRight size={15} /><span className="adjusted-value"><small>Adjusted floor</small><strong>{formatNumber(previewValues.floor)}</strong><em>{delta.floor >= 0 ? "+" : ""}{formatNumber(delta.floor)}</em></span></div><div className="compare-row"><span><small>Median</small><strong>{formatNumber(row.original.median)}</strong></span><ArrowUpRight size={15} /><span className="adjusted-value"><small>Adjusted median</small><strong>{formatNumber(previewValues.median)}</strong><em>{delta.median >= 0 ? "+" : ""}{formatNumber(delta.median)}</em></span></div><div className="compare-row"><span><small>Ceiling</small><strong>{formatNumber(row.original.ceiling)}</strong></span><ArrowUpRight size={15} /><span className="adjusted-value"><small>Adjusted ceiling</small><strong>{formatNumber(previewValues.ceiling)}</strong><em>{delta.ceiling >= 0 ? "+" : ""}{formatNumber(delta.ceiling)}</em></span></div></div><div className="editor-section"><div className="editor-section-heading"><span>Workload preset</span><small>Choose one named preset or use a custom factor.</small></div><div className="preset-buttons"><button type="button" className={preset === "full" ? "active" : ""} onClick={() => { setPreset("full"); setFactor("1"); }}>Full <small>1.0</small></button><button type="button" className={preset === "half" ? "active" : ""} onClick={() => { setPreset("half"); setFactor("1"); }}>Half <small>0.5</small></button><button type="button" className={preset === "quarter" ? "active" : ""} onClick={() => { setPreset("quarter"); setFactor("1"); }}>Quarter <small>0.25</small></button>{["RB", "WR", "TE"].includes(row.position) ? <button type="button" className={preset === "reduced_role" ? "active" : ""} onClick={() => { setPreset("reduced_role"); setFactor("1"); }}>Reduced role <small>0.75</small></button> : null}<label className="factor-input"><span>Custom</span><input type="number" min="0" max="2" step="0.05" value={preset ? "" : factor} placeholder="1" onChange={(event) => { setPreset(undefined); setFactor(event.target.value); }} /><span>×</span></label></div><div className="factor-range"><input type="range" min="0" max="2" step="0.05" value={Number(factor) || 0} onChange={(event) => { setPreset(undefined); setFactor(event.target.value); }} aria-label="Custom workload factor" /><span>0</span><span>1</span><span>2</span></div></div><div className="editor-section"><div className="editor-section-heading"><span>Special actions</span><small>These apply before direct edits.</small></div><div className="editor-toggles"><Toggle label="Mark inactive" checked={inactive} onChange={setInactive} /><Toggle label="Exclude from export" checked={exclude} onChange={setExclude} /><Toggle label="Legacy defense uplift" checked={defensePreset && Boolean(defenseAvailable)} onChange={(checked) => setDefensePreset(defenseAvailable ? checked : false)} disabled={!defenseAvailable} /></div>{!defenseAvailable ? <small className="field-help">The legacy defense preset is available for DST rows only.</small> : null}<div className="analyst-input"><label>Analyst outcome estimate <input type="number" value={analystProjection} onChange={(event) => setAnalystProjection(event.target.value)} placeholder="Optional" /></label><small>Read-only source projection stays {formatNumber(row.sourceProjection)}. This field only feeds a named manual rule.</small></div></div><div className="editor-section"><div className="editor-section-heading"><span>Direct range edit</span><small>Leave a field empty to keep its calculated value.</small></div><div className="direct-edit-grid"><label>Adjusted floor<input type="number" step="0.01" value={floor} onChange={(event) => setFloor(event.target.value)} disabled={inactive} /></label><label>Adjusted median<input type="number" step="0.01" value={median} onChange={(event) => setMedian(event.target.value)} disabled={inactive} /></label><label>Adjusted ceiling<input type="number" step="0.01" value={ceiling} onChange={(event) => setCeiling(event.target.value)} disabled={inactive} /></label></div>{validationError ? <div className="field-error"><AlertTriangle size={14} /> {validationError}</div> : null}</div><div className="editor-section reason-section"><label className="reason-label">Reason for change <span>Required</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: workload concern from the latest injury report" rows={3} /></label></div><div className="editor-footer"><div>{previewed ? <StatusPill label="Preview updated" tone="good" /> : <span className="save-limit"><Info size={14} /> Original draws and official outcomes stay unchanged.</span>}</div><div className="editor-button-row"><Button variant="quiet" onClick={onReset} icon={<RotateCcw size={14} />}>Reset player</Button><Button variant="secondary" onClick={() => setPreviewed(true)} disabled={Boolean(validationError)} icon={<Eye size={14} />}>Preview changes</Button><Button variant="primary" onClick={handleSave} disabled={!reason.trim() || Boolean(validationError)} icon={<Check size={15} />}>Save overrides</Button></div></div></Panel>;
}
