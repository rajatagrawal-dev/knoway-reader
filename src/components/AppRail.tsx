import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookA,
  Check,
  Columns2,
  Highlighter,
  MessageSquare,
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
];

// A rail button's floating menu: closes on a click outside it or on Escape.
// Escape is caught in the capture phase and stopped there, so closing the
// menu doesn't also reach App's own Escape handling (which would drop the
// current tool back to Select).
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The zoom input handles its own Escape (cancel the edit, keep the menu).
      if (event.target instanceof HTMLInputElement && ref.current?.contains(event.target)) return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  return { open, setOpen, ref };
}

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
