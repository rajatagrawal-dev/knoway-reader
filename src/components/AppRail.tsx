import { useState, type ReactNode } from "react";
import { usePopover } from "./usePopover";
import {
  BookA,
  Check,
  Columns2,
  FlaskConical,
  Highlighter,
  Library,
  MessageSquare,
  MessageSquareText,
  Moon,
  Rows3,
  Search,
  SlidersHorizontal,
  SquareDashed,
  StickyNote,
  Sun,
  TextCursor,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { SidebarPanel } from "./Sidebar";
import { STYLE_BUTTONS, type HighlightStyle } from "../highlightStyles";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import type { Theme } from "../theme";
import {
  DEFAULT_EXPERIMENTS,
  EXPERIMENT_GROUPS,
  setExperiments,
  useExperiments,
} from "../deepdive/experiments";
import { DEV_MODE } from "../devMode";

// What a drag or click on the PDF does. Select and Highlight stay on until
// another tool is picked; Area and Sticky note are one-shot — they fall back
// to the previous one as soon as their highlight or note is placed.
export type Tool = "select" | "highlight" | "area" | "note";

// The color and style Highlight mode (and the Area tool) applies without
// showing the selection tip.
export interface HighlightPen {
  color: string;
  style: HighlightStyle;
}

function AnnotationsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h12v18l-6-4-6 4V3z" />
    </svg>
  );
}

function TocIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="14" y2="18" />
    </svg>
  );
}

const ICON_PROPS = { width: 18, height: 18, strokeWidth: 1.6, "aria-hidden": true } as const;

const PANEL_ITEMS: { id: SidebarPanel; label: string; icon: ReactNode }[] = [
  { id: "toc", label: "Table of contents", icon: <TocIcon /> },
  { id: "annotations", label: "Annotations", icon: <AnnotationsIcon /> },
  { id: "glossary", label: "Glossary", icon: <BookA {...ICON_PROPS} /> },
  { id: "search", label: "Search (⌘F)", icon: <Search {...ICON_PROPS} /> },
  { id: "ask", label: "Ask (⌘J)", icon: <MessageSquareText {...ICON_PROPS} /> },
];

export interface ViewSettings {
  zoomLabel: string;
  currentZoomPercent: () => number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onZoomSet: (percent: number) => void;
  minZoomPercent: number;
  maxZoomPercent: number;
  twoPageView: boolean;
  onToggleTwoPageView: () => void;
  continuousScroll: boolean;
  onToggleContinuousScroll: () => void;
  notesCollapsed: boolean;
  onToggleNotesCollapsed: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  // Extra rows at the bottom of the menu (e.g. Export, when enabled).
  footer?: ReactNode;
}

interface AppRailProps {
  onHome: () => void; // back to the library
  // The panel shown in the sidebar, or null (none open, or in Deep Dive).
  activePanel: SidebarPanel | null;
  onSelectPanel: (panel: SidebarPanel) => void;
  tool: Tool;
  // Picking the active Area or Sticky note tool again cancels it.
  onSelectTool: (tool: Tool) => void;
  pen: HighlightPen;
  onPenChange: (pen: HighlightPen) => void;
  view: ViewSettings;
}

export default function AppRail({
  onHome,
  activePanel,
  onSelectPanel,
  tool,
  onSelectTool,
  pen,
  onPenChange,
  view,
}: AppRailProps) {
  return (
    <nav className="app-rail" aria-label="Reader controls">
      <button type="button" className="app-rail-button" onClick={onHome} title="Library" aria-label="Library">
        <Library {...ICON_PROPS} />
      </button>
      <div className="app-rail-divider" role="separator" />
      {PANEL_ITEMS.map(({ id, label, icon }) => (
        <button
          key={id}
          type="button"
          className={`app-rail-button${activePanel === id ? " active" : ""}`}
          onClick={() => onSelectPanel(id)}
          title={label}
          aria-label={label}
          aria-pressed={activePanel === id}
        >
          {icon}
        </button>
      ))}

      <div className="app-rail-divider" role="separator" />

      <div className="app-rail-tools" role="radiogroup" aria-label="Tool">
        <ToolButton
          label="Select text"
          active={tool === "select"}
          onClick={() => onSelectTool("select")}
        >
          <TextCursor {...ICON_PROPS} />
        </ToolButton>
        <HighlightToolButton
          active={tool === "highlight"}
          onActivate={() => onSelectTool("highlight")}
          pen={pen}
          onPenChange={onPenChange}
        />
        <ToolButton
          label="Area highlight (or Alt-drag)"
          active={tool === "area"}
          onClick={() => onSelectTool("area")}
        >
          <SquareDashed {...ICON_PROPS} />
        </ToolButton>
        <ToolButton
          label="Sticky note (or right-click the page)"
          active={tool === "note"}
          onClick={() => onSelectTool("note")}
        >
          <StickyNote {...ICON_PROPS} />
        </ToolButton>
      </div>

      <div className="app-rail-spacer" />

      {DEV_MODE ? <ExperimentsMenu /> : null}
      <ViewMenu view={view} />
    </nav>
  );
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      className={`app-rail-button app-rail-tool${active ? " active" : ""}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-checked={active}
    >
      {children}
    </button>
  );
}

// Picks Highlight mode on the first click; once it's the current tool, a
// click opens its color/style menu instead. The dot shows the current color.
function HighlightToolButton({
  active,
  onActivate,
  pen,
  onPenChange,
}: {
  active: boolean;
  onActivate: () => void;
  pen: HighlightPen;
  onPenChange: (pen: HighlightPen) => void;
}) {
  const popover = usePopover();
  const label = active ? "Highlight: click for color and style" : "Highlight mode";

  return (
    <div className="app-rail-anchor" ref={popover.ref}>
      <button
        type="button"
        role="radio"
        className={`app-rail-button app-rail-tool${active ? " active" : ""}`}
        onClick={() => (active ? popover.setOpen((open) => !open) : onActivate())}
        title={label}
        aria-label={label}
        aria-checked={active}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
      >
        <Highlighter {...ICON_PROPS} />
        <span className="app-rail-pen-dot" style={{ backgroundColor: pen.color }} aria-hidden="true" />
      </button>
      {popover.open ? (
        <div className="rail-popover" role="dialog" aria-label="Highlight color and style">
          <div className="rail-popover-title">Highlight</div>
          <div className="rail-popover-row">
            {STYLE_BUTTONS.map(({ style, title, icon }) => (
              <button
                key={style}
                type="button"
                className={`rail-popover-icon-button${pen.style === style ? " active" : ""}`}
                title={title}
                aria-label={title}
                aria-pressed={pen.style === style}
                onClick={() => onPenChange({ ...pen, style })}
              >
                {icon}
              </button>
            ))}
          </div>
          <div className="rail-popover-row">
            {HIGHLIGHT_COLOR_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                className="rail-popover-swatch"
                style={{ backgroundColor: color }}
                title={HIGHLIGHT_COLOR_NAMES[color] || color}
                aria-label={HIGHLIGHT_COLOR_NAMES[color] || color}
                aria-pressed={pen.color === color}
                onClick={() => onPenChange({ ...pen, color })}
              >
                {pen.color === color ? <Check width={12} height={12} strokeWidth={3} /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Everything about how the document is shown. It stays open while its
// controls are used (e.g. several zoom steps in a row) and closes on a click
// outside it or Escape.
function ViewMenu({ view }: { view: ViewSettings }) {
  const popover = usePopover();
  // Non-null while the zoom readout is being edited as text; holds the raw
  // (possibly invalid/in-progress) input value until it's committed.
  const [zoomEditValue, setZoomEditValue] = useState<string | null>(null);

  const commitZoomEdit = () => {
    const parsed = zoomEditValue === null ? NaN : Number.parseFloat(zoomEditValue);
    if (Number.isFinite(parsed) && parsed > 0) view.onZoomSet(parsed);
    setZoomEditValue(null);
  };

  const label = `View (${view.zoomLabel})`;

  return (
    <div className="app-rail-anchor" ref={popover.ref}>
      <button
        type="button"
        className={`app-rail-button${popover.open ? " active" : ""}`}
        onClick={() => popover.setOpen((open) => !open)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
      >
        <SlidersHorizontal {...ICON_PROPS} />
      </button>
      {popover.open ? (
        <div className="rail-popover rail-popover--bottom view-menu" role="dialog" aria-label="View">
          <div className="rail-popover-title">View</div>

          <div className="view-menu-row">
            <span className="view-menu-label">Zoom</span>
            <div className="view-menu-zoom">
              <button type="button" className="rail-popover-icon-button" onClick={view.onZoomOut} title="Zoom out (⌘−)" aria-label="Zoom out">
                <ZoomOut width={16} height={16} />
              </button>
              {zoomEditValue !== null ? (
                <input
                  type="number"
                  className="view-menu-zoom-input"
                  value={zoomEditValue}
                  min={view.minZoomPercent}
                  max={view.maxZoomPercent}
                  autoFocus
                  aria-label="Zoom percent"
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setZoomEditValue(event.target.value)}
                  onBlur={commitZoomEdit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitZoomEdit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setZoomEditValue(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="view-menu-zoom-value"
                  onClick={() => setZoomEditValue(String(view.currentZoomPercent()))}
                  title="Set zoom level"
                >
                  {view.zoomLabel}
                </button>
              )}
              <button type="button" className="rail-popover-icon-button" onClick={view.onZoomIn} title="Zoom in (⌘+)" aria-label="Zoom in">
                <ZoomIn width={16} height={16} />
              </button>
              <button type="button" className="view-menu-fit" onClick={view.onZoomFit} title="Fit to width (⌘0)">
                Fit
              </button>
            </div>
          </div>

          <div className="rail-popover-separator" />

          <SwitchRow icon={<Columns2 width={16} height={16} />} label="Two-page view" checked={view.twoPageView} onChange={view.onToggleTwoPageView} />
          <SwitchRow icon={<Rows3 width={16} height={16} />} label="Continuous scrolling" checked={view.continuousScroll} onChange={view.onToggleContinuousScroll} />
          <SwitchRow icon={<MessageSquare width={16} height={16} />} label="Collapse sticky notes" checked={view.notesCollapsed} onChange={view.onToggleNotesCollapsed} />

          <div className="rail-popover-separator" />

          <div className="view-menu-row">
            <span className="view-menu-label">Theme</span>
            <div className="view-menu-segmented" role="radiogroup" aria-label="Theme">
              {(["light", "dark"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={view.theme === option}
                  className={view.theme === option ? "active" : ""}
                  onClick={() => {
                    if (view.theme !== option) view.onToggleTheme();
                  }}
                >
                  {option === "light" ? <Sun width={14} height={14} /> : <Moon width={14} height={14} />}
                  {option === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </div>

          {view.footer}
        </div>
      ) : null}
    </div>
  );
}

function SwitchRow({
  icon,
  label,
  checked,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="view-menu-switch-row" onClick={onChange}>
      <span className="view-menu-switch-icon">{icon}</span>
      <span className="view-menu-switch-label">{label}</span>
      <span className={`view-menu-switch${checked ? " on" : ""}`} aria-hidden="true" />
    </button>
  );
}

// Deep Dive experiments (deepdive/experiments.ts): each off by default, so
// the standard dive is what you get until one is switched on here.
function ExperimentsMenu() {
  const popover = usePopover();
  const experiments = useExperiments();
  const onCount = Object.values(experiments).filter(Boolean).length;
  const label = `Deep Dive experiments${onCount ? ` (${onCount} on)` : ""}`;

  return (
    <div className="app-rail-anchor" ref={popover.ref}>
      <button
        type="button"
        className={`app-rail-button${popover.open ? " active" : ""}`}
        onClick={() => popover.setOpen((open) => !open)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
      >
        <FlaskConical {...ICON_PROPS} />
        {onCount ? <span className="app-rail-badge" aria-hidden="true">{onCount}</span> : null}
      </button>
      {popover.open ? (
        <div className="rail-popover rail-popover--bottom view-menu experiments-menu" role="dialog" aria-label="Deep Dive experiments">
          <div className="rail-popover-title">Deep Dive experiments</div>
          <p className="experiments-menu-note">Off by default. Each one works on its own; they apply to the next dive message.</p>
          {EXPERIMENT_GROUPS.map((group) => (
            <div key={group.title} className="experiments-menu-group">
              <div className="experiments-menu-group-title">{group.title}</div>
              {group.items.map((item) => (
                <div key={item.key} title={item.hint}>
                  <SwitchRow
                    icon={null}
                    label={item.label}
                    checked={experiments[item.key]}
                    onChange={() => setExperiments({ [item.key]: !experiments[item.key] })}
                  />
                </div>
              ))}
            </div>
          ))}
          <div className="rail-popover-separator" />
          <div className="experiments-menu-actions">
            <button type="button" className="view-menu-action" onClick={() => setExperiments(Object.fromEntries(Object.keys(DEFAULT_EXPERIMENTS).map((key) => [key, true])))}>
              Turn all on
            </button>
            <button type="button" className="view-menu-action" onClick={() => setExperiments(DEFAULT_EXPERIMENTS)} disabled={onCount === 0}>
              Turn all off
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
