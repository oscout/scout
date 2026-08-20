import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createArtifactPresentation,
  purgeExpiredArtifactPresentations,
  revokeArtifactPresentation,
  serveArtifactPresentation,
} from "./artifact-presentation.ts";

const temporaryRoots: string[] = [];
const grantIds: string[] = [];

afterEach(async () => {
  while (grantIds.length > 0) {
    revokeArtifactPresentation(grantIds.pop()!);
  }
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scout-presentation-"));
  temporaryRoots.push(root);
  return root;
}

function remember<T extends { id: string }>(grant: T): T {
  grantIds.push(grant.id);
  return grant;
}

test("presentation grants preserve a static artifact's relative tree", async () => {
  const root = await fixtureRoot();
  await mkdir(join(root, "study", "assets"), { recursive: true });
  await writeFile(
    join(root, "study", "index.html"),
    '<link rel="stylesheet" href="assets/app.css"><img src="assets/shot.png">',
  );
  await writeFile(join(root, "study", "assets", "app.css"), "body { color: tomato; }\n");
  await writeFile(join(root, "study", "assets", "shot.png"), "fake-png");

  const grant = remember(createArtifactPresentation(
    { sourcePath: join(root, "study"), title: "Studio study" },
    { allowedRoot: root, now: 1_000 },
  ));

  expect(grant.path).toMatch(/^\/present\/present-[A-Za-z0-9_-]+\/index\.html$/);
  const entryURL = new URL(grant.path, "http://scout.local:43132");
  const entry = serveArtifactPresentation(new Request(entryURL), entryURL, 2_000);
  expect(entry?.status).toBe(200);
  expect(await entry?.text()).toContain('href="assets/app.css"');
  expect(entry?.headers.get("referrer-policy")).toBe("no-referrer");

  const cssURL = new URL("assets/app.css", entryURL);
  const css = serveArtifactPresentation(new Request(cssURL), cssURL, 2_000);
  expect(css?.status).toBe(200);
  expect(await css?.text()).toContain("color: tomato");
});

test("a single-file grant uses the parent only to keep sibling references working", async () => {
  const root = await fixtureRoot();
  await writeFile(join(root, "README.md"), "![shot](shot.png)\n");
  await writeFile(join(root, "shot.png"), "fake-png");

  const grant = remember(createArtifactPresentation(
    { sourcePath: join(root, "README.md") },
    { allowedRoot: root },
  ));
  expect(grant.entryPath).toBe("README.md");

  const shotURL = new URL(
    grant.path.replace(/README\.md$/, "shot.png"),
    "http://scout.local:43132",
  );
  const shot = serveArtifactPresentation(new Request(shotURL), shotURL);
  expect(shot?.status).toBe(200);
  expect(await shot?.text()).toBe("fake-png");
});

test("presentation grants reject workspace escapes and symlink escapes", async () => {
  const root = await fixtureRoot();
  const outside = await fixtureRoot();
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
  await writeFile(join(root, "index.html"), "ok");

  expect(() => createArtifactPresentation(
    { sourcePath: outside },
    { allowedRoot: root },
  )).toThrow("outside the session workspace");

  const grant = remember(createArtifactPresentation(
    { sourcePath: root },
    { allowedRoot: root },
  ));
  const linkURL = new URL(
    grant.path.replace(/index\.html$/, "secret-link.txt"),
    "http://scout.local:43132",
  );
  const link = serveArtifactPresentation(new Request(linkURL), linkURL);
  expect(link?.status).toBe(403);
});

test("presentation grants expire and reject non-read methods", async () => {
  const root = await fixtureRoot();
  await writeFile(join(root, "index.html"), "hello");
  const grant = remember(createArtifactPresentation(
    { sourcePath: root, ttlMs: 1_000 },
    { allowedRoot: root, now: 10_000 },
  ));
  const url = new URL(grant.path, "http://scout.local:43132");

  const post = serveArtifactPresentation(new Request(url, { method: "POST" }), url, 10_500);
  expect(post?.status).toBe(405);

  const expired = serveArtifactPresentation(new Request(url), url, 11_001);
  expect(expired?.status).toBe(404);
  expect(purgeExpiredArtifactPresentations(11_001)).toBe(0);
});
