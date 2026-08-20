// Approval-gated LAN pairing requests.
//
// Initial pairing over the relay is trust-on-first-use: whoever completes the
// Noise handshake in the live relay room is silently trusted. The deliberate
// human gate that keeps that safe is that pair mode only runs when someone
// starts it. To let a phone on the LAN pair with a single tap *without*
// dropping that gate, a tap registers a pending request here, the Mac surfaces
// it ("A device wants to pair — Allow?"), and only an explicit approval starts
// pair mode and hands the phone the payload. Unapproved requests expire.
//
// State is per-MAC, not per-process.
//
// It used to be per-process and in-memory, on the reasoning that the web server
// is a single long-lived process. That assumption does not hold: the pairing
// IDENTITY lives in `~/.openscout` and is shared by every local instance, so two
// servers on one Mac (a second worktree, a demo stack, a dev server beside the
// supervised one) both advertise the SAME fingerprint over Bonjour. mDNS renames
// the duplicate rather than rejecting it, the phone resolves whichever advert it
// likes, and the request lands in that process's memory. Approve it in the app —
// which is talking to the other process — and the approval can never reach the
// request. The phone sits on "waiting for approval" forever, with a request that
// is genuinely approved somewhere the approver cannot see.
//
// So the requests live under the same home the identity does, and any instance
// can list, approve, or deny any of them. Which server received the tap stops
// being something a human has to know.
//
// Losing the state on restart is still the safe outcome (the phone re-requests),
// so this is a shared cache, not a durable record. But it is a cache that two
// processes WRITE, and the whole point is that the two writers are a decision
// ("approved") and a poll ("still here"), racing by construction: the phone
// polls the instance it resolved to while the human approves on the other. A
// bare read-modify-write loses that race about half the time — both writers
// reload the pending row, and the poll publishes its stale copy last, silently
// reverting the approval.
//
// What serializes them is a compare-and-swap, not a lock.
//
// The state is generational. A writer loads generation N, applies its change,
// writes the result to a temp file, and publishes it by hard-linking that temp
// to the *name* of generation N+1. `link(2)` fails with EEXIST if anybody got
// there first, so "nothing has been published since I loaded" is the
// precondition of every write, enforced by the kernel rather than by agreement.
// A writer that loses reloads what the winner published, re-applies its change
// on top of THAT, and tries the next generation. Every mutation here is a state
// transition keyed by a token — create, touch, approve, deny, fulfil, sweep — so
// re-applying is the exactly-right thing to do rather than a heuristic.
//
// This was a file lock first, and a lock cannot be made correct here. Any lock a
// crash can leave behind needs a staleness rule to break it, and no staleness
// rule can distinguish a dead holder from a slow one. A holder that is merely
// descheduled — a suspended process, a machine under load, a laptop that slept —
// gets evicted, wakes up inside what it still believes is its critical section,
// and republishes the pending row over the approval that landed while it was
// away. Under a compare-and-swap that same suspended writer simply loses its
// link, reloads, sees the approval, re-applies its poll on top of it and
// publishes that. Nothing about correctness depends on anyone's clock, and there
// is no timeout to fall back from: a writer that cannot win the swap has not
// written anything.
//
// Reads take no part in any of it. They resolve the newest generation and parse
// it, and write nothing at all, which keeps the polling device — which has no
// decision to publish — out of the writer set entirely.
//
// Two things a published generation carries besides the rows, both because a
// row's ABSENCE from a generation is ambiguous and an instance that could not
// publish has to interpret it:
//
// - a terminal marker per fulfilled token. A row goes away either because its
//   payload was handed over — final, nothing may bring it back — or because
//   somebody's expiry sweep collected it on the state that instance could see,
//   which may not have included a legal extension made by an instance that
//   could not publish. Guessing wrong in one direction resurrects a spent
//   token; guessing wrong in the other answers a live phone with 410. So the
//   terminal case says so out loud, in the same swapped file, and absence with
//   no marker means garbage collection.
// - an epoch per chain, minted when a writer starts one from nothing. Clearing
//   the run directory takes the numbering back to one, and the next chain
//   climbs through numbers a previous one already used, so "a later generation
//   than the one I saw this row in" is only meaningful inside a single chain.
//
// Omit `statePath` for a pure in-memory store (tests, ephemeral servers).

import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertIsolatedPairingRunStateWrite } from "./pairing-run-state.ts";

export type PairRequestStatus = "pending" | "approved" | "denied";

export interface PairRequest {
  /** Opaque polling token handed to the requesting device. */
  token: string;
  status: PairRequestStatus;
  /** Best-effort requester identity for the approval prompt. */
  requesterIp: string | null;
  requesterLabel: string | null;
  /** Route the phone asked for (lan/tailnet/default) — surfaced for context. */
  route: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** Public view of a request, minus nothing sensitive (there is nothing). */
export type PairRequestView = PairRequest;

export interface PendingPairRequestStore {
  /**
   * Register (or reuse) a pending request for a requester. Repeated taps/polls
   * from the same device collapse onto one prompt rather than spamming the Mac.
   */
  create(input: {
    requesterIp?: string | null;
    requesterLabel?: string | null;
    route?: string | null;
  }): PairRequest;
  get(token: string): PairRequest | null;
  /** Extend a still-open request's window (a device is actively polling it). */
  touch(token: string): void;
  list(): PairRequest[];
  /** Apply an approve/deny decision; returns the updated request or null. */
  decide(token: string, decision: "approve" | "deny"): PairRequest | null;
  /**
   * Hand a request's payload over: bury the token and report the row that was
   * delivered, or null when there is no live row here to deliver.
   *
   * The report is the point. Handing the payload to the device and recording
   * that it went are one decision, and a caller that delivers first and tells
   * the store afterwards can be left having delivered a payload the store never
   * marked — the row it was about pruned out from under it in between. So the
   * store takes the decision, on state it can actually see, and null means
   * nothing was handed over and nothing was buried.
   */
  fulfill(token: string): PairRequest | null;
  dispose(): void;
}

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes — matches the pairing QR TTL ballpark
const SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * How many generations a losing writer will chase before keeping its change in
 * memory instead.
 *
 * This is a fairness bound, not a correctness one: every attempt that fails
 * fails because somebody else's write succeeded, so the state is moving
 * forward, and a change that never lands is retained and merged exactly like
 * one an unwritable home rejected. With the two writers this store exists for,
 * exhausting it would mean the peer published thirty-two generations inside our
 * load-apply-link window.
 */
const MAX_PUBLISH_ATTEMPTS = 32;
/** Retries taken back-to-back before we start yielding between them. */
const PUBLISH_SPIN_ATTEMPTS = 8;
const PUBLISH_BACKOFF_CEILING_MS = 8;
/**
 * Generations kept behind the newest.
 *
 * Locating the newest generation and reading it are two steps, and collecting
 * everything but the newest would let a writer that gets two publications ahead
 * remove the file in the gap between them — correct, since the reader retries,
 * but it would make the retry the common case rather than the rare one. One
 * generation of slack costs a few hundred bytes.
 */
const RETAINED_GENERATIONS = 1;

/**
 * Sleep without yielding the loop.
 *
 * Every store operation is synchronous by design (route handlers call in and
 * read the result on the next line), so backing off between swap attempts has
 * to happen in place. `Atomics.wait` on a private buffer is the portable way to
 * do that without burning the CPU.
 */
const publishWaitSlot = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(publishWaitSlot, 0, 0, ms);
}

/**
 * Where the shared requests live, given a config home. Beside the identity that
 * makes them shareable in the first place.
 */
export function pairRequestStatePath(configHome: string): string {
  return join(configHome, "run", "pair-requests.json");
}

function generationStem(statePath: string): string {
  return statePath.endsWith(".json") ? statePath.slice(0, -".json".length) : statePath;
}

/**
 * The file a given generation of the state is published as.
 *
 * Generation 0 IS the historical single-file path, so state written by the
 * pre-swap store is picked up as the starting generation on upgrade and then
 * collected like any other once it has been superseded.
 */
export function pairRequestGenerationPath(statePath: string, generation: number): string {
  return generation <= 0 ? statePath : `${generationStem(statePath)}.${generation}.json`;
}

/**
 * The newest generation published to a given state path, or null when nothing
 * has been. Reads the directory, so it always tells the truth about a store
 * some other process is writing.
 */
export function latestPairRequestGeneration(statePath: string): number | null {
  const directory = dirname(statePath);
  const name = basename(statePath);
  const stem = basename(generationStem(statePath));
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return null;
  }
  let latest: number | null = null;
  for (const entry of entries) {
    let generation: number;
    if (entry === name) {
      generation = 0;
    } else {
      if (!entry.startsWith(`${stem}.`) || !entry.endsWith(".json")) continue;
      const middle = entry.slice(stem.length + 1, entry.length - ".json".length);
      // Digits only: the temp files this store links from are siblings, and a
      // half-written one must never be mistaken for published state.
      if (!/^\d+$/.test(middle)) continue;
      generation = Number(middle);
    }
    if (latest === null || generation > latest) latest = generation;
  }
  return latest;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPairRequest(value: unknown): value is PairRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.token === "string" &&
    r.token.length > 0 &&
    (r.status === "pending" || r.status === "approved" || r.status === "denied") &&
    // The file is a trust boundary (another instance wrote it, and a human can
    // hand-edit it). A row with the right shape but a numeric `requesterIp`
    // would survive into `findReusable` and get republished, so check the
    // nullable fields too rather than only the ones we sort and expire on.
    isNullableString(r.requesterIp) &&
    isNullableString(r.requesterLabel) &&
    isNullableString(r.route) &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number" &&
    typeof r.expiresAt === "number"
  );
}

/**
 * A cheap fingerprint of a published generation.
 *
 * A generation is write-once — it is created by a `link` that would have failed
 * had the name existed — so its number alone is normally enough to know whether
 * we have already parsed it. The exception is generation 0, the file the
 * pre-swap store rewrote in place, which an older instance running beside us
 * still might; folding in the inode (every publication lands on a new one) and
 * size keeps a reader honest there without costing anything.
 */
function fileSignature(path: string): string | null {
  try {
    const stats = statSync(path);
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * The published state a row was last seen in.
 *
 * Which chain, which generation of that chain, and which file that generation
 * was — the last only matters for generation 0, the one name a pre-swap
 * instance can write twice.
 *
 * The chain has to be part of it because generation numbers restart. A run
 * directory that gets cleared — a reset, an `rm -rf ~/.openscout/run`, a
 * restore over the top — takes the numbering back to one, and the chain that
 * grows after it climbs through the same numbers the old one used. Comparing
 * bare numbers across that boundary reads generation 1 of a chain that has
 * never held a row as "the shared state moved past where I saw this row",
 * which is the opposite of the truth: a cleared directory is not evidence that
 * anybody deleted anything.
 *
 * `epoch` is null for state that carries none — the legacy generation-0 file,
 * which a pre-swap instance rewrites in place and never stamps. Those all
 * share the one null epoch, so inside it the file signature stays the only
 * moved-on signal there is, exactly as before. That is as good as it can get
 * while an old instance is still writing that name, and it is the case this
 * store upgrades away from on its first publication.
 */
interface SharedSighting {
  epoch: string | null;
  generation: number;
  signature: string | null;
}

/** A terminal marker as it travels in the published payload. */
interface TerminalMarker {
  token: string;
  /** The instant after which the marker can be collected. */
  collectAfter: number;
}

/**
 * Terminal markers out of a published payload, ignoring anything malformed.
 *
 * The file is a trust boundary like the rows are: another instance wrote it and
 * a human can hand-edit it, and a marker with a non-numeric horizon would
 * either never be collected or suppress a row forever.
 */
function parseTerminalMarkers(value: unknown): TerminalMarker[] {
  if (!Array.isArray(value)) return [];
  const markers: TerminalMarker[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const marker = entry as { token?: unknown; collectAfter?: unknown };
    if (typeof marker.token !== "string" || marker.token.length === 0) continue;
    if (typeof marker.collectAfter !== "number" || !Number.isFinite(marker.collectAfter)) continue;
    markers.push({ token: marker.token, collectAfter: marker.collectAfter });
  }
  return markers;
}

function inodeOf(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function createPendingPairRequestStore(
  options: { ttlMs?: number; now?: () => number; statePath?: string } = {},
): PendingPairRequestStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const statePath = options.statePath;
  const byToken = new Map<string, PairRequest>();
  /** The generation our map was loaded from, its fingerprint, and its chain. */
  let loadedGeneration: number | null = null;
  let loadedSignature: string | null = null;
  let loadedEpoch: string | null = null;
  /**
   * Whether the state we loaded carries a terminal ledger at all.
   *
   * An instance running an older build deletes a fulfilled row without saying
   * so, and its publications have no `fulfilled` key — so absence in one of
   * them is exactly as ambiguous as it always was, and the safe reading is
   * still the terminal one. The key's presence, empty or not, is what says the
   * writer speaks this protocol and that absence with no marker really is a
   * sweep.
   */
  let loadedHasTerminalLedger = false;
  /**
   * Rows whose current local state never reached the shared file, and rows we
   * expired out of our own map but could not expire out of it. See
   * `mergeUnpersisted`.
   *
   * Expiry only: a row we fulfilled is recorded in `fulfilledMarkers` instead,
   * because the two removals mean opposite things to everybody else.
   */
  const unpersistedUpserts = new Set<string>();
  const unpersistedExpiries = new Map<string, number>();
  /**
   * Tokens whose payload has been handed over, and the instant after which the
   * marker saying so can go.
   *
   * A row leaving the shared state has two causes that are indistinguishable
   * from a peer's side and mean opposite things. `fulfill` is terminal — the
   * device got what it asked for, and nothing may bring the row back. The
   * expiry sweep is garbage collection — whoever ran it acted on the state it
   * could see, and an instance that could not publish may be holding a legally
   * extended copy of the very row being collected. Reading a sweep as terminal
   * hands that phone a 410 for a token that is still good; reading a fulfil as
   * a sweep hands a phone a token whose payload has already been delivered.
   *
   * So the terminal case is said out loud rather than inferred from absence.
   * The marker rides the same compare-and-swapped file the rows do — a side
   * file would be a second consistency domain, and the two could disagree about
   * the same token. It is unioned rather than overwritten across writers,
   * because no writer can un-say it. And it is keyed by token rather than by
   * chain: what it records is a fact about that token's own life, which does
   * not stop being true because a run directory was cleared. Tokens are UUIDs,
   * so there is no cross-chain collision to protect against, and chain-scoping
   * would only make a spent token resurrectable by deleting a directory.
   */
  const fulfilledMarkers = new Map<string, number>();
  /**
   * Markers minted here that have not reached the shared file yet — the same
   * bookkeeping unpersisted row changes get, so a terminal outcome survives a
   * failed publish and is retried on the next operation.
   */
  const unpublishedFulfilled = new Set<string>();
  /**
   * Where each row we know reached the shared state was last seen in it.
   *
   * Recorded when we read a row out of a published generation and when we
   * publish one ourselves; forgotten once the row is no longer ours to hold.
   * This is the provenance that tells a row the shared state has never held
   * apart from one a peer has since deleted. See `mergeUnpersisted`.
   */
  const lastSeenInShared = new Map<string, SharedSighting>();
  /**
   * Unique per store, so two stores sharing a path — two servers in one
   * process, or the cross-instance tests — never collide on the temp file and
   * never inherit a stale temp's mode. A publication links this into place, so
   * a name nobody else can guess is also what makes it impossible to publish
   * through a file somebody else prepared.
   */
  const tempPath = statePath
    ? `${statePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
    : null;

  function generationPath(generation: number): string {
    return pairRequestGenerationPath(statePath as string, generation);
  }

  function exists(path: string): boolean {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The newest generation on disk, read from the directory every time.
   *
   * Probing forward from the generation we last read would be one stat instead
   * of a scan, and would be wrong: the collector leaves gaps below the newest
   * generation, so "the next number does not exist" does not mean "nothing is
   * newer". A reader that concluded otherwise would sit on a stale approval,
   * which is the failure this whole file is about. The directory is four
   * entries; the scan is not worth being clever about.
   */
  function latestGeneration(): number | null {
    return statePath ? latestPairRequestGeneration(statePath) : null;
  }

  /**
   * Has the shared state moved past the point a row was last seen in it?
   *
   * Only ever asked within one chain. Generation numbers restart when a run
   * directory is cleared, so across chains they compare as freely as they do
   * within one and mean nothing: a fresh chain's generation 1 has a different
   * signature from the old chain's, and a fresh chain that has grown past the
   * number we saw has a bigger number. Both used to read as "a peer deleted
   * this row", and neither is evidence of anything — the state we knew is not
   * gone, it is unreachable, and the row we are holding simply republishes into
   * the chain that replaced it.
   *
   * Inside one chain, generations only ever go up, so the number answers this
   * on its own — except at generation 0, the file a pre-swap instance rewrites
   * in place, where the second write lands on the same name. The fingerprint
   * the reader already keeps in order to know whether it has parsed a file
   * covers that, and it is all there is to go on in the null epoch that legacy
   * file lives in.
   */
  function movedOnSince(sighting: SharedSighting): boolean {
    if (loadedEpoch !== sighting.epoch) return false;
    const generation = loadedGeneration ?? -1;
    if (generation !== sighting.generation) return generation > sighting.generation;
    return loadedSignature !== sighting.signature;
  }

  /**
   * How long a terminal marker outlives the row it buries.
   *
   * A marker can go once the row it marks could no longer be republished live
   * under any legal extension. `touch` grants `now + ttlMs`, and only to a row
   * that is still live, so the latest expiry reachable from a copy that expires
   * at E is E + ttlMs. Past that the merge's own liveness test drops the copy
   * and the marker has nothing left to do.
   *
   * This is expiry arithmetic, in the one domain this store already keeps a
   * clock for — rows carry deadlines and the sweep reads them off this same
   * time source — and it is NOT a concurrency timeout. Nothing here decides
   * between two writers: who lands a generation is settled by `link(2)`, and a
   * writer that arrives late reloads and re-applies rather than being judged
   * stale. An instance descheduled across a marker's whole horizon stays safe
   * by construction rather than by luck, because it could not have touched
   * anything while it was away: its copy is past its own expiry when it wakes,
   * and the liveness test — not the marker — is what drops it. The only way to
   * carry a copy past the horizon is to keep committing, and every commit
   * reloads first, which is where it meets the marker.
   */
  function terminalMarkerHorizon(expiresAt: number): number {
    return Math.max(expiresAt, now()) + ttlMs;
  }

  /** Record that a row's payload was handed over, and bury the row. */
  function markFulfilled(request: PairRequest): void {
    const horizon = terminalMarkerHorizon(request.expiresAt);
    const known = fulfilledMarkers.get(request.token);
    fulfilledMarkers.set(request.token, known === undefined ? horizon : Math.max(known, horizon));
    // Only a store with a shared file can have a marker nobody else has seen.
    // Without one there are no peers to tell, nothing for the marker to ride,
    // and nothing anywhere that could bring the row back.
    if (statePath) unpublishedFulfilled.add(request.token);
  }

  /**
   * Drop markers whose row could no longer come back even without them.
   *
   * Two things keep a marker past the horizon it was minted with.
   *
   * A marker that has never ridden a publish is not collected at all. The
   * horizon's whole argument is "no copy of this row can still be live", and
   * that only holds for a marker every peer has had the chance to read. While
   * it exists nowhere but here, the peers that cannot see it are free to go on
   * extending the very row it buries — legally, because to them the token is
   * simply still open — and collecting it would hand our next reload a live row
   * and no reason to disbelieve it. Once it has landed in a published
   * generation the ordinary horizon applies again. The boundary this leaves is
   * the one the whole degraded mode already has: if the process dies while its
   * home is unwritable, everything it could not publish dies with it, and the
   * marker is no different from the rows beside it.
   *
   * And the horizon moves. `adopt` raises it every time the shared state still
   * shows the marked token, so peers extending a row can never outrun the
   * marker that buries it.
   */
  function collectTerminalMarkers(): void {
    const t = now();
    for (const [token, collectAfter] of fulfilledMarkers) {
      if (unpublishedFulfilled.has(token)) continue;
      // Strictly after: at the horizon itself a copy extended to exactly that
      // instant is still live by the store's own `expiresAt > now` rule.
      if (collectAfter < t) fulfilledMarkers.delete(token);
    }
  }

  /**
   * Reconcile the file against writes of ours that never reached it.
   *
   * Without this, a degraded instance is strictly worse than the per-process
   * store it replaced: it registers a token it cannot publish, some other
   * instance publishes anything at all, and the wholesale reload drops the
   * token the phone is holding — which answers the next poll with 410 and
   * stops it retrying. Keeping unpublished rows in memory is the floor.
   *
   * Which is not the same as keeping every row we happen to be holding.
   * "Missing from the state we just loaded" has two causes that look identical
   * in the map and mean opposite things: a row we created and could not
   * publish, which nobody else can be holding and which has to survive; and a
   * row that WAS published and that a peer has since deleted by fulfilling or
   * sweeping it, which must not come back. Retaining the second is how a
   * fulfilled token gets answered as `pending` again — reproduced 10/10 by
   * failing a poll's publish, letting another instance fulfil the row, and
   * merging: the next publication carried the row back into the shared file at
   * a later generation than the one that had deleted it.
   *
   * The generational model separates those two, within one chain: a row absent
   * from a generation LATER than the one we last saw it in went away between
   * them, and it was not us that removed it. So sightings are recorded on the
   * way past.
   *
   * But "a peer removed it" is itself two events that mean opposite things,
   * and absence cannot tell them apart. `fulfill` is terminal — the payload
   * went to the device, and the row and everything stacked on it must die.
   * The expiry sweep is garbage collection, run by an instance on the state it
   * could see, which is precisely not the state we are holding: our extension
   * of that row is the newer knowledge, and it was unpublishable rather than
   * wrong. So the terminal case is read off the marker a fulfiller publishes,
   * and absence with no marker is a sweep, which our copy survives for as long
   * as it is genuinely still live under its own extended expiry.
   */
  function mergeUnpersisted(loaded: Map<string, PairRequest>): void {
    collectTerminalMarkers();
    // Terminal first, and unconditionally. A token whose payload was handed
    // over is finished everywhere: in the state we just read (a peer running an
    // older build could still be republishing it), in whatever we have stacked
    // to publish, and in our own map. Our own marker that never reached the
    // file is applied here exactly like an unpersisted delete used to be.
    for (const token of fulfilledMarkers.keys()) {
      loaded.delete(token);
      unpersistedUpserts.delete(token);
    }
    for (const token of [...unpersistedUpserts]) {
      const mine = byToken.get(token);
      if (!mine) {
        // Expired out of our own map; there is nothing left to republish.
        unpersistedUpserts.delete(token);
        continue;
      }
      const theirs = loaded.get(token);
      if (!theirs) {
        const sighting = lastSeenInShared.get(token);
        if (sighting && movedOnSince(sighting)) {
          // Gone from a later generation of the same chain, with no marker to
          // say the payload was delivered: somebody swept it. They were reading
          // an expiry we had already extended and could not publish, so the row
          // comes back — but only while it really is still live under that
          // extension. A copy that has run out is dropped, which is the same
          // answer the sweeper reached, one instance late.
          //
          // Unless the state we loaded has no ledger in it at all, in which
          // case its writer is an older build that would not have marked a
          // fulfil either, absence is as ambiguous there as it ever was, and
          // the terminal reading is the safe one.
          if (!loadedHasTerminalLedger || !isLive(mine)) {
            unpersistedUpserts.delete(token);
            continue;
          }
        }
        loaded.set(token, mine);
        continue;
      }
      // Both sides hold the row, so this is not about keeping it alive any
      // more — it is about not losing a human's answer. A decision outranks a
      // non-decision in either direction: a remote approval beats our
      // unpublished poll, and our unpublished approval beats a remote poll. Two
      // rows in the same class fall back to the later `updatedAt`. The window
      // is the max of the two, because extending is always safe and either side
      // extending means somebody is actively polling.
      const mineDecided = mine.status !== "pending";
      const theirsDecided = theirs.status !== "pending";
      const winner =
        mineDecided === theirsDecided
          ? (theirs.updatedAt > mine.updatedAt ? theirs : mine)
          : (theirsDecided ? theirs : mine);
      loaded.set(token, { ...winner, expiresAt: Math.max(theirs.expiresAt, mine.expiresAt) });
    }
    for (const [token, forgetAfter] of unpersistedExpiries) {
      // Not worth keeping past the point where the row would have expired on
      // its own anyway.
      if (forgetAfter <= now()) {
        unpersistedExpiries.delete(token);
        continue;
      }
      const theirs = loaded.get(token);
      if (theirs === undefined) continue;
      // The same classification, seen from the sweeper's side. Our sweep was
      // garbage collection performed on the state WE could see; a peer that
      // has since published an extension of the row knew something we did not,
      // and re-applying the sweep on top of that would kill a token a device
      // is still polling. Only a row that is still expired is ours to remove.
      if (isLive(theirs)) {
        unpersistedExpiries.delete(token);
        continue;
      }
      loaded.delete(token);
    }
  }

  /**
   * Forget sightings of rows we are no longer holding.
   *
   * A token is a UUID and never legitimately comes back, so a row that has left
   * the map has left for good; without this the record would grow for the life
   * of the process.
   */
  function forgetSightingsWeNoLongerHold(): void {
    for (const token of lastSeenInShared.keys()) {
      if (!byToken.has(token)) lastSeenInShared.delete(token);
    }
  }

  function adopt(rows: PairRequest[], markers: TerminalMarker[]): void {
    const loaded = new Map<string, PairRequest>();
    for (const row of rows) loaded.set(row.token, row);
    // A union, not a replacement: a marker says a payload was handed over, and
    // no writer can un-say that. The longer horizon wins for the same reason.
    for (const marker of markers) {
      const known = fulfilledMarkers.get(marker.token);
      fulfilledMarkers.set(
        marker.token,
        known === undefined ? marker.collectAfter : Math.max(known, marker.collectAfter),
      );
    }
    // A marker's horizon is monotonic against the extensions we can see. It was
    // minted from one reading of the row's expiry, and an instance that has not
    // read the marker yet can legally push that row further out than the
    // horizon reaches. So every time the shared state still shows a marked
    // token, the horizon is raised to cover the longest life that copy could
    // still be given — the same arithmetic the marker was minted with, an
    // expiry plus the one stranded touch that can extend it, applied to newer
    // evidence and only ever upwards. A marker whose token is no longer in the
    // file stops being raised, which is what keeps this bounded: there is
    // nothing left for it to outlive.
    for (const [token, row] of loaded) {
      const known = fulfilledMarkers.get(token);
      if (known === undefined) continue;
      const floor = row.expiresAt + ttlMs;
      if (floor > known) fulfilledMarkers.set(token, floor);
    }
    // Every row in the file demonstrably reached the shared state, in this
    // generation of this chain. Recorded before the merge, which reads
    // sightings back.
    const sighting: SharedSighting = {
      epoch: loadedEpoch,
      generation: loadedGeneration ?? 0,
      signature: loadedSignature,
    };
    for (const token of loaded.keys()) lastSeenInShared.set(token, sighting);
    mergeUnpersisted(loaded);
    byToken.clear();
    for (const [token, request] of loaded) byToken.set(token, request);
    forgetSightingsWeNoLongerHold();
  }

  /**
   * Pull in the newest generation another instance has published.
   *
   * Writes nothing, which is what keeps the polling device off the writer set.
   * A generation can be collected between being located and being read — the
   * writer that collected it published something newer — so a miss re-locates
   * rather than giving up.
   */
  function reload(): void {
    if (!statePath) return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const generation = latestGeneration();
      if (generation === null) {
        // Nothing published yet, or the run directory was cleared out from
        // under us: whatever we hold is all there is, and the next write starts
        // a new chain from generation one.
        loadedGeneration = null;
        loadedSignature = null;
        loadedEpoch = null;
        loadedHasTerminalLedger = false;
        return;
      }
      const path = generationPath(generation);
      const signature = fileSignature(path);
      if (signature === null) {
        loadedGeneration = null;
        continue;
      }
      if (generation === loadedGeneration && signature === loadedSignature) return;
      const raw = readFileOrNull(path);
      if (raw === null) {
        loadedGeneration = null;
        continue;
      }
      loadedGeneration = generation;
      loadedSignature = signature;
      // Cleared until the payload parses: claiming the chain we were on before
      // would let a state we cannot read inherit an epoch it never published
      // under, and every sighting from it would compare against the wrong one.
      loadedEpoch = null;
      loadedHasTerminalLedger = false;
      let rows: unknown[];
      let epoch: string | null = null;
      let hasLedger = false;
      let markers: TerminalMarker[] = [];
      try {
        const parsed = JSON.parse(raw) as {
          requests?: unknown;
          epoch?: unknown;
          fulfilled?: unknown;
        };
        rows = Array.isArray(parsed?.requests) ? parsed.requests : [];
        epoch = typeof parsed?.epoch === "string" && parsed.epoch.length > 0 ? parsed.epoch : null;
        hasLedger = Array.isArray(parsed?.fulfilled);
        markers = parseTerminalMarkers(parsed?.fulfilled);
      } catch {
        // A hand-edited file is not worth failing pairing over, and it must not
        // cost us the rows we are holding either: keep them and republish on
        // the next mutation, which supersedes the damage.
        return;
      }
      loadedEpoch = epoch;
      loadedHasTerminalLedger = hasLedger;
      adopt(rows.filter(isPairRequest), markers);
      return;
    }
  }

  type PublishOutcome = "won" | "lost" | "failed";

  function discardTemp(): void {
    if (!tempPath) return;
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // A temp we cannot remove is inert: it is not a generation, so nobody
      // will ever read it.
    }
  }

  /**
   * Publish our view as the next generation, if nobody else has.
   *
   * `touched` and `expired` name the rows this operation changed, so a write
   * that cannot land can be retried later without claiming authority over rows
   * we merely happened to be holding — republishing those would resurrect
   * another instance's decisions.
   */
  function publish(touched: readonly string[], expired: readonly string[]): PublishOutcome {
    if (!statePath || !tempPath) return "won";
    // Nothing changed and nothing is owed: stay off the writer set entirely.
    // Anything outstanding, though, is a write that failed and still has to
    // land, so a home that has become writable again is retried here — on the
    // very next operation, without waiting for one that happens to mutate.
    if (touched.length === 0 && expired.length === 0 && !hasOutstandingWrites()) return "won";
    // Publishing is only allowed onto the state we actually read, and only
    // while that is still the newest state there is.
    //
    // The link alone is not enough for the second half. Superseded generations
    // are collected, so their names come free again, and an instance that was
    // suspended long enough for its target name to be collected would link
    // successfully into the PAST — its write invisible behind newer
    // generations, and worse, believed to have landed. Reproduced by suspending
    // an instance across five publications. So the frontier is read first and
    // has to agree with what we loaded; the link then settles who gets there
    // first among everyone who agrees.
    if ((latestGeneration() ?? -1) !== (loadedGeneration ?? -1)) return "lost";
    const next = (loadedGeneration ?? 0) + 1;
    // State we did not load an epoch from is a chain we are starting: either
    // nothing has been published, or the only thing published is the legacy
    // generation-0 file, which carries none. Everyone after us copies it
    // forward, which is what makes the generations of one chain comparable to
    // each other and to no other chain's.
    const epoch = loadedEpoch ?? crypto.randomUUID();
    const target = generationPath(next);
    // Before the first byte hits the disk, not after: a test that reaches for
    // the real home must fail loudly instead of leaving a bearer token there.
    assertIsolatedPairingRunStateWrite(target);
    assertIsolatedPairingRunStateWrite(tempPath);
    // `version` describes the row schema, which has not changed; which
    // generation a file is lives in its name. `epoch` and `fulfilled` are
    // additive siblings of `requests` — an instance running an older build
    // ignores them, which is the same exposure it already had, and bumping the
    // number would not teach it to read them.
    const payload = JSON.stringify({
      version: 1,
      epoch,
      requests: [...byToken.values()],
      fulfilled: [...fulfilledMarkers].map(
        ([token, collectAfter]) => ({ token, collectAfter }) satisfies TerminalMarker,
      ),
    });
    try {
      // 0700: a row carries the pairing token, which is a bearer credential —
      // whoever reads one can complete the pair. The files are 0600, but if we
      // are the ones creating the directory it must not be left world-listable.
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      writeFileSync(tempPath, payload, { mode: 0o600 });
    } catch {
      discardTemp();
      return "failed";
    }
    try {
      linkSync(tempPath, target);
    } catch (error) {
      discardTemp();
      // EEXIST is the swap doing its job: somebody published this generation
      // while we were preparing ours, and what they published is state we have
      // not seen. Anything else is a home we cannot write to.
      return (error as NodeJS.ErrnoException | null)?.code === "EEXIST" ? "lost" : "failed";
    }
    // `link` reports EEXIST rather than replacing, which is the whole
    // guarantee — but confirming that the name really is our inode costs one
    // stat and keeps that guarantee from resting on a single syscall's
    // exclusivity on filesystems (network homes in particular) that have been
    // known to report success for a link they did not make.
    const ours = inodeOf(tempPath);
    const signature = fileSignature(target);
    const landed = ours !== null && ours === inodeOf(target);
    discardTemp();
    if (!landed || signature === null) return "lost";
    // Winning the name is not the same as winning the swap. Collected
    // generations give their names back, so an instance suspended between
    // reading the frontier and linking can land in a hole beneath it: the link
    // succeeds and the write is invisible, sitting behind newer generations
    // that nobody derived from it. The frontier is therefore checked once more,
    // and only a link that IS the frontier counts as published.
    //
    // A peer that legitimately publishes on top of ours in the moment between
    // the link and this check reads as a loss too. That is harmless: our write
    // is inside the generation they derived from it, and re-applying a
    // transition that already landed is the same transition.
    if (latestGeneration() !== next) {
      // A generation nobody derived from is nobody's parent. Leaving it behind
      // would only mislead a store that later found it as the newest thing in a
      // half-cleared directory.
      try {
        if (inodeOf(target) === ours) unlinkSync(target);
      } catch {
        // Already gone, or not ours to remove.
      }
      return "lost";
    }
    loadedGeneration = next;
    loadedSignature = signature;
    loadedEpoch = epoch;
    loadedHasTerminalLedger = true;
    // What we just published speaks for everything we hold: the rows we
    // removed, and the tokens we buried. Nothing of ours is outstanding.
    unpersistedUpserts.clear();
    unpersistedExpiries.clear();
    unpublishedFulfilled.clear();
    // And every row in it has now been seen in the shared state at this
    // generation of this chain — by us, which is the same evidence as having
    // read it there.
    const sighting: SharedSighting = { epoch, generation: next, signature };
    for (const token of byToken.keys()) lastSeenInShared.set(token, sighting);
    forgetSightingsWeNoLongerHold();
    collectSuperseded(next);
    return "won";
  }

  /**
   * Unlink generations nobody needs. Walks down from the newest and stops at
   * the first gap, so it is two stats in the steady state and cannot wander off
   * into a directory it does not own.
   */
  function collectSuperseded(published: number): void {
    for (let generation = published - 1 - RETAINED_GENERATIONS; generation >= 0; generation -= 1) {
      const path = generationPath(generation);
      if (!exists(path)) return;
      try {
        unlinkSync(path);
      } catch {
        // Not ours to remove, or already gone. Either way there is nothing
        // below it worth walking to.
        return;
      }
    }
  }

  function recordOutstanding(touched: readonly string[], expired: readonly string[]): void {
    for (const token of touched) {
      if (byToken.has(token)) unpersistedUpserts.add(token);
    }
    const forgetAfter = now() + ttlMs;
    for (const token of expired) unpersistedExpiries.set(token, forgetAfter);
    // Terminal outcomes need no recording here: `markFulfilled` already put
    // them in `unpublishedFulfilled`, where a failed publish leaves them.
  }

  function isLive(request: PairRequest): boolean {
    return request.expiresAt > now();
  }

  /** Drop expired rows from our map, reporting what went. */
  function pruneExpired(): string[] {
    const t = now();
    const removed: string[] = [];
    for (const [token, request] of byToken) {
      if (request.expiresAt <= t) {
        byToken.delete(token);
        unpersistedUpserts.delete(token);
        removed.push(token);
      }
    }
    return removed;
  }

  function hasOutstandingWrites(): boolean {
    return unpersistedUpserts.size > 0
      || unpersistedExpiries.size > 0
      || unpublishedFulfilled.size > 0;
  }

  interface Applied<T> {
    value: T;
    /** Rows this application changed, for the degraded-write bookkeeping. */
    touched: readonly string[];
  }

  /**
   * Apply a mutation and publish it as the next generation, re-applying it
   * against whatever a peer published if they got there first.
   *
   * `apply` must be re-runnable: it is handed freshly-loaded state, and it can
   * be handed newer state and run again. Every mutation in this store is a
   * transition keyed by a token, so re-running one on top of a state that moved
   * is not a compromise — it is what "extend the window of the request that is
   * now approved" means.
   */
  function commit<T>(apply: () => Applied<T>): T {
    if (!statePath) {
      pruneExpired();
      collectTerminalMarkers();
      return apply().value;
    }
    for (let attempt = 1; ; attempt += 1) {
      reload();
      const expired = pruneExpired();
      collectTerminalMarkers();
      const { value, touched } = apply();
      const outcome = publish(touched, expired);
      if (outcome === "won") return value;
      if (outcome === "failed" || attempt >= MAX_PUBLISH_ATTEMPTS) {
        // A read-only home, or a peer we cannot get a word in edgeways with.
        // Either way this instance keeps serving the change out of its own
        // memory — the per-process behaviour this store replaced — and retries
        // it on the next operation.
        recordOutstanding(touched, expired);
        return value;
      }
      if (attempt > PUBLISH_SPIN_ATTEMPTS) {
        // Jittered, so two instances in lockstep do not keep colliding in phase.
        sleepSync(1 + Math.floor(Math.random() * PUBLISH_BACKOFF_CEILING_MS));
      }
    }
  }

  function sweep(): void {
    // Look before writing. The common case is nothing to collect, and every
    // instance publishing a generation every 30 seconds just to discover that
    // would be churn bought for nothing.
    reload();
    const t = now();
    const collectable = [...byToken.values()].some((request) => request.expiresAt <= t);
    if (!collectable && !hasOutstandingWrites()) return;
    commit(() => ({ value: undefined, touched: [] }));
  }

  // Keep the state from growing unbounded if nobody ever polls a stale request.
  // Reads do not prune (they must not write), so this is what collects them.
  const sweepTimer = setInterval(() => {
    try {
      sweep();
    } catch {
      // A sweep that cannot run is not worth taking the process down for; the
      // rows it would have dropped are already invisible to readers.
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive solely for the sweep.
  (sweepTimer as { unref?: () => void }).unref?.();

  function findReusable(requesterIp: string | null): PairRequest | null {
    if (!requesterIp) return null;
    const t = now();
    for (const req of byToken.values()) {
      if (
        req.requesterIp === requesterIp &&
        req.expiresAt > t &&
        (req.status === "pending" || req.status === "approved")
      ) {
        return req;
      }
    }
    return null;
  }

  return {
    create(input) {
      const requesterIp = input.requesterIp?.trim() || null;
      const label = input.requesterLabel?.trim() || null;
      // Minted once, outside the retry loop: a swap we lose must not cost the
      // Mac a second row for one tap.
      const token = crypto.randomUUID();
      return commit(() => {
        // Re-evaluated per attempt, so a peer that registered this device while
        // we were losing the swap collapses the prompt rather than duplicating
        // it — which is the same reasoning as reusing within one instance.
        const existing = findReusable(requesterIp);
        if (existing) {
          // Refresh metadata + extend the window so an actively-polling device
          // doesn't time out mid-approval.
          existing.updatedAt = now();
          existing.expiresAt = now() + ttlMs;
          if (input.route) existing.route = input.route;
          if (label) existing.requesterLabel = label;
          return { value: existing, touched: [existing.token] };
        }
        const t = now();
        const request: PairRequest = {
          token,
          status: "pending",
          requesterIp,
          requesterLabel: label,
          route: input.route ?? null,
          createdAt: t,
          updatedAt: t,
          expiresAt: t + ttlMs,
        };
        byToken.set(token, request);
        return { value: request, touched: [token] };
      });
    },

    // Reads write nothing. The polling device hits this constantly and has no
    // decision to publish, so keeping it out of the writer set removes it from
    // the race entirely — expired rows are filtered out of the answer and
    // collected by the sweep instead of being deleted here, which is what used
    // to let a poll republish stale rows.
    get(token) {
      reload();
      const req = byToken.get(token);
      return req && isLive(req) ? req : null;
    },

    touch(token) {
      commit(() => {
        const req = byToken.get(token);
        const extended = now() + ttlMs;
        // A request that already expired was dropped by pruneExpired, so a
        // touch cannot resurrect one. Denied requests are not extended either.
        const extend =
          req !== undefined
          && (req.status === "pending" || req.status === "approved")
          && extended > req.expiresAt;
        if (extend && req) req.expiresAt = extended;
        return { value: undefined, touched: extend ? [token] : [] };
      });
    },

    list() {
      reload();
      return [...byToken.values()].filter(isLive).sort((a, b) => b.createdAt - a.createdAt);
    },

    decide(token, decision) {
      return commit(() => {
        const req = byToken.get(token);
        if (!req) return { value: null, touched: [] };
        req.status = decision === "approve" ? "approved" : "denied";
        req.updatedAt = now();
        // Give an approved request a fresh window to be polled + fulfilled.
        if (decision === "approve") req.expiresAt = now() + ttlMs;
        // Published immediately: the instance the phone is polling is very
        // often NOT the instance the human just approved on. That is the whole
        // point.
        return { value: req, touched: [token] };
      });
    },

    fulfill(token) {
      // Taken once, on the first attempt that sees the shared state, and
      // carried through the retries. A lost swap reloads — and by then the
      // marker this call minted has emptied the row out of everything it can
      // reload, so deciding again there would report a refusal for a payload
      // that has already gone to the device.
      let delivered: PairRequest | null = null;
      return commit<PairRequest | null>(() => {
        if (delivered === null) {
          const request = byToken.get(token);
          // Only a row this instance can see LIVE is one it may act on. An
          // expired copy is not a delivery it is entitled to make: a peer that
          // could not publish may be holding a legal extension of that very
          // row, and burying the token here would take the extension with it —
          // the row would leave the file with no marker, which reads as a
          // sweep, and the phone would be sent back to a peer republishing a
          // token whose payload had already gone out. Refusing costs the device
          // a retry against the instance that can still see the row. It is
          // availability, not a lost decision.
          //
          // Only a row we are actually holding is marked, for the same reason
          // in the other direction. A token we do not have is one a peer has
          // already removed — if they fulfilled it their marker is in the file
          // we just loaded, and if they swept it there is nothing to bury.
          // Marking regardless would turn an unauthenticated LAN endpoint into
          // a way to plant markers for arbitrary strings.
          if (!request || !isLive(request)) return { value: null, touched: [] };
          // The snapshot handed over IS what the marker is minted from, taken
          // at the moment of the decision. Nothing between here and the write
          // looks the row up a second time, so no prune can come between the
          // handover and the marker.
          delivered = { ...request };
        }
        // Terminal, and said out loud rather than left to be inferred from the
        // row's absence: the payload behind this token has been handed to the
        // device, and no instance may bring it back. The marker is what stacks
        // if this write cannot land, so the row stays buried either way.
        markFulfilled(delivered);
        byToken.delete(token);
        unpersistedUpserts.delete(token);
        return { value: delivered, touched: [] };
      });
    },

    dispose() {
      clearInterval(sweepTimer);
      discardTemp();
      byToken.clear();
      unpersistedUpserts.clear();
      unpersistedExpiries.clear();
      unpublishedFulfilled.clear();
      fulfilledMarkers.clear();
      lastSeenInShared.clear();
    },
  };
}
