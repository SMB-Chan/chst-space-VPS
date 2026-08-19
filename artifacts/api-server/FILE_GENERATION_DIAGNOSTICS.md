# File generation diagnostics

Run the focused runtime check from the workspace root:

```sh
pnpm --filter @workspace/api-server test:file-generation-diagnostics
```

The command renders PDF, DOCX, XLSX, and PPTX fixtures, renders Japanese PDF
content, exercises layout previews when the tools are available, and prints the
detected prerequisites.

## Runtime prerequisites

- `libreoffice`: converts DOCX/XLSX/PPTX files to PDF for optional layout review.
- `pdftocairo`: converts PDF pages to PNG images for optional layout review.
- A Japanese-capable CJK font discoverable through `fontconfig`: embedded into
  Japanese PDF files.

The Replit environment declares `libreoffice` and the static `ipaexfont` package
in `.replit`. `pdftocairo` is supplied by the runtime.

## Expected log stages

Every file-generation log includes `stage`, `fileFormat`, `conversationId`, and
the request ID when the HTTP request provides one. No prompt, generated content,
base64 payload, image bytes, credential, or database query parameter is logged.

- `file-format-detection`
- `file-model-generation`
- `file-model-output-parsing`
- `file-render-pdf`, `file-render-docx`, `file-render-xlsx`, or `file-render-pptx`
- `layout-preview-prerequisites`
- `layout-preview-office-conversion`
- `layout-preview-pdf-render`
- `layout-review-model`
- `asset-persistence`

Preview and layout-review failures are warnings and do not prevent a successfully
rendered file from being saved. Model generation, document rendering, and asset
persistence failures produce the safe `file_warning` SSE event. Server errors
are represented by an allowlisted type/code/status taxonomy and a stable
fingerprint; arbitrary error messages and stacks are not logged. The two managed
preview commands additionally retain their exit status and sanitized stderr.

## Reproduction outcome

The initial runtime check on 2026-08-19 found:

- `pdftocairo` available.
- `libreoffice` unavailable, so Office layout review was skipped.
- No Japanese-capable font discoverable, so Japanese PDF rendering could fall
  through to Helvetica and fail with a WinAnsi encoding error.

The first CJK package evaluated exposed only a variable TTC collection, which
`pdf-lib` cannot lay out or subset. The narrowly scoped correction therefore
uses the static IPAex TTF package and filters fontconfig discovery to standalone
TTF/OTF files that `pdf-lib` can embed. Malformed model fields are normalized
before format renderers consume them. Missing or invalid `<file_data>` output
remains a safe fallback and is now reported as a distinct parse status.