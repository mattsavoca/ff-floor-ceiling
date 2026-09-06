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
  positionModelSelections,
  scoringContract,
  selectedCalibrationBins,
  selectedModelByPosition,
  selectedPortfolioOverall,
} from "@/lib/calibration-data";
import {
  demoForecasts,
  demoUploadReport,
  positionSummaries,
  timeline,
  toolRows,
} from "@/lib/project-data";
import { applyOverride, calculateDemoSummary, clampFactor, formatNumber, validateRange } from "@/lib/metrics";
import type { ForecastRow, OverrideSpec, RangeValues, RunState, TabId, UploadReport, ViewMode } from "@/lib/types";
import type { EChartsOption } from "echarts";

const navItems: Array<{ id: TabId; label: string; description: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", description: "Weekly monitoring", icon: LayoutDashboard },
  { id: "methodology", label: "Methodology", description: "How the model changed", icon: GitBranch },
  { id: "calibration", label: "Model calibration", description: "Historical evidence", icon: Target },
  { id: "projection", label: "Projection to sim", description: "Run a forecast", icon: Zap },
  { id: "overrides", label: "Manual overrides", description: "Record judgment", icon: SlidersHorizontal },
];

const positionOptions = ["All", "QB", "RB", "WR", "TE"] as const;
const runStates: RunState[] = ["Empty", "Checking upload", "Ready", "Queued", "Running", "Complete", "Failed", "Canceled"];
type OverrideHistoryEntry = { id: string; label: string; detail: string; time: string; tone: "blue" | "orange" | "gray"; previous?: RangeValues; next?: RangeValues };

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

function ContextStrip({ season, week, metricDefinition, onSeason, onWeek, onMetricDefinition }: { season: string; week: string; metricDefinition: string; onSeason: (value: string) => void; onWeek: (value: string) => void; onMetricDefinition: (value: string) => void }) {
  return (
    <div className="context-strip">
      <FilterSelect label="Season" value={season} options={["2026", "2025", "2024"]} onChange={onSeason} compact />
      <FilterSelect label="Week" value={week} options={["1", "2", "3", "4", "Season to date"]} onChange={onWeek} compact />
      <FilterSelect label="Metric" value={metricDefinition} options={["Outcome metric v1.0"]} onChange={onMetricDefinition} compact />
      <div className="context-divider" />
      <div className="context-meta"><span className="live-dot" /> Source refresh <strong>Aug 31, 2026</strong></div>
      <div className="context-meta">Forecast created <strong>Aug 31, 2026</strong></div>
      <StatusPill label="Bundled output" tone="blue" />
    </div>
  );
}

function MiniBar({ value, max = 1, color = "blue" }: { value: number; max?: number; color?: "blue" | "orange" | "green" }) {
  return <span className="mini-bar"><span className={`mini-bar-fill ${color}`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} /></span>;
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

  const selectedRow = demoForecasts.find((row) => row.id === selectedPlayerId) ?? demoForecasts[0];
  const teams = useMemo(() => ["All", ...Array.from(new Set(demoForecasts.map((row) => row.team))).sort()], []);
  const filteredForecasts = useMemo(() => {
    const filtered = demoForecasts.filter((row) => {
      const matchesSearch = !projectionSearch || `${row.name} ${row.team}`.toLowerCase().includes(projectionSearch.toLowerCase());
      const matchesPosition = projectionPosition === "All" || row.position === projectionPosition;
      const matchesTeam = projectionTeam === "All" || row.team === projectionTeam;
      return matchesSearch && matchesPosition && matchesTeam;
    });
    return [...filtered].sort((left, right) => {
      const leftValues = viewMode === "adjusted" ? applyOverride(left, overrides[left.id]) : left.original;
      const rightValues = viewMode === "adjusted" ? applyOverride(right, overrides[right.id]) : right.original;
      if (projectionSort === "name") return left.name.localeCompare(right.name);
      if (projectionSort === "median") return rightValues.median - leftValues.median;
      if (projectionSort === "floor") return rightValues.floor - leftValues.floor;
      return rightValues.ceiling - leftValues.ceiling;
    });
  }, [overrides, projectionPosition, projectionSearch, projectionSort, projectionTeam, viewMode]);

  useEffect(() => {
    const stored = window.sessionStorage.getItem("fc-overrides");
    if (stored) {
      try { setOverrides(JSON.parse(stored) as Record<string, OverrideSpec>); } catch { window.sessionStorage.removeItem("fc-overrides"); }
    }
    const storedWorkspace = window.sessionStorage.getItem("fc-workspace-id");
    if (storedWorkspace) setWorkspaceId(storedWorkspace);
    else window.sessionStorage.setItem("fc-workspace-id", workspaceId);
    void fetch("/api/session").then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { workspaceId?: string; expiresAt?: string };
      if (data.workspaceId) { setWorkspaceId(data.workspaceId); window.sessionStorage.setItem("fc-workspace-id", data.workspaceId); }
      if (data.expiresAt) setExpiresAt(data.expiresAt);
    }).catch(() => undefined);
  }, [workspaceId]);

  useEffect(() => {
    window.sessionStorage.setItem("fc-overrides", JSON.stringify(overrides));
  }, [overrides]);

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

  function resetWorkspace() {
    setOverrides({});
    setOverrideHistory([]);
    setUpload(demoUploadReport);
    setRunState("Complete");
    setRunId("run_w1_2026_7f3a");
    setProjectionSearch("");
    setToast("The temporary workspace now shows the public demonstration.");
    setSessionMenuOpen(false);
  }

  async function handleFile(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setUploadErrors([{ row: 0, field: "file", message: "The file is larger than the 10 MB upload limit." }]);
      setRunState("Failed");
      return;
    }
    const parsed = parseProjectionCsv(await file.text(), file.name);
    setUpload(parsed.report);
    setUploadErrors(parsed.report.errors);
    setRunState(parsed.report.errors.length || parsed.report.accepted === 0 ? "Failed" : "Ready");
    setToast(parsed.report.errors.length ? "The upload needs review before a run can start." : `Accepted ${parsed.report.accepted.toLocaleString()} rows.`);
  }

  function useDemoSample() {
    setUpload(demoUploadReport);
    setUploadErrors([]);
    setRunState("Ready");
    setToast("The Week 1 demonstration upload is ready to run.");
  }

  function resetUpload() {
    setUpload(demoUploadReport);
    setUploadErrors([]);
    setRunState("Complete");
    setRunId("run_w1_2026_7f3a");
    setToast("The draft upload reset to the public sample. Prior runs stay available.");
  }

  async function startRun() {
    if (runState === "Queued" || runState === "Running" || runState === "Checking upload") {
      setToast("This submission already has an active job.");
      return;
    }
    if (uploadErrors.length || upload.accepted === 0) {
      setToast("Resolve the upload rows before starting a run.");
      return;
    }
    setRunState("Checking upload");
    const numericWeek = Number.parseInt(week, 10) || 1;
    const submissionToken = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": browserCookie("fc_csrf") },
        body: JSON.stringify({
          season: Number(season),
          week: numericWeek,
          metricDefinitionVersion: metricDefinition,
          simulationCount: 100,
          acceptedRows: upload.accepted,
          inputRevision: `${upload.fileName}:${upload.accepted}:${upload.rows}`,
          submissionToken,
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        setRunState("Failed");
        setToast(error?.error ?? "The server could not accept this run.");
        return;
      }
      const data = await response.json() as { runId?: string };
      const nextRunId = data.runId ?? `run_${season}_w${numericWeek}_${submissionToken.slice(0, 6)}`;
      setRunId(nextRunId);
    } catch {
      setRunState("Failed");
      setToast("The run request failed. Check the session and try again.");
      return;
    }
    window.setTimeout(() => setRunState("Queued"), 500);
    window.setTimeout(() => setRunState("Running"), 1100);
    window.setTimeout(() => { setRunState("Complete"); setToast("The simulation completed. The result is ready to inspect."); }, 2200);
  }

  function exportForecasts(rows: ForecastRow[], scope: "filtered" | "all") {
    const exportRows = rows.filter((row) => scope === "all" || !overrides[row.id]?.exclude).map((row) => {
      const override = overrides[row.id];
      const adjusted = applyOverride(row, override);
      return {
        stable_player_id: row.id,
        player_name: row.name,
        position: row.position,
        team: row.team,
        opponent: row.opponent,
        season,
        week,
        metric_definition_version: metricDefinition,
        model_version: "sim-2026.1",
        run_id: runId,
        source_projection: row.sourceProjection,
        original_p15: row.original.floor,
        original_p50: row.original.median,
        original_p85: row.original.ceiling,
        adjusted_floor: adjusted.floor,
        adjusted_median: adjusted.median,
        adjusted_ceiling: adjusted.ceiling,
        exclusion_state: override?.exclude ? "excluded" : "active",
        override_revision: override?.revision ?? 0,
      };
    });
    const columns = Object.keys(exportRows[0] ?? {}) as Array<keyof (typeof exportRows)[number]>;
    downloadText(`floor-ceiling-${scope}-${season}-week-${week}.csv`, buildCsv(exportRows, columns));
    setToast(`Downloaded ${exportRows.length.toLocaleString()} ${scope} rows${scope === "filtered" ? ". Excluded rows stay out of the active export." : "."}`);
  }

  function addHistory(label: string, detail: string, tone: "blue" | "orange" | "gray" = "blue", values?: Pick<OverrideHistoryEntry, "previous" | "next">) {
    setOverrideHistory((history) => [{ id: `${Date.now()}-${label}`, label, detail, time: new Date().toISOString(), tone, ...values }, ...history]);
  }

  function saveOverride(spec: OverrideSpec) {
    if (!selectedRow) return;
    const values = applyOverride(selectedRow, spec);
    const validationError = validateRange(values);
    if (validationError) { setToast(validationError); return; }
    const previous = applyOverride(selectedRow, overrides[selectedRow.id]);
    setOverrides((current) => ({ ...current, [selectedRow.id]: spec }));
    addHistory(`Saved ${selectedRow.name}`, spec.reason, spec.inactive ? "gray" : "orange", { previous, next: values });
    setToast(`${selectedRow.name}'s adjustment is saved as revision ${spec.revision}.`);
  }

  function resetPlayer(row: ForecastRow) {
    if (!overrides[row.id]) { setToast(`${row.name} has no saved adjustment.`); return; }
    const previous = applyOverride(row, overrides[row.id]);
    setOverrides((current) => { const next = { ...current }; delete next[row.id]; return next; });
    addHistory(`Reset ${row.name}`, "Restored original simulation values.", "gray", { previous, next: row.original });
    setToast(`${row.name} now uses the original range.`);
  }

  function resetAllOverrides() {
    const count = Object.keys(overrides).length;
    if (!count) { setToast("There are no saved adjustments to reset."); return; }
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
        <div className="sidebar-label">{activeTab === "calibration" ? "Selected portfolio" : "Current run"}</div>
        {activeTab === "calibration" ? <div className="sidebar-run-card calibration-sidebar-card"><div className="run-card-top"><span className="run-dot run-dot-good" />Held-out evidence<MoreHorizontal size={15} /></div><strong>{calibrationModel.shortName}</strong><span>{calibrationModel.oosRows.toLocaleString()} held-out rows</span><span className="sidebar-run-id">2024 · 2025</span></div> : <div className="sidebar-run-card"><div className="run-card-top"><span className={cx("run-dot", runState === "Complete" ? "run-dot-good" : runState === "Failed" ? "run-dot-warn" : "run-dot-blue")} />{runState}<MoreHorizontal size={15} /></div><strong>Week {week} · {season}</strong><span>{upload.accepted.toLocaleString()} accepted rows</span><span className="sidebar-run-id">{shortId(runId)}</span></div>}
        <div className="sidebar-spacer" />
        <div className="sidebar-footer"><div className="owner-row"><span className="owner-avatar">MS</span><span><strong>Matt Savoca</strong><small>Owner workspace</small></span><Settings2 size={16} /></div><div className="privacy-note"><LockKeyhole size={13} /> Temporary data stays in this browser.</div></div>
      </aside>
      {mobileNavOpen ? <button className="nav-scrim" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" /> : null}
      <main className="main-area">
        <header className="topbar"><div className="mobile-brand"><button type="button" className="menu-button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><span>Floor &amp; Ceiling</span></div><div className="topbar-context"><span className="topbar-kicker">{activeTab === "calibration" ? "Model card" : "Forecast workspace"}</span><span className="topbar-separator">/</span><strong>{activeTab === "calibration" ? calibrationModel.shortName : `${season} · Week ${week}`}</strong></div><div className="topbar-actions"><span className="saved-state"><span className="saved-dot" /> Saved locally</span><button type="button" className="session-button" onClick={() => setSessionMenuOpen((open) => !open)}><span className="session-avatar"><UserRound size={14} /></span><span>{shortId(workspaceId)}</span><ChevronDown size={14} /></button>{sessionMenuOpen ? <div className="session-menu"><div className="session-menu-heading"><span className="session-avatar large"><UserRound size={16} /></span><div><strong>Temporary workspace</strong><span>{shortId(workspaceId)}</span></div></div><div className="session-menu-row"><Clock3 size={15} /><span>Expires {formatRelativeTime(expiresAt)}</span></div><div className="session-menu-row"><ShieldCheck size={15} /><span>Private to this browser</span></div><div className="session-menu-divider" /><Button variant="quiet" onClick={resetWorkspace} icon={<RotateCcw size={15} />}>Reset workspace</Button><p>Download work before the session expires. Lost or expired data cannot be recovered.</p></div> : null}</div></header>
        {activeTab !== "calibration" ? <ContextStrip season={season} week={week} metricDefinition={metricDefinition} onSeason={setSeason} onWeek={setWeek} onMetricDefinition={setMetricDefinition} /> : null}
        <div className="page-content">
          {activeTab === "overview" ? <OverviewPage navigate={navigate} /> : null}
          {activeTab === "methodology" ? <MethodologyPage /> : null}
          {activeTab === "calibration" ? <CalibrationPage /> : null}
          {activeTab === "projection" ? <ProjectionPage upload={upload} uploadErrors={uploadErrors} runState={runState} runId={runId} viewMode={viewMode} onViewMode={setViewMode} rows={filteredForecasts} allRows={demoForecasts} overrides={overrides} search={projectionSearch} position={projectionPosition} team={projectionTeam} sort={projectionSort} teams={teams} onSearch={setProjectionSearch} onPosition={setProjectionPosition} onTeam={setProjectionTeam} onSort={setProjectionSort} onFile={handleFile} onUseDemo={useDemoSample} onResetUpload={resetUpload} onStartRun={startRun} onExport={(scope) => exportForecasts(scope === "filtered" ? filteredForecasts : demoForecasts, scope)} onSelectPlayer={(row) => setSelectedPlayerId(row.id)} onOpenOverrides={(row) => { setSelectedPlayerId(row.id); setActiveTab("overrides"); }} /> : null}
          {activeTab === "overrides" ? <OverridesPage rows={demoForecasts} overrides={overrides} history={overrideHistory} selectedRow={selectedRow} selectedPlayerId={selectedPlayerId} onSelectRow={(row) => setSelectedPlayerId(row.id)} onSave={saveOverride} onResetPlayer={resetPlayer} onResetAll={resetAllOverrides} onCopy={() => { setToast("Copy prior overrides creates a reviewable draft inside this session."); addHistory("Copied prior overrides", "No unmatched players in the current run.", "blue"); }} /> : null}
        </div>
        <footer className="app-footer"><span><Database size={14} /> Public evidence build · v0.1</span><span>Last data check Aug 31, 2026</span><a href="#methodology" onClick={(event) => { event.preventDefault(); navigate("methodology"); }}>How to read this site <ChevronRight size={13} /></a></footer>
      </main>
      {toast ? <div className="toast" role="status"><CheckCircle2 size={17} /><span>{toast}</span><button type="button" onClick={() => setToast(null)} aria-label="Dismiss message"><X size={15} /></button></div> : null}
    </div>
  );
}

function OverviewPage({ navigate }: { navigate: (tab: TabId) => void }) {
  const totalRows = demoForecasts.length;
  const averageMedian = demoForecasts.reduce((sum, row) => sum + row.original.median, 0) / Math.max(totalRows, 1);
  const averageWidth = demoForecasts.reduce((sum, row) => sum + row.original.ceiling - row.original.floor, 0) / Math.max(totalRows, 1);
  const simulationCounts = Array.from(new Set(demoForecasts.map((row) => row.nSimulations)));
  const summaryItems = [
    ["Loaded rows", totalRows.toLocaleString(), "Week 1 player range output"],
    ["Simulation draws", simulationCounts.length === 1 ? simulationCounts[0].toLocaleString() : "Mixed", "Stored on each output row"],
    ["Average median", formatNumber(averageMedian), "Across loaded player rows"],
    ["Average width", formatNumber(averageWidth), "Average ceiling minus floor"],
  ];

  return (
    <>
      <SectionIntro eyebrow="Weekly monitoring" title="Read the current forecast output" status={<StatusPill label="Output loaded" tone="good" />} action={<Button variant="primary" onClick={() => navigate("projection")} icon={<Upload size={16} />}>Open forecast workflow</Button>}>This view shows the stored Week 1 ranges and the checks that are available now. Historical accuracy stays empty until completed outcomes are loaded.</SectionIntro>
      <div className="overview-hero-grid">
        <Panel className="latest-panel" eyebrow="Current output" title="2026 · Week 1" action={<button type="button" className="icon-button" aria-label="Open output details" onClick={() => navigate("projection")}><MoreHorizontal size={18} /></button>}>
          <div className="latest-status"><StatusPill label="Stored output" tone="good" /><span>{totalRows.toLocaleString()} player rows · 4 positions</span></div>
          <div className="latest-big-number">{totalRows.toLocaleString()} <small>player range rows</small></div>
          <div className="latest-detail-grid"><div><span>Lower marker</span><strong>p15</strong><small>Loaded</small></div><div><span>Median</span><strong>p50</strong><small>Loaded</small></div><div><span>Upper marker</span><strong>p85</strong><small>Loaded</small></div><div><span>Completed outcomes</span><strong>Pending</strong><small>Needed for evaluation</small></div></div>
          <div className="latest-foot"><span><Clock3 size={14} /> Source timestamp: Aug 31, 2026</span><button type="button" className="text-button" onClick={() => navigate("projection")}>Inspect rows <ArrowUpRight size={14} /></button></div>
        </Panel>
        <Panel className="next-forecast-panel" eyebrow="Evaluation status" title="Waiting for outcomes"><div className="forecast-readiness"><div className="readiness-icon"><Clock3 size={22} /></div><div><strong>Forecast rows are ready</strong><span>Completed outcome rows are not loaded</span></div></div><div className="readiness-list"><div><span>Accuracy checks</span><strong>Pending</strong></div><div><span>Coverage</span><strong>Pending</strong></div><div><span>Quantile loss</span><strong>Pending</strong></div><div><span>Next action</span><strong>Load outcomes</strong></div></div><Button variant="secondary" onClick={() => navigate("calibration")} className="full-width" icon={<Target size={15} />}>Open evaluation</Button></Panel>
      </div>
      <div className="metric-grid">{summaryItems.map(([label, value, detail], index) => <MetricCard key={label} label={label} value={value} detail={detail} tone={index < 2 ? "good" : "neutral"} icon={index === 0 ? <Users size={17} /> : index === 1 ? <Gauge size={17} /> : index === 2 ? <Activity size={17} /> : <Target size={17} />} />)}<MetricCard label="Held-out evaluation" value="Pending" detail="Completed outcomes are required" tone="neutral" icon={<Link2 size={17} />} /></div>
      <div className="two-column-grid overview-main-grid">
        <Panel className="chart-panel" eyebrow="Forecast performance" title="Historical evaluation is empty"><div className="empty-chart-state"><Database size={22} /><strong>Completed outcomes are required</strong><span>The current artifact contains ranges only. Coverage, loss, and error charts will appear after matching outcome rows are loaded.</span><Button variant="secondary" onClick={() => navigate("calibration")}>Open evaluation</Button></div></Panel>
        <Panel className="inspect-panel" eyebrow="Available checks" title="Review the current output"><div className="inspect-list">{[
          ["Loaded player rows", "The site loaded every row from the Week 1 player range output.", "Open output", "projection"],
          ["Range fields", "Each row includes a floor, median, and ceiling.", "Open output", "projection"],
          ["Stored run count", "Each row records the number of simulation draws.", "Open methodology", "methodology"],
          ["Evaluation boundary", "Accuracy claims wait for completed outcome rows.", "Open evaluation", "calibration"],
        ].map(([label, detail, value, tab]) => <button type="button" className="inspect-item" key={label} onClick={() => navigate(tab as TabId)}><span className="inspect-item-icon inspect-good"><CheckCircle2 size={16} /></span><span className="inspect-copy"><strong>{label}</strong><small>{detail}</small></span><span className="inspect-value">{value}</span><ChevronRight size={15} /></button>)}</div><Explainer>These checks describe data state. They do not alter the stored output.</Explainer></Panel>
      </div>
      <Panel className="input-change-panel" eyebrow="Input changes" title="What is loaded now?" action={<div className="panel-actions"><StatusPill label="Source checked" tone="good" /><button type="button" className="text-button" onClick={() => navigate("projection")}>Open output <ArrowUpRight size={14} /></button></div>}><div className="input-summary-grid"><div className="input-summary-item"><div className="input-summary-top"><span>Player rows</span><strong>{totalRows.toLocaleString()}</strong></div><MiniBar value={Math.min(1, totalRows / 300)} color="blue" /><small>Week 1 stored range output</small></div><div className="input-summary-item"><div className="input-summary-top"><span>Range fields</span><strong>3</strong></div><MiniBar value={0.75} color="green" /><small>p15, p50, and p85</small></div><div className="input-summary-item"><div className="input-summary-top"><span>Identity fields</span><strong>Present</strong></div><MiniBar value={1} color="green" /><small>Player ID and name are loaded</small></div><div className="input-summary-item"><div className="input-summary-top"><span>Outcome rows</span><strong>Pending</strong></div><MiniBar value={0} color="orange" /><small>Required for historical checks</small></div></div><Explainer>Upload a new file to create a local run. The stored output remains unchanged until you start that run.</Explainer></Panel>
      <div className="two-column-grid lower-overview-grid"><Panel eyebrow="Position breakdown" title="Stored range summary"><div className="position-breakdown">{positionSummaries.map((row) => <div className="position-line" key={row.position}><span className="position-chip">{row.position}</span><span className="position-name">{row.position === "QB" ? "Quarterback" : row.position === "RB" ? "Running back" : row.position === "WR" ? "Wide receiver" : "Tight end"}</span><span className="position-stat"><strong>{row.rows.toLocaleString()}</strong><small>rows</small></span><MiniBar value={row.rows / Math.max(...positionSummaries.map((item) => item.rows))} color={row.position === "QB" ? "orange" : "blue"} /><span className="position-stat"><strong>{formatNumber(row.averageMedian)}</strong><small>average median</small></span></div>)}</div><Explainer>These values summarize the stored Week 1 rows. They do not measure accuracy.</Explainer></Panel><Panel eyebrow="Weekly loop" title="From output to evidence"><div className="loop-list">{["Load model output", "Inspect input changes", "Review stored ranges", "Record manual changes", "Freeze before kickoff", "Load completed outcomes", "Inspect the evaluation"].map((item, index) => <button type="button" className={cx("loop-step", index === 2 && "loop-step-current")} key={item} onClick={() => index < 4 ? navigate("projection") : navigate("calibration")}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item}</strong>{index === 2 ? <StatusPill label="Current" tone="blue" /> : <ChevronRight size={14} />}</button>)}</div></Panel></div>
    </>
  );
}


function MethodologyPage() {
  const [selectedStage, setSelectedStage] = useState(3);
  const stage = timeline[selectedStage];
  return (
    <>
      <SectionIntro eyebrow="Methodology" title="What changed the engineer's mind?" status={<StatusPill label={`${timeline.length} recorded stages`} tone="blue" />} action={<Button variant="secondary" onClick={() => document.getElementById("methodology-source-map")?.scrollIntoView({ behavior: "smooth" })} icon={<FileText size={15} />}>Source map</Button>}>This timeline records the data contract, the stored output, and the checks that remain before evaluation.</SectionIntro>
      <div className="methodology-notice"><div className="notice-icon"><GitBranch size={20} /></div><div><strong>The stored output stays explicit.</strong><p>The Week 1 output supplies p15, p50, and p85 for each loaded row. Evaluation stays separate until outcomes arrive.</p></div><StatusPill label="Model policy" tone="dark" /></div>
      <div className="methodology-layout"><div className="timeline-column"><div className="timeline-header"><div><span className="panel-eyebrow">Derivation timeline</span><h2>From rank inputs to weekly monitoring</h2></div><span className="timeline-count">{String(timeline.length).padStart(2, "0")} stages</span></div>{timeline.map((item, index) => <button type="button" className={cx("timeline-item", index === selectedStage && "timeline-item-active")} key={item.number} onClick={() => setSelectedStage(index)}><span className="timeline-number">{item.number}</span><span className="timeline-line" /><span className="timeline-content"><span className="timeline-tag">{item.tag}</span><strong>{item.title}</strong><small>{item.question}</small></span><ChevronRight size={16} /></button>)}</div><div className="evidence-column"><Panel className="stage-panel" eyebrow={`Stage ${stage.number} · ${stage.tag}`} title={stage.title} action={<button type="button" className="icon-button" aria-label="More stage details"><MoreHorizontal size={18} /></button>}><div className="stage-question"><CircleHelp size={17} /><span>{stage.question}</span></div><div className="stage-sections"><div><span className="stage-label">Method</span><p>{stage.method}</p></div><div><span className="stage-label">Evidence</span><p>{stage.evidence}</p></div><div><span className="stage-label">Decision</span><p>{stage.decision}</p></div></div><div className="stage-source"><Link2 size={14} /><span>Source link</span><code>{stage.source}</code><ArrowUpRight size={14} /></div></Panel><Panel className="ai-evidence-panel" eyebrow="AI-assisted work" title="A correction, recorded" action={<StatusPill label="Summary" tone="blue" />}><div className="ai-evidence-grid"><div className="ai-evidence-block owner"><div className="ai-avatar owner-avatar-small">MS</div><div><span className="stage-label">Owner question</span><p>The owner asked whether future data could be in the earlier forecast.</p></div></div><div className="ai-evidence-block agent"><div className="ai-avatar agent-avatar-small"><Sparkles size={15} /></div><div><span className="stage-label">Implementation work</span><p>Rebuilt the time boundary, added a future-season rejection case, and reran the backtest.</p></div></div><div className="ai-evidence-block checks"><div className="ai-avatar check-avatar-small"><Check size={15} /></div><div><span className="stage-label">Checks</span><p>Every training season now precedes its target season. The earlier result stays discarded.</p></div></div><div className="ai-evidence-block decision"><div className="ai-avatar decision-avatar-small"><ArrowUpRight size={15} /></div><div><span className="stage-label">Resulting decision</span><p>Report the corrected chronology and keep the baseline until a candidate clears its full range checks.</p></div></div></div><Explainer>Summary of a reviewed agent session. It does not claim autonomy, time savings, or a model promotion.</Explainer></Panel></div></div>
      <div className="two-column-grid method-lower-grid"><Panel eyebrow="Tools and data" title="What powers the work"><div className="tools-table"><div className="tools-row tools-head"><span>Group</span><span>Tools or sources</span><span>Role</span></div>{toolRows.map(([group, tools, role]) => <div className="tools-row" key={group}><strong>{group}</strong><span>{tools}</span><span>{role}</span></div>)}</div></Panel><Panel eyebrow="Metric definition" title="Outcome metric v1.0"><div className="metric-definition-card"><div className="metric-definition-value">Version 1.0 <span>approved outcome metric</span></div><div className="metric-definition-rules"><span><CheckCircle2 size={14} /> Metric definition is explicit</span><span><CheckCircle2 size={14} /> Input and output units stay consistent</span><span><CheckCircle2 size={14} /> Version is stored with every result</span></div></div><Explainer>The metric contract is explicit, versioned, and applied before simulation.</Explainer></Panel></div>
      <Panel className="method-source-panel" eyebrow="Public evidence" title="Data boundaries" action={<span className="source-status"><span className="saved-dot" /> Stored output</span>}><div className="source-grid"><div><span>Projection source</span><strong>Week 1 model output</strong><small>Player ranges · Aug 31, 2026</small></div><div><span>Identity match</span><strong>100.0%</strong><small>{demoForecasts.length.toLocaleString()} accepted · 0 unresolved</small></div><div><span>Historical source</span><strong>Not loaded</strong><small>Evaluation waits for completed outcomes</small></div><div><span>Training cutoff</span><strong>Before target season</strong><small>Worker input remains versioned</small></div></div></Panel>
      <div id="methodology-source-map" className="source-map-box"><FileText size={18} /><div><strong>Source map</strong><p>Repository code, session summaries, selected model artifacts, and the Week 1 output define this public preview. Private uploads and session records never enter the bundled output.</p></div><button type="button" className="text-button">View repository links <ArrowUpRight size={14} /></button></div>
    </>
  );
}

const calibrationSeasonOptions = ["All held-out seasons", "2024", "2025"] as const;
const calibrationPositionOptions = ["All positions", "QB", "RB", "WR", "TE"] as const;

function formatCalibrationPercent(value: number, digits = 1) {
  return (value * 100).toFixed(digits) + "%";
}

function formatCalibrationMetric(value: number) {
  return value.toFixed(2);
}

function CalibrationPage() {
  const [seasonFilter, setSeasonFilter] = useState<string>("All held-out seasons");
  const [positionFilter, setPositionFilter] = useState<string>("All positions");

  const filteredBins = useMemo(
    () => selectedCalibrationBins.filter((row) => {
      const matchesSeason = seasonFilter === "All held-out seasons" || row.season === Number(seasonFilter);
      const matchesPosition = positionFilter === "All positions" || row.position === positionFilter;
      return matchesSeason && matchesPosition;
    }),
    [positionFilter, seasonFilter],
  );

  const chartGroups = useMemo(() => {
    const groups = new Map<string, { label: string; rows: Array<(typeof selectedCalibrationBins)[number]> }>();
    filteredBins.forEach((row) => {
      const groupKey = [
        row.position,
        row.model,
        seasonFilter === "All held-out seasons" ? String(row.season) : "selected-season",
      ].join("-");
      const current = groups.get(groupKey);
      if (current) {
        current.rows.push(row);
      } else {
        const labelParts = [
          row.position + " · " + row.model,
          seasonFilter === "All held-out seasons" ? String(row.season) : null,
        ].filter(Boolean);
        groups.set(groupKey, { label: labelParts.join(" · ") || "Selected data", rows: [row] });
      }
    });
    return Array.from(groups.values());
  }, [filteredBins, seasonFilter]);

  const chartMax = useMemo(() => {
    const values = filteredBins.flatMap((row) => [row.predicted, row.observed]);
    return Math.max(30, Math.ceil(Math.max(...values, 0) / 5) * 5);
  }, [filteredBins]);

  const reliabilityOption = useMemo<EChartsOption>(() => ({
    animation: false,
    color: ["#1264A3", "#2E8B73", "#D87945", "#7C5BAA", "#496A81", "#B35C66", "#748C3B", "#A26A38"],
    grid: { left: 52, right: 18, top: 42, bottom: 48, containLabel: true },
    legend: { top: 0, type: "scroll", textStyle: { color: "#50687A", fontSize: 10 } },
    tooltip: { trigger: "item" },
    xAxis: {
      type: "value",
      min: 0,
      max: chartMax,
      name: "Predicted high estimate",
      nameLocation: "middle",
      nameGap: 30,
      nameTextStyle: { color: "#50687A", fontSize: 10 },
      axisLabel: { color: "#73889A", fontSize: 9 },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: chartMax,
      name: "Observed high estimate",
      nameLocation: "middle",
      nameGap: 38,
      nameTextStyle: { color: "#50687A", fontSize: 10 },
      axisLabel: { color: "#73889A", fontSize: 9 },
      splitLine: { lineStyle: { color: "#E8EEF2" } },
    },
    series: [
      {
        name: "Same prediction and result",
        type: "line",
        data: [[0, 0], [chartMax, chartMax]],
        symbol: "none",
        lineStyle: { color: "#A8B7C2", type: "dashed", width: 1.5 },
      },
      ...chartGroups.map((group) => ({
        name: group.label,
        type: "scatter" as const,
        data: group.rows.map((row) => [row.predicted, row.observed, row.n]),
        symbolSize: 10,
        itemStyle: { opacity: 0.88 },
      })),
    ],
  }), [chartGroups, chartMax]);

  const coverageRows = useMemo(
    () => oosSeasonPositionMetrics
      .filter((row) => {
        const matchesSeason = seasonFilter === "All held-out seasons" || row.season === Number(seasonFilter);
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
      data: coverageRows.map((row) => row.position + " · " + (row.selectedModel === "ffsimulator" ? "sim" : "XGB") + " · " + row.season),
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
        name: "Selected coverage",
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
    method: row.selectedModel === "ffsimulator" ? "ffsimulator" : "XGBoost",
  }));

  const chartScope = [
    seasonFilter === "All held-out seasons" ? "2024 and 2025" : seasonFilter,
    positionFilter === "All positions" ? "all positions" : positionFilter,
  ].join(" · ");

  return (
    <>
      <SectionIntro eyebrow="Model calibration" title="How good is the model?" status={<StatusPill label={calibrationModel.status} tone="good" />} action={<StatusPill label="PPR scoring" tone="blue" />}>We tested two prediction methods on QB, RB, WR, and TE. This page shows the best-performing method for each position and how it performed on weeks it did not see during training.</SectionIntro>

      <section className="calibration-model-card">
        <div className="calibration-model-main">
          <div className="calibration-model-heading">
            <div className="model-symbol"><Activity size={21} /></div>
            <div>
              <div className="panel-eyebrow">The short answer</div>
              <h2>Validated PPR model</h2>
              <p>The selected method changes by position. The result below combines the selected methods across all four positions.</p>
            </div>
            <StatusPill label="Held-out results" tone="blue" />
          </div>
          <div className="calibration-model-result">
            <span className="calibration-result-icon"><CheckCircle2 size={17} /></span>
            <div><strong>{formatCalibrationPercent(selectedPortfolioOverall.coverage)} high-score coverage</strong><span>Across {selectedPortfolioOverall.n.toLocaleString()} held-out player-weeks, the actual score stayed at or below the model&apos;s high estimate {formatCalibrationPercent(selectedPortfolioOverall.coverage)} of the time. The goal is 85%.</span></div>
          </div>
        </div>
        <div className="calibration-model-meta">
          <div><span>Held-out seasons</span><strong>{calibrationModel.oosSeasons}</strong></div>
          <div><span>Held-out player-weeks</span><strong>{selectedPortfolioOverall.n.toLocaleString()}</strong></div>
          <div><span>Positions tested</span><strong>QB · RB · WR · TE</strong></div>
          <div><span>Scoring</span><strong>{calibrationModel.scoringFormat}</strong></div>
        </div>
      </section>

      <div className="calibration-model-note"><Info size={15} /><span>{scoringContract.format} scoring: {scoringContract.rules.join(". ")}.</span></div>

      <div className="calibration-summary-grid">
        <MetricCard label="High-score coverage" value={formatCalibrationPercent(selectedPortfolioOverall.coverage)} detail="Goal: 85% of actual scores stay below the ceiling" tone="good" icon={<Target size={17} />} />
        <MetricCard label="Average error" value={formatCalibrationMetric(selectedPortfolioOverall.p85Mae) + " pts"} detail="Average distance from the actual score" tone="neutral" icon={<Activity size={17} />} />
        <MetricCard label="Above-ceiling weeks" value={formatCalibrationPercent(selectedPortfolioOverall.highSideMissRate)} detail="Actual score exceeded the ceiling" tone="warn" icon={<ArrowUpRight size={17} />} />
        <MetricCard label="High-score loss" value={formatCalibrationMetric(selectedPortfolioOverall.pinballLoss)} detail="Lower is better" tone="good" icon={<Gauge size={17} />} />
      </div>

      <div className="two-column-grid calibration-info-grid">
        <Panel eyebrow="What we tested" title="Two methods across four positions">
          <div className="calibration-definition-list">
            <div><span>Method 1</span><strong>ffsimulator</strong><small>Uses earlier-season PPR outcomes to create a low estimate, a middle estimate, and a high estimate.</small></div>
            <div><span>Method 2</span><strong>XGBoost</strong><small>Uses the PPR projection inputs to predict the high estimate directly.</small></div>
          </div>
          <Explainer>We tried both methods on QB, RB, WR, and TE. We selected the method with coverage closest to 85%, then used the lower high-score loss when coverage was close.</Explainer>
        </Panel>
        <Panel eyebrow="How to read the result" title="The high estimate is a ceiling">
          <div className="calibration-definition-list">
            <div><span>Coverage</span><strong>How often actual stays below</strong><small>{formatCalibrationPercent(selectedPortfolioOverall.coverage)} means about 85 of 100 held-out scores stayed at or below the high estimate.</small></div>
            <div><span>Average error</span><strong>Typical distance</strong><small>{formatCalibrationMetric(selectedPortfolioOverall.p85Mae)} PPR points is the average distance between the high estimate and the actual score.</small></div>
          </div>
          <Explainer>These results describe a group of held-out weeks. They do not guarantee the result for one player or one future week.</Explainer>
        </Panel>
      </div>

      <Panel className="calibration-scorecard-panel" eyebrow="Best model by position" title="Which method did best?" action={<span className="calibration-panel-note">85% coverage goal</span>}>
        <DataTable
          data={selectedPositionRows}
          columns={[
            { accessorKey: "position", header: "Position", cell: (info) => <span className="position-chip">{info.getValue<string>()}</span> },
            { accessorKey: "method", header: "Best method", cell: (info) => <strong>{info.getValue<string>()}</strong> },
            { accessorKey: "n", header: "Held-out weeks", cell: (info) => info.getValue<number>().toLocaleString() },
            { accessorKey: "selectedCoverage", header: "Coverage", cell: (info) => <strong>{formatCalibrationPercent(info.getValue<number>())}</strong> },
            { accessorKey: "selectedP85Mae", header: "Average error", cell: (info) => formatCalibrationMetric(info.getValue<number>()) + " pts" },
            { accessorKey: "selectedHighSideMissRate", header: "Above ceiling", cell: (info) => formatCalibrationPercent(info.getValue<number>()) },
            { accessorKey: "selectedPinballLoss", header: "High-score loss", cell: (info) => formatCalibrationMetric(info.getValue<number>()) },
          ]}
        />
        <Explainer>Coverage near 85% is the target. Average error is the average distance from the actual score. High-score loss is the quantile error measure, where lower is better.</Explainer>
      </Panel>

      <div className="calibration-visual-toolbar">
        <div><div className="panel-eyebrow">Held-out evidence</div><strong>Check the result by season or position</strong><span>Both charts show only the selected method for each position.</span></div>
        <div className="calibration-visual-filters">
          <FilterSelect label="Held-out season" value={seasonFilter} options={calibrationSeasonOptions} onChange={setSeasonFilter} compact />
          <FilterSelect label="Position" value={positionFilter} options={calibrationPositionOptions} onChange={setPositionFilter} compact />
        </div>
      </div>

      <div className="calibration-chart-grid calibration-oos-charts">
        <Panel className="calibration-chart-large" eyebrow="Reliability check" title="Do predicted ceilings match actual scores?" action={<span className="calibration-panel-note">{chartScope}</span>}>
          {filteredBins.length ? <EChart option={reliabilityOption} height={330} ariaLabel="Held-out reliability diagram for the selected models" /> : <EmptyState icon={<Database size={22} />} title="No chart data" body="The selected view has no groups with enough rows." />}
          <Explainer>Each dot groups held-out weeks with similar predicted high scores. Dots near the diagonal mean the prediction and the observed high score are similar. Each group has at least {calibrationBinMinimum} weeks.</Explainer>
        </Panel>
        <Panel eyebrow="Coverage check" title="Coverage by position and season" action={<span className="calibration-panel-note">85% target</span>}>
          {coverageRows.length ? <EChart option={coverageOption} height={330} ariaLabel="Held-out high-score coverage for the selected models" /> : <EmptyState icon={<Database size={22} />} title="No coverage data" body="The selected view has no held-out coverage rows." />}
          <Explainer>A bar near the dashed 85% line means the high estimate behaves as intended for that position and season.</Explainer>
        </Panel>
      </div>

      <div className="two-column-grid calibration-policy-grid">
        <Panel eyebrow="Evidence window" title="What this test covers">
          <div className="calibration-data-facts">
            <div><strong>{calibrationModel.oosRows.toLocaleString()}</strong><span>Held-out player-weeks</span></div>
            <div><strong>{calibrationModel.oosSeasons}</strong><span>Test seasons</span></div>
            <div><strong>{calibrationModel.positionModels}</strong><span>Positions</span></div>
          </div>
          <p className="calibration-copy">Each test season used only earlier seasons for model history. The scoring contract is PPR for every result on this page.</p>
          <Explainer>Two seasons provide useful evidence, but they are a short test window. Review the results again as more seasons finish.</Explainer>
        </Panel>
        <Panel eyebrow="Before use" title="Keep the result in context">
          <ul className="calibration-list">
            <li>The model estimates a high score range. It does not predict the exact score.</li>
            <li>Results describe the full held-out group. One player or week can miss by more or less.</li>
            <li>The best method can differ by position. This test selected ffsimulator for QB and XGBoost for RB, WR, and TE.</li>
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
  onUseDemo: () => void;
  onResetUpload: () => void;
  onStartRun: () => void;
  onExport: (scope: "filtered" | "all") => void;
  onSelectPlayer: (row: ForecastRow) => void;
  onOpenOverrides: (row: ForecastRow) => void;
};

function ProjectionPage({ upload, uploadErrors, runState, runId, viewMode, onViewMode, rows, allRows, overrides, search, position, team, sort, teams, onSearch, onPosition, onTeam, onSort, onFile, onUseDemo, onResetUpload, onStartRun, onExport, onSelectPlayer, onOpenOverrides }: ProjectionPageProps) {
  const [detailRow, setDetailRow] = useState<ForecastRow | null>(null);
  const inputId = "projection-csv-input";
  const progress = runState === "Checking upload" ? 20 : runState === "Queued" ? 42 : runState === "Running" ? 72 : runState === "Complete" ? 100 : runState === "Ready" ? 8 : 0;
  const hasCompletedResult = runState === "Complete";
  const statusTone = runState === "Complete" ? "good" : runState === "Failed" ? "warn" : runState === "Ready" ? "blue" : "neutral";
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
      <SectionIntro eyebrow="Projection to sim" title="Turn a projection file into ranges" status={<StatusPill label={runState} tone={statusTone as "good" | "warn" | "neutral" | "blue"} />} action={<div className="action-group"><Button variant="secondary" onClick={onResetUpload} icon={<RotateCcw size={15} />}>Reset upload</Button><Button variant="quiet" icon={<CircleHelp size={15} />}>Input guide</Button></div>}>The baseline run uses fixed artifacts and an outcome pool. Uploads do not train a model. Every run stores its input revision, seed, count, metric definition, and model version.</SectionIntro>
      <div className="projection-workflow-grid"><Panel className="upload-panel" eyebrow="1 · Upload and preview" title="Player outcome projections" action={<StatusPill label={`${upload.accepted.toLocaleString()} accepted`} tone={uploadErrors.length ? "warn" : "good"} />}><div className="upload-dropzone"><div className="upload-icon"><Upload size={20} /></div><div><strong>Drop a CSV here, or browse</strong><span>10 MB maximum · 50,000 rows · QB, RB, WR, TE</span></div><label htmlFor={inputId} className="button button-secondary">Browse file<input id={inputId} type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); event.currentTarget.value = ""; }} /></label></div><button type="button" className="sample-link" onClick={onUseDemo}><Sparkles size={14} /> Use the bundled Week 1 output</button><div className="upload-file-card"><div className="file-icon"><FileText size={17} /></div><div className="file-copy"><strong>{upload.fileName}</strong><span>Loaded {upload.sourceTimestamp === demoUploadReport.sourceTimestamp ? "Aug 31, 2026 at 09:14 ET" : "just now"}</span></div><StatusPill label={uploadErrors.length ? "Needs review" : "Checked"} tone={uploadErrors.length ? "warn" : "good"} /></div><div className="upload-stats"><div><span>Rows</span><strong>{upload.rows.toLocaleString()}</strong></div><div><span>Accepted</span><strong className="text-green">{upload.accepted.toLocaleString()}</strong></div><div><span>Excluded</span><strong className={upload.excluded ? "text-orange" : ""}>{upload.excluded.toLocaleString()}</strong></div><div><span>Unresolved</span><strong className={upload.unresolved ? "text-orange" : ""}>{upload.unresolved.toLocaleString()}</strong></div></div><div className="set-select-row"><FilterSelect label="Projection set" value={upload.sets.find((set) => set.id === upload.selectedSet)?.label ?? upload.selectedSet} options={upload.sets.map((set) => set.label)} onChange={() => undefined} /><span className="set-note"><Info size={13} /> {upload.sets.find((set) => set.id === upload.selectedSet)?.rows ?? upload.rows} rows in selected set</span></div>{upload.sourceOrderUsed ? <Explainer>The file has no explicit rank field. The adapter preserves source order within each position.</Explainer> : null}{uploadErrors.length ? <div className="error-report"><div className="error-report-title"><AlertTriangle size={15} /><strong>Row report</strong><span>{uploadErrors.length} errors</span></div><div className="error-list">{uploadErrors.slice(0, 5).map((error) => <div key={`${error.row}-${error.field}-${error.message}`}><code>Row {error.row || "file"}</code><span><strong>{error.field}</strong> {error.message}</span></div>)}</div>{uploadErrors.length > 5 ? <small>Showing 5 of {uploadErrors.length} errors.</small> : null}</div> : null}</Panel><Panel className="run-panel" eyebrow="2 · Run the baseline" title="Update Floor/Ceiling" action={<span className="run-version">sim-2026.1</span>}><div className="run-model-card"><div className="model-symbol"><Activity size={20} /></div><div><strong>Independent rank-conditioned simulation</strong><span>Complete p15, p50, and p85 range · Baseline</span></div><StatusPill label="Available" tone="good" /></div><div className="run-settings"><div><span>Simulation count</span><strong>1,000 <em>standard</em></strong></div><div><span>Preview count</span><strong>100 <em>preview</em></strong></div><div><span>Seed policy</span><strong>Stored per run</strong></div><div><span>Input checks</span><strong>Pass <Check size={14} className="text-green" /></strong></div></div><div className="run-action"><Button variant="primary" onClick={onStartRun} disabled={runState === "Checking upload" || runState === "Queued" || runState === "Running" || uploadErrors.length > 0 || upload.accepted === 0} className="full-width" icon={runState === "Running" ? <RefreshCcw size={15} className="spin" /> : <Play size={15} />}>{runState === "Complete" ? "Run again" : runState === "Failed" ? "Retry run" : runState === "Running" ? "Simulation running" : "Update Floor/Ceiling"}</Button><span>Repeat clicks return the active job. A changed upload creates a new run.</span></div>{runState !== "Empty" && runState !== "Ready" && runState !== "Complete" ? <div className="run-progress"><div className="run-progress-top"><span>{runState}</span><strong>{progress}%</strong></div><span className="progress-track"><span style={{ width: `${progress}%` }} /></span><small>Job {shortId(runId)} · The page can be refreshed while the worker runs.</small></div> : null}<div className="run-state-row">{runStates.map((state) => <span key={state} className={cx(runState === state && "run-state-active", runState === "Failed" && state === "Failed" && "run-state-failed")}>{runState === state ? <Check size={12} /> : null}{state}</span>)}</div><Explainer>A 100-simulation run is a preview. It cannot become an official forecast.</Explainer></Panel></div>
      <Panel className="forecast-output-panel" eyebrow="3 · Inspect the result" title="Player ranges" action={<div className="panel-actions"><div className="view-toggle"><button type="button" className={viewMode === "original" ? "active" : ""} onClick={() => onViewMode("original")}>Original</button><button type="button" className={viewMode === "adjusted" ? "active" : ""} onClick={() => onViewMode("adjusted")}>Adjusted {Object.keys(overrides).length ? `(${Object.keys(overrides).length})` : ""}</button></div><StatusPill label={`${rows.length} shown`} tone="neutral" /></div>}>{hasCompletedResult ? <><div className="projection-toolbar"><SearchField value={search} onChange={onSearch} placeholder="Search by player or team" /><FilterSelect label="Position" value={position} options={positionOptions} onChange={onPosition} compact /><FilterSelect label="Team" value={team} options={teams} onChange={onTeam} compact /><FilterSelect label="Sort by" value={sort} options={["ceiling", "median", "floor", "name"]} onChange={onSort} compact /><div className="toolbar-spacer" /><div className="download-menu"><Button variant="secondary" icon={<Download size={15} />} onClick={() => onExport("filtered")}>Download filtered ({activeFilteredCount})</Button><Button variant="quiet" onClick={() => onExport("all")}>All {allRows.length}</Button></div></div><div className="range-chart-card"><div className="range-chart-header"><div><strong>Floor to ceiling</strong><span>Showing the first 25 rows · select a player for details</span></div><div className="range-chart-legend"><span><i className="legend-floor" /> Floor</span><span><i className="legend-median" /> Median</span><span><i className="legend-ceiling" /> Ceiling</span></div></div><div className="range-list">{rows.length ? rows.slice(0, 25).map((row) => <ForecastRange key={row.id} row={row} override={viewMode === "adjusted" ? overrides[row.id] : undefined} onSelect={selectPlayer} />) : <EmptyState icon={<Search size={24} />} title="No matching players" body="Change the search or filters to restore rows." />}</div><div className="range-chart-footer"><span>Player count limit: 25 of {rows.length}</span><span>Values display one decimal. Sorting and exports use full precision.</span></div></div><div className="linked-chart-grid"><Panel eyebrow="Median vs ceiling" title="Where is the upside?" className="small-range-panel"><div className="median-ceiling-chart">{rows.slice(0, 12).map((row, index) => { const values = viewMode === "adjusted" ? applyOverride(row, overrides[row.id]) : row.original; return <button type="button" className="median-ceiling-dot" key={row.id} style={{ left: `${Math.min(93, (values.median / 35) * 100)}%`, bottom: `${Math.min(86, (values.ceiling / 40) * 100)}%`, background: ["#1264A3", "#2E8B73", "#D87945", "#7C5BAA"][index % 4] }} onClick={() => selectPlayer(row)} aria-label={`Open ${row.name}`} />; })}<span className="axis-label-x">Median</span><span className="axis-label-y">Ceiling</span></div><Explainer>The dot uses the same player selection as the range chart and table.</Explainer></Panel><Panel eyebrow="Source and range" title="Current output"><div className="output-summary-list"><div><span>Average median</span><strong>{formatNumber(calculateDemoSummary(rows, overrides).averageMedian)}</strong></div><div><span>Average range width</span><strong>{formatNumber(calculateDemoSummary(rows, overrides).averageWidth)}</strong></div><div><span>Model version</span><strong>sim-2026.1</strong></div><div><span>Run ID</span><strong className="mono">{shortId(runId)}</strong></div></div><Explainer>The bar runs from the estimated floor to the ceiling. The dot marks the median. Observed outcomes can fall outside the range.</Explainer></Panel></div><DataTable data={forecastTableRows} columns={columns} onRowClick={selectPlayer} /></> : <EmptyState icon={runState === "Failed" ? <AlertTriangle size={24} /> : <Play size={15} />} title={runState === "Failed" ? "The run needs attention" : runState === "Ready" ? "Ready to run" : "Waiting for a result"} body={runState === "Failed" ? "Read the row report above, correct the input, and retry the same submission." : runState === "Ready" ? "The upload passed the baseline input checks. Start a simulation to create ranges." : "The worker result will appear here when the run completes."} action={runState === "Ready" ? <Button variant="primary" onClick={onStartRun} icon={<Play size={15} />}>Update Floor/Ceiling</Button> : undefined} />}</Panel>
      <div className="projection-footnotes"><span><LockKeyhole size={14} /> Raw source uploads remain private and expire with this temporary workspace.</span><span><Database size={14} /> Results use Outcome metric v1.0 · {runId}</span></div>
      <PlayerDetailDrawer row={detailRow} override={detailRow ? overrides[detailRow.id] : undefined} onClose={() => setDetailRow(null)} onOpenOverrides={() => { if (detailRow) onOpenOverrides(detailRow); setDetailRow(null); }} />
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

type OverridesPageProps = {
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

function OverridesPage({ rows, overrides, history, selectedRow, selectedPlayerId, onSelectRow, onSave, onResetPlayer, onResetAll, onCopy }: OverridesPageProps) {
  const [rosterSearch, setRosterSearch] = useState("");
  const [rosterPosition, setRosterPosition] = useState("All");
  const filteredRows = rows.filter((row) => (!rosterSearch || row.name.toLowerCase().includes(rosterSearch.toLowerCase())) && (rosterPosition === "All" || row.position === rosterPosition));
  return (
    <>
      <SectionIntro eyebrow="Manual overrides" title="Record judgment without rewriting the model" status={<StatusPill label={`${Object.keys(overrides).length} saved`} tone={Object.keys(overrides).length ? "warn" : "neutral"} />} action={<div className="action-group"><Button variant="secondary" onClick={onCopy} icon={<CopyIcon />}>Copy prior overrides</Button><Button variant="quiet" onClick={onResetAll} icon={<RotateCcw size={15} />}>Reset all</Button></div>}>One explicit override layer sits over the selected run. Original simulation values stay intact. Adjusted values flow to the table, range charts, and exports together.</SectionIntro>
      <div className="override-policy-strip"><div><ShieldCheck size={18} /><strong>Original model evaluation stays unchanged</strong><span>Manual adjustments get a separate evaluation view.</span></div><div><LockKeyhole size={18} /><strong>Session-only edits</strong><span>These changes expire with the temporary workspace.</span></div><div><FileText size={18} /><strong>Reason required</strong><span>Every saved revision records why it changed.</span></div></div>
      <div className="override-layout"><Panel className="roster-panel" eyebrow="Selected run · sim-2026.1" title="Players" action={<span className="table-count">{filteredRows.length} shown</span>}><div className="roster-filters"><SearchField value={rosterSearch} onChange={setRosterSearch} placeholder="Find a player" /><FilterSelect label="Position" value={rosterPosition} options={positionOptions} onChange={setRosterPosition} compact /></div><div className="roster-list">{filteredRows.map((row) => { const saved = overrides[row.id]; const adjusted = applyOverride(row, saved); return <button type="button" className={cx("roster-item", selectedPlayerId === row.id && "roster-item-active")} key={row.id} onClick={() => onSelectRow(row)}><span className="roster-avatar">{row.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span><span className="roster-copy"><strong>{row.name}</strong><small>{row.position} · {row.team} vs {row.opponent}</small></span><span className="roster-values"><strong>{formatNumber(adjusted.median)}</strong><small>{saved?.inactive ? "Inactive" : saved ? "Adjusted" : "Original"}</small></span>{saved ? <span className={cx("override-indicator", saved.inactive && "override-indicator-gray")} /> : null}</button>; })}</div><div className="roster-foot"><span>Stable player IDs match overrides.</span><span>Sorted by source rank</span></div></Panel><OverrideEditor row={selectedRow} override={selectedRow ? overrides[selectedRow.id] : undefined} onSave={onSave} onReset={() => selectedRow && onResetPlayer(selectedRow)} /></div>
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
  }), [analystProjection, ceiling, defensePreset, exclude, factor, floor, inactive, median, override?.revision, reason]);

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

  return <Panel className="editor-panel" eyebrow="Adjustment editor" title={row.name} action={<div className="editor-actions"><StatusPill label={override ? `Revision ${override.revision}` : "Original"} tone={override ? "warn" : "neutral"} /><button type="button" className="icon-button" aria-label="More player actions"><MoreHorizontal size={18} /></button></div>}><div className="editor-player-meta"><span className="position-chip">{row.position}</span><strong>{row.team} vs {row.opponent}</strong><span>Source projection {formatNumber(row.sourceProjection)}</span><span className="mono">{row.id}</span></div><div className="value-compare"><div className="value-compare-head"><span>Original simulation</span><span>Adjusted preview</span></div><div className="compare-row"><span><small>Floor</small><strong>{formatNumber(row.original.floor)}</strong></span><ArrowUpRight size={15} /><span className="adjusted-value"><small>Adjusted floor</small><strong>{formatNumber(previewValues.floor)}</strong><em>{delta.floor >= 0 ? "+" : ""}{formatNumber(delta.floor)}</em></span></div><div className="compare-row"><span><small>Median</small><strong>{formatNumber(row.original.median)}</strong></span><ArrowUpRight size={15} /><span className="adjusted-value"><small>Adjusted median</small><strong>{formatNumber(previewValues.median)}</strong><em>{delta.median >= 0 ? "+" : ""}{formatNumber(delta.median)}</em></span></div><div className="compare-row"><span><small>Ceiling</small><strong>{formatNumber(row.original.ceiling)}</strong></span><ArrowUpRight size={15} /><span className="adjusted-value"><small>Adjusted ceiling</small><strong>{formatNumber(previewValues.ceiling)}</strong><em>{delta.ceiling >= 0 ? "+" : ""}{formatNumber(delta.ceiling)}</em></span></div></div><div className="editor-section"><div className="editor-section-heading"><span>Workload preset</span><small>Scales all three values.</small></div><div className="preset-buttons"><button type="button" className={factor === "1" ? "active" : ""} onClick={() => setFactor("1")}>Full <small>1.0</small></button><button type="button" className={factor === "0.5" ? "active" : ""} onClick={() => setFactor("0.5")}>Half <small>0.5</small></button><button type="button" className={factor === "0.25" ? "active" : ""} onClick={() => setFactor("0.25")}>Quarter <small>0.25</small></button><label className="factor-input"><span>Custom</span><input type="number" min="0" max="2" step="0.05" value={factor} onChange={(event) => setFactor(event.target.value)} /><span>×</span></label></div><div className="factor-range"><input type="range" min="0" max="2" step="0.05" value={Number(factor) || 0} onChange={(event) => setFactor(event.target.value)} aria-label="Custom workload factor" /><span>0</span><span>1</span><span>2</span></div></div><div className="editor-section"><div className="editor-section-heading"><span>Special actions</span><small>These apply before direct edits.</small></div><div className="editor-toggles"><Toggle label="Mark inactive" checked={inactive} onChange={setInactive} /><Toggle label="Exclude from export" checked={exclude} onChange={setExclude} /><Toggle label="Legacy defense uplift" checked={defensePreset && Boolean(defenseAvailable)} onChange={(checked) => setDefensePreset(defenseAvailable ? checked : false)} disabled={!defenseAvailable} /></div>{!defenseAvailable ? <small className="field-help">The legacy defense preset is available for DST rows only.</small> : null}<div className="analyst-input"><label>Analyst outcome estimate <input type="number" value={analystProjection} onChange={(event) => setAnalystProjection(event.target.value)} placeholder="Optional" /></label><small>Read-only source projection stays {formatNumber(row.sourceProjection)}. This field only feeds a named manual rule.</small></div></div><div className="editor-section"><div className="editor-section-heading"><span>Direct range edit</span><small>Leave a field empty to keep its calculated value.</small></div><div className="direct-edit-grid"><label>Adjusted floor<input type="number" step="0.01" value={floor} onChange={(event) => setFloor(event.target.value)} disabled={inactive} /></label><label>Adjusted median<input type="number" step="0.01" value={median} onChange={(event) => setMedian(event.target.value)} disabled={inactive} /></label><label>Adjusted ceiling<input type="number" step="0.01" value={ceiling} onChange={(event) => setCeiling(event.target.value)} disabled={inactive} /></label></div>{validationError ? <div className="field-error"><AlertTriangle size={14} /> {validationError}</div> : null}</div><div className="editor-section reason-section"><label className="reason-label">Reason for change <span>Required</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: workload concern from the latest injury report" rows={3} /></label></div><div className="editor-footer"><div>{previewed ? <StatusPill label="Preview updated" tone="good" /> : <span className="save-limit"><Info size={14} /> Original draws and official outcomes stay unchanged.</span>}</div><div className="editor-button-row"><Button variant="quiet" onClick={onReset} icon={<RotateCcw size={14} />}>Reset player</Button><Button variant="secondary" onClick={() => setPreviewed(true)} disabled={Boolean(validationError)} icon={<Eye size={14} />}>Preview changes</Button><Button variant="primary" onClick={handleSave} disabled={!reason.trim() || Boolean(validationError)} icon={<Check size={15} />}>Save overrides</Button></div></div></Panel>;
}
