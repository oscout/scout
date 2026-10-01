import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { resolveOpenScoutWebRoutes } from "./shared/runtime-config.js";

const require = createRequire(import.meta.url);

function resolveHudsonSdkSource(): string | null {
  const sourceMode = process.env.OPENSCOUT_WEB_HUDSONKIT_SOURCE?.trim();
  if (sourceMode === "package") {
    return null;
  }
  if (process.env.HUDSON_SDK_PATH) {
    return resolve(process.env.HUDSON_SDK_PATH);
  }
  const localSourceMode = sourceMode || "auto";
  if (localSourceMode !== "local" && localSourceMode !== "auto") {
    return null;
  }
  const direct = resolve(__dirname, "../../..", "hudson/packages/web/hudsonkit");
  if (existsSync(direct)) {
    return direct;
  }
  const legacyDirect = resolve(__dirname, "../../..", "hudson/packages/hudson-sdk");
  if (existsSync(legacyDirect)) {
    return legacyDirect;
  }
  try {
    const commonGitDir = execSync("git rev-parse --git-common-dir", {
      cwd: __dirname,
      encoding: "utf8",
    }).trim();
    const mainRepoRoot = resolve(commonGitDir, "..");
    const fromCommon = resolve(mainRepoRoot, "..", "hudson/packages/web/hudsonkit");
    if (existsSync(fromCommon)) {
      return fromCommon;
    }
    const legacyFromCommon = resolve(mainRepoRoot, "..", "hudson/packages/hudson-sdk");
    if (existsSync(legacyFromCommon)) {
      return legacyFromCommon;
    }
  } catch {
    // git not available or not a repo — fall through
  }
  return null;
}

/**
 * `OPENSCOUT_WEB_PROFILE=basic` builds the npm package's web client: the same
 * index.html booting `basic/main.tsx` (Home, DMs, Tail) into dist/basic-client.
 * The ordinary build is untouched and stays the full app.
 */
const basicWeb = process.env.OPENSCOUT_WEB_PROFILE === "basic";
/** Public files only full-app surfaces load (ops 3D studio, crew preview page, crew source masters). */
const BASIC_WEB_OMITTED_PUBLIC = ["characters", "crew/masters", "crew-preview.html"];

function basicWebPlugin(): Plugin {
  let outDir = "";
  return {
    name: "scout-basic-entry",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    transformIndexHtml: {
      order: "pre",
      // Basic has no standalone chat/invite surfaces, so it always bootstraps
      // the operator API.
      handler: (html) => html
        .replace('src="/main.tsx"', 'src="/basic/main.tsx"')
        .replace("if (!standalone)", "if (true)"),
    },
    closeBundle() {
      for (const entry of BASIC_WEB_OMITTED_PUBLIC) {
        rmSync(resolve(outDir, entry), { recursive: true, force: true });
      }
      // The server reports this so the Mac app only opens surfaces basic has.
      writeFileSync(resolve(outDir, "scout-web-profile.json"), `${JSON.stringify({ profile: "basic" })}\n`);
    },
  };
}

const hudsonSdk = resolveHudsonSdkSource();
const webNodeModules = resolve(__dirname, "node_modules");
const bunTarget = process.env.OPENSCOUT_WEB_BUN_URL?.trim() || "http://127.0.0.1:43120";
const routes = resolveOpenScoutWebRoutes(process.env);
const viteHmrProtocol = process.env.OPENSCOUT_WEB_VITE_HMR_PROTOCOL?.trim() || undefined;
const viteHmrHost = process.env.OPENSCOUT_WEB_VITE_HMR_HOST?.trim() || undefined;
const viteHmrClientPort = Number.parseInt(
  process.env.OPENSCOUT_WEB_VITE_HMR_CLIENT_PORT?.trim() || "",
  10,
);

function resolveHudsonKitModule(id: string): string {
  return require.resolve(id, { paths: [__dirname] });
}

function hudsonKitAlias(sourceFile: string, packageExport: string): string {
  if (hudsonSdk) {
    return resolve(hudsonSdk, "src", sourceFile);
  }
  return resolveHudsonKitModule(packageExport);
}

export default defineConfig({
  root: resolve(__dirname, "client"),
  clearScreen: false,
  plugins: [react(), tailwindcss(), ...(basicWeb ? [basicWebPlugin()] : [])],
  define: { "import.meta.env.VITE_SCOUT_WEB_PROFILE": JSON.stringify(basicWeb ? "basic" : "full") },
  server: {
    // The portal name (DEFAULT_SCOUT_WEB_PORTAL_HOST) and its subdomains, so
    // dev work is reachable as scout.local:43122 like the service is.
    allowedHosts: ["scout.local", ".scout.local"],
    hmr: {
      path: routes.viteHmrPath,
      ...(viteHmrProtocol ? { protocol: viteHmrProtocol } : {}),
      ...(viteHmrHost ? { host: viteHmrHost } : {}),
      ...(Number.isFinite(viteHmrClientPort) && viteHmrClientPort > 0
        ? { clientPort: viteHmrClientPort }
        : {}),
    },
    proxy: {
      "/api": { target: bunTarget, changeOrigin: false, ws: true },
      [routes.terminalRelayPath]: { target: bunTarget, changeOrigin: false, ws: true },
      [routes.terminalRelayHealthPath]: { target: bunTarget, changeOrigin: false, ws: false },
      [routes.tailStreamPath]: { target: bunTarget, changeOrigin: false, ws: true },
      [routes.eventsStreamPath]: { target: bunTarget, changeOrigin: false, ws: true },
    },
  },
  resolve: {
    alias: {
      "react": resolve(webNodeModules, "react"),
      "react-dom": resolve(webNodeModules, "react-dom"),
      "@ai-sdk/react": resolve(webNodeModules, "@ai-sdk/react"),
      "ai": resolve(webNodeModules, "ai"),
      "@hudsonkit/app-shell": hudsonKitAlias("app-shell.ts", "hudsonkit/app-shell"),
      "@hudsonkit/shell": hudsonKitAlias("shell.ts", "hudsonkit/shell"),
      "@hudsonkit/chrome": hudsonKitAlias("chrome.ts", "hudsonkit/chrome"),
      "@hudsonkit/controls": hudsonKitAlias("controls.ts", "hudsonkit/controls"),
      "@hudsonkit/canvas": hudsonKitAlias("canvas.ts", "hudsonkit/canvas"),
      "@hudsonkit/overlays": hudsonKitAlias("overlays.ts", "hudsonkit/overlays"),
      "hudsonkit/terminal": hudsonKitAlias("terminal.ts", "hudsonkit/terminal"),
      "hudsonkit/flags": hudsonKitAlias("flags/index.ts", "hudsonkit/flags"),
      "@hudsonkit/styles": hudsonKitAlias("styles/bundle.css", "hudsonkit/styles"),
      "@hudsonkit": hudsonKitAlias("index.ts", "hudsonkit"),
      "@openscout/agent-sessions/client": resolve(__dirname, "../agent-sessions/src/client.ts"),
      "@xterm/addon-fit": resolveHudsonKitModule("@xterm/addon-fit"),
      "@xterm/addon-webgl": resolveHudsonKitModule("@xterm/addon-webgl"),
      "@xterm/xterm/css/xterm.css": resolveHudsonKitModule("@xterm/xterm/css/xterm.css"),
      "@xterm/xterm": resolveHudsonKitModule("@xterm/xterm"),
    },
  },
  build: {
    outDir: resolve(__dirname, basicWeb ? "dist/basic-client" : "dist/client"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
