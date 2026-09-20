import { describe, expect, test, spyOn } from "bun:test";

import {
  extractHttpUrls,
  fetchLinkPreview,
  supportedPreviewUrl,
  readBoundedHtml,
  LinkPreviewCache,
  githubOpenGraphFallback,
  parseOpenGraph,
  safePublicHttpUrl,
} from "./link-preview.ts";

describe("safePublicHttpUrl", () => {
  test("allows public https and rejects loopback and .local", () => {
    expect(safePublicHttpUrl("https://github.com/arach/openscout")).toContain("github.com");
    expect(safePublicHttpUrl("http://127.0.0.1/secret")).toBeNull();
    expect(safePublicHttpUrl("http://10.0.0.4/secret")).toBeNull();
    expect(safePublicHttpUrl("http://192.168.1.9/secret")).toBeNull();
    expect(safePublicHttpUrl("http://[::1]/secret")).toBeNull();
    expect(safePublicHttpUrl("http://chat.scout.local/chat")).toBeNull();
    expect(safePublicHttpUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("extractHttpUrls", () => {
  test("dedupes and strips trailing punctuation", () => {
    expect(extractHttpUrls("see https://github.com/arach/openscout, and https://github.com/arach/openscout.")).toEqual([
      "https://github.com/arach/openscout",
    ]);
  });

  test("skips blob URLs", () => {
    expect(extractHttpUrls("shot https://example.com/api/blobs/abc and https://github.com/arach/openscout")).toEqual([
      "https://github.com/arach/openscout",
    ]);
  });
});

describe("githubOpenGraphFallback", () => {
  test("mints GitHub OG images for repo, pull, issue, and commit", () => {
    expect(githubOpenGraphFallback("https://github.com/arach/openscout")?.imageUrl)
      .toBe("https://opengraph.githubassets.com/1/arach/openscout");
    expect(githubOpenGraphFallback("https://github.com/arach/openscout/pull/12")?.imageUrl)
      .toBe("https://opengraph.githubassets.com/1/arach/openscout/pull/12");
    expect(githubOpenGraphFallback("https://www.github.com/arach/openscout/issues/3")?.imageUrl)
      .toBe("https://opengraph.githubassets.com/1/arach/openscout/issues/3");
    expect(githubOpenGraphFallback("https://github.com/arach/openscout/commit/abc123")?.imageUrl)
      .toBe("https://opengraph.githubassets.com/1/arach/openscout/commit/abc123");
    expect(githubOpenGraphFallback("https://github.com/arach")).toBeNull();
    expect(githubOpenGraphFallback("https://example.com/arach/openscout")).toBeNull();
  });
});

describe("parseOpenGraph", () => {
  test("reads github-style og tags", () => {
    const html = `
      <meta property="og:title" content="arach/openscout">
      <meta property="og:description" content="Local-first agent coordination.">
      <meta property="og:image" content="https://opengraph.githubassets.com/1/arach/openscout">
      <meta property="og:site_name" content="GitHub">
      <title>GitHub - arach/openscout</title>
    `;
    const preview = parseOpenGraph(html, "https://github.com/arach/openscout");
    expect(preview.title).toBe("arach/openscout");
    expect(preview.siteName).toBe("GitHub");
    expect(preview.imageUrl).toBe("https://opengraph.githubassets.com/1/arach/openscout");
    expect(preview.description).toContain("Local-first");
  });
});

describe("bounded preview fetching", () => {
  test("only trusted HTTPS GitHub authorities can initiate requests", async () => {
    for (const url of [
      "https://attacker.example/", "https://github.com.attacker.example/",
      "https://github.com:8443/repo", "http://github.com/repo",
      "https://user:pass@github.com/repo", "http://100.64.0.1/",
      "http://[::ffff:7f00:1]/", "http://[fe90::1]/", "http://0.1.2.3/",
    ]) {
      expect(supportedPreviewUrl(url)).toBeNull();
      expect(await fetchLinkPreview(url)).toBeNull();
    }
    expect(supportedPreviewUrl("https://github.com/arach/openscout")).not.toBeNull();
  });

  test("stops reading and cancels when the byte budget is exhausted", async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("abcdefgh"));
      },
      cancel() { cancelled = true; },
    });
    expect(await readBoundedHtml(new Response(stream), 10)).toBe("abcdefghab");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  test("bounds bytes rather than Unicode character count", async () => {
    expect(await readBoundedHtml(new Response("éééé"), 4)).toBe("éé");
  });

  test("evicts old cache entries and expires stale entries", () => {
    const cache = new LinkPreviewCache(2);
    const entry = { preview: null, expiresAt: Date.now() + 10_000 };
    cache.set("a", entry);
    cache.set("b", entry);
    cache.set("c", entry);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual(entry);
    cache.set("expired", { preview: null, expiresAt: 0 });
    expect(cache.get("expired")).toBeUndefined();
  });
});


test("redirects cannot escape the trusted authority and their bodies are cancelled", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 302, headers: { location: "http://127.0.0.1/secret" } });
  const request = spyOn(globalThis, "fetch").mockResolvedValue(response);
  try {
    const preview = await fetchLinkPreview("https://github.com/arach/redirect-regression");
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
    expect(preview?.siteName).toBe("GitHub");
    expect(preview?.url).toBe("https://github.com/arach/redirect-regression");
  } finally {
    request.mockRestore();
  }
});
