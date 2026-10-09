import { isTauri } from "@tauri-apps/api/core";

// Desktop-only library actions (the web build has no folder to show).
export const canRevealFiles = isTauri();

// Opens Finder (Explorer, …) at a document's folder in the library, or at the
// library itself.
export async function revealInFileManager(docId?: string): Promise<void> {
  const [{ appDataDir, join }, { revealItemInDir }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-opener"),
  ]);
  const path = docId ? await join(await appDataDir(), "library", docId) : await join(await appDataDir(), "library");
  await revealItemInDir(path);
}

// A web page (e.g. a Google Scholar search) in the system browser — from the
// desktop app via the opener plugin, else a new tab.
export async function openExternal(url: string): Promise<void> {
  if (canRevealFiles) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}
