import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectTrustedRoots,
  readFilePreview,
  resolveTrustedPath,
  type TrustedRoot,
} from "./file-preview.ts";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) rmSync(path, { force: true, recursive: true });
  }
});

function makeRoot(prefix = "openscout-file-preview-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

function trustedRoot(path: string): TrustedRoot {
  return { path: realpathSync(path), source: "current-directory" };
}

function expectedRawUrl(path: string): string {
  return `/api/file/raw${path.split("/").map(encodeURIComponent).join("/")}`;
}

describe("file preview path resolution", () => {
  test("resolves relative paths inside a trusted workspace root", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    const filePath = join(root, "src", "app.ts");
    writeFileSync(filePath, "export const app = true;\n", "utf8");

    const result = resolveTrustedPath({
      requestedPath: "src/app.ts",
      roots: [trustedRoot(root)],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realPath).toBe(realpathSync(filePath));
      expect(result.root.path).toBe(realpathSync(root));
    }
  });

  test("rejects symlinks that resolve outside trusted roots", () => {
    const root = makeRoot();
    const outside = makeRoot("openscout-file-preview-outside-");
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "do not leak\n", "utf8");
    const linkPath = join(root, "secret.txt");
    symlinkSync(outsideFile, linkPath);

    const result = resolveTrustedPath({
      requestedPath: linkPath,
      roots: [trustedRoot(root)],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  test("collects the real system temp directory as an explicit trusted root", () => {
    const roots = collectTrustedRoots({ currentDirectory: process.cwd() });
    const tempRoot = realpathSync(tmpdir());

    expect(roots).toContainEqual({ path: tempRoot, source: "system-temp" });
  });

  test("allows an absolute file under a system temp root", () => {
    const filePath = join(tmpdir(), `openscout-temp-preview-${Date.now()}.txt`);
    writeFileSync(filePath, "temp preview ok\n", "utf8");
    cleanup.push(filePath);

    const result = resolveTrustedPath({
      requestedPath: filePath,
      roots: [{ path: realpathSync(tmpdir()), source: "system-temp" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realPath).toBe(realpathSync(filePath));
      expect(result.root.source).toBe("system-temp");
    }
  });
});

describe("readFilePreview", () => {
  test("returns directory entries sorted with folders first", () => {
    const root = makeRoot();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "README.md"), "# Hello\n", "utf8");

    const result = readFilePreview({ requestedPath: root, currentDirectory: root });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.kind).toBe("directory");
      if (result.content.kind === "directory") {
        expect(result.content.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
          "directory:docs",
          "file:README.md",
        ]);
      }
    }
  });

  test("returns raw media metadata without a text payload", () => {
    const root = makeRoot();
    const imagePath = join(root, "preview.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const result = readFilePreview({ requestedPath: imagePath, currentDirectory: root });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.kind).toBe("file");
      expect(result.content.previewable).toBe(false);
      expect(result.content.mediaType).toBe("image/png");
      expect(result.content.sizeBytes).toBe(5);
      expect(result.content.rawUrl).toBe(expectedRawUrl(realpathSync(imagePath)));
      expect("content" in result.content).toBe(false);
    }
  });

  test("uses path-shaped raw URLs so iframe-relative assets stay in the same folder", () => {
    const root = makeRoot();
    const pagePath = join(root, "reports", "daily summary.html");
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(pagePath, "<!doctype html><link rel=\"stylesheet\" href=\"style.css\">", "utf8");

    const result = readFilePreview({ requestedPath: pagePath, currentDirectory: root });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const realPagePath = realpathSync(pagePath);
      const realReportsPath = realpathSync(join(root, "reports"));
      expect(result.content.kind).toBe("file");
      expect(result.content.rawUrl).toBe(expectedRawUrl(realPagePath));
      expect(new URL("style.css", `http://localhost${result.content.rawUrl}`).pathname).toBe(
        expectedRawUrl(join(realReportsPath, "style.css")),
      );
    }
  });

  test("truncates large text previews using the preview byte limit", () => {
    const root = makeRoot();
    const logPath = join(root, "large.log");
    const body = "x".repeat(300 * 1024);
    writeFileSync(logPath, body, "utf8");

    const result = readFilePreview({ requestedPath: logPath, currentDirectory: root });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.kind).toBe("file");
      expect(result.content.previewable).toBe(true);
      if (result.content.previewable) {
        expect(result.content.truncated).toBe(true);
        expect(result.content.sizeBytes).toBe(body.length);
        expect(result.content.content.length).toBeLessThan(body.length);
      }
    }
  });
});
