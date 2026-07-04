# Export Zip Feasibility

## Goal

Add a project export feature that downloads the current generated React project as a static site zip.

The export package should contain built HTML, JavaScript, CSS, and locally downloaded image assets, so the user can unzip and deploy the result to a static host.

## Core Judgment

Worth implementing.

The right first version is a static site zip, not a single inline HTML file. A zip keeps the output deployable, debuggable, and close to what normal frontend build tools produce.

## Recommended Scope

First version:

- Export only saved project files.
- Build inside the browser-side WebContainer.
- Read the generated `dist/` directory.
- Download Web Cursor-owned project images.
- Rewrite generated asset URLs to local relative paths.
- Generate and download a zip in the browser.

Out of scope for first version:

- Single-file HTML with inline JS/CSS/images.
- Server-side build execution.
- Fetching arbitrary third-party image URLs.
- Exporting unsaved editor drafts.
- Exporting private user uploads unless they have an explicit export contract.

## Architecture Boundary

Export must stay in the browser orchestration domain.

AI-generated code is untrusted, so Next.js Route Handlers must not run `npm install`, `npm run build`, or any generated project code. The server can provide controlled asset bytes through existing APIs, but build execution belongs in WebContainer.

Relevant domains:

- A domain: Next.js server APIs. Owns DB, Blob reads, and controlled asset endpoints.
- B domain: browser main thread. Owns editor, project orchestration, WebContainer calls, and zip download.
- C domain: iframe preview. Runs the generated app preview.

The export flow should execute from B domain and reuse WebContainer. It should not move generated-code execution into A domain.

## Data Sources

Current project code:

- Source: `project_files`
- Client access path: existing project file loading flow

Generated images:

- Source: `project_assets`
- Public runtime URL shape: `/api/project-assets/:id` or absolute site URL ending in `/api/project-assets/:id`
- Byte endpoint: `app/api/project-assets/[id]/route.ts`

Build output:

- Source: WebContainer filesystem after `npm run build`
- Expected directory: `dist/`

## Proposed User Flow

1. User generates or opens a project.
2. User saves any active editor draft.
3. User clicks `Export`.
4. UI shows export progress:
   - reading files
   - installing dependencies
   - building
   - collecting assets
   - creating zip
5. Browser downloads `web-cursor-export.zip`.

If there are unsaved editor changes, first version should ask the user to save before exporting, or disable export until saved. This keeps exported content aligned with the persisted project contract.

## Proposed Technical Flow

1. Read current project files through the existing project file loader.
2. Mount files into WebContainer.
3. Run:

   ```bash
   npm install
   npm run build
   ```

4. Recursively read `dist/`.
5. Scan text build outputs:
   - `.html`
   - `.css`
   - `.js`
   - `.mjs`
6. Extract project asset URLs matching:
   - `/api/project-assets/:id`
   - `https://<site>/api/project-assets/:id`
7. Fetch each matched asset URL from the browser.
8. Determine file extension from `Content-Type`.
9. Write downloaded images into:

   ```text
   assets/project-assets/<assetId>.<ext>
   ```

10. Rewrite matched URLs in build output to local relative paths.
11. Add all rewritten build files and downloaded assets to a zip.
12. Trigger browser download.

## Zip Shape

Example:

```text
web-cursor-export.zip
├── index.html
├── assets/
│   ├── index-abc123.js
│   ├── index-def456.css
│   └── project-assets/
│       ├── <assetId>.png
│       └── <assetId>.webp
└── ...
```

The zip should preserve the build tool's output structure where possible. Only Web Cursor project image URLs should be rewritten.

## Why Not Download Arbitrary External Images

First version should not fetch arbitrary external image URLs.

Reasons:

- Browser fetch may fail because of CORS.
- A server proxy for arbitrary URLs introduces SSRF risk.
- Unknown external URLs do not have a project-owned export contract.

The safe first version is to support only assets produced or stored by Web Cursor, because those have a known API contract and controlled byte endpoint.

## State Ownership

Export should have its own state owner, likely a hook such as `useProjectExport`.

Suggested states:

```ts
type ExportPhase =
  | "idle"
  | "reading"
  | "installing"
  | "building"
  | "collecting-assets"
  | "zipping"
  | "done"
  | "error";
```

This avoids mixing export progress into preview state. Preview runs a dev server; export builds a static artifact. They share WebContainer infrastructure but are different user actions.

## Expected File Changes

```text
/
├── UPDATE package.json
├── UPDATE lib/webcontainer/runtime.ts
├── NEW    lib/webcontainer/export.ts
├── NEW    hooks/useProjectExport.ts
├── UPDATE components/Workbench.tsx
├── UPDATE components/workbench/WorkbenchTopBar.tsx
├── UPDATE components/common/TopBar.tsx
└── UPDATE messages/zh.json / messages/en.json
```

### `package.json` UPDATE

Add `jszip` for browser-side zip generation.

### `lib/webcontainer/runtime.ts` UPDATE

Expose reusable WebContainer boot/mount/build helpers or factor shared runtime code so preview and export can share the same instance safely.

Important: export should stop or coordinate with the dev server before mounting/building if the same WebContainer instance is reused.

### `lib/webcontainer/export.ts` NEW

Own the pure export workflow:

- mount project files
- run install/build
- read `dist/`
- collect project asset URLs
- download assets
- rewrite URLs
- create zip blob

This module should not know about React UI state.

### `hooks/useProjectExport.ts` NEW

Own UI-facing export state:

- current phase
- error message
- busy flag
- `exportProject(projectId)` action

### `components/Workbench.tsx` UPDATE

Wire the export hook to current project state and file loading.

### `components/workbench/WorkbenchTopBar.tsx` UPDATE

Pass export state and action into the top bar.

### `components/common/TopBar.tsx` UPDATE

Render the export button, disabled state, and progress label.

### `messages/zh.json` / `messages/en.json` UPDATE

Add export UI copy.

## Failure Cases

The UI should expose clear errors for:

- No current project.
- Active file has unsaved changes.
- Project contract is incomplete.
- `npm install` fails.
- `npm run build` fails.
- `dist/` is missing.
- A project asset URL returns 404.
- Zip generation fails.

Errors should be diagnostic. Do not silently skip unknown required assets.

## Validation Plan

Manual validation is enough for the first implementation unless export parsing becomes complex.

Cases:

- Project with no images exports and opens locally.
- Project with one generated image exports with local image path.
- Project with multiple generated images deduplicates asset downloads.
- Project with CSS `background-image` using a project asset exports correctly.
- Build failure shows a readable error and does not download a broken zip.
- Unsaved editor draft is blocked or clearly handled.

## Open Questions

- Should export be enabled only after a successful preview run, or anytime a complete project exists?
- Should exported zip name use project title, project id, or a fixed filename?
- Should first version block on unsaved draft, or auto-save before export?
- Should showcase read-only pages expose export too, or only editable workbench projects?
