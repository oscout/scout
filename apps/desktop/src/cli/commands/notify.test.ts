import { expect, test } from "bun:test";
import { parseNotifyCommandOptions } from "./notify.ts";
import { parseOperatorQuestionOptions, renderOperatorQuestionHelp } from "./operator-question.ts";
import { renderScoutHelp } from "../help.ts";

test("notify requires intentional content and supports an image", () => {
  expect(() => parseNotifyCommandOptions(["--image", "screen.png"])).toThrow("--message");
  expect(() => parseNotifyCommandOptions(["--message", "  "])).toThrow("non-empty");
  expect(() => parseNotifyCommandOptions(["--to", "other-agent"])).toThrow("unknown notify");
  expect(parseNotifyCommandOptions(["--message", "Review this", "--image", "screen.png"])).toMatchObject({ message: "Review this", image: "screen.png" });
});

test("operator permission is an explicit question, and public help teaches the new verbs", () => {
  expect(parseOperatorQuestionOptions(["--question", "May I deploy to staging?", "--permission"]).permission).toBe(true);
  expect(renderOperatorQuestionHelp()).toContain("does not grant harness permissions");
  const help = renderScoutHelp();
  expect(help).toContain("scout status --all --blocked");
  expect(help).toContain("scout notify --message");
  expect(help).not.toContain("scout attention");
  expect(help).not.toContain("scout need");
});
