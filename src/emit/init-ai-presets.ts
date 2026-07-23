/**
 * AI-assistant instruction presets for `sidestep init`. One canonical body of
 * sidestep guidance ({@link guidanceBody}) rendered into each tool's format so
 * the three can't drift. Nothing is written unless the user opts into a preset
 * (interactively or via `--ai`).
 *
 * The guidance encodes the "learn the library from the library" rule — author
 * against the package's own types and shipped `llms.txt`, never an invented API.
 */

/** The presets `init` can scaffold, mapped to the file each writes. */
export const AI_PRESETS = ["claude", "codex", "cursor"] as const;
export type AiPreset = (typeof AI_PRESETS)[number];

/** A sentinel line present in every preset's output — asserts the shared body didn't drift. */
export const GUIDANCE_SENTINEL = "Learn the library from the library";

/**
 * The shared guidance body (markdown), rendered into each preset. Written for an
 * AI coding agent working in a freshly scaffolded sidestep project.
 */
export function guidanceBody(): string {
  return `## Working in this sidestep project

This is a [sidestep](https://www.npmjs.com/package/@sidestep/core) project. The
Xano backend is authored in TypeScript under \`xano/\`; the React + Vite frontend
lives under \`frontend/\`. sidestep is an independent, third-party way to drive
Xano from code — not an official Xano tool.

### ${GUIDANCE_SENTINEL}

Everything you need to author the backend is in the package itself:

- \`node_modules/@sidestep/core/llms.txt\` — a compact tour of every builder.
- The published TypeScript types and JSDoc (\`node_modules/@sidestep/core/**/*.d.ts\`).

Author against those signatures. Do **not** invent an API that isn't there — if
the types don't offer something, make your best typed guess from the exported
signatures and note the gap.

### The one contract

\`frontend/src/lib/api.ts\` imports the sidestep query defs and derives request
paths (\`getPath()\`) and request/response types (\`InferInput\` / \`InferResponse\`)
from them. Never hand-type a URL or a request body — change a def and the
frontend types follow.

### Layout

- \`xano/index.ts\` — default-exports the \`workspace()\`, registering tables, API
  groups, and endpoints. Pin each API group's canonical slug so public paths are
  stable and \`getPath()\` resolves in the browser bundle.
- \`xano/EXAMPLE.md\` — the walkthrough for adding your first table + endpoint.
- \`frontend/src/\` — the React app.

### Workflow

- \`npm run dev\` — run the frontend.
- \`npm run typecheck\` / \`npm run build\` — must stay green.
- \`npm run xano:export\` — compile the backend to \`workspace.json\` (never commit it).
- \`sidestep login\` then \`npm run xano:deploy\` — ship the backend + static
  frontend together.

### Add-ons

Other \`@sidestep/*\` packages register onto the same workspace. Notably
\`@sidestep/auth\` provides turnkey authentication (user/login/signup) — install
it and register it in \`xano/index.ts\`. More packages compose the same way.
`;
}

export function renderClaudeMd(appName: string): string {
  return `# ${appName}

${guidanceBody()}`;
}

export function renderAgentsMd(appName: string): string {
  return `# ${appName}

${guidanceBody()}`;
}

export function renderCursorRules(appName: string): string {
  // Cursor project rules are MDC: YAML frontmatter + a markdown body. `alwaysApply`
  // keeps the guidance in context for every request in this project.
  return `---
description: sidestep project conventions for ${appName}
alwaysApply: true
---

${guidanceBody()}`;
}

/** The relative path each preset writes to, from the project root. */
export function presetFilePath(preset: AiPreset): string {
  switch (preset) {
    case "claude":
      return "CLAUDE.md";
    case "codex":
      return "AGENTS.md";
    case "cursor":
      return ".cursor/rules/sidestep.mdc";
  }
}

/** Render a preset's file content. */
export function renderPreset(preset: AiPreset, appName: string): string {
  switch (preset) {
    case "claude":
      return renderClaudeMd(appName);
    case "codex":
      return renderAgentsMd(appName);
    case "cursor":
      return renderCursorRules(appName);
  }
}
