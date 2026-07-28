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
 * Which kind of project the guidance is written for.
 *
 * `authored` — `init`'s: the agent is about to write the backend.
 * `generated` — `codegen`'s: the backend already exists and `xano/` is
 * machine-written, so an agent that edits it in good faith loses that work on
 * the next pull. This is the highest-leverage place to say so in an AI-first
 * SDK, which is why it is a variant of the shared body rather than a separate
 * document that could drift from it.
 */
export type GuidanceMode = "authored" | "generated";

/**
 * The shared guidance body (markdown), rendered into each preset. Written for an
 * AI coding agent working in a scaffolded sidestep project.
 */
export function guidanceBody(mode: GuidanceMode = "authored"): string {
  if (mode === "generated") return generatedGuidanceBody();
  return `## Working in this sidestep project

This is a [sidestep](https://www.npmjs.com/package/@sidestep/core) project. The
Xano backend is authored in TypeScript under \`xano/\`; the React + Vite frontend
lives under \`frontend/\`. sidestep is an independent, third-party way to drive
Xano from code — not an official Xano tool.

### ${GUIDANCE_SENTINEL}

Everything you need to author the backend is in the package itself:

- \`node_modules/@sidestep/core/llms.txt\` — the lean, canonical tour of every builder; read this first.
- The published TypeScript types and JSDoc (\`node_modules/@sidestep/core/**/*.d.ts\`).
- \`node_modules/@sidestep/core/manifest.json\` — the exhaustive reference (every field schema and filter argument list). Grep or \`jq\` the one entry you need; it is large, so don't read it whole.

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

/**
 * The `codegen` variant: the backend was pulled from a live Xano workspace, so
 * the agent's first job is to read what did not translate, and its standing
 * constraint is that `xano/` is regenerated wholesale.
 */
function generatedGuidanceBody(): string {
  return `## Working in this sidestep project

This is a [sidestep](https://www.npmjs.com/package/@sidestep/core) project whose
Xano backend under \`xano/\` was **pulled from a live workspace** and written as
TypeScript by \`sidestep … codegen\`. The React + Vite frontend under \`frontend/\`
is a starter. sidestep is an independent, third-party way to drive Xano from
code — not an official Xano tool.

### Two rules before you edit anything

- **\`xano/\` is machine-written and disposable.** Re-running \`sidestep … codegen\`
  on this project rewrites that directory wholesale — no merge, no diff, no
  preservation of hand edits. Work you want to keep goes outside \`xano/\`, or
  gets re-applied after each pull. Everything else in the project is yours.
- **Deploying is a full replace** of the target workspace. \`npm run xano:deploy\`
  targets a disposable **ephemeral** environment for exactly that reason. Never
  point a deploy at a workspace holding data anyone cares about.

Read \`xano/README.md\` first: it is the generated record of what did and did not
round-trip on the pull, and it is the only place a decode gap is written down.

### ${GUIDANCE_SENTINEL}

Everything you need is in the package itself:

- \`node_modules/@sidestep/core/llms.txt\` — the lean, canonical tour of every builder; read this first.
- The published TypeScript types and JSDoc (\`node_modules/@sidestep/core/**/*.d.ts\`).
- \`node_modules/@sidestep/core/manifest.json\` — the exhaustive reference (every field schema and filter argument list). Grep or \`jq\` the one entry you need; it is large, so don't read it whole.

Author against those signatures. Do **not** invent an API that isn't there — if
the types don't offer something, make your best typed guess from the exported
signatures and note the gap.

### The one contract

\`frontend/src/lib/api.ts\` derives request paths (\`getPath()\`) and request/response
types (\`InferInput\` / \`InferResponse\`) from the query defs in \`xano/\`. Never
hand-type a URL or a request body. \`npx sidestep paths xano/index.ts\` lists every
endpoint's verb and resolved path.

### Layout

- \`xano/index.ts\` — the barrel: default-exports the \`workspace()\` with every pulled object registered.
- \`xano/_shared.ts\` — tables, and anything referenced from more than one file.
- \`xano/README.md\` — the decode report for this pull.
- \`frontend/src/\` — the React app.

### Workflow

- \`npm run dev\` — run the frontend.
- \`npm run typecheck\` / \`npm run build\` — must stay green.
- \`npm run xano:export\` — compile the backend to \`workspace.json\` (never commit it).
- \`sidestep login\` then \`npm run xano:deploy\` — ship the backend + static frontend to an ephemeral env.

### Add-ons

Other \`@sidestep/*\` packages register onto the same workspace — but a
\`.register*()\` call added to \`xano/index.ts\` is lost on the next pull, so prefer
composing them from a module outside \`xano/\`.
`;
}

export function renderClaudeMd(appName: string, mode: GuidanceMode = "authored"): string {
  return `# ${appName}

${guidanceBody(mode)}`;
}

export function renderAgentsMd(appName: string, mode: GuidanceMode = "authored"): string {
  return `# ${appName}

${guidanceBody(mode)}`;
}

export function renderCursorRules(appName: string, mode: GuidanceMode = "authored"): string {
  // Cursor project rules are MDC: YAML frontmatter + a markdown body. `alwaysApply`
  // keeps the guidance in context for every request in this project.
  return `---
description: sidestep project conventions for ${appName}
alwaysApply: true
---

${guidanceBody(mode)}`;
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
export function renderPreset(
  preset: AiPreset,
  appName: string,
  mode: GuidanceMode = "authored",
): string {
  switch (preset) {
    case "claude":
      return renderClaudeMd(appName, mode);
    case "codex":
      return renderAgentsMd(appName, mode);
    case "cursor":
      return renderCursorRules(appName, mode);
  }
}
