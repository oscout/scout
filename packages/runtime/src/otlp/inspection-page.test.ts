import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { otlpPaths } from "./config.js";
import { renderInspectionPage } from "./inspection-page.js";
import type { InspectionSession, InspectionView } from "./inspection-view.js";
import { startOtlpReceiver } from "./receiver.js";

const directories: string[] = [];
const servers: Awaited<ReturnType<typeof startOtlpReceiver>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const health = {
  accepted: { traces: 0, logs: 0, metrics: 0 },
  rejected: { traces: 0, logs: 0, metrics: 0 },
  invalidRequests: 0, persistenceFailures: 0, persistenceLost: 0,
  queue: { items: 0, bytes: 0 },
  store: { rows: 0, bytes: 0, retentionEvicted: 0 },
};

function session(overrides: Partial<InspectionSession> = {}): InspectionSession {
  return {
    key: '["rk","session-abc"]', nativeSessionId: "session-abc",
    service: "claude-code", version: "2.1.258",
    firstReceivedAt: 1789872335000, lastReceivedAt: 1789872336000,
    counts: { traces: 1, logs: 2, metrics: 0 }, observationCount: 3,
    models: ["claude-sonnet-4-5"], requestEvents: [], timeline: [], timelineCount: 0,
    ...overrides,
  };
}

function view(overrides: Partial<InspectionView> = {}): InspectionView {
  const sessions = overrides.sessions ?? [session()];
  return {
    generatedAt: 1789872336000, retentionMs: 21_600_000, loadedCount: 3, bounded: false,
    sessionCount: 1, uncorrelatedGroupCount: 0,
    counts: { traces: 1, logs: 2, metrics: 0 },
    sessions, selected: sessions[0], health,
    ...overrides,
  };
}

describe("inspection page renderer (synthetic view)", () => {
  test("renders service, native id and exact large token formatting", () => {
    const html = renderInspectionPage(view({
      sessions: [session({
        requestEvents: [
          { id: "a", occurredAt: 1789872335500, model: "claude-sonnet-4-5", input: "9007199254740993", output: "0", cacheRead: "42" },
        ],
        timeline: [{
          id: "t", signal: "traces", label: "Completed span", occurredAt: 1789872335500,
          durationMs: "12.345", traceId: "abcdef0123456789abcdef0123456789", spanId: "abcdef0123456789",
        }],
        timelineCount: 1,
      })],
    }));
    expect(html).toContain("<title>");
    expect(html).toContain('role="region" aria-label="Token buckets" tabindex="0"');
    expect(html).toContain('<div class="what">');
    expect(html).toContain("Trace IDs");
    expect(html).toContain("Claude Code");
    expect(html).toContain("session-abc");
    expect(html).toContain("9,007,199,254,740,993");
    expect(html).toContain(">0</td>");
    expect(html).toContain("1 event rows");
    expect(html).toContain("provider-reported event");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("src=");
  });

  test("missing token renders em dash", () => {
    const html = renderInspectionPage(view({
      sessions: [session({ requestEvents: [{ id: "a", occurredAt: 1, model: "m" }] })],
    }));
    expect(html).toContain("&mdash;");
  });

  test("escapes hostile markup in service, model and ids", () => {
    const hostile = '<script>alert(1)</script>"onmouseover="x';
    const html = renderInspectionPage(view({
      sessions: [session({
        key: '["k","' + hostile + '"]', service: hostile, nativeSessionId: hostile,
        models: [hostile],
        requestEvents: [{ id: "a", occurredAt: 1, model: hostile, input: "1" }],
      })],
    }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain(`"${hostile}"`);
    expect(html).toContain(`${otlpPaths.inspector}?session=${encodeURIComponent('["k","')}`);
  });

  test("duplicate log events stay labelled event rows", () => {
    const event = { id: "a", occurredAt: 1, model: "m", input: "5", output: "6" };
    const html = renderInspectionPage(view({
      sessions: [session({ requestEvents: [{ ...event }, { ...event, id: "b" }] })],
    }));
    expect(html).toContain("2 event rows");
    expect(html).not.toContain("unique requests");
  });

  test("empty state when nothing retained", () => {
    const html = renderInspectionPage(view({
      sessions: [], selected: undefined, sessionCount: 0, loadedCount: 0,
      counts: { traces: 0, logs: 0, metrics: 0 },
    }));
    expect(html).toContain("Waiting for agent telemetry");
    expect(html).not.toContain("src=");
  });
});

describe("inspection page over HTTP (synthetic ingest)", () => {
  test("routes, guards and sanitized content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-otlp-page-test-"));
    directories.push(dir);
    const receiver = await startOtlpReceiver({ databasePath: join(dir, "observations.sqlite"), port: 0 });
    servers.push(receiver);

    const root = await fetch(`${receiver.url}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(root.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await root.text();
    expect(html).toContain("Waiting for agent telemetry");

    expect((await fetch(`${receiver.url}/favicon.ico`)).status).toBe(204);
    expect((await fetch(`${receiver.url}/`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${receiver.url}/`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${receiver.url}/`, { headers: { Host: "evil.example" } })).status).toBe(403);

    const secret = "PRIVATE CONTENT SENTINEL";
    const payload = {
      resourceLogs: [{
        resource: { attributes: [
          { key: "service.name", value: { stringValue: "claude-code" } },
          { key: "session.id", value: { stringValue: "smoke-session" } },
        ] },
        scopeLogs: [{ logRecords: [{
          eventName: "api_request", timeUnixNano: "1789872335795123456",
          body: { stringValue: secret },
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4-5" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "9007199254740993" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "0" } },
            { key: "gen_ai.prompt", value: { stringValue: secret } },
          ],
        }] }],
      }],
    };
    const post = await fetch(`${receiver.url}${otlpPaths.logs}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(post.status).toBe(200);
    await receiver.flush();

    const page = await (await fetch(`${receiver.url}/`)).text();
    expect(page).toContain("claude-sonnet-4-5");
    expect(page).toContain("9,007,199,254,740,993");
    expect(page).toContain("smoke-session");
    expect(page).not.toContain(secret);

    const unknown = await (await fetch(`${receiver.url}/?session=${encodeURIComponent('bogus"><script>')}`)).text();
    expect(unknown).not.toContain('bogus"<script>');
    expect(unknown).not.toContain("<script>");

    const healthResponse = await fetch(`${receiver.url}${otlpPaths.health}`);
    expect(healthResponse.headers.get("content-type")).toContain("application/json");
    const status = await healthResponse.json() as { accepted: { logs: number } };
    expect(status.accepted.logs).toBe(1);
  });
});
