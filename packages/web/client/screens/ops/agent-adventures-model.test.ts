import { test, expect } from "bun:test";
import { adventureJourneys, adventureKind } from "./agent-adventures-model.ts";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { ObserveEvent } from "../../lib/types.ts";
const base = 1_700_000_000_000;
const event = (id: string, kind: ObserveEvent["kind"], text: string, extra = {}): ObserveEvent => ({ id, kind, text, at: base + Number(id) * 1000, t: Number(id), ...extra });
const lane = (events: ObserveEvent[]) => ({ id: "agent", observe: { events, files: [] } }) as unknown as AgentLane;
test("only observed lifecycle records close turns, never prose or elapsed time", () => {
 const input = lane([event("1", "note", "turn started"), event("2", "message", "turn complete"), event("3", "tool", "task complete", { tool: "Bash" })]);
 expect(adventureJourneys(input, base + 100_000)[0]!.closed).toBe(false);
 expect(adventureJourneys(input, base + 10_000_000)).toEqual(adventureJourneys(input, base + 100_000));
});
test("splits observed turns and preserves partial history and interruptions", () => {
 const input = lane([event("1", "tool", "read", {tool: "Read"}), event("2", "note", "turn ended"), event("3", "note", "turn started"), event("4", "system", "turn aborted by user")]);
 const result = adventureJourneys(input, base + 5000);
 expect(result).toHaveLength(2);
 expect(result[0]!.partial).toBe(true);
 expect(result[1]!.partial).toBe(false);
 expect(result[1]!.stops.at(-1)!.kind).toBe("stopped");
});
test("excludes future and unclocked events, deduplicates records", () => {
 const first = event("1", "think", "thinking");
 expect(adventureJourneys(lane([first, first, event("3", "note", "turn complete"), {...event("0", "think", "unknown"), at: undefined}]), base + 2000)[0]!.stops).toHaveLength(1);
});
test("maps observed activity to meaningful props", () => {
 expect(adventureKind(event("1", "tool", "file", { tool: "Read" }))).toBe("read");
 expect(adventureKind(event("1", "tool", "file", { tool: "apply_patch" }))).toBe("edit");
 expect(adventureKind(event("1", "tool", "hold", { tool: "wait" }))).toBe("wait");
 expect(adventureKind(event("1", "note", "token usage record"))).toBeNull();
});

test("terminal input is not a file edit and observed failures end a journey", () => {
 expect(adventureKind(event("1", "tool", "poll", {tool: "write_stdin"}))).toBe("tool");
 expect(adventureKind(event("1", "system", "task failed"))).toBe("stopped");
 expect(adventureKind(event("1", "note", "turn completed"))).toBe("end");
});
