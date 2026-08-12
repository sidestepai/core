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

/**
 * The `@sidestep/auth` range for the scaffold. Bundled by default because auth is
 * the add-on nearly every project reaches for, and the scaffold references it in
 * the README + `xano/index.ts` — pre-installing it means the `registerAuth(...)`
 * example works without a separate `npm i`. Independent release cadence from the
 * CLI, so it's a plain pin; bump it here when auth ships a new minor.
 */
const AUTH_DEP = "^0.5.0";

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
      "xano:deploy": "sidestep deploy ./xano/index.ts --static ./frontend/dist",
    },
    dependencies: {
      "@sidestep/core": coreDep(coreVersion),
      "@sidestep/auth": AUTH_DEP,
      // shadcn/ui's runtime surface. `radix-ui` is the unified primitives
      // package current components import (`Slot.Root` powers `asChild`) — not
      // the per-primitive `@radix-ui/react-*` packages, which it superseded.
      // cva types the variants, clsx + tailwind-merge back `cn()`, lucide is
      // the icon set. Pre-installed so `npx shadcn@latest add <component>`
      // works without a separate npm i.
      "class-variance-authority": "^0.7.1",
      clsx: "^2.1.1",
      "lucide-react": "^0.475.0",
      "radix-ui": "^1.6.7",
      react: "^19.1.0",
      "react-dom": "^19.1.0",
      "tailwind-merge": "^3.0.1",
    },
    devDependencies: {
      "@tailwindcss/vite": "^4.1.5",
      "@types/node": "^20.19.43",
      "@types/react": "^19.1.0",
      "@types/react-dom": "^19.1.0",
      "@vitejs/plugin-react": "^4.3.4",
      tailwindcss: "^4.1.5",
      "tw-animate-css": "^1.2.4",
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
      // The `@/*` alias shadcn/ui generates its imports against. It resolves to
      // the frontend source root, so `@/components/ui/button` and `@/lib/utils`
      // work from anywhere in the app. Mirrored in vite.config.ts — both halves
      // are needed (TypeScript resolves types, Vite resolves the bundle).
      baseUrl: ".",
      paths: { "@/*": ["frontend/src/*"] },
    },
    // Both halves of the project typecheck together: the sidestep backend and
    // the React frontend that derives its types from the backend's defs.
    include: ["xano", "frontend/src"],
  };
  return JSON.stringify(tsconfig, null, 2) + "\n";
}

export function renderViteConfig(): string {
  return `import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite's root is the frontend/ folder, so index.html and the app live there
// while the sidestep backend sits in xano/ as a peer. The build lands in
// frontend/dist, which \`npm run xano:deploy\` ships as the static frontend.
export default defineConfig({
  root: "frontend",
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The alias shadcn/ui writes its imports against. Resolved from this file
      // rather than from Vite's root so it points at frontend/src either way.
      // Keep in sync with the \`paths\` entry in tsconfig.json.
      "@": fileURLToPath(new URL("./frontend/src", import.meta.url)),
    },
  },
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
- \`npm run xano:deploy\` deploys the backend and the built frontend to a live
  **ephemeral** environment and prints its URL. Run it again to refresh the same
  environment; if it expired, a fresh one is created and the new URL is called out.
- Deploying to your throwaway singleton sandbox instead: \`sidestep deploy --dest sandbox\`.

## The one contract

[\`frontend/src/lib/api.ts\`](frontend/src/lib/api.ts) imports the sidestep query
defs and derives paths (\`getPath()\`) and request/response types
(\`InferInput\` / \`InferResponse\`) from them. Never hand-type a URL or a request
body — change a def and the frontend types follow.

> To spot-check a def from Node (read \`getPath()\`/\`verb\`, log a value), run a real
> file with \`tsx <file.ts>\` **from inside the project root** — not \`tsx -e\`, not
> bare \`node file.ts\`, and not from another directory (they mis-resolve the
> intra-workspace \`.js\` imports and the \`@sidestep/core\` specifier). Or use
> \`sidestep paths xano/index.ts\` to list every endpoint's verb + path.

## The frontend

React + Vite, styled with [Tailwind CSS](https://tailwindcss.com) v4 and
[shadcn/ui](https://ui.shadcn.com). shadcn is not a dependency — its components
are copied into [\`frontend/src/components/ui/\`](frontend/src/components/ui/) and
owned by this project, so edit them freely. \`Button\` and \`Card\` are already
there; add more with:

\`\`\`bash
npx shadcn@latest add dialog input form
\`\`\`

[\`components.json\`](components.json) is pre-configured, so that works with no
\`shadcn init\` step. Components import through the \`@/\` alias
(\`@/components/ui/button\`, \`@/lib/utils\`), which maps to \`frontend/src/\` in both
\`tsconfig.json\` and \`vite.config.ts\` — change one and change the other.

To rebrand, edit the color tokens at the top of
[\`frontend/src/index.css\`](frontend/src/index.css). Tailwind v4 has no
\`tailwind.config.js\`; the theme lives in that stylesheet.

## Add-ons

sidestep is composable with other \`@sidestep/*\` packages:

- **[\`@sidestep/auth\`](https://www.npmjs.com/package/@sidestep/auth)** — turnkey
  authentication (user/login/signup tables and endpoints). Already installed;
  register it in \`xano/index.ts\` when you want it.
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

## Testing event-driven objects

A scheduled \`task\`, an \`mcpServer\`, and every trigger **fire normally on an
ephemeral** — \`deploy\`'s default destination — so test them by deploying and
letting them run.

Under \`--dest sandbox\` they **deploy but do not fire**: they import cleanly, never
execute, and there's no way to fire one manually (a table insert/update/delete does
NOT run its trigger). Only synchronously-invoked objects — queries, functions, and
the agents an endpoint calls with \`s.ai.agent.run\` — run there. If you must stay on
the sandbox, factor the body into a \`defineFunction\` you can also call directly
(e.g. from a query via \`s.function.run\`) and assert against that. See \`llms.txt\`
for the full guidance.

## Wire the frontend

In [\`../frontend/src/lib/api.ts\`](../frontend/src/lib/api.ts), derive paths and
types from your query defs (\`getPath()\`, \`InferInput\`, \`InferResponse\`) — never
hand-type a URL or a request body.

Keep the client bundle lean (**split route metadata from stack-heavy authoring**):

- \`import type\` for shapes — \`InferInput\`/\`InferResponse\` erase to nothing.
- Import the **one lean query def** for its \`getPath()\`/\`verb\`, never \`xano/index.ts\`
  (that pulls the whole workspace). A def's \`s.*\`/\`c.*\` stack calls run at module
  load to build it, so they can't be tree-shaken out of the bundle.
- A def whose stack builds a heavy graph — an agent + its tools via \`s.ai.agent.run\`
  — drags that whole graph in. For those, don't import the def in the browser:
  declare its \`{ path, verb }\` as plain metadata (see the \`ROUTES\` example in
  \`api.ts\`) and verify it against the compiled bundle with
  \`npx sidestep paths xano/index.ts\`.
`;
}

/** Where a codegen'd tree came from, for the marker and the README. */
export interface CodegenOrigin {
  /** Which command form produced the tree. */
  readonly source: "workspace" | "sandbox" | "ephemeral" | "file";
  /** The workspace id, tenant name, or bundle path — whatever identifies the source. */
  readonly origin: string;
}

/** A human phrase for an origin, used in both the README and the CLI summary. */
export function describeOrigin(o: CodegenOrigin): string {
  switch (o.source) {
    case "workspace":
      return `workspace ${o.origin}`;
    case "sandbox":
      return "the sandbox workspace";
    case "ephemeral":
      return `ephemeral "${o.origin}"`;
    case "file":
      return `the bundle at ${o.origin}`;
  }
}

/**
 * The provenance marker a codegen'd project carries.
 *
 * Two jobs: it records where the tree came from, and its presence is what lets a
 * re-run refresh `xano/` without `--force` (see `scaffold.ts`). It lives inside
 * `xano/` so the delete-and-rewrite branch is self-cleaning — no marker is ever
 * left pointing at a directory that no longer matches it.
 */
export function renderCodegenMarker(
  { coreVersion }: TemplateVars,
  origin: CodegenOrigin,
  generatedAt: string,
): string {
  return (
    JSON.stringify(
      {
        source: origin.source,
        origin: origin.origin,
        coreVersion,
        generatedAt,
        note: "Written by `sidestep … codegen`. Its presence lets a re-run refresh xano/ in place.",
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * The root README for a pulled project.
 *
 * `init`'s README addresses someone about to author a backend; this one
 * addresses someone who already has one and just pulled it. The warnings are
 * unconditional and rescoped: it is **`xano/`** that regenerating destroys, not
 * the project around it.
 */
export function renderCodegenReadme(
  { appName }: TemplateVars,
  origin: CodegenOrigin,
  envNames: readonly string[],
): string {
  const secrets =
    envNames.length === 0
      ? ""
      : `
## Heads up: this tree contains your workspace env var values

The pull carried ${envNames.length} workspace env var${envNames.length === 1 ? "" : "s"} —
${envNames.map((n) => `\`${n}\``).join(", ")} — **with their values**, inline in
[\`xano/index.ts\`](xano/index.ts), because that is what a deploy has to send. If any of them
is a secret, do not commit \`xano/\` as-is: add it to \`.gitignore\`, or replace the values
before committing.
`;

  return `# ${appName}

A [sidestep](https://www.npmjs.com/package/@sidestep/core) project pulled from
${describeOrigin(origin)}. The Xano backend lives in [\`xano/\`](xano/) as readable
TypeScript; the React + Vite frontend under [\`frontend/\`](frontend/) is a starter —
the pull carries a backend, not a UI.

## Deploy it

\`\`\`bash
sidestep login          # once, to authenticate against your Xano account
npm run build           # typecheck the backend + build the static frontend
npm run xano:deploy     # ship both to a live ephemeral environment
\`\`\`

## Read this before deploying

- **\`xano/\` is disposable.** Re-running \`sidestep … codegen\` on this directory
  rewrites it wholesale — no merge, no diff, no preservation of hand edits. The rest of
  the project (this README, \`package.json\`, \`frontend/\`) is yours and is left alone.
- **Deploying is a full replace.** The import path clears the target workspace and
  re-imports. Send this only to an **ephemeral or sandbox** environment — never to a
  workspace holding data you care about. That is why \`npm run xano:deploy\` targets an
  ephemeral env and there is no deploy-to-your-real-workspace command.
- **This is schema only.** Table rows are not carried, and neither are payload sections
  this SDK models no kind for. A deploy recreates the structure, not the data.

[\`xano/README.md\`](xano/README.md) is the authoritative record of what did and did not
translate cleanly on this pull. Read it before trusting the tree.
${secrets}
## Working on it

\`\`\`bash
npm run dev            # run the starter frontend
npm run typecheck      # the whole project, both halves
npm run xano:export    # compile the backend to workspace.json (don't commit it)
npx sidestep paths xano/index.ts   # list every endpoint's verb + path
\`\`\`

[\`frontend/src/lib/api.ts\`](frontend/src/lib/api.ts) shows the one contract: derive
request paths and types from the query defs in \`xano/\` rather than hand-typing a URL.
`;
}

/**
 * A `<code>` styled with the shadcn token palette, shared by both landing pages
 * so the two can't drift on the one bit of inline styling they both need.
 */
const CODE_CLASS = "bg-muted rounded px-1.5 py-0.5 font-mono text-sm";

/** The landing page for a pulled project — it has a backend already, not a blank one. */
export function renderCodegenAppTsx({ appName }: TemplateVars, origin: CodegenOrigin): string {
  return `import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-3xl tracking-tight">${appName}</CardTitle>
          <CardDescription className="text-base">
            This project was pulled from ${describeOrigin(origin)}. The backend lives in{" "}
            <code className="${CODE_CLASS}">xano/</code> as readable TypeScript; this
            frontend is a starter.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="text-muted-foreground list-inside list-decimal space-y-2">
            <li>
              Read <code className="${CODE_CLASS}">xano/README.md</code> — what did and
              did not translate cleanly on the pull.
            </li>
            <li>
              List the endpoints:{" "}
              <code className="${CODE_CLASS}">npx sidestep paths xano/index.ts</code>, then
              wire them up in{" "}
              <code className="${CODE_CLASS}">frontend/src/lib/api.ts</code>.
            </li>
            <li>
              Ship it: <code className="${CODE_CLASS}">npm run xano:deploy</code> (a full
              replace of an ephemeral env).
            </li>
          </ol>
        </CardContent>
        <CardFooter>
          {/* asChild renders the Button's styles onto the anchor. Components come
              from shadcn/ui — add more with \`npx shadcn@latest add <name>\`. */}
          <Button asChild>
            <a href="https://ui.shadcn.com/docs/components" target="_blank" rel="noreferrer">
              Browse UI components <ArrowRight />
            </a>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
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
  return `import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-3xl tracking-tight">${appName}</CardTitle>
          <CardDescription className="text-base">
            Your sidestep project is ready. The backend lives in{" "}
            <code className="${CODE_CLASS}">xano/</code> and this frontend in{" "}
            <code className="${CODE_CLASS}">frontend/</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="text-muted-foreground list-inside list-decimal space-y-2">
            <li>
              Author your first table + endpoint in{" "}
              <code className="${CODE_CLASS}">xano/index.ts</code> (see{" "}
              <code className="${CODE_CLASS}">xano/EXAMPLE.md</code>).
            </li>
            <li>
              Wire it into the UI from{" "}
              <code className="${CODE_CLASS}">frontend/src/lib/api.ts</code>.
            </li>
            <li>
              Ship it: <code className="${CODE_CLASS}">npm run xano:deploy</code>.
            </li>
          </ol>
        </CardContent>
        <CardFooter>
          {/* asChild renders the Button's styles onto the anchor. Components come
              from shadcn/ui — add more with \`npx shadcn@latest add <name>\`. */}
          <Button asChild>
            <a href="https://ui.shadcn.com/docs/components" target="_blank" rel="noreferrer">
              Browse UI components <ArrowRight />
            </a>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
`;
}

/**
 * The frontend stylesheet: Tailwind v4 plus the shadcn/ui theme layer.
 *
 * shadcn/ui components are Tailwind classes over a fixed set of semantic color
 * tokens (`bg-primary`, `text-muted-foreground`, `border-input`, …). Those
 * tokens are declared here as CSS custom properties — light on `:root`, dark
 * under `.dark` — and mapped into Tailwind's theme with `@theme inline`, which
 * is how v4 replaces the v3 `tailwind.config.js`. Every component the shadcn CLI
 * adds later resolves against this same block, so it is the one file to edit
 * when rebranding.
 */
export function renderIndexCss(): string {
  return `@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

/* Map the tokens below into Tailwind's theme so \`bg-primary\` and friends
   resolve. Tailwind v4 does this in CSS; there is no tailwind.config.js. */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

/* Rebrand here: these are the only colors the components know about. */
:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
}

/* Applied by adding \`class="dark"\` to <html> — wire that to a toggle if you
   want one; the scaffold ships light-only. */
.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
`;
}

/**
 * `components.json` — the shadcn/ui CLI's config, read by
 * `npx shadcn@latest add <component>` to decide where files land and which
 * variant to write. Present in the scaffold so the CLI needs no `init` run:
 * paths point at this project's `frontend/` layout, and the aliases match the
 * `@/*` mapping in `tsconfig.json` + `vite.config.ts`.
 */
export function renderComponentsJson(): string {
  const config = {
    $schema: "https://ui.shadcn.com/schema.json",
    style: "new-york",
    rsc: false,
    tsx: true,
    tailwind: {
      // v4 has no config file; the theme lives in the stylesheet.
      config: "",
      css: "frontend/src/index.css",
      baseColor: "neutral",
      cssVariables: true,
      prefix: "",
    },
    aliases: {
      components: "@/components",
      utils: "@/lib/utils",
      ui: "@/components/ui",
      lib: "@/lib",
      hooks: "@/hooks",
    },
    iconLibrary: "lucide",
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * `cn()` — the class merger every shadcn/ui component imports. `clsx` resolves
 * conditionals; `tailwind-merge` then drops earlier Tailwind classes that a
 * later one overrides, so a caller's `className` always wins over a component's
 * defaults instead of colliding with them.
 */
export function renderCnUtil(): string {
  return `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;
}

/**
 * `components/ui/button.tsx` — verbatim shadcn/ui (new-york).
 *
 * shadcn is not a dependency: components are *copied in* and owned by the
 * project. This is the file the CLI would write, so \`npx shadcn@latest add
 * button\` overwrites it with an equivalent one rather than conflicting.
 */
export function renderButtonTsx(): string {
  return `import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
`;
}

/** \`components/ui/card.tsx\` — verbatim shadcn/ui (new-york). See {@link renderButtonTsx}. */
export function renderCardTsx(): string {
  return `import * as React from "react"

import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
`;
}

export function renderApiTs(): string {
  return `// The one contract: derive paths and request/response *types* from your sidestep
// query defs. Never hand-type a URL or a request body — change a def and
// everything here follows.
//
// Keep the client bundle lean (the split-route-metadata rule):
//   • \`import type\` for shapes — InferInput/InferResponse erase to nothing.
//   • Import the ONE lean query def module for its getPath()/verb — never
//     ../../../xano/index.js (that pulls the whole workspace) and never a def
//     whose stack builds a heavy graph (an agent + its tools via s.ai.agent.run):
//     those s.*/c.* factory calls run at module load and can't be tree-shaken out.
//   • For such a stack-heavy endpoint, don't import its def in the browser at all —
//     declare its { path, verb } in the ROUTES table below and verify it against
//     the compiled bundle with \`npx sidestep paths xano/index.ts\`.
//
// This starter has no endpoints yet. Once you add one in xano/, wire it like:
//
//   // Types are free — always import them type-only.
//   import type { InferInput, InferResponse } from "@sidestep/core";
//   import type { createNoteQuery } from "../../../xano/api/create-note.js";
//
//   // Runtime path/verb: import the lean def value, OR (for a stack-heavy def)
//   // read it from ROUTES so the def never enters the bundle.
//   import { createNoteQuery } from "../../../xano/api/create-note.js";
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
//
// The stack-heavy escape hatch — plain metadata, no def import, no bundle cost.
// Keep it in sync with \`npx sidestep paths xano/index.ts\` (it prints verb + path):
//
//   export const ROUTES = {
//     triageRequest: { path: "/api:notes/triage_request", verb: "POST" },
//   } as const;

/**
 * The deployed Xano backend's base URL. Injected as \`window.XANO_HOST\` by
 * \`sidestep deploy --static\`, or read from \`VITE_XANO_HOST\` in dev.
 * Empty string when neither is set (the UI runs with no backend).
 */
export const XANO_HOST: string =
  (typeof window !== "undefined" && (window as { XANO_HOST?: string }).XANO_HOST) ||
  import.meta.env.VITE_XANO_HOST ||
  "";
`;
}
