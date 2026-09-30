// A reply from the phone or iPad to a session that is open somewhere goes
// INTO that session, where it runs — never to a background copy or a fork.
// The operator started it in a place; the words belong in that place.
//
// Three ways in, tried in order:
//   1. Herdr — Herdr knows which pane holds which harness session (by the
//      harness's own id), and `agent prompt` submits through its agent surface.
//   2. tmux  — a Claude session whose process record names a tmux pane gets a
//      bracketed paste and Enter, the same dispatch Scout uses for its own panes.
//   3. Lattices — a Claude session live in a plain terminal tab is typed into
//      by its tty through Lattices' computer-use surface. A Codex thread held
//      by the ChatGPT app's Codex (its app-server is stdio-only, so no process
//      can join it) gets the words through the app's own thread link
//      (`codex://threads/<id>?prompt=`); the Scout app, which holds the
//      Accessibility grant, focuses the composer holding exactly that text and
//      presses Return, and the thread's transcript confirms it.
// When none finds the session live, the caller falls back to an exact resume
// (nothing holds the session, so there is no second writer).

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readHerdrSessions, readHerdrTopology, execSystemFile } from "@openscout/runtime/system-probes";
import { findLiveClaudeSession, type ClaudeSessionRecord } from "@openscout/runtime";
import { sendTmuxPrompt } from "@openscout/runtime/local-agents";

import { askScoutApp, type ScoutAppReply } from "./scout-app-socket.ts";

export type InPlaceVia = "herdr" | "tmux" | "lattices" | "scout-app";

export type InPlaceDelivery =
  | { ok: true; via: InPlaceVia; location: string }
  /** The session is live but can't take words right now (e.g. a permission prompt is up). */
  | { ok: false; code: "session_blocked"; via: InPlaceVia; location: string }
  /** The session is live in a place Scout found but couldn't type into. */
  | { ok: false; code: "in_place_failed"; via: InPlaceVia; location: string; detail: string }
  /** Live in an app only the Scout app can reach, and the Scout app can't right now. */
  | { ok: false; code: "scout_app_unavailable" | "scout_app_accessibility"; via: InPlaceVia; location: string }
  /** No live place holds this session. */
  | { ok: false; code: "not_live" };

export type HerdrPaneMatch = { session: string; paneId: string; status: string | null };

export type DeliverInPlaceDeps = {
  findHerdrPane?: (sessionId: string) => Promise<HerdrPaneMatch | null>;
  promptHerdr?: (match: HerdrPaneMatch, body: string) => Promise<void>;
  findClaudeRecord?: (sessionId: string) => Promise<ClaudeSessionRecord | null>;
  promptTmux?: (target: string, body: string) => Promise<void>;
  ttyForPid?: (pid: number) => Promise<string | null>;
  typeIntoTty?: (tty: string, body: string) => Promise<void>;
  /** Whether the ChatGPT app's Codex holds this thread's writer lock. */
  codexHeldByApp?: (sessionId: string) => Promise<boolean>;
  typeIntoCodexApp?: (sessionId: string, body: string) => Promise<void>;
  /** The Scout app's socket; injectable for tests. */
  askScoutApp?: (request: { op: string; [field: string]: unknown }) => Promise<ScoutAppReply>;
};

const HERDR_TIMEOUT_MS = 4_000;

/**
 * Scout's own background continuations run in tmux sessions it names
 * `flat-<harness>-<id>`. They are copies, not the place the operator works,
 * so a reply never targets one.
 */
export function isScoutBackgroundCopy(record: ClaudeSessionRecord): boolean {
  const tmuxSession = record.tmux?.session ?? "";
  return tmuxSession.startsWith("flat-") || (record.name ?? "").endsWith("-relay-agent");
}

export async function deliverInPlace(
  input: { sessionId: string; harness?: string | null; body: string },
  deps: DeliverInPlaceDeps = {},
): Promise<InPlaceDelivery> {
  const { sessionId, body } = input;
  const harness = input.harness?.trim().toLowerCase() || null;

  // 1. Herdr — any harness Herdr recognizes.
  const pane = await (deps.findHerdrPane ?? findHerdrPaneForSession)(sessionId).catch(() => null);
  if (pane) {
    const location = `Herdr ${pane.session} · ${pane.paneId}`;
    if (pane.status === "blocked") return { ok: false, code: "session_blocked", via: "herdr", location };
    try {
      await (deps.promptHerdr ?? promptHerdrPane)(pane, body);
      return { ok: true, via: "herdr", location };
    } catch (error) {
      return { ok: false, code: "in_place_failed", via: "herdr", location, detail: errorText(error) };
    }
  }

  if (harness === "codex") {
    const held = await (deps.codexHeldByApp ?? codexThreadHeldByChatGPTApp)(sessionId).catch(() => false);
    if (!held) return { ok: false, code: "not_live" };
    const location = "the ChatGPT app’s Codex";
    const via = "scout-app";
    // Check the app can finish before the link puts words in the composer,
    // so a refusal never leaves a half-sent reply sitting there.
    const ask = deps.askScoutApp ?? ((request) => askScoutApp(request, { timeoutMs: 3_000 }));
    const status = await ask({ op: "status" });
    if (!status.ok) return { ok: false, code: "scout_app_unavailable", via, location };
    if (status.accessibility !== "granted") return { ok: false, code: "scout_app_accessibility", via, location };
    try {
      await (deps.typeIntoCodexApp ?? ((id, words) => typeIntoCodexApp(id, words, deps.askScoutApp)))(sessionId, body);
      return { ok: true, via, location };
    } catch (error) {
      return { ok: false, code: "in_place_failed", via, location, detail: errorText(error) };
    }
  }

  // tmux and a plain terminal tab need the harness's own record of which
  // process holds the session; only Claude Code writes one.
  if (harness && harness !== "claude") return { ok: false, code: "not_live" };
  const record = await (deps.findClaudeRecord ?? findLiveClaudeSession)(sessionId).catch(() => null);
  if (!record || isScoutBackgroundCopy(record)) return { ok: false, code: "not_live" };

  if (record.tmux) {
    const target = record.tmux.pane ?? record.tmux.session;
    const location = `tmux ${record.tmux.session}${record.tmux.pane ? ` · ${record.tmux.pane}` : ""}`;
    try {
      await (deps.promptTmux ?? promptTmuxPane)(target, body);
      return { ok: true, via: "tmux", location };
    } catch (error) {
      return { ok: false, code: "in_place_failed", via: "tmux", location, detail: errorText(error) };
    }
  }

  const tty = await (deps.ttyForPid ?? ttyForPid)(record.pid).catch(() => null);
  if (!tty) return { ok: false, code: "not_live" };
  const location = `terminal ${tty}`;
  try {
    await (deps.typeIntoTty ?? typeIntoTtyWithLattices)(tty, body);
    return { ok: true, via: "lattices", location };
  } catch (error) {
    return { ok: false, code: "in_place_failed", via: "lattices", location, detail: errorText(error) };
  }
}

export async function findHerdrPaneForSession(sessionId: string): Promise<HerdrPaneMatch | null> {
  const sessions = await readHerdrSessions({ maxAgeMs: 0 });
  for (const session of sessions) {
    if (!session.running) continue;
    const topology = await readHerdrTopology(session.name).catch(() => null);
    if (!topology?.running) continue;
    for (const workspace of topology.workspaces) {
      for (const tab of workspace.tabs) {
        for (const pane of tab.panes) {
          if (pane.agentSession?.value === sessionId) {
            return { session: session.name, paneId: pane.paneId, status: pane.agentStatus ?? null };
          }
        }
      }
    }
  }
  return null;
}

async function promptHerdrPane(match: HerdrPaneMatch, body: string): Promise<void> {
  // `agent prompt` honors the pane's bracketed-paste mode and sends Enter as
  // one ordered submission; it refuses a pane sitting at an approval dialog.
  await execSystemFile("herdr", ["--session", match.session, "agent", "prompt", match.paneId, body], {
    timeoutMs: HERDR_TIMEOUT_MS,
    maxStdoutBytes: 64 * 1024,
  });
}

async function promptTmuxPane(target: string, body: string): Promise<void> {
  const result = await sendTmuxPrompt(target, body);
  if (!result.submitted) throw new Error("the pane did not accept the prompt");
}

async function ttyForPid(pid: number): Promise<string | null> {
  const { stdout } = await execSystemFile("ps", ["-p", String(pid), "-o", "tty="], { timeoutMs: 2_000, maxStdoutBytes: 1024 });
  const tty = stdout.trim();
  if (!tty || tty === "??") return null;
  return tty.startsWith("tty") ? tty : `tty${tty}`;
}

async function typeIntoTtyWithLattices(tty: string, body: string): Promise<void> {
  await execSystemFile("lattices", [
    "computer", "type-text",
    "--tty", tty,
    "--text", body,
    "--treatment", "execute",
    "--enter",
    "--no-capture",
    "--json",
  ], { timeoutMs: 15_000, maxStdoutBytes: 256 * 1024 });
}

const CHATGPT_APP = "ChatGPT.app/";
const CODEX_APP_OPEN_SETTLE_MS = 1_200;

/**
 * Codex takes a per-thread writer lock under ~/.codex/thread-writer-locks.
 * When the process holding it lives inside ChatGPT.app, the thread is open
 * in the app — the place the operator is working it.
 */
export async function codexThreadHeldByChatGPTApp(sessionId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{16,}$/iu.test(sessionId)) return false;
  const lock = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "thread-writer-locks", `${sessionId}.lock`);
  let pids: string[] = [];
  try {
    const { stdout } = await execSystemFile("lsof", ["-t", lock], { timeoutMs: 3_000, maxStdoutBytes: 4 * 1024 });
    pids = stdout.split(/\s+/u).filter(Boolean);
  } catch {
    return false; // lsof exits 1 when nothing holds the file
  }
  for (const pid of pids) {
    const { stdout } = await execSystemFile("ps", ["-p", pid, "-o", "command="], { timeoutMs: 2_000, maxStdoutBytes: 8 * 1024 })
      .catch(() => ({ stdout: "" }));
    if (stdout.includes(CHATGPT_APP)) return true;
  }
  return false;
}

async function typeIntoCodexApp(
  sessionId: string,
  body: string,
  ask: DeliverInPlaceDeps["askScoutApp"] = (request) => askScoutApp(request),
): Promise<void> {
  // The bridge holds no Accessibility grant. The link and the transcript need
  // none; the one step that does (focus + Return) runs in the Scout app.
  const transcript = await findCodexTranscript(sessionId);
  const offset = transcript ? (await stat(transcript).catch(() => null))?.size ?? 0 : 0;

  // 1. The app's own thread link picks the thread by id and fills its
  //    composer. `-u` keeps `open` a plain URL open; a lone argument is
  //    rerouted to scoutd's file-reveal verb, which refuses URLs.
  const link = `codex://threads/${encodeURIComponent(sessionId)}?prompt=${encodeURIComponent(body)}`;
  await execSystemFile("open", ["-u", link], { timeoutMs: 5_000, maxStdoutBytes: 4 * 1024 });
  await new Promise((resolve) => setTimeout(resolve, CODEX_APP_OPEN_SETTLE_MS));

  // 2. The Scout app anchors on content (the one composer holding exactly
  //    these words; none or several and it stops) and presses Return there.
  const submitted = await ask({ op: "composer.submit", bundleId: CHATGPT_BUNDLE_ID, text: body });
  if (!submitted.ok) throw new Error(`the Scout app didn't submit it: ${submitted.message}`);

  // 3. Delivered means the thread recorded it, not that a key was pressed.
  if (!transcript) throw new Error("couldn't find this thread's transcript to confirm the reply");
  if (!(await waitForCodexUserMessage(transcript, offset, body))) {
    throw new Error("Return was pressed, but the thread didn't record the reply");
  }
}

/** The ChatGPT app's bundle id (it ships Codex, and registers as such). */
const CHATGPT_BUNDLE_ID = "com.openai.codex";
const TRANSCRIPT_CONFIRM_MS = 8_000;

async function findCodexTranscript(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{16,}$/iu.test(sessionId)) return null;
  const sessions = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions");
  const { stdout } = await execSystemFile("find", [sessions, "-name", `rollout-*-${sessionId}.jsonl`, "-print", "-quit"], {
    timeoutMs: 5_000,
    maxStdoutBytes: 4 * 1024,
  }).catch(() => ({ stdout: "" }));
  return stdout.trim() || null;
}

/** Reads what the thread appended after `offset`, looking for a user turn with these words. */
async function waitForCodexUserMessage(transcript: string, offset: number, body: string): Promise<boolean> {
  const expected = collapseWhitespace(body);
  const deadline = Date.now() + TRANSCRIPT_CONFIRM_MS;
  while (Date.now() < deadline) {
    const text = await readFile(transcript, "utf8").catch(() => "");
    for (const line of Buffer.from(text, "utf8").subarray(offset).toString("utf8").split("\n")) {
      if (!line.includes('"user"')) continue;
      try {
        const payload = (JSON.parse(line) as { payload?: { role?: string; type?: string; message?: string; content?: Array<{ text?: string }> } }).payload;
        const said = payload?.type === "user_message"
          ? payload.message ?? ""
          : payload?.role === "user" ? (payload.content ?? []).map((part) => part.text ?? "").join(" ") : "";
        if (said && collapseWhitespace(said).includes(expected)) return true;
      } catch {
        // A line still being written; read again.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
