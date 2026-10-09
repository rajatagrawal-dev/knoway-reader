import { useEffect, useId, useState } from "react";

// Draws a diagram answer's Mermaid source. Mermaid is large, so it's loaded
// only the first time a diagram is shown; a diagram that doesn't parse
// shows its source instead.

type MermaidApi = typeof import("mermaid")["default"];
let loading: Promise<MermaidApi> | null = null;
let initializedTheme: string | null = null;

function loadMermaid(theme: "dark" | "default"): Promise<MermaidApi> {
  loading ??= import("mermaid").then((module) => module.default);
  return loading.then((mermaid) => {
    if (initializedTheme !== theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, flowchart: { htmlLabels: false } });
      initializedTheme = theme;
    }
    return mermaid;
  });
}

export default function MermaidDiagram({ code }: { code: string }) {
  const id = `dive-diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "default";
    loadMermaid(theme)
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg: rendered }) => {
        if (!cancelled) {
          setSvg(rendered);
          setFailed(false);
        }
      })
      .catch(() => {
        // Mermaid leaves its error graphic in the page on a parse failure.
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  if (failed) {
    return (
      <figure className="dive-diagram dive-diagram--failed">
        <figcaption>This diagram couldn't be drawn. Its source:</figcaption>
        <pre>{code}</pre>
      </figure>
    );
  }
  if (!svg) return <div className="dive-diagram dive-diagram--loading">Drawing the diagram…</div>;
  // Mermaid's own output, rendered with securityLevel "strict" (labels are
  // escaped, no scripts or click handlers).
  return <figure className="dive-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
