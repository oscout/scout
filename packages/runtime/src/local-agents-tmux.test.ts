import { describe, expect, test } from "bun:test";

import {
  buildTmuxDispatchStrategy,
  buildTmuxLaunchShellCommand,
  buildTmuxPasteBufferArgs,
  tmuxPaneTailContainsPromptFragment,
  tmuxPaneTailShowsReadyComposer,
  tmuxVerifyDeadlineMs,
} from "./local-agents";

function paneTail(lines: string[]): string {
  return lines.join("\n");
}

const brokerAskPrompt =
  "New broker ask from operator. Task: please refactor the dispatch path so it submits the prompt.";

describe("tmux prompt delivery", () => {
  test("quotes launch scripts with spaces", () => {
    expect(buildTmuxLaunchShellCommand("/Users/arach/Library/Application Support/OpenScout/runtime/agents/spectator/launch.sh"))
      .toBe('exec bash "/Users/arach/Library/Application Support/OpenScout/runtime/agents/spectator/launch.sh"');
  });

  test("pastes prompts as bracketed raw input before sending one submit key", () => {
    expect(buildTmuxPasteBufferArgs("openscout-prompt-test", "relay-agent")).toEqual([
      "paste-buffer",
      "-dpr",
      "-b",
      "openscout-prompt-test",
      "-t",
      "relay-agent",
    ]);

    const claudeStrategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const piStrategy = buildTmuxDispatchStrategy("pi", brokerAskPrompt);
    expect(claudeStrategy.pre).toBeUndefined();
    expect(claudeStrategy.submit).toEqual(["Enter"]);
    expect(piStrategy.submit).toEqual(["Enter"]);
  });

  test("verifier treats a composer-held prompt as not submitted", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const stuckTail = paneTail([
      "╭──────────────────────────────────────────────────────────────────╮",
      "│ > New broker ask from operator. Task: please refactor the        │",
      "│   dispatch path so it submits the prompt.                        │",
      "╰──────────────────────────────────────────────────────────────────╯",
    ]);

    expect(strategy.verify(stuckTail)).toBe(false);
  });

  test("verifier treats an empty composer after harness activity as submitted", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const submittedTail = paneTail([
      "● Reading file...",
      "  packages/runtime/src/local-agents.ts",
      "╭──────────────────────────────────────────────────────────────────╮",
      "│ >                                                                │",
      "╰──────────────────────────────────────────────────────────────────╯",
    ]);

    expect(strategy.verify(submittedTail)).toBe(true);
  });

  test("verifier does not accept unrelated non-empty composer text", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const pendingTail = paneTail([
      "───────────────────────────── relay-agent ──",
      "❯ draft still pending in the composer",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Sonnet 4.6 │ ⎇ main │ ~/dev/openscout",
    ]);

    expect(strategy.verify(pendingTail)).toBe(false);
  });

  test("verifier does not accept Claude's collapsed paste placeholder", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const pendingTail = paneTail([
      "───────────────────────────── relay-agent ──",
      "❯ [Pasted text #1 +111 lines]",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Sonnet 4.6 │ ⎇ main │ ~/dev/openscout",
    ]);

    expect(strategy.verify(pendingTail)).toBe(false);
  });

  test("verifier requires activity after the prompt, not stale activity above it", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const pendingTail = paneTail([
      "⏺ Read(packages/runtime/src/local-agents.ts)",
      "  ⎿  Read 30 lines",
      "",
      "───────────────────────────── relay-agent ──",
      "❯ [Pasted text #1 +111 lines]",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Sonnet 4.6 │ ⎇ main │ ~/dev/openscout",
    ]);

    expect(strategy.verify(pendingTail)).toBe(false);
  });

  test("verifier accepts a prompt queued while Claude is actively working", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const queuedTail = paneTail([
      "⏺ Update(packages/runtime/src/local-agents.ts)",
      "  ⎿  Added 9 lines, removed 2 lines",
      "",
      "───────────────────────────── relay-agent ──",
      "❯ New broker ask from operator. Task: please refactor the dispatch path so it submits the prompt.",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Opus 5 │ ⎇ main │ ~/dev/openscout",
      "  ✻ Working… (esc to interrupt) · 12.4k tokens",
    ]);

    expect(strategy.verify(queuedTail)).toBe(true);
  });

  test("verifier accepts Claude's queued-message composer placeholder", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const queuedTail = paneTail([
      "❯ New broker ask from operator. Task: please refactor the dispatch path so it submits the prompt.",
      "",
      "⏺ Update(packages/runtime/src/local-agents.ts)",
      "  ⎿  Added 9 lines, removed 2 lines",
      "",
      "───────────────────────────── relay-agent ──",
      "❯ Press up to edit queued messages",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Opus 5 │ ⎇ main │ ~/dev/openscout",
      "  -- INSERT -- ⏵⏵ bypass permissions on",
    ]);

    expect(strategy.verify(queuedTail)).toBe(true);
  });

  test("verifier does not mistake an idle token counter for queued acceptance", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const pendingTail = paneTail([
      "⏺ Update(packages/runtime/src/local-agents.ts)",
      "  ⎿  Added 9 lines, removed 2 lines",
      "",
      "───────────────────────────── relay-agent ──",
      "❯ draft still pending in the composer",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Opus 5 │ ⎇ main │ ~/dev/openscout",
      "  -- INSERT -- ⏵⏵ bypass permissions on · 12.4k tokens",
    ]);

    expect(strategy.verify(pendingTail)).toBe(false);
  });

  // The predicate above decides WHETHER a submit was acknowledged; the deadline
  // below decides HOW LONG we keep asking before calling it a stall. Both had to
  // change: a working pane can be slow to drain its composer even when nothing
  // in the tail says "queued", and the old fixed ~1.4s budget turned that
  // slowness into a stall, which then latched the endpoint offline.
  test("busy panes earn a longer verification deadline than idle ones", () => {
    const busyTail = paneTail([
      "⏺ Update(packages/runtime/src/local-agents.ts)",
      "  ⎿  Added 9 lines, removed 2 lines",
      "───────────────────────────── relay-agent ──",
      "❯ ",
    ]);
    const idleTail = paneTail([
      "───────────────────────────── relay-agent ──",
      "❯ ",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Opus 5 │ ⎇ main │ ~/dev/openscout",
    ]);

    // Explicit deadlines keep this deterministic under the env escape hatch
    // (OPENSCOUT_TMUX_VERIFY_*_DEADLINE_MS), which callers may set to 0 to
    // restore the original budget. What matters is the selection, not the numbers.
    const budget = { idleMs: 4_000, busyMs: 15_000 };
    expect(tmuxVerifyDeadlineMs(busyTail, budget)).toBe(15_000);
    expect(tmuxVerifyDeadlineMs(idleTail, budget)).toBe(4_000);

    // Zeroed deadlines collapse to the pre-fix behaviour: no extra sampling.
    expect(tmuxVerifyDeadlineMs(busyTail, { idleMs: 0, busyMs: 0 })).toBe(0);
  });

  test("verifier accepts harness activity emitted after the submitted prompt", () => {
    const strategy = buildTmuxDispatchStrategy("claude", brokerAskPrompt);
    const acceptedTail = paneTail([
      "❯ New broker ask from operator. Task: please refactor the dispatch path so it submits the prompt.",
      "",
      "⏺ Read(packages/runtime/src/local-agents.ts)",
      "  ⎿  Read 30 lines",
    ]);

    expect(strategy.verify(acceptedTail)).toBe(true);
  });
});

describe("tmux Claude readiness detection", () => {
  const cases: Array<{ name: string; tail: string; ready: boolean }> = [
    {
      name: "boot splash before composer",
      ready: false,
      tail: paneTail([
        "Claude Code v2.1.143",
        "Opus 4.7 (1M context) with xhigh effort",
        "~/dev/openscout",
      ]),
    },
    {
      name: "inline ready composer",
      ready: true,
      tail: paneTail([
        " ▐▛███▜▌   Claude Code v2.1.143",
        "▝▜█████▛▘  Opus 4.7 (1M context) with xhigh effort",
        " openscout-relay-agent ",
        "──",
        "❯ Try \"edit broker-daemon.ts to...\"",
        "────────────────────────────────────────────────────────────────────────────────",
        "  Opus 4.7 (1M context) │ main",
        "  -- INSERT -- ⏵⏵ bypass permissions on",
      ]),
    },
    {
      name: "boxed ready composer",
      ready: true,
      tail: paneTail([
        "╭──────────────────────────────────────────────────────────────────╮",
        "│ >                                                                │",
        "╰──────────────────────────────────────────────────────────────────╯",
      ]),
    },
    {
      name: "ready composer with Claude status-line effort marker",
      ready: true,
      tail: paneTail([
        "▐▛███▜▌   Claude Code v2.1.143",
        "▝▜█████▛▘  Sonnet 4.6 with high effort · Claude Max",
        " ui-dead-code-review-card-relay-agent ──",
        "❯ ",
        "────────────────────────────────────────────────────────────────────────────────",
        "  Sonnet 4.6 │ ⎇ sco-050-backend │ session-id │ ~/dev/openscout",
        "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login",
        "                                                                      0 tokens",
        "                                                              ● high · /effort",
      ]),
    },
    {
      name: "active tool output below composer",
      ready: false,
      tail: paneTail([
        "❯ New broker ask from operator. Task: inspect the dispatch path",
        "",
        "⏺ Read(packages/runtime/src/local-agents.ts)",
        "  ⎿  Read 40 lines",
      ]),
    },
  ];

  for (const entry of cases) {
    test(entry.name, () => {
      expect(tmuxPaneTailShowsReadyComposer(entry.tail)).toBe(entry.ready);
    });
  }
});

describe("tmux prompt-fragment detection", () => {
  const cases: Array<{ name: string; tail: string; containsPrompt: boolean }> = [
    {
      name: "boxed composer still contains prompt",
      containsPrompt: true,
      tail: paneTail([
        "╭──────────────────────────────────────────────────────────────────╮",
        "│ > New broker ask from operator. Task: please refactor the        │",
        "│   dispatch path so it submits the prompt.                        │",
        "╰──────────────────────────────────────────────────────────────────╯",
      ]),
    },
    {
      name: "inline composer still contains prompt",
      containsPrompt: true,
      tail: paneTail([
        "❯ New broker ask from operator. Task: please refactor the",
        "  dispatch path so it submits the prompt.",
      ]),
    },
    {
      name: "empty boxed composer after submission",
      containsPrompt: false,
      tail: paneTail([
        "● Reading file...",
        "  packages/runtime/src/local-agents.ts",
        "╭──────────────────────────────────────────────────────────────────╮",
        "│ >                                                                │",
        "╰──────────────────────────────────────────────────────────────────╯",
      ]),
    },
    {
      name: "submitted prompt text remains in transcript above idle composer",
      containsPrompt: false,
      tail: paneTail([
        "  New broker ask from operator. Task: please refactor the dispatch",
        "  path so it submits the prompt.",
        "",
        "⏺ Read(/Users/arach/dev/openscout/packages/runtime/src/local-agents.ts)",
        "  ⎿  Read 30 lines",
        "",
        "───────────────────────────── openscout-review-relay-agent ──",
        "❯ ",
        "────────────────────────────────────────────────────────────────────────────────",
        "  Sonnet 4.6 │ ⎇ main │ ~/dev/openscout",
        "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)",
      ]),
    },
    {
      name: "active harness output is not a stuck composer",
      containsPrompt: false,
      tail: paneTail([
        "New broker ask from operator. Task: please refactor the dispatch path so it submits the prompt.",
        "",
        "⏺ Grep(pattern: \"sendTmuxPrompt\")",
        "  ⎿  Found 2 files",
      ]),
    },
    {
      name: "empty pane tail is not stuck",
      containsPrompt: false,
      tail: "",
    },
  ];

  for (const entry of cases) {
    test(entry.name, () => {
      expect(tmuxPaneTailContainsPromptFragment(entry.tail, brokerAskPrompt)).toBe(entry.containsPrompt);
    });
  }
});
