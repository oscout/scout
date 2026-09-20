/**
 * The hosted Chat build.
 *
 * It compiles `client/hosted-chat/` — which is an entry point and a transport,
 * nothing more — and pulls in `client/screens/chat-space/` as ordinary imports,
 * so the Cloudflare Worker ships the *same* components, the same `chat-space.css`
 * and the same interaction code the local Scout serves at `/chat`. There is no
 * second copy of the interface to keep in step.
 *
 * Output goes to `apps/hosted-chat/public/`, which the Worker serves through its
 * static-assets binding. It is a build artifact and is not checked in.
 *
 * Deliberately thinner than `vite.config.ts`: no dev proxy to the local Bun
 * server, no terminal/xterm resolution, and only the one HudsonKit alias that
 * `app.css` needs for the token layer `chat-space.css` is written against.
 * Hosted Chat mounts the standalone surface and nothing that would reach the
 * operator shell.
 */

import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const webNodeModules = resolve(__dirname, "node_modules");
const hostedOut = resolve(__dirname, "../../apps/hosted-chat/public");

/**
 * The browser mark.
 *
 * `client/public/` is the local app's static tree and is 11 MB of crew and
 * character art. The hosted page does not take that tree as `publicDir`.
 * The signed-out landing imports a few crew busts as bundled assets instead,
 * so the example room can paint coins without shipping the rest of the pack.
 * Copied here are exactly the two files a browser requests for a tab icon —
 * `index.html` names the SVG, and every browser asks for `/favicon.ico`
 * whether or not anything names it.
 */
const icons = {
  name: "hosted-chat-icons",
  async closeBundle() {
    const from = resolve(__dirname, "client/public");
    for (const file of ["favicon.svg", "favicon.ico"]) {
      await copyFile(resolve(from, file), resolve(hostedOut, file));
    }
  },
};

export default defineConfig({
  root: resolve(__dirname, "client/hosted-chat"),
  base: "/",
  clearScreen: false,
  plugins: [react(), tailwindcss(), icons],
  resolve: {
    alias: {
      react: resolve(webNodeModules, "react"),
      "react-dom": resolve(webNodeModules, "react-dom"),
      // `app.css` imports this: it declares the `--hud-*` tokens that the
      // `[data-scout-theme]` alias layer — and therefore `chat-space.css` —
      // resolves against. Published package only; the local hudson checkout is
      // a development convenience the hosted build must not depend on.
      "@hudsonkit/styles": require.resolve("hudsonkit/styles", { paths: [__dirname] }),
      "@hudsonkit": require.resolve("hudsonkit", { paths: [__dirname] }),
    },
  },
  build: {
    outDir: hostedOut,
    emptyOutDir: true,
    sourcemap: false,
    // The Worker serves these by exact path from its assets binding.
    assetsDir: "assets",
  },
});
