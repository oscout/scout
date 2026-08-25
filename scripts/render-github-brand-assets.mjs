import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, ".github", "assets");

const jobs = [
  ["avatar.svg", "avatar.png"],
  ["readme-hero.svg", "readme-hero.png"],
  ["social-preview.svg", "social-preview.png"],
];

for (const [source, output] of jobs) {
  await sharp(join(assets, source), { density: 144 })
    .png({ compressionLevel: 9 })
    .toFile(join(assets, output));
  console.log(`rendered .github/assets/${output}`);
}
