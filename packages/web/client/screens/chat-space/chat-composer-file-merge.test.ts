import { expect, test } from "bun:test";
import { composerFileId, mergeComposerFiles } from "../../lib/composer-file-recovery.ts";

test("separate tabs staging the same capture retain one chip while newer captures stay distinct", () => {
  const first = new File(["abc"], "shot.png", { lastModified: 100 });
  const otherTab = new File(["abc"], "shot.png", { lastModified: 100 });
  const newer = new File(["abc"], "shot.png", { lastModified: 200 });
  expect(composerFileId(first)).not.toBe(composerFileId(otherTab));
  expect(mergeComposerFiles([first], [otherTab, otherTab, newer])).toEqual([first, newer]);
  expect(mergeComposerFiles([], [first, otherTab])).toEqual([first]);
});
