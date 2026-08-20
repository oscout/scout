import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  normalizeServerOpenPath,
  requestScoutWebControl,
  renderServerCommandHelp,
  resolveBunExecutable,
  resolveServerBrowserUrl,
} from "./server.ts";

describe("server command helpers", () => {
  test("documents the open workflow", () => {
    expect(renderServerCommandHelp()).toContain("scout server open [options]");
    expect(renderServerCommandHelp()).toContain("scout server caddyfile [options]");
    expect(renderServerCommandHelp()).toContain("scout server edge [options]");
    expect(renderServerCommandHelp()).toContain("deprecated alias for `scout server open`");
    expect(renderServerCommandHelp()).toContain("--host <h>");
    expect(renderServerCommandHelp()).toContain("--local-name NAME");
    expect(renderServerCommandHelp()).toContain("--public-origin URL");
    expect(renderServerCommandHelp()).toContain("--http");
    expect(renderServerCommandHelp()).toContain("--https");
    expect(renderServerCommandHelp()).toContain("--both");
  });

  test("normalizes relative browser paths", () => {
    expect(normalizeServerOpenPath("agents/arc")).toBe("/agents/arc");
    expect(normalizeServerOpenPath("/agents/arc")).toBe("/agents/arc");
    expect(normalizeServerOpenPath("")).toBe("/");
  });

  test("rejects absolute URLs for browser paths", () => {
    expect(() => normalizeServerOpenPath("https://local.openscout.app")).toThrow(
      "--path must be a local path, not an absolute URL",
    );
  });

  test("opens the Scout portal URL by default", () => {
    expect(
      resolveServerBrowserUrl(
        { OPENSCOUT_WEB_ADVERTISED_HOST: "hudson-mini.local" },
        43120,
        "/agents",
      ),
    ).toBe("http://scout.local:43120/agents");
  });

  test("opens public origin when configured", () => {
    expect(
      resolveServerBrowserUrl(
        { OPENSCOUT_WEB_PUBLIC_ORIGIN: "https://scout.local/" },
        43120,
        "agents",
      ),
    ).toBe("https://scout.local/agents");
  });

  test("opens configured portal host", () => {
    expect(
      resolveServerBrowserUrl(
        { OPENSCOUT_WEB_PORTAL_HOST: "local.scout" },
        43120,
        "agents",
      ),
    ).toBe("http://local.scout:43120/agents");
  });

  test("resolves bun from explicit environment overrides", () => {
    const directory = mkdtempSync(join(tmpdir(), "scout-server-bun-"));
    const bunPath = join(directory, "bun");

    try {
      writeFileSync(bunPath, "#!/bin/sh\nexit 0\n");
      chmodSync(bunPath, 0o755);

      expect(resolveBunExecutable({ OPENSCOUT_BUN_BIN: bunPath })).toBe(bunPath);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("uses the broker as the only web server owner", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const status = await requestScoutWebControl("start", {
      brokerUrl: "http://127.0.0.1:43110",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(JSON.stringify({
          ok: true,
          running: true,
          starting: false,
          managed: true,
          webUrl: "http://127.0.0.1:43120",
          port: 43120,
          pid: 2468,
          error: null,
        }), { headers: { "content-type": "application/json" } });
      },
    });

    expect(calls).toEqual([{ url: "http://127.0.0.1:43110/v1/web/start", method: "POST" }]);
    expect(status.webUrl).toBe("http://127.0.0.1:43120");
    expect(status.managed).toBe(true);
  });

  test("surfaces broker web lifecycle failures without spawning a local server", async () => {
    await expect(requestScoutWebControl("restart", {
      brokerUrl: "http://127.0.0.1:43110",
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        error: "Scout web is running outside broker management.",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    })).rejects.toThrow("Scout web is running outside broker management.");
  });
});
