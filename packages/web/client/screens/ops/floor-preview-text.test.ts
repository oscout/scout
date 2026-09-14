import { expect, test } from "bun:test";
import { floorPreviewText } from "./floor-preview-text.ts";
test("removes image wrappers and paths while preserving the request", () => {
 expect(floorPreviewText('Please improve spacing. <image name="Image #1" path="/private/tmp/screenshot.png"></image>')).toBe("Please improve spacing.");
 expect(floorPreviewText('<image name="Image #1" path="/private/tmp/screenshot.png"></image>')).toBe("Image attached");
});
test("truncated attachment attributes cannot leak into previews", () => {
 expect(floorPreviewText('<image name="Image #1" path="/private/tmp/screen')).toBe("Image attached");
});
test("removes ambient browser payload and lightweight markdown", () => {
 expect(floorPreviewText('<in-app-browser-context>Current URL: localhost</in-app-browser-context> **Fix** the `labels` [here](https://example.com).')).toBe("Fix the labels here.");
});
test("keeps ordinary comparisons and bounds the visible result", () => {
 expect(floorPreviewText('Keep x < 4 and y > 2')).toBe('Keep x < 4 and y > 2');
 expect(floorPreviewText('A longer sentence', 8)).toBe('A longe…');
});
test("removes nested environment metadata while preserving surrounding task prose", () => {
 const text = 'Keep the caption short. <environment_context><current_date>2026-09-08</current_date><timezone>America/Montreal</timezone><filesystem><workspace_roots>/private/work</workspace_roots></filesystem></environment_context> Then fix the hover.';
 expect(floorPreviewText(text)).toBe('Keep the caption short. Then fix the hover.');
});
test("metadata-only and truncated environment snippets are empty", () => {
 expect(floorPreviewText('<environment_context>\n<timezone>America/Montreal</timezone>')).toBe('');
 expect(floorPreviewText('<environment_context source="')).toBe('');
 expect(floorPreviewText('<timezone>America/Montreal</timezone></environment_context>')).toBe('');
});
test("keeps delegated input and excludes repeated transcript/context scaffolding", () => {
 expect(floorPreviewText('<realtime_delegation><input>Make the actors clearer.</input><transcript_delta>user: old conversation</transcript_delta></realtime_delegation>')).toBe('Make the actors clearer.');
});
test("context cleanup happens before excerpt truncation", () => {
 expect(floorPreviewText(`<environment_context>${'timezone metadata '.repeat(50)}</environment_context>Fix the names.`, 30)).toBe('Fix the names.');
});
test("ordinary timezone prose and comparison syntax remain readable", () => {
 expect(floorPreviewText('Show the timezone beside the clock; keep x < 4.')).toBe('Show the timezone beside the clock; keep x < 4.');
});
