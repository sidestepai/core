/**
 * File templates for `sidestep init` — the "perfect sidestep project" distilled
 * to the smallest thing that compiles, deploys, and demonstrates the one
 * contract (frontend paths/types derived from the backend defs).
 *
 * Layout: `xano/` (the sidestep backend) and `frontend/` (the Vite + React app)
 * as peer top-level folders under a single root `package.json`. Vite's root is
 * pinned to `frontend/` (see {@link renderViteConfig}) so `index.html` and the
 * build both live there without npm workspaces.
 *
 * Templates are inlined string builders (not a shipped `templates/` directory)
 * so they are always available at runtime regardless of packaging — the same
 * reason the CLI avoids `__dirname` asset resolution across `npx`/`file:`
 * installs. Each builder takes already-resolved, already-sanitized values.
 */

/** Inputs every template may need. `appName` is a valid npm package name; `coreVersion` is the running CLI's version (or `"unknown"`). */
export interface TemplateVars {
  appName: string;
  coreVersion: string;
}

/**
 * The `@sidestep/core` dependency range for the scaffold's `package.json`. Pins
 * to the running CLI's version so the project matches the tool that created it;
 * falls back to the 3.x line when the version can't be resolved (`"unknown"`).
 */
export function coreDep(coreVersion: string): string {
  return /^\d+\.\d+\.\d+/.test(coreVersion) ? `^${coreVersion}` : "^3.0.0";
}

export function renderPackageJson({ appName, coreVersion }: TemplateVars): string {
  const pkg = {
    name: appName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "tsc --noEmit && vite build",
      preview: "vite preview",
      typecheck: "tsc --noEmit",
      "xano:export": "sidestep export ./xano/index.ts --out workspace.json",
      "xano:deploy": "sidestep sandbox deploy ./xano/index.ts --reset --static ./frontend/dist",
    },
    dependencies: {
      "@sidestep/core": coreDep(coreVersion),
      react: "^19.1.0",
      "react-dom": "^19.1.0",
    },
    devDependencies: {
      "@tailwindcss/vite": "^4.1.5",
      "@types/node": "^20.19.43",
      "@types/react": "^19.1.0",
      "@types/react-dom": "^19.1.0",
      "@vitejs/plugin-react": "^4.3.4",
      tailwindcss: "^4.1.5",
      tsx: "^4.19.2",
      typescript: "^5.9.0",
      vite: "^6.1.0",
    },
    engines: { node: ">=20" },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

export function renderTsconfig(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      isolatedModules: true,
      types: ["node", "vite/client"],
    },
    // Both halves of the project typecheck together: the sidestep backend and
    // the React frontend that derives its types from the backend's defs.
    include: ["xano", "frontend/src"],
  };
  return JSON.stringify(tsconfig, null, 2) + "\n";
}

export function renderViteConfig(): string {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite's root is the frontend/ folder, so index.html and the app live there
// while the sidestep backend sits in xano/ as a peer. The build lands in
// frontend/dist, which \`npm run xano:deploy\` ships as the static frontend.
export default defineConfig({
  root: "frontend",
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173 },
});
`;
}

export function renderIndexHtml({ appName }: TemplateVars): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${appName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

export function renderGitignore(): string {
  return `node_modules/
dist/
workspace.json
.xano/
.env
.env.local
*.local
`;
}

export function renderEnvExample(): string {
  return `# Point the frontend at a deployed Xano backend. Leave unset to run the UI
# with no backend. When you \`npm run xano:deploy\`, the backend URL is injected
# as window.XANO_HOST at runtime instead — no rebuild needed.
VITE_XANO_HOST=https://your-instance.xano.io
`;
}

export function renderReadme({ appName }: TemplateVars): string {
  return `# ${appName}

A [sidestep](https://www.npmjs.com/package/@sidestep/core) project: a Xano
backend authored in TypeScript under [\`xano/\`](xano/), and a React + Vite
frontend under [\`frontend/\`](frontend/) that derives its request paths and
types from the backend defs — so the two can't drift.

## Quick start

\`\`\`bash
npm install
npm run dev          # run the frontend (no backend needed yet)
\`\`\`

Then author your backend in [\`xano/index.ts\`](xano/index.ts) — start with the
walkthrough in [\`xano/EXAMPLE.md\`](xano/EXAMPLE.md).

## Deploy

\`\`\`bash
sidestep login          # once, to authenticate against your Xano account
npm run build           # build the static frontend into frontend/dist
npm run xano:deploy     # ship the backend + static frontend together
\`\`\`

- \`npm run xano:export\` compiles the backend to \`workspace.json\` (don't commit it).
- \`npm run xano:deploy\` deploys the backend and the built frontend to your
  sandbox in one clean step.

## The one contract

[\`frontend/src/lib/api.ts\`](frontend/src/lib/api.ts) imports the sidestep query
defs and derives paths (\`getPath()\`) and request/response types
(\`InferInput\` / \`InferResponse\`) from them. Never hand-type a URL or a request
body — change a def and the frontend types follow.

## Add-ons

sidestep is composable with other \`@sidestep/*\` packages:

- **[\`@sidestep/auth\`](https://www.npmjs.com/package/@sidestep/auth)** — turnkey
  authentication (user/login/signup tables and endpoints). Install it
  (\`npm i @sidestep/auth\`) and register it in \`xano/index.ts\`.
- More \`@sidestep/*\` packages can register onto the same workspace as they
  become available.
`;
}

export function renderXanoIndex({ appName }: TemplateVars): string {
  return `import { workspace } from "@sidestep/core";

/**
 * The ${appName} backend.
 *
 * A workspace is assembled by registering typed objects onto a workspace()
 * instance and default-exporting it. This starter is intentionally empty and
 * already compiles + deploys — add your first table and endpoint below.
 *
 * ── Add your first table + endpoint ─────────────────────────────────────────
 *
 *   import { workspace, table, apiGroup, query, f, input, s, ref } from "@sidestep/core";
 *
 *   const notes = table({
 *     name: "notes",
 *     // \`id\` (int PK) + \`created_at\` (epochms) are auto-injected.
 *     schema: {
 *       body: f.text({ required: true }),
 *     },
 *   });
 *
 *   const api = apiGroup({ name: "notes", canonical: "notes" }); // pin the slug
 *
 *   const createNote = query({
 *     name: "create_note",
 *     verb: "POST",
 *     apiGroup: api,
 *     input: { body: input.text({ required: true }) },
 *     // ...build the stack with the s.* statement helpers...
 *   });
 *
 *   export default workspace("${appName}")
 *     .registerTables([notes])
 *     .registerApiGroups([api])
 *     .registerQueries([createNote]);
 *
 * Discover the exact builders and options from the package's own types and its
 * shipped docs — see \`node_modules/@sidestep/core/llms.txt\` and the .d.ts files.
 * See \`xano/EXAMPLE.md\` for the full walkthrough.
 *
 * ── Optional add-ons ─────────────────────────────────────────────────────────
 * @sidestep/auth registers turnkey auth (user/login/signup) onto this same
 * workspace: \`registerAuth(workspace("${appName}"), { canonical: "authn" })\`
 * returns the instance to chain your own .register*() calls onto. Future
 * @sidestep/* packages register the same way.
 */
export default workspace("${appName}");
`;
}

export function renderXanoExampleMd({ appName }: TemplateVars): string {
  return `# Building your ${appName} backend

The backend lives in [\`index.ts\`](index.ts) and is a single default-exported
\`workspace()\`. You grow it by registering typed objects.

## Learn the library from the library

Everything you need is in the package itself:

- \`node_modules/@sidestep/core/llms.txt\` — the lean, canonical tour of every builder; read this first.
- The published TypeScript types and JSDoc (\`node_modules/@sidestep/core/**/*.d.ts\`).
- \`node_modules/@sidestep/core/manifest.json\` — the exhaustive reference; grep or \`jq\` the one entry you need rather than reading it whole.

Author against those signatures — don't invent an API that isn't there.

## The shape

\`\`\`
xano/
├── index.ts          default export: the workspace registering everything below
├── tables/<name>.ts  a table (name, typed schema, indexes)
├── api/<group>.ts    an API group; pin its canonical slug so paths are stable
└── api/<endpoint>.ts a query: name, verb, apiGroup, typed input, a stack, a response
\`\`\`

## Steps

1. **Define a table** under \`tables/\` with \`table({ name, schema: { ... } })\`.
   \`id\` and \`created_at\` are auto-injected.
2. **Define an API group** with \`apiGroup({ name, canonical })\`. Pinning the
   canonical slug keeps the public path stable and lets \`getPath()\` resolve in
   the browser bundle without a lock file.
3. **Define endpoints** with \`query({ name, verb, apiGroup, input, ... })\`, building
   the logic from the \`s.*\` statement helpers and the expression/column/input/
   reference helpers.
4. **Register everything** in \`index.ts\`:
   \`\`\`ts
   export default workspace("${appName}")
     .registerTables([...])
     .registerApiGroups([...])
     .registerQueries([...]);
   \`\`\`
5. **Compile** with \`npm run xano:export\`, and **deploy** with
   \`npm run xano:deploy\` (after \`sidestep login\`).

## Testing in the sandbox

Event-driven objects **deploy but do not fire in the sandbox**: a scheduled
\`task\`, an \`mcpServer\`, and every trigger (a table insert/update/delete does NOT
run its stack) import cleanly but never execute, and there's no way to fire one
manually. Only synchronously-invoked objects — queries, functions, and the agents
an endpoint calls with \`s.ai.agent.run\` — actually run. To test event-driven
logic, factor its body into a \`defineFunction\` you can also call directly (e.g.
from a query via \`s.function.run\`) and assert against that. See \`llms.txt\` for the
full guidance.

## Wire the frontend

In [\`../frontend/src/lib/api.ts\`](../frontend/src/lib/api.ts), import your query
defs and derive paths and types from them (\`getPath()\`, \`InferInput\`,
\`InferResponse\`) — never hand-type a URL or a request body.
`;
}

export function renderMainTsx(): string {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;
}

export function renderAppTsx({ appName }: TemplateVars): string {
  return `export default function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-8">
      <h1 className="text-3xl font-bold tracking-tight">${appName}</h1>
      <p className="text-lg text-gray-600">
        Your sidestep project is ready. The backend lives in{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">xano/</code> and this
        frontend in{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">frontend/</code>.
      </p>
      <ol className="list-inside list-decimal space-y-2 text-gray-700">
        <li>
          Author your first table + endpoint in{" "}
          <code className="rounded bg-gray-100 px-1.5 py-0.5">xano/index.ts</code>{" "}
          (see <code className="rounded bg-gray-100 px-1.5 py-0.5">xano/EXAMPLE.md</code>).
        </li>
        <li>
          Wire it into the UI from{" "}
          <code className="rounded bg-gray-100 px-1.5 py-0.5">frontend/src/lib/api.ts</code>.
        </li>
        <li>
          Ship it:{" "}
          <code className="rounded bg-gray-100 px-1.5 py-0.5">npm run xano:deploy</code>.
        </li>
      </ol>
    </main>
  );
}
`;
}

export function renderIndexCss(): string {
  return `@import "tailwindcss";
`;
}

export function renderApiTs(): string {
  return `// The one contract: import your sidestep query defs and derive paths and
// request/response *types* from them. Never hand-type a URL or a request body —
// change a def and everything here follows.
//
// This starter has no endpoints yet. Once you add one in xano/, wire it like:
//
//   import { createNoteQuery } from "../../../xano/api/create-note.js";
//   import type { InferInput, InferResponse } from "@sidestep/core";
//
//   export type CreateNoteBody = InferInput<typeof createNoteQuery>;
//   export type Note = InferResponse<typeof createNoteQuery>;
//
//   export async function createNote(body: CreateNoteBody): Promise<Note> {
//     const res = await fetch(XANO_HOST + createNoteQuery.getPath(), {
//       method: createNoteQuery.verb,
//       headers: { "content-type": "application/json" },
//       body: JSON.stringify(body),
//     });
//     if (!res.ok) throw new Error(await res.text());
//     return res.json();
//   }

/**
 * The deployed Xano backend's base URL. Injected as \`window.XANO_HOST\` by
 * \`sidestep sandbox deploy --static\`, or read from \`VITE_XANO_HOST\` in dev.
 * Empty string when neither is set (the UI runs with no backend).
 */
export const XANO_HOST: string =
  (typeof window !== "undefined" && (window as { XANO_HOST?: string }).XANO_HOST) ||
  import.meta.env.VITE_XANO_HOST ||
  "";
`;
}
