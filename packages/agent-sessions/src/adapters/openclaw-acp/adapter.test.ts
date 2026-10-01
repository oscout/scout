import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAgentClient } from "../../local/index.js";
import { createAdapter } from "./adapter.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(publishSessionKey = true) {
  const root = mkdtempSync(join(tmpdir(), "scout-openclaw-acp-"));
  roots.push(root);
  const script = join(root, "gateway.mjs");
  const log = join(root, "frames.jsonl");
  writeFileSync(script, `#!${process.execPath}
import readline from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));
let pendingPrompt;
for await (const line of readline.createInterface({input: process.stdin})) {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + '\\n');
  const reply = result => console.log(JSON.stringify({jsonrpc:'2.0', id:m.id, result}));
  if (m.id === 'approval' && m.result) {
    console.log(JSON.stringify({jsonrpc:'2.0',id:pendingPrompt,result:{stopReason:'end_turn'}}));
  }
  else if (m.method === 'initialize') reply({protocolVersion:1, agentCapabilities:{sessionCapabilities:{resume:{}}}});
  else if (m.method === 'session/new') {
    if (${publishSessionKey}) console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'bridge-local-uuid',update:{sessionUpdate:'session_info_update',_meta:{sessionKey:'agent:main:acp-bridge:test'}}}}));
    reply({sessionId:'bridge-local-uuid'});
  }
  else if (m.method === 'session/resume') {
    if (m.params.sessionId === 'missing') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Session not found'}}));
    else {
      console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'session_info_update',_meta:{sessionKey:m.params.sessionId}}}}));
      reply({});
    }
  }
  else if (m.method === 'session/prompt' && m.params.prompt.some(p => p.text === 'permission')) {
    pendingPrompt = m.id;
    console.log(JSON.stringify({jsonrpc:'2.0',id:'approval',method:'session/request_permission',params:{sessionId:m.params.sessionId,toolCall:{toolCallId:'exec-1',title:'Run command',kind:'execute'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'},{optionId:'deny',kind:'reject_once',name:'Deny'}]}}));
  }
  else if (m.method === 'session/prompt') {
    console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Gateway reply'}}}}));
    reply({stopReason:'end_turn'});
  }
  else if (m.id != null) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported method'}}));
}
`);
  chmodSync(script, 0o755);
  return { root, log, options: { command: script, startupTimeoutMs: 2000 } };
}

describe("OpenClaw ACP", () => {
  test("local client streams replies, preserves native identity and resumes a cold bridge", async () => {
    const f = fixture();
    const first = await createLocalAgentClient({ harness: "openclaw", cwd: f.root, adapterOptions: f.options });
    let nativeId: string | undefined;
    try {
      const result = await first.turn("hello");
      expect(result.text).toBe("Gateway reply");
      expect(result.harness).toBe("openclaw");
      expect(result.transport).toBe("openclaw_acp");
      nativeId = result.session.nativeId;
      expect(nativeId).toBe("agent:main:acp-bridge:test");
      expect((await first.turn("again")).session.reused).toBe(true);
      await expect(first.turn({ input: "hello", model: "other" })).rejects.toThrow("Gateway");
    } finally { await first.close(); }
    const resumed = await createLocalAgentClient({ harness: "openclaw", cwd: f.root, reuseKey: nativeId, adapterOptions: f.options });
    try { expect((await resumed.turn("continue")).session.nativeId).toBe(nativeId); }
    finally { await resumed.close(); }
    const frames = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(JSON.parse(readFileSync(join(f.root, "argv.json"), "utf8"))).toEqual(["acp"]);
    expect(frames.filter(f => f.method === "session/new")).toHaveLength(1);
    expect(frames.find(f => f.method === "session/new").params.mcpServers).toEqual([]);
    expect(frames.find(f => f.method === "session/resume").params.sessionId).toBe(nativeId);
    expect(frames.some(f => f.method === "authenticate" || f.method === "session/set_model")).toBe(false);
  });

  test("does not expose a process-local UUID when Gateway metadata is absent", async () => {
    const f = fixture(false);
    const client = await createLocalAgentClient({ harness: "openclaw", cwd: f.root, adapterOptions: f.options });
    try { expect((await client.turn("hello")).session.nativeId).toBeUndefined(); }
    finally { await client.close(); }
  });

  test("local client rejects approvals when no approval consumer is attached", async () => {
    const f = fixture();
    const client = await createLocalAgentClient({ harness: "openclaw", cwd: f.root, adapterOptions: f.options });
    try { await client.turn({ input: "permission", timeoutMs: 2000 }); }
    finally { await client.close(); }
    const frames = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(frames.find(f => f.id === "approval").result.outcome).toEqual({ outcome: "selected", optionId: "deny" });
  });

  test("missing continuation fails without starting a fresh session", async () => {
    const f = fixture();
    const client = await createLocalAgentClient({ harness: "openclaw", cwd: f.root, reuseKey: "missing", warmth: "lazy", adapterOptions: f.options });
    try { await expect(client.turn("continue")).rejects.toThrow("Session not found"); }
    finally { await client.close(); }
    expect(readFileSync(f.log, "utf8")).not.toContain('"method":"session/new"');
  });

  test("rejects unsupported controls and inline credentials before launch", async () => {
    for (const options of [{ model: "x" }, { reasoningEffort: "high" }, { mcpServers: [{}] }, { args: ["acp", "--token=secret"] }, { args: ["acp", "--password", "secret"] }]) {
      expect(() => createAdapter({ sessionId: "test", options })).toThrow();
    }
    for (const options of [{model: "x"}, {reasoningEffort: "high"}]) {
      await expect(createLocalAgentClient({ harness: "openclaw", cwd: process.cwd(), warmth: "lazy", ...options })).rejects.toThrow("Gateway");
    }
    await expect(createLocalAgentClient({ harness: "openclaw", transport: "pi_rpc", cwd: process.cwd() })).rejects.toThrow("does not support");
  });
});
