import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Download, FolderOpen, Globe, MoreHorizontal, Plus, Search, Upload } from "lucide-react";
import type { DocumentMeta, LibraryStorage } from "../storage/types";
import {
  continueReading,
  exportNotes,
  filterDocuments,
  importNotes,
  readingProgress,
  sortDocuments,
  type LibrarySort,
} from "./library";
import { importFiles } from "./importFiles";
import { canRevealFiles, revealInFileManager } from "./desktop";
import AddFromUrlDialog from "../web/AddFromUrlDialog";
import { looksLikeUrl } from "../web/url";

// The library: every PDF and EPUB the reader has added, what they were last reading,
// and the way to add more — files, or pages from the web (src/web/). Replaces
// the old single-file upload screen.

const SORT_KEY = "library-sort";
const NOTICE_MS = 7000;

function loadSort(): LibrarySort {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (saved === "opened" || saved === "title" || saved === "added") return saved;
  } catch {
    // Default below.
  }
  return "opened";
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export default function LibraryHome({
  storage,
  onOpen,
}: {
  storage: LibraryStorage;
  onOpen: (meta: DocumentMeta) => void;
}) {
  const [documents, setDocuments] = useState<DocumentMeta[] | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>(loadSort);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // "Add from URL", with the address it opened with; `autoStart` when that
  // came from a paste or a drop rather than the button.
  const [urlDialog, setUrlDialog] = useState<{ url: string; autoStart: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const notesInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const reload = useCallback(async () => {
    const list = await storage.listDocuments().catch(() => []);
    setDocuments(list);
  }, [storage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Covers load after the list, each on its own, once.
  const requestedCovers = useRef(new Set<string>());
  useEffect(() => {
    if (!documents) return;
    for (const doc of documents) {
      if (requestedCovers.current.has(doc.docId)) continue;
      requestedCovers.current.add(doc.docId);
      storage
        .getData<string>(doc.docId, "thumbnail")
        .catch(() => null)
        .then((thumbnail) => setThumbnails((all) => ({ ...all, [doc.docId]: thumbnail })));
    }
  }, [documents, storage]);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      // Not remembered; the sort still applies.
    }
  }, [sort]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // ⌘O adds PDFs and EPUBs from here too.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        fileInputRef.current?.click();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // A web address pasted anywhere on the library (not into a field) adds it.
  useEffect(() => {
    if (urlDialog) return;
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!looksLikeUrl(text)) return;
      event.preventDefault();
      setUrlDialog({ url: text.trim(), autoStart: true });
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [urlDialog]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || importing) return;
    setImporting({ done: 0, total: files.length });
    const result = await importFiles(storage, files, (done, total) => setImporting({ done, total }));
    setImporting(null);
    await reload();
    const parts = [];
    if (result.added.length) parts.push(`Added ${plural(result.added.length, "document")}.`);
    if (result.alreadyThere.length) {
      parts.push(
        result.alreadyThere.length === 1
          ? `“${result.alreadyThere[0].title}” is already in your library.`
          : `${plural(result.alreadyThere.length, "document")} were already in your library.`,
      );
    }
    if (result.failed.length) parts.push(`Couldn't read ${result.failed.join(", ")}.`);
    setNotice(parts.join(" ") || null);
    // A single new document opens right away — that's almost always why it was added.
    if (files.length === 1 && result.added.length === 1) onOpen(result.added[0]);
    else if (files.length === 1 && result.alreadyThere.length === 1 && !result.alreadyThere[0].fileMissing) {
      onOpen(result.alreadyThere[0]);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length === 0) {
      // A link dragged in from a browser.
      const link = (event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#"));
      if (link && looksLikeUrl(link)) setUrlDialog({ url: link, autoStart: true });
      return;
    }
    void addFiles([...event.dataTransfer.files]);
  };

  const exportAllNotes = async () => {
    setMenuOpen(false);
    const backup = await exportNotes(storage);
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `knowbelreader-notes-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(`Exported notes for ${plural(backup.documents.length, "document")}.`);
  };

  const importNotesFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const summary = await importNotes(storage, JSON.parse(await file.text()));
      await reload();
      setNotice(
        `Imported notes for ${plural(summary.documents, "document")}.` +
          (summary.missingFiles ? ` Add ${summary.missingFiles === 1 ? "its file" : "their files"} to open ${plural(summary.missingFiles, "of them")}.` : ""),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't import those notes.");
    }
  };

  const visible = useMemo(
    () => (documents ? sortDocuments(filterDocuments(documents, query), sort) : []),
    [documents, query, sort],
  );
  const recent = useMemo(() => (documents && !query ? continueReading(documents) : []), [documents, query]);

  const cardProps = {
    thumbnails,
    onOpen: (doc: DocumentMeta) => {
      if (doc.fileMissing) {
        setNotice(`Add the file of “${doc.title}” to open it — its notes are already here.`);
        fileInputRef.current?.click();
        return;
      }
      onOpen(doc);
    },
    onRename: async (doc: DocumentMeta, title: string) => {
      await storage.putMeta({ ...doc, title });
      await reload();
    },
    // Confirmed in the card's menu first (window.confirm never shows in the
    // desktop app's webview: it just answers no).
    onRemove: async (doc: DocumentMeta) => {
      try {
        await storage.removeDocument(doc.docId);
      } catch (error) {
        console.error(error);
        setNotice(`Couldn't remove “${doc.title}”${error instanceof Error && error.message ? `: ${error.message}` : "."}`);
      }
      await reload();
    },
  };

  return (
    <div
      className={`library${dragging ? " is-dragging" : ""}`}
      onDragEnter={(event) => {
        const types = [...event.dataTransfer.types];
        if (!types.includes("Files") && !types.includes("text/uri-list")) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="library-header">
        <h1>Knowbel Reader</h1>
        <div className="library-search">
          <Search width={15} height={15} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your library" />
        </div>
        <select className="library-sort" value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
          <option value="opened">Recently opened</option>
          <option value="added">Recently added</option>
          <option value="title">Title</option>
        </select>
        <button type="button" className="library-add" onClick={() => fileInputRef.current?.click()} title="Add PDFs or EPUBs (⌘O)">
          <Plus width={16} height={16} /> Add books
        </button>
        <button
          type="button"
          className="library-add"
          onClick={() => setUrlDialog({ url: "", autoStart: false })}
          title="Add a web page, or a PDF or EPUB from the web (or paste a link anywhere here)"
        >
          <Globe width={16} height={16} /> Add from URL
        </button>
        <div className="library-menu-anchor">
          <button type="button" className="library-icon-button" onClick={() => setMenuOpen((open) => !open)} title="More">
            <MoreHorizontal width={18} height={18} />
          </button>
          {menuOpen ? (
            <Menu onClose={() => setMenuOpen(false)}>
              <button type="button" onClick={() => void exportAllNotes()}>
                <Download width={14} height={14} /> Export all notes
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  notesInputRef.current?.click();
                }}
              >
                <Upload width={14} height={14} /> Import notes…
              </button>
              {canRevealFiles ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void revealInFileManager();
                  }}
                >
                  <FolderOpen width={14} height={14} /> Show library folder
                </button>
              ) : null}
            </Menu>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf,application/epub+zip,.epub"
          multiple
          hidden
          onChange={(event) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <input
          ref={notesInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            void importNotesFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </header>

      {importing ? (
        <p className="library-notice" role="status">
          Adding {importing.total > 1 ? `${Math.min(importing.done + 1, importing.total)} of ${importing.total}` : "your file"}…
        </p>
      ) : notice ? (
        <p className="library-notice" role="status">
          {notice}
        </p>
      ) : null}

      <main className="library-body">
        {documents === null ? null : documents.length === 0 ? (
          <button type="button" className="library-empty" onClick={() => fileInputRef.current?.click()}>
            <Plus width={28} height={28} />
            <span className="library-empty-title">Add your first PDF or EPUB</span>
            <span className="library-empty-hint">
              Drop PDFs or EPUBs anywhere here, or click to choose files. To save a web page, paste its link.
            </span>
          </button>
        ) : (
          <>
            {recent.length ? (
              <section>
                <h2 className="library-section-title">Continue reading</h2>
                <div className="library-recent">
                  {recent.map((doc) => (
                    <DocumentCard key={doc.docId} doc={doc} wide {...cardProps} />
                  ))}
                </div>
              </section>
            ) : null}
            <section>
              <h2 className="library-section-title">
                {query ? `${plural(visible.length, "match")}` : `All documents · ${documents.length}`}
              </h2>
              <div className="library-grid">
                {visible.map((doc) => (
                  <DocumentCard key={doc.docId} doc={doc} {...cardProps} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      {dragging ? (
        <div className="library-drop-overlay" aria-hidden="true">
          Drop PDFs, EPUBs or links to add them
        </div>
      ) : null}

      {urlDialog ? (
        <AddFromUrlDialog
          storage={storage}
          initialUrl={urlDialog.url}
          autoStart={urlDialog.autoStart}
          onClose={() => setUrlDialog(null)}
          onChanged={() => void reload()}
          onOpen={(meta) => {
            setUrlDialog(null);
            onOpen(meta);
          }}
        />
      ) : null}
    </div>
  );
}

function Menu({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Registered after the click that opened the menu has finished.
    const timer = window.setTimeout(() => document.addEventListener("mousedown", handleMouseDown));
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);
  return (
    <div className="library-menu" ref={ref} role="menu">
      {children}
    </div>
  );
}

function DocumentCard({
  doc,
  wide = false,
  thumbnails,
  onOpen,
  onRename,
  onRemove,
}: {
  doc: DocumentMeta;
  wide?: boolean;
  thumbnails: Record<string, string | null>;
  onOpen: (doc: DocumentMeta) => void;
  onRename: (doc: DocumentMeta, title: string) => Promise<void>;
  onRemove: (doc: DocumentMeta) => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setConfirmingRemove(false);
  }, []);
  const thumbnail = thumbnails[doc.docId];
  const progress = readingProgress(doc);

  return (
    <article className={`library-card${wide ? " library-card--wide" : ""}${doc.fileMissing ? " is-missing" : ""}`}>
      <button type="button" className="library-card-open" onClick={() => onOpen(doc)} title={`Open “${doc.title}”`}>
        <span className="library-cover">
          {thumbnail ? <img src={thumbnail} alt="" /> : <span className="library-cover-placeholder">{doc.title.slice(0, 1)}</span>}
        </span>
        <span className="library-card-text">
          {renaming ? null : <span className="library-card-title">{doc.title}</span>}
          {doc.author ? <span className="library-card-author">{doc.author}</span> : null}
          {doc.fileMissing ? (
            <span className="library-card-missing">File not added yet</span>
          ) : progress ? (
            <span className="library-progress" title={progress.label}>
              <span className="library-progress-bar">
                <span style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
              </span>
              <span className="library-progress-label">{progress.label}</span>
            </span>
          ) : doc.pageCount ? (
            <span className="library-progress-label">{doc.pageCount} pages</span>
          ) : null}
        </span>
      </button>
      {renaming ? (
        <input
          className="library-rename"
          defaultValue={doc.title}
          autoFocus
          onBlur={(event) => {
            const title = event.target.value.trim();
            setRenaming(false);
            if (title && title !== doc.title) void onRename(doc, title);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setRenaming(false);
          }}
        />
      ) : null}
      <div className="library-menu-anchor library-card-menu">
        <button type="button" className="library-icon-button" onClick={() => setMenuOpen((open) => !open)} title="More">
          <MoreHorizontal width={16} height={16} />
        </button>
        {menuOpen && confirmingRemove ? (
          <Menu onClose={closeMenu}>
            <p className="library-menu-confirm">
              Remove “{doc.title}”? Its highlights, notes and questions go too.
            </p>
            <div className="library-menu-confirm-actions">
              <button type="button" onClick={closeMenu}>
                Cancel
              </button>
              <button
                type="button"
                className="is-danger"
                autoFocus
                onClick={() => {
                  closeMenu();
                  void onRemove(doc);
                }}
              >
                Remove
              </button>
            </div>
          </Menu>
        ) : menuOpen ? (
          <Menu onClose={closeMenu}>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setRenaming(true);
              }}
            >
              Rename
            </button>
            {canRevealFiles && !doc.fileMissing ? (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void revealInFileManager(doc.docId);
                }}
              >
                Show in Finder
              </button>
            ) : null}
            <button
              type="button"
              className="is-danger"
              onClick={() => setConfirmingRemove(true)}
            >
              Remove from library
            </button>
          </Menu>
        ) : null}
      </div>
    </article>
  );
}
