# MuseReader

A simple React + TypeScript app for uploading PDFs and annotating them with [react-pdf-highlighter-plus](https://www.npmjs.com/package/react-pdf-highlighter-plus).

## Features

- Upload a local PDF file
- Select text to highlight and attach a comment
- Hold **Alt** and drag (or toggle **Area highlight**) for rectangular highlights
- Toggle **Sticky note** mode to place editable notes on the PDF
- Sidebar listing all annotations with jump-to and delete
- Annotations persist in `localStorage` per uploaded file
- Export an annotated copy of the PDF

## Setup

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (usually `http://localhost:5173`).

## Usage

1. Click **Choose PDF file** and select a PDF.
2. Select text in the document — a popup lets you add a comment and save the highlight.
3. Use toolbar buttons for area highlights or sticky notes.
4. Click an item in the sidebar to scroll to that annotation.
5. Click **Export PDF** to download a flattened annotated copy.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — type-check and build for production
- `npm run preview` — preview the production build
