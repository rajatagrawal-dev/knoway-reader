import { extractPageTextItems } from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";

// Root-dive context: the selected phrase's page plus the page before it, so
// short/ambiguous selections still get real surrounding context without
// extracting the whole document. Never throws — a failed extraction just
// means the dive proceeds with the selection alone.
export async function extractPageContext(
  pdfDocument: PDFDocumentProxy,
  pageNumber: number,
): Promise<string> {
  const pages = pageNumber > 1 ? [pageNumber - 1, pageNumber] : [pageNumber];
  try {
    const extracted = await extractPageTextItems(pdfDocument, { pages });
    return extracted
      .slice()
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .map((page) => page.textItems.map((item) => item.text).join(" "))
      .join("\n\n");
  } catch {
    return "";
  }
}
