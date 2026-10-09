// Dev mode: on under the Vite dev server (`npm run dev`, `tauri dev`), off in
// builds unless built with VITE_DEV_MODE=1. Experimental features (the Deep
// Dive experiments menu) only exist in dev mode. Optional chaining because
// unit tests load this under plain Node, where import.meta.env is undefined.
export const DEV_MODE: boolean = import.meta.env?.DEV === true || import.meta.env?.VITE_DEV_MODE === "1";
