import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "knowayreader-theme";

// A saved choice wins; otherwise start in dark.
function readInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") {
      return saved;
    }
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return "dark";
}

// data-theme drives the app's own palette (index.css); .rphp-dark switches
// react-pdf-highlighter-plus's tokens (its tokens.css) so its comment panels
// and highlight popovers follow along.
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("rphp-dark", theme === "dark");
}

// Applied once at module load (imported from main.tsx before first render)
// so there's no light-mode flash while React mounts.
applyTheme(readInitialTheme());

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) ?? "dark");

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Non-fatal: the choice just won't persist.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((value) => (value === "dark" ? "light" : "dark")), []);

  return { theme, toggleTheme };
}
