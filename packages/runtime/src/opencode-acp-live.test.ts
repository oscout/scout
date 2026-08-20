import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createLocalAgentClient } from "@openscout/agent-sessions/local";

// Excluded from the unit run by the `**/*live.test.ts` ignore pattern: this
// spawns a real `opencode acp` process and spends real tokens. Run it with
// `bun run --cwd packages/runtime test:live:opencode-acp`.

const OPENCODE_AUTH = join(homedir(), ".local", "share", "opencode", "auth.json");

// A free Zen model keeps the smoke test cheap and credential-free. Ids are
// provider-qualified (`opencode/*` = Zen, `opencode-go/*` = the subscription);
// a bare id is qualified against Zen.
const SMOKE_MODEL = process.env.OPENCODE_SMOKE_MODEL ?? "opencode/laguna-s-2.1-free";

const authenticated = existsSync(OPENCODE_AUTH) || Boolean(process.env.OPENCODE_API_KEY);

describe.skipIf(!authenticated)("opencode acp live", () => {
  test("completes a turn through the local agent client", async () => {
    const client = await createLocalAgentClient({
      harness: "opencode",
      transport: "opencode_acp",
      cwd: process.cwd(),
      sessionId: `opencode-acp-live-${Date.now()}`,
      model: SMOKE_MODEL,
      warmth: "lazy",
    });

    try {
      const turn = await client.turn({
        input: "Reply with exactly: SCOUT_OPENCODE_OK",
        timeoutMs: 180_000,
      });

      expect(turn.text).toContain("SCOUT_OPENCODE_OK");
      // A provider-native id is what a later cold resume attaches to, so an
      // empty one would silently break session continuity.
      expect(turn.session.nativeId?.trim()).toBeTruthy();
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 300_000);
});
