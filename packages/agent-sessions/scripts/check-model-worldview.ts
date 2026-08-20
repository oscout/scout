/** Regenerate the worldview at a temporary path and compare it byte-for-byte. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLISHED_MODEL_WORLDVIEW,
  generateModelWorldviewFile,
} from "./generate-model-worldview.js";
import type { ModelWorldview } from "../src/model-worldview.js";

const published = (await Bun.file(PUBLISHED_MODEL_WORLDVIEW).json()) as ModelWorldview;
const tempDirectory = await mkdtemp(join(tmpdir(), "openscout-model-worldview-"));
const generated = join(tempDirectory, "model-worldview.json");

try {
  await generateModelWorldviewFile(generated, published.generatedAt);
  const [publishedText, generatedText] = await Promise.all([
    Bun.file(PUBLISHED_MODEL_WORLDVIEW).text(),
    Bun.file(generated).text(),
  ]);

  if (publishedText !== generatedText) {
    throw new Error(
      "model-worldview.json has drifted; run `bun scripts/generate-model-worldview.ts`",
    );
  }

  console.log(
    `model worldview is current (${published.families.length} families, ${published.generatedAt})`,
  );
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
