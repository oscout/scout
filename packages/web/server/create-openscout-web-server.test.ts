import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  stubs,
  createOpenScoutWebServer,
  git,
  gitBuildInfoProbe,
  isolatedTestHome,
  lanBeaconSuppressPredicates,
  makeDiscoverySnapshot,
  makePairingState,
  makePortalPeerMachine,
  makeStaticRoot,
  testDirectories,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "./web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer", () => {
  test("serves /api/build from warmed git.buildInfo without rerunning the probe", async () => {
    const repo = mkdtempSync(join(tmpdir(), "openscout-web-build-info-"));
    testDirectories.add(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "web-probe@example.com"]);
    git(repo, ["config", "user.name", "Web Probe"]);
    writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    const commit = git(repo, ["rev-parse", "--short", "HEAD"]);

    const tailSnapshot = makeDiscoverySnapshot(Date.now());
    const server = await createOpenScoutWebServer({
      currentDirectory: repo,
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      tailRuntime: {
        getTailDiscovery: () => tailSnapshot,
        refreshTailDiscovery: async () => tailSnapshot,
        readRecentTranscriptEvents: async () => [],
        snapshotRecentEvents: () => [],
      },
    });

    await server.warmupCaches();
    const beforeRuns = gitBuildInfoProbe.for(repo).metrics().runCount;

    const response = await server.app.request("http://localhost/api/build");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: expect.any(String),
      branch: "main",
      commit,
      dirty: false,
      mode: "dev",
      server: {
        engine: expect.stringMatching(/^(bun|node)$/),
        engineVersion: expect.any(String),
        nodeVersion: expect.any(String),
        platform: expect.any(String),
        arch: expect.any(String),
      },
    });
    expect(gitBuildInfoProbe.for(repo).metrics().runCount).toBe(beforeRuns);

    writeFileSync(join(repo, "README.md"), "hello\nmodified\n", "utf8");
    const refreshedResponse = await server.app.request("http://localhost/api/build?refresh=1");
    expect(refreshedResponse.status).toBe(200);
    expect((await refreshedResponse.json() as { dirty: boolean }).dirty).toBe(true);
    expect(gitBuildInfoProbe.for(repo).metrics().runCount).toBe(beforeRuns + 1);
  });

  test("serves /api/build by warming git.buildInfo when the cache is empty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "openscout-web-build-info-empty-"));
    testDirectories.add(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "web-probe@example.com"]);
    git(repo, ["config", "user.name", "Web Probe"]);
    writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    const commit = git(repo, ["rev-parse", "--short", "HEAD"]);
    gitBuildInfoProbe.invalidate(repo, "test.empty-cache");

    const server = await createOpenScoutWebServer({
      currentDirectory: repo,
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/build");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      branch: "main",
      commit,
      mode: "dev",
    });
  });

  test("health reports which web client the server serves", async () => {
    const full = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    await expect((await full.app.request("http://localhost/api/health")).json()).resolves.toMatchObject({ webClient: "full" });

    const basicRoot = makeStaticRoot();
    writeFileSync(join(basicRoot, "scout-web-profile.json"), JSON.stringify({ profile: "basic" }), "utf8");
    const basic = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: basicRoot,
    });
    await expect((await basic.app.request("http://localhost/api/health")).json()).resolves.toMatchObject({ webClient: "basic" });
  });

  test("serves static app shell without browser storage", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    for (const path of ["/dispatch", "/broker"]) {
      const response = await server.app.request(`http://localhost${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.text()).resolves.toContain("<body>ok</body>");
    }
  });

  test("does not fall back to app shell for missing static assets", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/assets/index-stale.js");

    expect(response.status).toBe(404);
  });

  test("serves trusted raw files from path-shaped URLs for iframe-relative assets", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-web-raw-file-"));
    testDirectories.add(root);
    mkdirSync(join(root, "reports"), { recursive: true });
    const stylesheetPath = join(root, "reports", "daily summary.css");
    writeFileSync(stylesheetPath, "body { color: red; }\n", "utf8");
    const rawPath = realpathSync(stylesheetPath)
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const server = await createOpenScoutWebServer({
      currentDirectory: root,
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(`http://localhost/api/file/raw${rawPath}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    await expect(response.text()).resolves.toBe("body { color: red; }\n");
    const htmlPath = join(root, "你好.html");
    writeFileSync(htmlPath, "<h1>Report</h1>", "utf8");
    const html = await server.app.request(`http://localhost/api/file/raw${htmlPath.split("/").map(encodeURIComponent).join("/")}`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("sandbox;");
    expect(html.headers.get("content-disposition")).toContain("filename*=UTF-8''%E4%BD%A0%E5%A5%BD.html");
    expect(await html.text()).toBe("<h1>Report</h1>");
  });

  test("serves runtime bootstrap config for the client", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/bootstrap.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    const body = await response.text();
    expect(body).toContain('"terminalRelayPath":"/ws/terminal"');
    expect(body).toContain('"terminalRelayHealthPath":"/ws/terminal/health"');
    expect(body).toContain('"tailStreamPath":"/ws/tail"');
    expect(body).toContain('"eventsStreamPath":"/ws/events"');
    expect(body).toContain('"terminalRunPath":"/api/terminal/run"');
  });

  test("redirects the remote pairing page to the iOS deep link", async () => {
    const qrValue = JSON.stringify({
      v: 1,
      relay: "ws://mac.tailnet.ts.net:43131",
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    });
    stubs.pairingStateResult = makePairingState({
      pairing: {
        relay: "ws://mac.tailnet.ts.net:43131",
        room: "room-1",
        publicKey: "a".repeat(64),
        expiresAt: 1_780_958_228_426,
        qrArt: "",
        qrValue,
      },
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      resolvePeerAddress: () => "127.0.0.1",
    });

    const response = await server.app.request("http://localhost/pair", {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(`scout://pair?payload=${encodeURIComponent(qrValue)}`);
  });

  test("treats the loopback relay marker as a LAN approval request", async () => {
    const qrValue = JSON.stringify({
      v: 1,
      relay: "ws://192.168.18.14:43131",
      room: "room-relayed",
      publicKey: "c".repeat(64),
      expiresAt: Date.now() + 60_000,
    });
    stubs.pairingStateResult = makePairingState({ pairing: { qrValue } });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      lanAccessScope: "pairing",
      resolvePeerAddress: () => "127.0.0.1",
    });

    const hostInfo = await server.app.request("http://localhost/.host-info", {
      headers: { "x-forwarded-for": "192.168.18.204" },
    });
    expect(hostInfo.status).toBe(404);

    const response = await server.app.request("http://localhost/pair", {
      headers: {
        accept: "application/json",
        "x-scout-pair-relay": "1",
        "x-forwarded-for": "192.168.18.203",
      },
      redirect: "manual",
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBeNull();
    const { token } = await response.json() as { token: string };
    const listed = await server.app.request("http://localhost/api/pairing/requests");
    const body = await listed.json() as {
      requests: Array<{ token: string; requesterIp: string | null }>;
    };
    expect(body.requests.find((request) => request.token === token)?.requesterIp)
      .toBe("192.168.18.203");
    await server.stop();
  });

  test("fails closed in every scope when the pairing listener cannot identify its peer", async () => {
    stubs.pairingStateResult = makePairingState({ pairing: { qrValue: "live-secret" } });
    for (const lanAccessScope of ["full", "pairing"] as const) {
      const server = await createOpenScoutWebServer({
        currentDirectory: "/tmp/openscout",
        assetMode: "static",
        staticRoot: makeStaticRoot(),
        lanAccessScope,
        resolvePeerAddress: () => undefined,
      });

      const response = await server.app.request("http://localhost/pair", {
        headers: {
          accept: "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        redirect: "manual",
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("location")).toBeNull();
      await server.stop();
    }
  });

  test("redirects route-specific pairing pages to reordered iOS deep links", async () => {
    const lanPayload = {
      v: 1,
      relay: "ws://192.168.18.14:43131",
      fallbackRelays: ["ws://mac.tailnet.ts.net:43131"],
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    };
    const tailnetPayload = {
      ...lanPayload,
      relay: "ws://mac.tailnet.ts.net:43131",
      fallbackRelays: ["ws://192.168.18.14:43131"],
    };
    const qrValue = JSON.stringify(lanPayload);
    stubs.pairingStateResult = makePairingState({
      pairing: {
        relay: lanPayload.relay,
        fallbackRelays: lanPayload.fallbackRelays,
        room: lanPayload.room,
        publicKey: lanPayload.publicKey,
        expiresAt: lanPayload.expiresAt,
        qrArt: "",
        qrValue,
      },
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      resolvePeerAddress: () => "127.0.0.1",
    });

    const lan = await server.app.request("http://localhost/pair?route=lan", {
      redirect: "manual",
    });
    const tailnet = await server.app.request("http://localhost/pair?route=tsn", {
      redirect: "manual",
    });

    expect(lan.status).toBe(302);
    expect(lan.headers.get("location")).toBe(`scout://pair?payload=${encodeURIComponent(JSON.stringify(lanPayload))}`);
    expect(tailnet.status).toBe(302);
    expect(tailnet.headers.get("location")).toBe(`scout://pair?payload=${encodeURIComponent(JSON.stringify(tailnetPayload))}`);
  });

  test("adds the actual web port to pairing deep-link payloads", async () => {
    const lanPayload = {
      v: 1,
      relay: "ws://192.168.18.14:7889",
      fallbackRelays: ["ws://mac.tailnet.ts.net:7889"],
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    };
    stubs.pairingStateResult = makePairingState({
      pairing: {
        relay: lanPayload.relay,
        fallbackRelays: lanPayload.fallbackRelays,
        room: lanPayload.room,
        publicKey: lanPayload.publicKey,
        expiresAt: lanPayload.expiresAt,
        qrArt: "",
        qrValue: JSON.stringify(lanPayload),
      },
    });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      webPort: 4311,
      resolvePeerAddress: () => "127.0.0.1",
    });

    const response = await server.app.request("http://localhost/pair?route=tsn", {
      redirect: "manual",
    });
    const location = response.headers.get("location");
    const payload = JSON.parse(new URL(location ?? "").searchParams.get("payload") ?? "{}");

    expect(response.status).toBe(302);
    expect(payload).toMatchObject({
      relay: "ws://mac.tailnet.ts.net:7889",
      webPort: 4311,
    });
  });

  test("keeps LAN discovery advertised for remote relay pair mode", async () => {
    stubs.pairingStateResult = makePairingState({
      isRunning: true,
      relay: "wss://mesh.oscout.net/v1/relay",
      lanDiscoveryAdvertised: false,
    });
    await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      webPort: 3200,
    });

    expect(lanBeaconSuppressPredicates).toHaveLength(1);
    expect(await lanBeaconSuppressPredicates[0]!()).toBe(false);
  });

  test("suppresses LAN discovery when the runtime controller advertises it", async () => {
    stubs.pairingStateResult = makePairingState({
      isRunning: true,
      relay: "ws://192.168.18.14:43131",
      lanDiscoveryAdvertised: true,
    });
    await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      webPort: 3200,
    });

    expect(lanBeaconSuppressPredicates).toHaveLength(1);
    expect(await lanBeaconSuppressPredicates[0]!()).toBe(true);
  });

  test("registers an approval request when remote pairing has no active payload", async () => {
    const startedAt = Date.now();
    stubs.pairingStateResult = makePairingState({ pairing: null });
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      resolvePeerAddress: () => "192.168.18.210",
    });

    const response = await server.app.request("http://localhost/pair");

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain("scout://pair pairing requires approval");

    // The request that just got registered carries a bearer token, and this
    // test used to persist one into the runner's REAL ~/.openscout because it
    // never isolated OPENSCOUT_HOME. It has to land in the temp home instead,
    // and it has to land there unreadable by anyone else. State is published a
    // generation at a time, so the file to look at is whichever generation is
    // newest rather than a fixed name.
    const runDirectory = join(isolatedTestHome, ".openscout", "run");
    const published = readdirSync(runDirectory).filter((entry) => entry.startsWith("pair-requests"));
    expect(published).not.toHaveLength(0);
    for (const entry of published) {
      expect(statSync(join(runDirectory, entry)).mode & 0o077).toBe(0);
    }
    // And nothing of this test's went to the operator's real home. That home
    // may legitimately hold pair state of its own, so what is asserted is that
    // nothing was written there while this test ran.
    const realRunDirectory = join(homedir(), ".openscout", "run");
    const writtenDuringTest = existsSync(realRunDirectory)
      ? readdirSync(realRunDirectory).filter(
        (entry) =>
          entry.startsWith("pair-requests")
          && statSync(join(realRunDirectory, entry)).mtimeMs >= startedAt,
      )
      : [];
    expect(writtenDuringTest).toEqual([]);
  });

  test("serves site-level feature flag bundle config for the client", async () => {
    const originalBundle = process.env.OPENSCOUT_WEB_FLAG_BUNDLE;
    const originalExperience = process.env.OPENSCOUT_WEB_EXPERIENCE;
    const originalVariant = process.env.OPENSCOUT_WEB_AB_VARIANT;
    process.env.OPENSCOUT_WEB_FLAG_BUNDLE = "B";
    delete process.env.OPENSCOUT_WEB_EXPERIENCE;
    delete process.env.OPENSCOUT_WEB_AB_VARIANT;

    try {
      const server = await createOpenScoutWebServer({
        currentDirectory: "/tmp/openscout",
        assetMode: "static",
        staticRoot: makeStaticRoot(),
      });

      const response = await server.app.request("http://localhost/api/bootstrap.js");
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('"featureFlags":{"bundle":"max-pro"}');
    } finally {
      if (originalBundle === undefined) {
        delete process.env.OPENSCOUT_WEB_FLAG_BUNDLE;
      } else {
        process.env.OPENSCOUT_WEB_FLAG_BUNDLE = originalBundle;
      }
      if (originalExperience === undefined) {
        delete process.env.OPENSCOUT_WEB_EXPERIENCE;
      } else {
        process.env.OPENSCOUT_WEB_EXPERIENCE = originalExperience;
      }
      if (originalVariant === undefined) {
        delete process.env.OPENSCOUT_WEB_AB_VARIANT;
      } else {
        process.env.OPENSCOUT_WEB_AB_VARIANT = originalVariant;
      }
    }
  });

  test("adds mixed-content protection only for HTTPS edge requests", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const plainResponse = await server.app.request("http://localhost/api/bootstrap.js");
    expect(plainResponse.headers.get("content-security-policy")).toBeNull();

    const forwardedHttpsResponse = await server.app.request("http://localhost/api/bootstrap.js", {
      headers: {
        "x-forwarded-proto": "https",
      },
    });
    expect(forwardedHttpsResponse.headers.get("content-security-policy"))
      .toBe("upgrade-insecure-requests; block-all-mixed-content");
  });

  test("serves the local portal only for the portal host on the same app port", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      portalMachines: async () => [],
    });

    const response = await server.app.request("http://127.0.0.1:4321/", {
      headers: { host: "scout.local:4321" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Scout local");
    expect(body).toContain("m1.scout.local");
    expect(body).toContain(
      'class="field" href="http://m1.scout.local:4321/" aria-label="Open m1.scout.local"',
    );
    expect(body).toContain('class="field__layer" data-t="4" aria-hidden="true"');
    expect(body).toContain('class="hero rise"');
    expect(body).toContain('href="http://m1.scout.local:4321/"');
    expect(body).toContain("max-width: 720px");
    expect(body).toContain("align-content: center");
    expect(body).toContain("prefers-color-scheme: light");
    expect(body).toContain("https://openscout.app/docs");
    expect(body).toContain("https://github.com/oscout/scout");
    expect(body).toContain("served by this machine’s Scout broker");
    // The review-pin regexes live inside a TS template literal; a single
    // backslash would be cooked away and the emitted script would break.
    expect(body).toContain("[?&]t=(-?[\\d.]+)");
    expect(body).toContain("[?&]px=([\\d.]+)");
    expect(body).not.toContain("class=\"identity\"");
    expect(body).not.toContain("class=\"eyebrow\"");
    expect(body).not.toContain("class=\"meta\"");
    expect(body).not.toContain("class=\"orb-l\"");
    expect(body).not.toContain("--accent");
    expect(body).not.toContain("nothing leaves this network");
  });

  test("the local portal lists other scout-enabled machines with their doorways", async () => {
    const NOW = Date.now();
    const machine = makePortalPeerMachine;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      portalMachines: async () => [
        // The row above is this machine already; never listed again.
        machine({
          name: "m1",
          isSelf: true,
          scoutNodeId: "node-self",
          capabilities: ["scout-broker", "scout-web"],
        }),
        // Same LAN: the peer advertises its doorway name, and `*.scout.local`
        // resolves to the viewer's own loopback — the local edge proxies the
        // name to the peer's live LAN route, so the name is the link.
        machine({
          name: "studio-mini",
          scoutNodeId: "node-studio",
          capabilities: ["scout-broker", "scout-web"],
          routes: [{ kind: "lan", host: "192.168.1.40", lastSeenAt: NOW }],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-studio",
            nodeName: "studio-mini",
            hostName: "Studio-Mini.local",
            brokerUrl: "https://192.168.1.40:43110",
            webUrl: "http://127.0.0.1:43120",
            webHost: "studio-mini.scout.local",
          }],
        }),
        // Tailnet-only: a doorway name derived from the node name is still the
        // better link — the local edge proxies it over the tailnet route.
        machine({
          name: "workbench",
          scoutNodeId: "node-workbench",
          capabilities: ["scout-broker"],
          routes: [{ kind: "tailnet", host: "workbench.tail-abc.ts.net", lastSeenAt: NOW }],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-workbench",
            nodeName: "workbench",
            brokerUrl: "https://100.64.0.12:43110",
          }],
        }),
        // A LAN route but no name evidence: the bare address is the link.
        machine({
          name: "noname",
          scoutNodeId: "node-noname",
          capabilities: ["scout-broker"],
          routes: [{ kind: "lan", host: "192.168.1.41", lastSeenAt: NOW }],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-noname",
            nodeName: "",
          }],
        }),
        // A node that announces a real web URL is linked exactly as announced.
        machine({
          name: "relay",
          scoutNodeId: "node-relay",
          capabilities: ["scout-web"],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-relay",
            nodeName: "relay",
            webUrl: "https://scout.example.com/",
          }],
        }),
        // Registered but with no dialable route: listed, not linked.
        machine({
          name: "ghost",
          scoutNodeId: "node-ghost",
          capabilities: ["scout-broker"],
          lastSeenAt: NOW - 3 * 60 * 60_000,
          evidence: [{
            kind: "scout",
            observedAt: NOW - 3 * 60 * 60_000,
            nodeId: "node-ghost",
            nodeName: "ghost",
          }],
        }),
        // A LAN machine that runs no Scout is not a portal row.
        machine({
          name: "printer",
          capabilities: ["smb"],
          routes: [{ kind: "lan", host: "192.168.1.50", lastSeenAt: NOW }],
        }),
      ],
    });

    const response = await server.app.request("http://127.0.0.1:4321/", {
      headers: { host: "scout.local:4321" },
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("This machine");
    expect(body).toContain('href="http://studio-mini.scout.local:4321/"');
    expect(body).toContain('href="http://workbench.scout.local:4321/"');
    expect(body).toContain("LAN · online");
    expect(body).toContain("Tailnet · online");
    expect(body).toContain('href="http://192.168.1.41/"');
    expect(body).toContain("LAN · online · noname");
    expect(body).toContain('href="https://scout.example.com/"');
    expect(body).toContain("Mesh · online");
    expect(body).toContain(">ghost</span>");
    expect(body).toContain("registered · offline");
    expect(body).not.toContain("printer");
  });

  test("a peer doorway host proxies to the peer's live route", async () => {
    const NOW = Date.now();
    const calls: Array<{ url: string; host: string | null; cookie: string | null }> = [];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      resolvePeerAddress: () => "127.0.0.1",
      portalMachines: async () => [
        makePortalPeerMachine({
          name: "studio-mini",
          scoutNodeId: "node-studio",
          capabilities: ["scout-broker", "scout-web"],
          routes: [{ kind: "lan", host: "192.168.1.40", lastSeenAt: NOW }],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-studio",
            nodeName: "studio-mini",
            webUrl: "http://127.0.0.1:43120",
            webHost: "studio-mini.scout.local",
          }],
        }),
      ],
      portalFetch: (async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL ? input.toString() : (input as Request).url;
        const headers = new Headers(init?.headers);
        calls.push({ url, host: headers.get("host"), cookie: headers.get("cookie") });
        if (new URL(url).pathname === "/go") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://192.168.1.40/home" },
          });
        }
        return new Response(`peer:${new URL(url).pathname}`, { status: 200 });
      }) as typeof fetch,
    });

    const response = await server.app.request(
      "http://studio-mini.scout.local/sessions/abc?x=1",
      { headers: { host: "studio-mini.scout.local", cookie: "openscout_web=session-cookie" } },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("peer:/sessions/abc");
    expect(calls).toEqual([{
      url: "http://192.168.1.40/sessions/abc?x=1",
      host: "studio-mini.scout.local",
      cookie: "openscout_web=session-cookie",
    }]);

    // Same-origin redirects come back pointing at the doorway, not the LAN IP.
    const redirect = await server.app.request("http://studio-mini.scout.local/go", {
      headers: { host: "studio-mini.scout.local" },
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("http://studio-mini.scout.local/home");
  });

  test("chat.scout.local is this node's own surface, never a peer doorway", async () => {
    const NOW = Date.now();
    const calls: string[] = [];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      resolvePeerAddress: () => "127.0.0.1",
      // A machine actually named `chat` is on the mesh and advertises the
      // doorway name. Reserving the label must beat it: otherwise anyone who
      // renames a laptop can capture the chat surface for the whole network.
      portalMachines: async () => [
        makePortalPeerMachine({
          name: "chat",
          scoutNodeId: "node-chat",
          capabilities: ["scout-broker", "scout-web"],
          routes: [{ kind: "lan", host: "192.168.1.50", lastSeenAt: NOW }],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-chat",
            nodeName: "chat",
            webUrl: "http://127.0.0.1:43120",
            webHost: "chat.scout.local",
          }],
        }),
      ],
      portalFetch: (async (input: unknown) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL ? input.toString() : (input as Request).url;
        calls.push(url);
        return new Response("peer", { status: 200 });
      }) as typeof fetch,
    });

    const response = await server.app.request("http://chat.scout.local/api/health", {
      headers: { host: "chat.scout.local" },
    });

    // Served locally: nothing was proxied to the peer that claimed the name.
    expect(calls).toEqual([]);
    expect(await response.text()).not.toBe("peer");
  });

  test("an advertised webUrl peer keeps its own host and origin upstream", async () => {
    const NOW = Date.now();
    const calls: Array<{ url: string; host: string | null; origin: string | null }> = [];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      resolvePeerAddress: () => "127.0.0.1",
      portalMachines: async () => [
        makePortalPeerMachine({
          name: "relay",
          scoutNodeId: "node-relay",
          capabilities: ["scout-web"],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-relay",
            nodeName: "relay",
            webUrl: "https://scout.example.com/",
            webHost: "relay.scout.local",
          }],
        }),
      ],
      portalFetch: (async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL ? input.toString() : (input as Request).url;
        const headers = new Headers(init?.headers);
        calls.push({ url, host: headers.get("host"), origin: headers.get("origin") });
        return new Response("peer", { status: 200 });
      }) as typeof fetch,
    });

    const response = await server.app.request("http://relay.scout.local/api/state", {
      headers: { host: "relay.scout.local", origin: "http://relay.scout.local" },
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      url: "https://scout.example.com/api/state",
      host: null,
      origin: "https://scout.example.com",
    }]);
  });

  test("a doorway host without a dialable route never serves the local app", async () => {
    const NOW = Date.now();
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      resolvePeerAddress: () => "127.0.0.1",
      portalMachines: async () => [
        makePortalPeerMachine({
          name: "ghost",
          scoutNodeId: "node-ghost",
          capabilities: ["scout-broker"],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-ghost",
            nodeName: "ghost",
          }],
        }),
      ],
    });

    const response = await server.app.request("http://ghost.scout.local/", {
      headers: { host: "ghost.scout.local" },
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("ghost");
  });

  test("an unknown doorway host and a LAN client never reach the peer proxy", async () => {
    const NOW = Date.now();
    let proxied = 0;
    const portalFetch = (async () => {
      proxied += 1;
      return new Response("peer", { status: 200 });
    }) as typeof fetch;
    const make = (resolvePeerAddress: () => string) => createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      resolvePeerAddress,
      portalMachines: async () => [
        makePortalPeerMachine({
          name: "studio-mini",
          scoutNodeId: "node-studio",
          capabilities: ["scout-web"],
          routes: [{ kind: "lan", host: "192.168.1.40", lastSeenAt: NOW }],
          evidence: [{
            kind: "scout",
            observedAt: NOW,
            nodeId: "node-studio",
            nodeName: "studio-mini",
            webHost: "studio-mini.scout.local",
          }],
        }),
      ],
      portalFetch,
    });

    // Unknown doorway name: the local app answers, nothing is proxied.
    const local = await make(() => "127.0.0.1");
    const miss = await local.app.request("http://stranger.scout.local/", {
      headers: { host: "stranger.scout.local" },
    });
    expect(miss.status).toBe(200);
    expect(await miss.text()).toContain("<body>ok</body>");

    // A LAN client with a peer doorway Host header is not a doorway request.
    const remote = await make(() => "192.168.1.99");
    const lan = await remote.app.request("http://studio-mini.scout.local/", {
      headers: { host: "studio-mini.scout.local" },
    });
    expect(lan.status).toBe(200);
    expect(await lan.text()).toContain("<body>ok</body>");
    expect(proxied).toBe(0);
  });

  test("the local portal still renders when the machine roster is unavailable", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      portalMachines: async () => {
        throw new Error("broker offline");
      },
    });

    const response = await server.app.request("http://127.0.0.1:4321/", {
      headers: { host: "scout.local:4321" },
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Scout local");
    expect(body).toContain("m1.scout.local");
  });

  test("serves the web app directly for the node host without a portal redirect", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
    });

    const response = await server.app.request("http://127.0.0.1:4321/", {
      headers: { host: "m1.scout.local:4321" },
    });

    expect(response.status).toBe(200);
    expect(response.redirected).toBe(false);
    expect(await response.text()).toContain("<body>ok</body>");
  });

  test("derives the relay health route from the configured relay path by default", async () => {
    const originalRelayPath = process.env.OPENSCOUT_WEB_TERMINAL_RELAY_PATH;
    const originalRelayHealthPath = process.env.OPENSCOUT_WEB_TERMINAL_RELAY_HEALTH_PATH;
    process.env.OPENSCOUT_WEB_TERMINAL_RELAY_PATH = "/ws/relay";
    delete process.env.OPENSCOUT_WEB_TERMINAL_RELAY_HEALTH_PATH;

    try {
      const server = await createOpenScoutWebServer({
        currentDirectory: "/tmp/openscout",
        assetMode: "static",
        staticRoot: makeStaticRoot(),
      });

      const response = await server.app.request("http://localhost/api/bootstrap.js");
      const body = await response.text();
      expect(body).toContain('"terminalRelayPath":"/ws/relay"');
      expect(body).toContain('"terminalRelayHealthPath":"/ws/relay/health"');
      expect(body).toContain('"tailStreamPath":"/ws/tail"');
      expect(body).toContain('"eventsStreamPath":"/ws/events"');
    } finally {
      if (originalRelayPath === undefined) {
        delete process.env.OPENSCOUT_WEB_TERMINAL_RELAY_PATH;
      } else {
        process.env.OPENSCOUT_WEB_TERMINAL_RELAY_PATH = originalRelayPath;
      }
      if (originalRelayHealthPath === undefined) {
        delete process.env.OPENSCOUT_WEB_TERMINAL_RELAY_HEALTH_PATH;
      } else {
        process.env.OPENSCOUT_WEB_TERMINAL_RELAY_HEALTH_PATH = originalRelayHealthPath;
      }
    }
  });

  test("serves terminal relay health at the configured route", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      terminalRelayHealthcheck: async () => true,
    });

    const okResponse = await server.app.request("http://localhost/ws/terminal/health");
    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({
      ok: true,
      surface: "openscout-terminal-relay",
    });

    const unavailableServer = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const unavailableResponse = await unavailableServer.app.request("http://localhost/ws/terminal/health");
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({
      ok: false,
      surface: "openscout-terminal-relay",
    });
  });

  test("returns JSON for unknown API routes instead of the app shell", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/repo-diff/missing");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: "unknown api route: /api/repo-diff/missing",
    });
  });

  test("proxies UI routes to the configured Vite dev server", async () => {
    const fetchCalls: Array<{
      input: string;
      init: RequestInit | undefined;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push({
        input: String(input),
        init,
      });
      return new Response("<!doctype html><html><body>vite</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as typeof fetch;

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "vite-proxy",
      viteDevUrl: "http://127.0.0.1:43122",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      "http://localhost/agents/demo?tab=inbox",
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("vite");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe(
      "http://127.0.0.1:43122/agents/demo?tab=inbox",
    );
    expect(fetchCalls[0]?.init?.method).toBe("GET");
    expect(fetchCalls[0]?.init?.headers).toBeInstanceOf(Headers);
    expect(fetchCalls[0]?.init?.body).toBeUndefined();
  });
});
