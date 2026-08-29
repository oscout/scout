import {
  paintRgbaPixels,
  type PixelPaintPalette,
  type PixelPaintProfile,
} from "./pixel-paint.ts";

const cache = new Map<string, Promise<string>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load pixel paint master: ${src}`));
    image.src = src;
  });
}

/**
 * Returns a cached PNG data URL for use in an <img>. The browser performs the
 * recolor once per source/profile/palette tuple; callers never hit an image API.
 */
export function paintPixelImage(
  src: string,
  profile: PixelPaintProfile,
  palette: PixelPaintPalette,
): Promise<string> {
  const cacheKey = JSON.stringify([src, profile, palette]);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = loadImage(src).then((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D is unavailable for pixel painting");
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    imageData.data.set(paintRgbaPixels(imageData.data, profile, palette));
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  });

  cache.set(cacheKey, result);
  result.catch(() => cache.delete(cacheKey));
  return result;
}
