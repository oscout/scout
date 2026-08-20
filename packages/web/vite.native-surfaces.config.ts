import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const nativeRoot = resolve(__dirname, "client/native-surfaces");
const surface = process.env.SCOUT_NATIVE_SURFACE;

if (surface !== "lanes" && surface !== "deck" && surface !== "dispatch" && surface !== "chat") {
  throw new Error("SCOUT_NATIVE_SURFACE must be lanes, deck, dispatch, or chat");
}

export default defineConfig({
  root: nativeRoot,
  base: "./",
  clearScreen: false,
  // Library mode does not apply Vite's normal app HTML replacement for this
  // Node convention. React's CJS wrapper reads it before mounting, so bake the
  // production branch into the signed browser-only artifact.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, "../../apps/ios/Scout/Resources/WebSurfaces"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve(nativeRoot, surface, "main.tsx"),
      name: surface === "lanes"
        ? "ScoutLanesSurface"
        : surface === "deck"
          ? "ScoutDeckSurface"
          : surface === "dispatch"
            ? "ScoutDispatchSurface"
            : "ScoutChatSurface",
      formats: ["iife"],
      fileName: () => `${surface}/app.js`,
      cssFileName: `${surface}/app`,
    },
    rollupOptions: {
      output: {
        // WKWebView gives file URLs opaque origins on some iOS versions. A
        // classic, self-contained script avoids module/chunk CORS failures
        // while keeping every executable byte inside the signed app bundle.
        inlineDynamicImports: true,
      },
    },
  },
});
