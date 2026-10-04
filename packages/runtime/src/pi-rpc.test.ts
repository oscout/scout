import { describe, expect, test } from "bun:test";

import { chmodSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("Pi tracked invocation capture", () => {
  test("waits past tool-turn narration for agent_end and captures the final result", async () => {
    const { invokePiRpcAgent, shutdownPiRpcAgent } = await import("./pi-rpc");
    const root = mkdtempSync(join(tmpdir(), "scout-pi-rpc-"));
    const binary = join(root, "pi");
    writeFileSync(binary, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(join(root, "pid"))}, String(process.pid));
const rl = require("node:readline").createInterface({input:process.stdin});
const emit = (x) => console.log(JSON.stringify(x));
rl.on("line", line => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") emit({type:"response", command:"get_state",success:true,data:{sessionId:"native-pi",model:{id:"fixture-model",provider:"fixture"},thinkingLevel:"off"}});
  if (cmd.type !== "prompt") return;
  if (cmd.message === "clean-exit") { process.exit(0); }
  if (cmd.message === "empty") {
    emit({type:"agent_start"}); emit({type:"agent_end"}); return;
  }
  if (cmd.message === "provider-error") {
    emit({type:"turn_start"});
    emit({type:"turn_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"Provider not configured"}});
    emit({type:"agent_end"}); return;
  }
  if (["recover", "retry-exhausted", "aborted"].includes(cmd.message)) {
    emit({type:"agent_start"}); emit({type:"turn_start"});
    emit({type:"turn_end",message:{role:"assistant",content:[{type:"text",text:"Partial answer"}],stopReason:cmd.message === "aborted" ? "aborted" : "error",errorMessage:"Provider temporarily unavailable"}});
    if (cmd.message === "aborted") { emit({type:"agent_end",isTerminal:true}); return; }
    emit({type:"agent_end",isTerminal:false});
    emit({type:"auto_retry_start"});
    setTimeout(() => {
      emit({type:"auto_retry_end",success:cmd.message === "recover"});
      if (cmd.message === "recover") {
        emit({type:"turn_start"});
        emit({type:"turn_end",message:{role:"assistant",content:[{type:"text",text:"Recovered result"}],stopReason:"stop"}});
      }
      emit({type:"agent_end",isTerminal:true});
    }, 50); return;
  }
  if (cmd.message === "timeout") {
    emit({type:"agent_start"}); emit({type:"turn_start"});
    setTimeout(() => {
      emit({type:"turn_end",message:{role:"assistant",content:[{type:"text",text:"Stale timed out result"}],stopReason:"stop"}});
      emit({type:"agent_end"});
    }, 200); return;
  }
  if (cmd.message === "reject") {
    emit({type:"response",command:"prompt",success:false,error:"Provider unavailable; configure Pi"});
    return;
  }
  emit({type:"agent_start"});
  emit({type:"turn_start"});
  emit({type:"turn_end",message:{role:"assistant",content:[{type:"text",text:"Reading the fixture now."},{type:"toolCall",id:"read-1",name:"read",arguments:{path:"ci-fixture.txt"}}],stopReason:"toolUse"}});
  setTimeout(() => {
    emit({type:"turn_start"});
    emit({type:"turn_end",message:{role:"assistant",model:"fixture-model",provider:"fixture",content:[{type:"text",text:"SCOUT_CI_DISPATCH_OK"}],stopReason:"stop"}});
    emit({type:"agent_end"});
  }, 50);
});
`);
    chmodSync(binary, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = root + ":" + oldPath;
    const options = {
      agentName: "pi-regression", sessionId: root, cwd: root,
      systemPrompt: "Test", runtimeDirectory: join(root, "runtime"),
      logsDirectory: join(root, "logs"), launchArgs: [], timeoutMs: 3000,
    };
    try {
      const result = await invokePiRpcAgent({ ...options, prompt: "read" });
      expect(result.output).toBe("SCOUT_CI_DISPATCH_OK");
      expect(result.metadata?.observeRuntime).toEqual(expect.objectContaining({
        model: "fixture-model", modelProvider: "fixture", effort: "off",
      }));
      expect((await invokePiRpcAgent({ ...options, prompt: "recover" })).output).toBe("Recovered result");
      await expect(invokePiRpcAgent({ ...options, prompt: "retry-exhausted" })).rejects.toThrow("Provider temporarily unavailable");
      await expect(invokePiRpcAgent({ ...options, prompt: "aborted" })).rejects.toThrow();
      await expect(invokePiRpcAgent({ ...options, prompt: "timeout", timeoutMs: 40 })).rejects.toThrow("timed out");
      expect((await invokePiRpcAgent({ ...options, prompt: "read" })).output).toBe("SCOUT_CI_DISPATCH_OK");
      await expect(invokePiRpcAgent({ ...options, prompt: "empty" })).rejects.toThrow("without a final assistant result");
      await expect(invokePiRpcAgent({ ...options, prompt: "provider-error" })).rejects.toThrow("Provider not configured");
      const rejectedPid = Number(readFileSync(join(root, "pid"), "utf8"));
      await expect(invokePiRpcAgent({ ...options, prompt: "reject" })).rejects.toThrow("Provider unavailable");
      expect((await invokePiRpcAgent({ ...options, prompt: "read" })).output).toBe("SCOUT_CI_DISPATCH_OK");
      expect(Number(readFileSync(join(root, "pid"), "utf8"))).not.toBe(rejectedPid);
      expect(() => process.kill(rejectedPid, 0)).toThrow();
      const exitOptions = { ...options, sessionId: root + "-exit", prompt: "clean-exit" };
      try {
        await expect(invokePiRpcAgent(exitOptions)).rejects.toThrow("pi exited with code 0");
      } finally {
        await shutdownPiRpcAgent(exitOptions);
      }
    } finally {
      await shutdownPiRpcAgent(options);
      process.env.PATH = oldPath;
    }
  });
});
