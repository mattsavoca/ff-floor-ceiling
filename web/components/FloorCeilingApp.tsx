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
} from "@/lib/project-data";
import { applyOverride, calculateDemoSummary, clampFactor, formatNumber, validateRange } from "@/lib/metrics";
import type { ForecastRow, OverrideSpec, RangeValues, RunState, TabId, UploadReport, ViewMode } from "@/lib/types";
import type { EChartsOption } from "echarts";

const navItems: Array<{ id: TabId; label: string; description: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", description: "Weekly monitoring", icon: LayoutDashboard },
  { id: "methodology", label: "Methodology", description: "How ranges are derived", icon: GitBranch },
  { id: "calibration", label: "Model check", description: "Compare with past scores", icon: Target },
  { id: "projection", label: "Forecast workflow", description: "Upload and run", icon: Zap },
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
        <div className="sidebar-label">{activeTab === "calibration" ? "Model check" : "Current run"}</div>
        {activeTab === "calibration" ? <div className="sidebar-run-card calibration-sidebar-card"><div className="run-card-top"><span className="run-dot run-dot-good" />Past results<MoreHorizontal size={15} /></div><strong>{calibrationModel.shortName}</strong><span>{calibrationModel.oosRows.toLocaleString()} scores checked</span><span className="sidebar-run-id">2024 · 2025</span></div> : <div className="sidebar-run-card"><div className="run-card-top"><span className={cx("run-dot", runState === "Complete" ? "run-dot-good" : runState === "Failed" ? "run-dot-warn" : "run-dot-blue")} />{runState}<MoreHorizontal size={15} /></div><strong>Week {week} · {season}</strong><span>{upload.accepted.toLocaleString()} accepted rows</span><span className="sidebar-run-id">{shortId(runId)}</span></div>}
        <div className="sidebar-spacer" />
        <div className="sidebar-footer"><div className="owner-row"><span className="owner-avatar">MS</span><span><strong>Matt Savoca</strong><small>Owner workspace</small></span><Settings2 size={16} /></div><div className="privacy-note"><LockKeyhole size={13} /> Temporary data stays in this browser.</div></div>
      </aside>
      {mobileNavOpen ? <button className="nav-scrim" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" /> : null}
      <main className="main-area">
        <header className={cx("topbar", activeTab === "projection" && "projection-topbar")}><div className="mobile-brand"><button type="button" className="menu-button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><span>Floor &amp; Ceiling</span></div><div className="topbar-context"><span className="topbar-kicker">{activeTab === "calibration" ? "Model check" : "Forecast workspace"}</span><span className="topbar-separator">/</span><strong>{activeTab === "calibration" ? calibrationModel.shortName : `${season} · Week ${week}`}</strong></div><div className="topbar-actions"><span className="saved-state"><span className="saved-dot" /> Saved locally</span><button type="button" className="session-button" onClick={() => setSessionMenuOpen((open) => !open)}><span className="session-avatar"><UserRound size={14} /></span><span>{shortId(workspaceId)}</span><ChevronDown size={14} /></button>{sessionMenuOpen ? <div className="session-menu"><div className="session-menu-heading"><span className="session-avatar large"><UserRound size={16} /></span><div><strong>Temporary workspace</strong><span>{shortId(workspaceId)}</span></div></div><div className="session-menu-row"><Clock3 size={15} /><span>Expires {formatRelativeTime(expiresAt)}</span></div><div className="session-menu-row"><ShieldCheck size={15} /><span>Private to this browser</span></div><div className="session-menu-divider" /><Button variant="quiet" onClick={resetWorkspace} icon={<RotateCcw size={15} />}>Reset workspace</Button><p>Download work before the session expires. Lost or expired data cannot be recovered.</p></div> : null}</div></header>
        {activeTab !== "calibration" && activeTab !== "projection" ? <ContextStrip season={season} week={week} metricDefinition={metricDefinition} onSeason={setSeason} onWeek={setWeek} onMetricDefinition={setMetricDefinition} /> : null}
        <div className="page-content">
          {activeTab === "overview" ? <OverviewPage navigate={navigate} /> : null}
          {activeTab === "methodology" ? <MethodologyPage navigate={navigate} /> : null}
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

  return (
    <>
      <SectionIntro eyebrow="Weekly monitoring" title="What is ready for this week?" status={<StatusPill label="Forecast ready" tone="good" />} action={<Button variant="primary" onClick={() => navigate("projection")} icon={<Upload size={16} />}>Open forecast</Button>}>The Week 1 player ranges are ready to review. Accuracy checks start after final player scores are loaded.</SectionIntro>
      <div className="overview-hero-grid">
        <Panel className="latest-panel" eyebrow="Current forecast" title="2026 · Week 1" action={<button type="button" className="icon-button" aria-label="Open forecast details" onClick={() => navigate("projection")}><MoreHorizontal size={18} /></button>}>
          <div className="latest-status"><StatusPill label="Ready to review" tone="good" /><span>{totalRows.toLocaleString()} players loaded</span></div>
          <div className="latest-summary"><strong>Review the range before kickoff.</strong><span>Each player has a low estimate, a middle estimate, and a high estimate.</span></div>
          <div className="latest-detail-grid"><div><span>Low estimate</span><strong>p15</strong><small>Lower end of the range</small></div><div><span>Middle estimate</span><strong>p50</strong><small>Typical result</small></div><div><span>High estimate</span><strong>p85</strong><small>Ceiling for the range</small></div><div><span>Final scores</span><strong>Waiting</strong><small>Needed to check accuracy</small></div></div>
          <div className="latest-foot"><span><Clock3 size={14} /> Forecast saved Aug 31, 2026</span><button type="button" className="text-button" onClick={() => navigate("projection")}>Open forecast <ArrowUpRight size={14} /></button></div>
        </Panel>
        <Panel className="next-forecast-panel" eyebrow="Next step" title="Add final player scores"><div className="forecast-readiness"><div className="readiness-icon"><Clock3 size={22} /></div><div><strong>Accuracy checks are waiting</strong><span>We need a final score for the same player and game.</span></div></div><div className="readiness-list"><div><span>Forecast</span><strong>Ready</strong></div><div><span>Final scores</span><strong>Waiting</strong></div><div><span>Accuracy report</span><strong>After scores load</strong></div></div><Button variant="secondary" onClick={() => navigate("calibration")} className="full-width" icon={<Target size={15} />}>Open evaluation</Button></Panel>
      </div>
      <div className="metric-grid overview-status-grid"><MetricCard label="Forecast" value="Ready" detail="Week 1 player ranges" tone="good" icon={<Users size={17} />} /><MetricCard label="Scoring" value="PPR" detail="1 point per reception" tone="neutral" icon={<Gauge size={17} />} /><MetricCard label="Range" value="3 estimates" detail="Low, middle, and high" tone="neutral" icon={<Target size={17} />} /><MetricCard label="Accuracy check" value="Waiting" detail="Add final player scores" tone="neutral" icon={<Link2 size={17} />} /></div>
      <div className="two-column-grid overview-main-grid">
        <Panel className="chart-panel" eyebrow="Accuracy check" title="Final scores are still needed"><div className="empty-chart-state"><Clock3 size={22} /><strong>Waiting for final scores</strong><span>Load completed player scores to see how often the estimates matched and how far they missed.</span><Button variant="secondary" onClick={() => navigate("calibration")}>Open evaluation</Button></div></Panel>
        <Panel className="inspect-panel" eyebrow="Next actions" title="What should you check?"><div className="inspect-list">{[
          ["Review the player ranges", "Check the low, middle, and high estimates before kickoff.", "Open forecast", "projection"],
          ["Review manual changes", "Saved edits need a reason and stay separate from the original forecast.", "Open overrides", "overrides"],
          ["Load final scores", "Accuracy checks need a completed score for the same player and game.", "Open evaluation", "calibration"],
          ["Check the source file", "The bundled Week 1 file passed the input checks.", "Open methodology", "methodology"],
        ].map(([label, detail, value, tab]) => <button type="button" className="inspect-item" key={label} onClick={() => navigate(tab as TabId)}><span className="inspect-item-icon inspect-good"><CheckCircle2 size={16} /></span><span className="inspect-copy"><strong>{label}</strong><small>{detail}</small></span><span className="inspect-value">{value}</span><ChevronRight size={15} /></button>)}</div><Explainer>These actions help you prepare the weekly forecast. They do not change the stored output.</Explainer></Panel>
      </div>
      <Panel className="input-change-panel" eyebrow="Data status" title="What is in the forecast?" action={<div className="panel-actions"><StatusPill label="Source checked" tone="good" /><button type="button" className="text-button" onClick={() => navigate("projection")}>Open forecast <ArrowUpRight size={14} /></button></div>}><div className="input-summary-grid"><div className="input-summary-item"><div className="input-summary-top"><span>Forecast file</span><strong>Ready</strong></div><MiniBar value={1} color="blue" /><small>Week 1 model output</small></div><div className="input-summary-item"><div className="input-summary-top"><span>Players</span><strong>{totalRows.toLocaleString()}</strong></div><MiniBar value={Math.min(1, totalRows / 300)} color="green" /><small>Player ranges loaded</small></div><div className="input-summary-item"><div className="input-summary-top"><span>Range values</span><strong>3</strong></div><MiniBar value={0.75} color="green" /><small>Low, middle, and high estimates</small></div><div className="input-summary-item"><div className="input-summary-top"><span>Final scores</span><strong>Waiting</strong></div><MiniBar value={0} color="orange" /><small>Needed for accuracy checks</small></div></div><Explainer>The forecast file is ready. Final scores are needed before the site can measure accuracy.</Explainer></Panel>
      <div className="two-column-grid lower-overview-grid"><Panel eyebrow="Forecast by position" title="Which players are included?"><div className="position-breakdown">{positionSummaries.map((row) => <div className="position-line" key={row.position}><span className="position-chip">{row.position}</span><span className="position-name">{row.position === "QB" ? "Quarterback" : row.position === "RB" ? "Running back" : row.position === "WR" ? "Wide receiver" : "Tight end"}</span><span className="position-stat"><strong>{row.rows.toLocaleString()}</strong><small>players</small></span><MiniBar value={row.rows / Math.max(...positionSummaries.map((item) => item.rows))} color={row.position === "QB" ? "orange" : "blue"} /><span className="position-stat"><strong>{formatNumber(row.averageMedian)}</strong><small>middle estimate</small></span></div>)}</div><Explainer>These are forecast rows. They do not measure accuracy.</Explainer></Panel><Panel eyebrow="Before kickoff" title="This week's checklist"><div className="loop-list">{["Load the player forecast", "Check the source", "Review the ranges", "Save manual changes", "Freeze the forecast", "Load final scores", "Compare with final scores"].map((item, index) => <button type="button" className={cx("loop-step", index === 2 && "loop-step-current")} key={item} onClick={() => index < 5 ? navigate(index === 0 ? "projection" : index === 3 ? "overrides" : "projection") : navigate("calibration")}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item}</strong>{index === 2 ? <StatusPill label="Current" tone="blue" /> : <ChevronRight size={14} />}</button>)}</div></Panel></div>
    </>
  );
}


type MethodologyPageProps = { navigate: (tab: TabId) => void };

function MethodologyPage({ navigate }: MethodologyPageProps) {
  const simulationPositions = positionModelSelections.filter((row) => row.selectedModel === "ffsimulator").map((row) => row.position);
  const xgboostPositions = positionModelSelections.filter((row) => row.selectedModel === "XGBoost").map((row) => row.position);
  const selectedSummary = `${simulationPositions.join(" and ")} use ffsimulator. ${xgboostPositions.join(", ")} use XGBoost.`;

  return (
    <>
      <SectionIntro eyebrow="Methodology" title="How each model builds a range" status={<StatusPill label="Two model paths" tone="blue" />} action={<Button variant="secondary" onClick={() => navigate("calibration")} icon={<Target size={15} />}>View model check</Button>}>The site compares a rank-based simulation with a direct XGBoost ceiling model. Both use the same PPR score definition and are tested on player-week results that the model did not see.</SectionIntro>

      <section className="methodology-range-summary" aria-labelledby="methodology-range-title">
        <div className="methodology-range-summary-copy">
          <span className="panel-eyebrow">The output</span>
          <h2 id="methodology-range-title">One weekly score, three markers</h2>
          <p>The published range describes a distribution of possible PPR scores. The floor and ceiling are percentiles, not promises about one player&apos;s result.</p>
        </div>
        <div className="methodology-range-markers">
          <div className="methodology-range-marker methodology-range-marker-floor"><strong>p15</strong><span>Floor</span><small>15th percentile of the simulated score distribution</small></div>
          <div className="methodology-range-marker methodology-range-marker-middle"><strong>p50</strong><span>Middle</span><small>Median score, where half the simulated scores are lower</small></div>
          <div className="methodology-range-marker methodology-range-marker-ceiling"><strong>p85</strong><span>Ceiling</span><small>85th percentile, used for the model comparison</small></div>
        </div>
      </section>

      <div className="methodology-model-grid">
        <article className="methodology-model-card methodology-model-card-simulation">
          <div className="methodology-model-heading">
            <div className="methodology-model-icon methodology-model-icon-simulation"><GitBranch size={21} /></div>
            <div><span className="panel-eyebrow">Path 1 · R</span><h2>ffsimulator rank-conditioned simulation</h2><p>Builds the full range by sampling historical weekly scores for players at nearby ranks.</p></div>
          </div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">Stack</span><div className="methodology-pill-list"><span>R</span><span>fffloorceiling</span><span>ffsimulator</span><span>data.table</span><span>arrow</span><span>nflreadr</span><span>ggplot2</span><span>testthat</span></div></div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">Data used</span><ul className="methodology-data-list"><li>Footballguys Projections Consensus. The source row order within each position becomes the player rank after free-agent rows are removed.</li><li>Historical FantasyPros weekly rank variation. The median standard deviation by position and rank supplies rank uncertainty.</li><li>Prior-season `nflreadr` weekly PPR scores. The history cutoff is strictly before the target season.</li></ul></div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">How one prediction is derived</span><ol className="methodology-step-list"><li><span>01</span><div><strong>Normalize the ranking row</strong><p>Keep the stable player ID, position, team, source rank, and rank uncertainty together.</p></div></li><li><span>02</span><div><strong>Draw a nearby rank</strong><p>For each simulation, sample an integer rank around the expected rank. The backtest uses a normal draw with a standard deviation equal to 0.5 times the mapped rank SD.</p></div></li><li><span>03</span><div><strong>Sample a historical score</strong><p>Use the sampled position and rank to select a weekly PPR outcome from the `ffsimulator` pool. Repeat for every simulation.</p></div></li><li><span>04</span><div><strong>Read the percentiles</strong><p>Take the 15th, 50th, and 85th percentiles of the simulated scores. Those values become p15, p50, and p85.</p></div></li></ol></div>
          <div className="methodology-output-box"><span>Current output</span><strong>Full p15 / p50 / p85 range</strong><small>The backtest uses 1,000 simulations per player-week. The Week 1 FBG snapshot uses 100.</small></div>
        </article>

        <article className="methodology-model-card methodology-model-card-xgboost">
          <div className="methodology-model-heading">
            <div className="methodology-model-icon methodology-model-icon-xgboost"><Activity size={21} /></div>
            <div><span className="panel-eyebrow">Path 2 · Python</span><h2>XGBoost direct p85 model</h2><p>Predicts the ceiling from the projection fields themselves instead of sampling a historical outcome pool.</p></div>
          </div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">Stack</span><div className="methodology-pill-list"><span>Python 3.12</span><span>XGBoost</span><span>pandas</span><span>NumPy</span><span>PyArrow</span><span>SHAP</span><span>matplotlib</span></div></div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">Data used</span><ul className="methodology-data-list"><li>Footballguys weekly Projections Consensus rows from the 2023 through 2025 backtest seasons.</li><li>Rank features such as week, ECR, rank SD, projector count, rank range, consensus rank, and consensus projected score.</li><li>Raw projected passing, rushing, receiving, and fumble statistics, plus one derived PPR projection score.</li><li>Actual weekly PPR points from `nflreadr` are the training label. They never enter the feature columns. The `ffsimulator` output is a comparison baseline, not an XGBoost feature.</li></ul></div>
          <div className="methodology-detail-block"><span className="methodology-detail-label">How one prediction is derived</span><ol className="methodology-step-list"><li><span>01</span><div><strong>Build one player-week row</strong><p>Join the rank summary, raw projection fields, derived PPR projection, and final PPR score for each historical row.</p></div></li><li><span>02</span><div><strong>Fit one model per position</strong><p>Train separate QB, RB, WR, and TE models with XGBoost&apos;s `reg:quantileerror` objective and `quantile_alpha = 0.85`.</p></div></li><li><span>03</span><div><strong>Tune on the latest prior weeks</strong><p>Test 144 bounded parameter settings on weeks 14 through 17 of the latest training season. Choose the setting with the lowest p85 pinball loss, then refit on all earlier seasons.</p></div></li><li><span>04</span><div><strong>Score the next season</strong><p>Pass only pre-kickoff features to the position model. Clamp a negative prediction to zero and store the result as `xgb_p85`.</p></div></li></ol></div>
          <div className="methodology-output-box"><span>Current output</span><strong>Direct p85 ceiling only</strong><small>The current XGBoost artifact does not produce p15 or p50. It cannot claim a complete range on its own.</small></div>
        </article>
      </div>

      <div className="methodology-limit"><Info size={17} /><div><strong>Why the two paths do not produce the same fields</strong><p>`ffsimulator` samples a full score distribution, so it can report a floor, middle, and ceiling. The current XGBoost experiment trains only the 85th-quantile model. A full XGBoost range needs separate p15 and p50 models with the same time-split checks.</p></div></div>

      <Panel className="methodology-contract-panel" eyebrow="Shared contract" title="The rules stay fixed across both paths">
        <div className="methodology-contract-grid"><div><span>Score</span><strong>Weekly PPR points</strong><small>1 point per reception. No tight-end bonus and no receiving first-down points.</small></div><div><span>Range target</span><strong>p15 to p85</strong><small>A nominal 70% interval when the distribution is calibrated.</small></div><div><span>Test seasons</span><strong>{calibrationModel.oosSeasons}</strong><small>Each target season uses earlier seasons for training.</small></div><div><span>Rows checked</span><strong>{calibrationModel.oosRows.toLocaleString()}</strong><small>Matched player-week rows with a forecast and a final score.</small></div><div><span>Future-data rule</span><strong>Train before target</strong><small>Target or future outcomes cannot enter the features or training rows.</small></div></div>
        <Explainer>More simulations reduce random sampling noise in `ffsimulator`. They do not fix a biased outcome pool or prove that the XGBoost ceiling is calibrated.</Explainer>
      </Panel>

      <Panel className="methodology-choice-panel" eyebrow="Model choice" title="Which model is better for future forecasts?" action={<Button variant="secondary" onClick={() => navigate("calibration")} icon={<Target size={15} />}>Open held-out results</Button>}>
        <div className="methodology-choice-layout"><div className="methodology-choice-copy"><p>We choose the ceiling model separately for each position. Both candidates see the same matched player-week rows from 2024 and 2025 after their predictions are frozen.</p><ol className="methodology-choice-rules"><li><strong>Check coverage.</strong> Keep a candidate only when the share of actual scores at or below p85 is within 5 percentage points of the 85% target.</li><li><strong>Compare pinball loss.</strong> Among candidates that pass the coverage guard, choose the lower p85 pinball loss. Lower is better because the loss penalizes misses above the ceiling more heavily.</li><li><strong>Keep diagnostics visible.</strong> p85 MAE, rank Spearman correlation, and the size of the upper-tail miss help review the choice. They do not replace the primary rule.</li></ol></div><div className="methodology-choice-result"><span className="methodology-detail-label">Current position-specific choice</span><strong>{selectedSummary}</strong><p>New completed seasons can change this choice. Until then, the selected model stays fixed for the forward forecast.</p></div></div>
        <div className="methodology-choice-table-wrap"><table className="methodology-choice-table"><caption className="sr-only">Held-out p85 coverage and pinball loss by position</caption><thead><tr><th rowSpan={2}>Position</th><th colSpan={2}>ffsimulator</th><th colSpan={2}>XGBoost</th><th rowSpan={2}>Selected</th></tr><tr><th>Coverage</th><th>Loss</th><th>Coverage</th><th>Loss</th></tr></thead><tbody>{positionModelSelections.map((row) => <tr key={row.position}><th scope="row"><span className="position-chip">{row.position}</span></th><td>{formatCalibrationPercent(row.ffsimulatorCoverage)}</td><td>{formatCalibrationMetric(row.ffsimulatorPinballLoss)}</td><td>{formatCalibrationPercent(row.xgbCoverage)}</td><td>{formatCalibrationMetric(row.xgbPinballLoss)}</td><td><span className={cx("methodology-model-badge", row.selectedModel === "ffsimulator" ? "methodology-model-badge-simulation" : "methodology-model-badge-xgboost")}>{row.selectedModel === "ffsimulator" ? "ffsimulator" : "XGBoost"}</span></td></tr>)}</tbody></table></div>
        <Explainer>Coverage is compared with 85%. Pinball loss is the main error score, and lower is better. The table uses held-out results, not the current Week 1 forecast.</Explainer>
      </Panel>

      <div id="methodology-source-map"><Panel className="methodology-sources-panel" eyebrow="Source map" title="Where to inspect the implementation" action={<span className="source-status"><span className="saved-dot" /> Public evidence</span>}><div className="methodology-source-grid"><div><strong>Ranked simulation</strong><code>R/01_rankings.R</code><code>R/02_ffsimulator.R</code><code>R/03_summaries.R</code><small>Ranking normalization, draws, and percentiles.</small></div><div><strong>Direct XGBoost</strong><code>scripts/08_xgb_p85_projection_experiment.py</code><code>scripts/10_build_calibration_page_data.py</code><small>Feature construction, walk-forward fits, and comparison data.</small></div><div><strong>Historical evidence</strong><code>backtest_fbg_2023_2025/README.md</code><code>outputs/player_backtest_metadata.json</code><code>outputs/xgb_p85_projection/metadata.json</code><small>Source choices, cutoffs, scoring rules, and saved model settings.</small></div></div><Explainer>Private uploads and temporary session records do not enter the published calibration data.</Explainer></Panel></div>
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

function CalibrationPage() {
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

  const chartMax = useMemo(() => {
    const values = filteredBins.flatMap((row) => [row.predicted, row.observed]);
    return Math.max(30, Math.ceil(Math.max(...values, 0) / 5) * 5);
  }, [filteredBins]);

  const reliabilityOption = useMemo<EChartsOption>(() => ({
    animation: false,
    grid: { left: 52, right: 18, top: 42, bottom: 48, containLabel: true },
    legend: { top: 0, type: "scroll", textStyle: { color: "#50687A", fontSize: 10 } },
    tooltip: { trigger: "item" },
    xAxis: {
      type: "value",
      min: 0,
      max: chartMax,
      name: "High estimate",
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
        data: [[0, 0], [chartMax, chartMax]],
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
  }), [chartGroups, chartMax]);

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
      <SectionIntro eyebrow="Model check" title="Do the high estimates match past scores?" status={<StatusPill label="Near target" tone="good" />} action={<StatusPill label="PPR scoring" tone="blue" />}>We compare each high estimate with the final score from past weeks. The target is for about 85 of 100 scores to stay at or below the estimate.</SectionIntro>

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

      <div className="calibration-range-note"><span className="calibration-range-note-icon"><Info size={15} /></span><div><strong>What does the 70% full-range check mean?</strong><span>The low estimate through the high estimate should contain about 70 of 100 final scores.</span><small>The selected mix does not get one full-range score here because the projection model supplies the high estimate only.</small></div></div>

      <div className="two-column-grid calibration-info-grid">
        <Panel eyebrow="Read the range" title="Three estimates, in plain English">
          <div className="calibration-definition-list">
            <div><span>Low estimate, p15</span><strong>Lower end</strong><small>About 15 of 100 final scores are at or below this number.</small></div>
            <div><span>Middle estimate, p50</span><strong>Typical result</strong><small>About half of final scores are at or below this number.</small></div>
            <div><span>High estimate, p85</span><strong>Ceiling</strong><small>About 85 of 100 final scores are at or below this number.</small></div>
            <div><span>Full range, p15 to p85</span><strong>About 70 of 100</strong><small>The low and high estimates together should contain about 70 of 100 final scores.</small></div>
          </div>
          <Explainer>For one player, the final score can fall below the low estimate or above the high estimate.</Explainer>
        </Panel>
        <Panel eyebrow="Method choice" title="The method can change by position">
          <div className="calibration-definition-list">
            <div><span>Quarterback</span><strong>Simulation</strong><small>Uses earlier PPR scores to build the low, middle, and high estimates.</small></div>
            <div><span>Running back, wide receiver, tight end</span><strong>Projection model</strong><small>Uses projection inputs to estimate the high score.</small></div>
          </div>
          <Explainer>We chose the method with the percentage of scores at or below the ceiling closest to 85%. When the percentages were close, we chose the lower miss score.</Explainer>
        </Panel>
      </div>

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
