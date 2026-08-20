import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertValidModelWorldview,
  buildModelWorldview,
  type ModelWorldview,
} from "./model-worldview.js";

/**
 * The published JSON is a complete projection of the TS picks. Comparing the
 * whole object keeps every consumer-visible field — including economics
 * context and structured-output support — from drifting independently.
 */
const PUBLISHED = join(
  import.meta.dir,
  "../../../landing/openscout.app/public/.well-known/model-worldview.json",
);

// The published projection lives in the monorepo landing tree; source-only
// checkouts validate the pure projection and skip the drift guard.
const publishedFile = Bun.file(PUBLISHED);
const hasPublished = await publishedFile.exists();
const worldview = hasPublished
  ? ((await publishedFile.json()) as ModelWorldview)
  : buildModelWorldview(new Date().toISOString().slice(0, 10));

describe("model-worldview.json", () => {
  test.skipIf(!hasPublished)("round-trips the complete pure projection", () => {
    expect(worldview).toEqual(buildModelWorldview(worldview.generatedAt));
  });

  test("satisfies the schema-1 consumer invariants", () => {
    expect(() => assertValidModelWorldview(worldview)).not.toThrow();
    expect(worldview.schema).toBe(1);
    expect(worldview.families.length).toBeGreaterThan(0);
    for (const family of worldview.families) {
      expect(family.id.trim()).not.toBe("");
      expect(family.inexpensive.trim()).not.toBe("");
    }
  });

  test("rejects blank or whitespace-only ids and picks", () => {
    const blankId = structuredClone(worldview);
    blankId.families[0]!.id = "   ";
    expect(() => assertValidModelWorldview(blankId)).toThrow(/family id must not be blank/u);

    const blankPick = structuredClone(worldview);
    blankPick.families[0]!.inexpensive = "\t";
    expect(() => assertValidModelWorldview(blankPick)).toThrow(/inexpensive pick must not be blank/u);
  });

  test("rejects duplicate family ids and inexpensive picks", () => {
    const duplicateId = structuredClone(worldview);
    duplicateId.families[1]!.id = duplicateId.families[0]!.id;
    expect(() => assertValidModelWorldview(duplicateId)).toThrow(
      /duplicate model worldview family id/u,
    );

    const duplicatePick = structuredClone(worldview);
    duplicatePick.families[1]!.inexpensive = duplicatePick.families[0]!.inexpensive;
    expect(() => assertValidModelWorldview(duplicatePick)).toThrow(
      /duplicate inexpensive model pick/u,
    );
  });
});
