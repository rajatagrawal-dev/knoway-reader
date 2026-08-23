// Vite must bundle the PDF.js worker; the library's default path does not
// resolve correctly in dev (it points at a non-existent file under node_modules).
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export default pdfWorkerUrl;
