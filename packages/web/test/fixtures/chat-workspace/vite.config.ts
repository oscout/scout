import { defineConfig, mergeConfig } from "vite";
import base from "../../../vite.config.ts";

// An isolated browser test surface, never a production entrypoint. Uses the
// actual Chat components with controlled records; no real broker writes.
export default mergeConfig(base, defineConfig({
  root: import.meta.dirname,
  plugins: [{
    name: "controlled-full-outcome",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/^\/api\/channels\/[^/]+\/asks\/fixture-flight\/output$/.test(req.url ?? "")) return next();
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.end("Verified behavior.\n".repeat(250) + "END OF FULL OUTCOME");
      });
    },
  }],
  server: { port: 43124, strictPort: true, host: "127.0.0.1", proxy: {} },
}));
