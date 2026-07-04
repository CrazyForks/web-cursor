# Backend Sandbox

> Status: design note, not current implementation.
> Last reviewed: 2026-07-03. Pricing and free quotas change frequently; verify provider pages before implementation.

## 1. Problem

Web Cursor currently runs generated React projects in the browser-side WebContainer and shows the result in an iframe. That keeps untrusted generated code out of the Next.js backend.

If we add a backend sandbox, the goal is not to let the Next.js Route Handler execute generated code. The goal is to add a separate execution domain that can run install/build/browser checks and return structured tool results to the agent loop.

```text
A. LLM proxy domain
   Next.js Route Handlers on Vercel.
   Owns API keys, DB, Blob, and LLM calls.

B. Orchestration domain
   Browser Client Components.
   Owns editor, chat UI, preview state, and agent orchestration.

C. Preview domain
   iframe / WebContainer preview.
   Displays and captures generated app runtime results.

D. Backend sandbox domain
   Vercel Sandbox or external worker.
   Runs untrusted generated code in an isolated environment.
```

The hard boundary is:

```text
Generated code must never run inside the Next.js application process.
```

## 2. Recommended First Version

Because the app is deployed on Vercel, the first backend sandbox should use Vercel Sandbox rather than a self-hosted Docker worker.

Minimal flow:

```text
POST /api/sandbox-runs
  -> validate owner and project access
  -> read project_files from DB
  -> create Vercel Sandbox
  -> write files into sandbox
  -> npm install
  -> npm run build
  -> optionally run Playwright validation
  -> stop sandbox
  -> return SandboxRunResult
```

Keep the first version one-shot:

```text
build once -> validate once -> return result
```

Do not start with a long-lived proxied dev server. It adds container lifecycle, port proxying, websocket, HMR, cleanup, and quota complexity before the core self-repair loop needs it.

## 3. Sandbox Result Contract

Use explicit result kinds. Do not collapse unknown structures into a guessed business enum.

```ts
export const SANDBOX_RESULT_KIND = {
  RenderOk: "render_ok",
  InstallError: "install_error",
  BuildError: "build_error",
  DevServerError: "dev_server_error",
  BrowserRuntimeError: "browser_runtime_error",
  RenderTimeout: "render_timeout",
  SandboxInternalError: "sandbox_internal_error",
} as const;

export type SandboxConsoleEvent = {
  level: "log" | "info" | "warn" | "error";
  text: string;
};

export type SandboxRunResult =
  | {
      status: "ok";
      kind: typeof SANDBOX_RESULT_KIND.RenderOk;
      console: SandboxConsoleEvent[];
      durationMs: number;
      screenshotId?: string;
      artifactUrl?: string;
    }
  | {
      status: "error";
      kind: Exclude<
        (typeof SANDBOX_RESULT_KIND)[keyof typeof SANDBOX_RESULT_KIND],
        typeof SANDBOX_RESULT_KIND.RenderOk
      >;
      message: string;
      console: SandboxConsoleEvent[];
      durationMs: number;
      rawLog?: string;
      stack?: string;
      screenshotId?: string;
    };
```

Rules:

- Unknown provider errors become `sandbox_internal_error` with diagnostic details.
- Invalid input returns 400 from the API before a sandbox is created.
- File paths must be validated before writing to the sandbox: relative paths only, no `..`, no absolute paths.
- The result is a tool result for the agent loop, not a free-form log string.

## 4. Provider Options And Free Quotas

The practical options for this project:

| Provider | Free / included quota | Fit |
|---|---:|---|
| Vercel Sandbox | Hobby includes sandbox usage; current public pricing references included active CPU, memory-hours, creations, and network quota. | Best first choice because the app is already on Vercel. |
| E2B | Usually offers free credits for sandbox usage. | Good alternative if Vercel Sandbox limits block the workflow. |
| Daytona | Usually offers free compute credits. | Good alternative for agent-oriented sandbox experiments. |
| Modal | Has monthly free credits on starter accounts. | Useful for generic compute workers, less product-aligned than Vercel Sandbox for this app. |
| Railway / Render / Fly.io | Trial credits or low-cost always-on containers vary by provider. | Viable for a custom Docker worker, but requires more operations work. |
| Cloudflare Workers Free | 100,000 requests/day for lightweight Workers. | Not enough for `npm install` / `npm run build` style sandbox execution. |
| Cloudflare Browser Rendering / Browser Run | Free browser time exists, currently documented as 10 minutes/day on Workers Free. | Can validate a page in a browser, but it does not build or run the project by itself. |
| Cloudflare Containers | Available through Workers Paid with included container usage; not a zero-cost free-plan sandbox. | Possible later, but not the simplest first version. |

Official references:

- Vercel Sandbox docs: https://vercel.com/docs/sandbox/working-with-sandbox
- Vercel pricing: https://vercel.com/docs/pricing
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Browser Run pricing: https://developers.cloudflare.com/browser-run/pricing/
- Cloudflare Containers pricing: https://developers.cloudflare.com/containers/pricing/

Cloudflare conclusion:

```text
Cloudflare has useful free quotas, but it is not the best first backend code sandbox for this project.
Workers Free is a lightweight edge runtime, not a Linux project build sandbox.
Browser Run can help with browser validation only after the app is already built and served.
Containers are closer to the need, but they require Workers Paid and more lifecycle work.
```

## 5. Security Baseline

The sandbox service must be treated as hostile-code infrastructure.

Required:

- The sandbox receives no production secrets.
- The sandbox runs outside the Next.js app process.
- Each run gets an isolated temporary filesystem.
- CPU, memory, process count, output size, and wall-clock time are capped.
- Network access is disabled or restricted to an explicit allowlist.
- Internal network addresses are blocked.
- The sandbox is stopped after each run.
- Logs and screenshots are size-limited before persistence.
- Static artifacts are served from a separate origin if they are exposed to users.

For Vercel deployment:

```text
Next.js on Vercel = control plane.
Vercel Sandbox or external worker = execution plane.
```

## 6. Integration Points

Likely files when this is implemented:

```text
types/sandbox.ts
  Sandbox result constants and TypeScript types.

server/sandbox/
  Provider adapter, project file validation, and result mapping.

app/api/sandbox-runs/route.ts
  POST endpoint to create a one-shot sandbox run.

hooks/usePreview.ts
  Optional mode switch between browser WebContainer preview and backend sandbox validation.

app/api/chat/route.ts
  If the LLM gets a run-preview tool result from the server side, feed SandboxRunResult back into the transcript.
```

Implementation should start with build validation, then add Playwright browser validation after the build path is stable.

