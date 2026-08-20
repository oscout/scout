import { describe, expect, test } from "bun:test";

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPiRpcCredentialEnv, parsePiRpcLaunchArgs, readPiRpcCredentialFile } from "./pi-rpc";

describe("Pi RPC launch args", () => {
  test("extracts modeled Pi options and preserves unknown passthrough args", () => {
    const parsed = parsePiRpcLaunchArgs(
      [
        "--model",
        "MiniMax-M3",
        "--provider=minimax",
        "--thinking",
        "low",
        "--resume",
        "review-pi",
        "--extension",
        "/dev/pi-scout",
        "--append-system-prompt",
        "managed prompt",
        "--custom-flag",
        "custom-value",
      ],
      {
        runtimeDirectory: "/runtime/pi-agent",
        includeDefaultScoutExtension: false,
      },
    );

    expect(parsed).toEqual({
      model: "MiniMax-M3",
      provider: "minimax",
      thinking: "low",
      session: "review-pi",
      sessionDir: "/runtime/pi-agent/pi-sessions",
      extensions: ["/dev/pi-scout"],
      extraArgs: ["--custom-flag", "custom-value"],
    });
  });

  test("consumes legacy session-id settings without forwarding them", () => {
    const parsed = parsePiRpcLaunchArgs(
      ["--session-id", "legacy-scout-id", "--custom-flag"],
      {
        runtimeDirectory: "/runtime/pi-agent",
        includeDefaultScoutExtension: false,
      },
    );

    expect(parsed).toEqual({
      sessionDir: "/runtime/pi-agent/pi-sessions",
      extensions: [],
      extraArgs: ["--custom-flag"],
    });
  });

  test("maps XAI_API_KEY credentials for Grok launches", () => {
    const sources = {
      env: {
        XAI_API_KEY: "xai-key",
        SCOUT_XAI_API_KEY: "scout-xai-key",
      },
      readSecret: () => undefined,
    };

    expect(buildPiRpcCredentialEnv({ model: "grok-4.3" }, sources)).toEqual({
      XAI_API_KEY: "xai-key",
    });
    expect(buildPiRpcCredentialEnv({ provider: "grok" }, sources)).toEqual({
      XAI_API_KEY: "xai-key",
    });
  });

  test("maps SCOUT_XAI_API_KEY credentials for Grok launches", () => {
    expect(
      buildPiRpcCredentialEnv(
        { model: "grok-4.3" },
        {
          env: {
            SCOUT_XAI_API_KEY: "scout-xai-key",
          },
          readSecret: () => undefined,
        },
      ),
    ).toEqual({
      XAI_API_KEY: "scout-xai-key",
    });
  });

  test("resolves Pi RPC credential aliases from env before secrets", () => {
    expect(
      buildPiRpcCredentialEnv(
        { provider: "minimax" },
        {
          env: {
            MINIMAX_TOKEN: "minimax-env-token",
          },
          readSecret: () => "minimax-secret-key",
        },
      ),
    ).toEqual({
      MINIMAX_API_KEY: "minimax-env-token",
    });

    expect(
      buildPiRpcCredentialEnv(
        { model: "grok-4.3" },
        {
          env: {},
          readSecret: (name) => name === "SCOUT_XAI_API_KEY" ? "scout-xai-secret" : undefined,
        },
      ),
    ).toEqual({
      XAI_API_KEY: "scout-xai-secret",
    });
  });

  test("reads a private Linux credential file without exposing it as metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-pi-credential-"));
    const directory = join(home, ".config", "openscout", "credentials");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "MINIMAX_API_KEY"), "linux-minimax-token\n", { mode: 0o600 });

    expect(readPiRpcCredentialFile("MINIMAX_API_KEY", {
      env: {},
      platform: "linux",
      homedir: home,
    })).toBe("linux-minimax-token");
  });

  test("rejects group-readable Linux credential files", () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-pi-credential-mode-"));
    const directory = join(home, ".config", "openscout", "credentials");
    const path = join(directory, "MINIMAX_API_KEY");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path, "do-not-read\n", { mode: 0o600 });
    chmodSync(path, 0o640);

    expect(readPiRpcCredentialFile("MINIMAX_API_KEY", {
      env: {},
      platform: "linux",
      homedir: home,
    })).toBeUndefined();
  });
});
