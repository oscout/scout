import { Fragment, StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  Camera,
  Check,
  Copy,
  Ellipsis,
  FileText,
  Forward,
  Image as ImageIcon,
  Info,
  Mic,
  Paperclip,
  Pause,
  Phone,
  Play,
  Plus,
  Reply,
  Search,
  Send,
  Smile,
  Square,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import { acceptedSendLabel, reconcileAuthoritativeMessages } from "./chat-runtime.ts";
import {
  HostedVoiceSource,
  createNativeAttachmentFetcher,
  resolveVoicePlaybackSource,
} from "./voice-note-source.ts";
import { stripLaunchOnlyFields } from "./bootstrap-lifecycle.ts";
import { LONG_PRESS_MS, armsLongPress, exceedsSlop, releaseOutcome, showsSwipeCue, swipeOffset } from "./gesture-machine.ts";
import { MOTION_QUICK_MS, type OverlayPhase, useOverlayPresence, useRetainedValue } from "./overlay-motion.ts";
import {
  type ChatDensity,
  type ChatMode,
  type HostIdentity,
  type Identity,
  hostStatus,
  identityFor,
  isGroupedWithPrevious,
  resolveDensity,
  senderAttribution,
  showsSenderLabel,
} from "./presentation.ts";
import "./scout-chat.css";
import "./messages-theme.css";
import "./whatsapp-theme.css";
import "./scout-theme.css";

type ChatStyle = "messages" | "whatsapp" | "scout";
type AuthorKind = "person" | "agent" | "system" | "unknown";

type VoiceInputState = "idle" | "preparing" | "listening" | "transcribing" | "unavailable";

type VoiceSnapshot = {
  input: {
    state: VoiceInputState;
    partialText: string;
    finalText: string;
    finalCount: number;
    engine: "parakeet" | "apple";
    modelReady: boolean;
    audioLevel: number;
    unavailableReason: string | null;
  };
};

const IDLE_VOICE: VoiceSnapshot["input"] = {
  state: "idle",
  partialText: "",
  finalText: "",
  finalCount: 0,
  engine: "apple",
  modelReady: false,
  audioLevel: 0,
  unavailableReason: null,
};

type Attachment = {
  id: string;
  mediaType: string;
  fileName?: string | null;
  blobKey?: string | null;
  url?: string | null;
};

type StagedAttachment = {
  file: File;
  preview?: string;
  hosted?: Attachment;
  uploading?: boolean;
  error?: string;
};

type Message = {
  id: string;
  conversationId: string;
  actorId: string;
  authorLabel: string;
  authorKind: AuthorKind;
  body: string;
  createdAt: number;
  replyToMessageId?: string | null;
  isOperator: boolean;
  attachments: Attachment[];
  clientMessageId?: string | null;
  optimistic?: boolean;
  deliveryIssue?: "failed" | "unconfirmed";
};

type ControlResult = {
  ok: boolean;
  messageId?: string | null;
  flightId?: string | null;
  lifecycleState?: string | null;
  summary?: string | null;
  delivery?: { state: "accepted" | "recoverable"; reason?: string | null; action?: "start_replacement" | "retry" | null; detail?: string | null } | null;
};

type Block = {
  id: string;
  turnId: string;
  type: string;
  status: string;
  text?: string | null;
  message?: string | null;
  name?: string | null;
  mimeType?: string | null;
  action?: {
    kind?: string;
    status?: string;
    output?: string;
    command?: string | null;
    path?: string | null;
    toolName?: string | null;
    approval?: { version: number; description?: string | null; risk?: string | null } | null;
  } | null;
  header?: string | null;
  question?: string | null;
  options?: { label: string; description?: string | null }[] | null;
  questionStatus?: string | null;
};

type Turn = {
  id: string;
  status: string;
  startedAt: number;
  isUserTurn?: boolean | null;
  blocks: { block: Block; status: string }[];
  clientMessageId?: string | null;
};

type SessionState = {
  session: { id: string; name: string; adapterType: string; status: string; cwd?: string | null; model?: string | null };
  turns: Turn[];
  currentTurnId?: string | null;
};

type Snapshot = {
  conversationId: string;
  title: string;
  messages: Message[];
  session: SessionState | null;
  /** Paired-host identity and link state, refreshed with every snapshot poll
   * so the status stays truthful without a separate channel. */
  host?: HostIdentity | null;
  generatedAt: number;
};

type Bootstrap = {
  protocolVersion: number;
  conversationId: string;
  title: string;
  mode: ChatMode;
  style: ChatStyle;
  /** Global reading scale — one setting for every style and detail mode. */
  density: ChatDensity;
  /** Simulator capture seam: open the identity card on mount. */
  openIdentity?: boolean;
  /** Capture seam: lift a message into the actions overlay on first paint, so
   * containment can be photographed in WebKit without a physical long-press. */
  openActions?: boolean;
  capabilities: string[];
};

type ReplyEnvelope<T> = { v: number; id: string; method: string; result: T } | { v: number; id: string; method: string; error: { code: string; message: string } };

declare global {
  interface Window {
    /** Density is optional on the wire so a host built before this setting
     * existed still boots, landing on the default reading scale. */
    __scoutChatBootstrap?: (Omit<Bootstrap, "density"> & { density?: string | null }) | null;
  }
}

type ChatNativeWindow = Window & {
  webkit?: { messageHandlers?: { scoutChat?: { postMessage(request: unknown): Promise<ReplyEnvelope<unknown>> } } };
};

function nativeHandler() {
  return (window as ChatNativeWindow).webkit?.messageHandlers?.scoutChat;
}

const DEMO_MESSAGES: Message[] = [
  { id: "demo-1", conversationId: "demo", actorId: "you", authorLabel: "You", authorKind: "person", body: "Hey — are you around?", createdAt: Date.now() - 420_000, isOperator: true, attachments: [] },
  { id: "demo-2", conversationId: "demo", actorId: "fable", authorLabel: "Fable", authorKind: "agent", body: "Yep. What’s up?", createdAt: Date.now() - 390_000, isOperator: false, attachments: [] },
  { id: "demo-3", conversationId: "demo", actorId: "you", authorLabel: "You", authorKind: "person", body: "Can you check the unread badge? It looks like it’s counting the same thing twice.", createdAt: Date.now() - 310_000, isOperator: true, attachments: [] },
  { id: "demo-4", conversationId: "demo", actorId: "fable", authorLabel: "Fable", authorKind: "agent", body: "I see it. I’m checking the phone path now — I’ll let you know before I change anything.", createdAt: Date.now() - 245_000, isOperator: false, attachments: [] },
];

/** Second and third voices, so a capture can show the case where a sender name
 * is carrying information rather than repeating the header. */
const DEMO_GROUP_TAIL: Message[] = [
  { id: "demo-g1", conversationId: "demo", actorId: "kimi", authorLabel: "Kimi", authorKind: "agent", body: "Jumping in — I have the simulator captures from the last run if that helps.", createdAt: Date.now() - 220_000, isOperator: false, attachments: [] },
  { id: "demo-g2", conversationId: "demo", actorId: "kimi", authorLabel: "Kimi", authorKind: "agent", body: "Both styles, light and dark.", createdAt: Date.now() - 215_000, isOperator: false, attachments: [] },
  { id: "demo-g3", conversationId: "demo", actorId: "opus", authorLabel: "Opus", authorKind: "agent", body: "Post them here and I’ll diff against the measure change.", createdAt: Date.now() - 180_000, isOperator: false, attachments: [] },
  { id: "demo-g4", conversationId: "demo", actorId: "you", authorLabel: "You", authorKind: "person", body: "Thanks both.", createdAt: Date.now() - 120_000, isOperator: true, attachments: [] },
];

/** The atoms that can widen an overlay past the phone, gathered into one message
 * so the containment measurement has something adversarial to measure.
 *
 * Each is a real mechanism, not decoration: the quoted line is `white-space:
 * nowrap`, so its min-content is the whole unwrapped sentence; the file card and
 * voice note carry `min-width` floors of 230pt and 224pt; and an unbroken token
 * has no soft-wrap opportunity at all. Any of them can set a floor that
 * propagates up and pushes the overlay off-screen. */
function overlayStressMessages(): Message[] {
  return [{
    id: "demo-stress-quote",
    conversationId: "demo",
    actorId: "you",
    authorLabel: "You",
    authorKind: "person" as const,
    body: "Great. Show me how the WhatsApp-inspired version handles the same conversation, end to end.",
    createdAt: Date.now() - 200_000,
    isOperator: true,
    attachments: [],
  }, {
    id: "demo-stress",
    conversationId: "demo",
    actorId: "fable",
    authorLabel: "Fable",
    authorKind: "agent" as const,
    // Replying makes the lifted message carry the nowrap quote — the exact
    // geometry in the operator's captures, which no other preview row produces.
    replyToMessageId: "demo-stress-quote",
    body: "Ready. Same Scout identity and content, with a warmer conversation grammar.\n\nlog: /Users/example/Library/Application-Support/OpenScout/diagnostics/chat-overlay-containment-measurement-2026-08-12.jsonl\n\n" + "This paragraph intentionally exercises a realistic long agent response without changing the production conversation record. ".repeat(16),
    createdAt: Date.now() - 190_000,
    isOperator: false,
    attachments: [
      { id: "demo-file", mediaType: "application/pdf", fileName: "chat-overlay-containment-report-2026-08-12.pdf" },
      { id: "demo-voice", mediaType: "audio/m4a", fileName: "voice-note.m4a" },
    ],
  } satisfies Message];
}

function previewFixtureMessages() {
  const preview = new URLSearchParams(window.location.search);
  if (preview.get("topology") === "group") return [...DEMO_MESSAGES, ...DEMO_GROUP_TAIL];
  if (preview.get("stress") === "overlay") return [...DEMO_MESSAGES, ...overlayStressMessages()];
  if (preview.get("stress") !== "long") return DEMO_MESSAGES;
  return [...DEMO_MESSAGES, {
    id: "demo-long",
    conversationId: "demo",
    actorId: "fable",
    authorLabel: "Fable",
    authorKind: "agent" as const,
    // Quoted, because the report this fixture stands for was itself a reply —
    // and a long body alone never reproduced the containment failure.
    replyToMessageId: "demo-3",
    body: "[ask:f-preview] Reviewed the phone captures and found the layout issue. **The message actions should stay reachable even when an agent sends a long report.**\n\n1. The reaction row stays compact and keeps 44-point targets.\n\n2. The lifted message becomes a bounded preview instead of taking over the screen.\n\n3. The complete report remains in the conversation behind Read more.\n\n" + "This paragraph intentionally exercises a realistic long agent response without changing the production conversation record. ".repeat(16),
    createdAt: Date.now() - 180_000,
    isOperator: false,
    attachments: [],
  } satisfies Message];
}

/** Stands in for the conversation's own agent before any incoming voice has
 * spoken, so the header card still has a subject. */
const CONVERSATION_IDENTITY = "__conversation__";

const REACTIONS = ["❤️", "👍", "👎", "😂", "‼️", "❓"];
const REACTION_LABELS: Record<string, string> = { "❤️": "Love", "👍": "Like", "👎": "Dislike", "😂": "Laugh", "‼️": "Emphasize", "❓": "Question" };
const MORE_REACTIONS = ["😀", "🥰", "😮", "😢", "😡", "👏", "🙌", "🔥", "🎉", "💯", "✅", "👀", "🙏", "🤝", "💡", "🚀", "🫶", "🤔", "🤯", "💪", "❤️‍🔥", "✨", "⭐️", "🫡"];

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function callNative<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const handler = nativeHandler();
  if (!handler) throw new Error("Scout’s native chat bridge is unavailable.");
  const id = requestId();
  const reply = await handler.postMessage({ v: 1, id, method, params });
  if (reply.id !== id || reply.method !== method) throw new Error("Scout returned the wrong chat reply.");
  if ("error" in reply) throw new Error(reply.error.message);
  return reply.result as T;
}

/** Preview-only host status, so every state can be captured without needing a
 * Mac in that condition. Ignored whenever the native bridge is present. */
function previewHost(): HostIdentity | null {
  const preview = new URLSearchParams(window.location.search);
  const state = preview.get("host");
  if (!state) return { name: "Arts Mac mini", state: "synced" };
  if (state === "unnamed") return { name: null, state: "synced" };
  if (state === "none") return null;
  return { name: "Arts Mac mini", state };
}

function bootstrap(): Bootstrap {
  const preview = new URLSearchParams(window.location.search);
  const native = window.__scoutChatBootstrap;
  // The host is the authority for everything except density, which an older
  // host may not send yet; `resolveDensity` supplies the refined default.
  if (native) return { ...native, density: resolveDensity(native.density) };
  return {
    protocolVersion: 1,
    conversationId: "preview",
    title: preview.get("title")?.trim() || "Fable",
    mode: preview.get("mode") === "techie" ? "techie" : "normie",
    style: preview.get("style") === "whatsapp" ? "whatsapp" : preview.get("style") === "scout" ? "scout" : "messages",
    density: resolveDensity(preview.get("density")),
    capabilities: [],
  };
}

function turnText(turn: Turn) {
  return turn.blocks
    .filter(({ block }) => block.type === "text")
    .map(({ block }) => block.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function normalise(snapshot: Snapshot | null): Message[] {
  if (!snapshot) return DEMO_MESSAGES;
  if (snapshot.messages.length) return snapshot.messages;
  return (snapshot.session?.turns ?? []).flatMap((turn) => {
    const body = turnText(turn);
    if (!body) return [];
    return [{
      id: turn.id,
      conversationId: snapshot.conversationId,
      actorId: turn.isUserTurn ? "you" : "agent",
      authorLabel: turn.isUserTurn ? "You" : snapshot.title,
      authorKind: turn.isUserTurn ? "person" : "agent",
      body,
      createdAt: turn.startedAt,
      isOperator: turn.isUserTurn === true,
      attachments: [],
      clientMessageId: turn.clientMessageId,
    } satisfies Message];
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Couldn’t read that attachment."));
    reader.readAsDataURL(file);
  });
}

function formatTime(value: number) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

/** Harness routing ids are useful in the technical view, but read like leaked
 * transport metadata in an ordinary conversation. Keep the stored message
 * untouched for copy/reply while presenting the human body cleanly. */
function cleanChatBody(value: string) {
  return value.replace(/^\s*\[(?:ask|reply|flight):[^\]]+\]\s*/i, "").trim();
}

function renderChatInline(value: string) {
  const parts = value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function MessageBody({ body, collapsed, focused }: { body: string; collapsed: boolean; focused: boolean }) {
  const blocks = body.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return (
    <div className="message-body" data-collapsed={collapsed} data-focused={focused}>
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
        const numbered = lines.every((line) => /^\d+[.)]\s+/.test(line));
        const bulleted = lines.every((line) => /^[-•]\s+/.test(line));
        if (numbered) {
          const first = Number(lines[0]?.match(/^(\d+)/)?.[1] ?? 1);
          return <ol key={blockIndex} start={first}>{lines.map((line, lineIndex) => <li key={lineIndex}>{renderChatInline(line.replace(/^\d+[.)]\s+/, ""))}</li>)}</ol>;
        }
        if (bulleted) {
          return <ul key={blockIndex}>{lines.map((line, lineIndex) => <li key={lineIndex}>{renderChatInline(line.replace(/^[-•]\s+/, ""))}</li>)}</ul>;
        }
        return <p key={blockIndex}>{lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{renderChatInline(line)}</Fragment>)}</p>;
      })}
    </div>
  );
}

function ChatAvatar({ name, scale = "standard" }: { name: string; scale?: "tiny" | "standard" | "large" | "huge" }) {
  return (
    <span className={`avatar${scale === "standard" ? "" : ` ${scale}`}`} role="img" aria-label={`${name} avatar`}>
      <SpriteAvatar name={name} tile glow={scale === "large" || scale === "huge"} title={name} />
    </span>
  );
}

function ChatApp() {
  // The host re-injects its bootstrap when a preference changes. Holding it in
  // state means an already-mounted conversation picks up a new reading scale
  // without waiting to be remounted.
  const [config, setConfig] = useState<Bootstrap>(bootstrap);
  useEffect(() => {
    // A re-read carries preferences forward but never the launch instruction.
    const reread = () => setConfig(stripLaunchOnlyFields(bootstrap()));
    window.addEventListener("scout:chat-bootstrap", reread);
    return () => window.removeEventListener("scout:chat-bootstrap", reread);
  }, []);
  const previewRows = useMemo(previewFixtureMessages, []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => nativeHandler() ? null : {
    conversationId: config.conversationId,
    title: config.title,
    messages: previewRows,
    host: previewHost(),
    generatedAt: Date.now(),
    session: {
      session: { id: "preview", name: config.title, adapterType: "codex", status: "ready", cwd: "/Users/example/dev/openscout", model: "gpt-5" },
      currentTurnId: null,
      turns: [{
        id: "preview-turn",
        status: "completed",
        startedAt: Date.now() - 220_000,
        blocks: [{
          status: "completed",
          block: { id: "preview-tool", turnId: "preview-turn", type: "tool", status: "completed", action: { toolName: "Simulator QA", status: "completed", output: "Messages surface rendered at phone size" } },
        }],
      }],
    },
  });
  const [messages, setMessages] = useState<Message[]>(() => nativeHandler() ? [] : previewRows);
  const [draft, setDraft] = useState(() => localStorage.getItem(`scout.chat.draft.${config.conversationId}`) ?? "");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendRecoveryAction, setSendRecoveryAction] = useState<"retry" | "start_replacement" | null>(null);
  const [retryClientMessageId, setRetryClientMessageId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(() => nativeHandler() ? null : new URLSearchParams(window.location.search).get("focus"));
  /** Honours the host's one-shot `openActions` once the snapshot has messages to
   * lift. Prefers a message that quotes another, because that is the shape that
   * used to break containment — a `white-space:nowrap` quote setting a floor no
   * ancestor could shrink. Runs once; dismissal is final, like every other
   * fixture seam here. */
  const actionsAutoOpened = useRef(false);
  /** The transcript reveal is a first-paint event, not a loading state. Latching
   * it here means a manual refresh or an older-history fetch — both of which can
   * legitimately flip `loading` — cannot fade the transcript a second time. */
  const hasRevealed = useRef(false);
  if (!loading) hasRevealed.current = true;
  const [moreReactionsOpen, setMoreReactionsOpen] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(`scout.chat.reactions.${config.conversationId}`) ?? "{}"); } catch { return {}; }
  });
  const [hiddenMessageIds, setHiddenMessageIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`scout.chat.hidden.${config.conversationId}`) ?? "[]"); } catch { return []; }
  });
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(() => localStorage.getItem(`scout.chat.pinned.${config.conversationId}`));
  const [sendStates, setSendStates] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [trayOpen, setTrayOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [identityActorId, setIdentityActorId] = useState<string | null>(
    () => (config.openIdentity ? CONVERSATION_IDENTITY : null),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [voiceInput, setVoiceInput] = useState<VoiceSnapshot["input"]>(IDLE_VOICE);
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = useState(0);
  const [showJump, setShowJump] = useState(false);
  /** How many messages have landed while the operator was reading further up.
   * The affordance says how much it is offering to catch you up on, rather than
   * just pointing downwards. */
  const [unseenCount, setUnseenCount] = useState(0);
  const seenCount = useRef(0);
  const [historyLimit, setHistoryLimit] = useState(300);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const refreshInFlight = useRef(false);
  const lastReadMessageId = useRef<string | null>(null);
  const pinnedToBottom = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const voiceLastFinalCount = useRef<number | null>(null);
  const voiceStartedAt = useRef<number | null>(null);
  const attachmentsRef = useRef(attachments);
  const focusDialogRef = useRef<HTMLDivElement>(null);
  const infoDialogRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!nativeHandler()) {
      setLoading(false);
      return;
    }
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const next = await callNative<Snapshot>("chat.snapshot", { limit: historyLimit });
      setSnapshot(next);
      setMessages((current) => {
        const authoritative = normalise(next);
        return reconcileAuthoritativeMessages(current, authoritative);
      });
      setLoadError(null);
      const newestMessageId = next.messages.at(-1)?.id ?? null;
      if (newestMessageId && newestMessageId !== lastReadMessageId.current) {
        lastReadMessageId.current = newestMessageId;
        void callNative("chat.markRead").catch(() => undefined);
      }
    } catch (error) {
      if (!quiet) setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      refreshInFlight.current = false;
    }
  }, [historyLimit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyVoiceSnapshot = useCallback((next: VoiceSnapshot, collectFinal: boolean) => {
    const input = next.input;
    setVoiceInput(input);

    if (input.state === "listening" && voiceStartedAt.current === null) {
      voiceStartedAt.current = Date.now();
      setVoiceElapsedSeconds(0);
    } else if (input.state !== "listening" && input.state !== "transcribing") {
      voiceStartedAt.current = null;
      setVoiceElapsedSeconds(0);
    }

    const previousFinalCount = voiceLastFinalCount.current;
    voiceLastFinalCount.current = input.finalCount;
    if (!collectFinal || previousFinalCount === null || input.finalCount <= previousFinalCount) return;

    const finalText = input.finalText.trim();
    if (!finalText) return;
    setDraft((current) => current.trim() ? `${current.trimEnd()} ${finalText}` : finalText);
  }, []);

  useEffect(() => {
    if (!config.capabilities.includes("native.voice.snapshot")) return;
    void callNative<VoiceSnapshot>("native.voice.snapshot")
      .then((next) => applyVoiceSnapshot(next, false))
      .catch(() => undefined);
  }, [applyVoiceSnapshot, config.capabilities]);

  useEffect(() => {
    if (!config.capabilities.includes("native.voice.snapshot")) return;
    if (!(["preparing", "listening", "transcribing"] as VoiceInputState[]).includes(voiceInput.state)) return;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await callNative<VoiceSnapshot>("native.voice.snapshot");
        applyVoiceSnapshot(next, true);
      } catch (error) {
        setToast(error instanceof Error ? error.message : "Voice input is unavailable");
        setVoiceInput(IDLE_VOICE);
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 120);
    void poll();
    return () => window.clearInterval(timer);
  }, [applyVoiceSnapshot, config.capabilities, voiceInput.state]);

  useEffect(() => {
    if (voiceInput.state !== "listening") return;
    const timer = window.setInterval(() => {
      const startedAt = voiceStartedAt.current;
      if (startedAt !== null) setVoiceElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [voiceInput.state]);

  useEffect(() => {
    const delay = snapshot?.session?.currentTurnId ? 1200 : 3200;
    const timer = window.setInterval(() => void refresh(true), delay);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot?.session?.currentTurnId]);

  useEffect(() => {
    localStorage.setItem(`scout.chat.draft.${config.conversationId}`, draft);
  }, [config.conversationId, draft]);

  useEffect(() => {
    localStorage.setItem(`scout.chat.reactions.${config.conversationId}`, JSON.stringify(reactions));
  }, [config.conversationId, reactions]);

  useEffect(() => {
    localStorage.setItem(`scout.chat.hidden.${config.conversationId}`, JSON.stringify(hiddenMessageIds));
  }, [config.conversationId, hiddenMessageIds]);

  useEffect(() => {
    const key = `scout.chat.pinned.${config.conversationId}`;
    if (pinnedMessageId) localStorage.setItem(key, pinnedMessageId);
    else localStorage.removeItem(key);
  }, [config.conversationId, pinnedMessageId]);

  useEffect(() => {
    if (!focusedId) setMoreReactionsOpen(false);
  }, [focusedId]);

  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    for (const item of attachmentsRef.current) if (item.preview) URL.revokeObjectURL(item.preview);
  }, []);

  useEffect(() => {
    const dialog = focusedId ? focusDialogRef.current : infoOpen ? infoDialogRef.current : null;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => dialog.focus());
    return () => previous?.focus();
  }, [focusedId, infoOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!messages.length) return;
    if (pinnedToBottom.current) {
      requestAnimationFrame(() => transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "auto" }));
      // Caught up by definition — nothing is waiting below the fold.
      setUnseenCount(0);
      seenCount.current = messages.length;
      return;
    }
    // F10: scrolled up is a deliberate position, so arrivals must not yank the
    // viewport. Count them instead and let the operator choose to come back.
    const arrived = messages.length - seenCount.current;
    if (arrived > 0) setUnseenCount((current) => current + arrived);
    seenCount.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    if (!config.openActions || actionsAutoOpened.current || !messages.length) return;
    const quoting = messages.find((message) => message.replyToMessageId && !message.isOperator);
    const subject = quoting ?? [...messages].reverse().find((message) => !message.isOperator);
    if (!subject) return;
    actionsAutoOpened.current = true;
    setFocusedId(subject.id);
  }, [config.openActions, messages]);

  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const replyTarget = replyToId ? byId.get(replyToId) ?? null : null;
  // Each overlay stays mounted for its exit (see `overlay-motion.ts`), so the
  // value that produced it has to outlive the dismissal that cleared it —
  // otherwise the last frame before it leaves is an empty one.
  const focusPresence = useOverlayPresence(focusedId != null);
  const focused = useRetainedValue(focusedId ? byId.get(focusedId) ?? null : null, focusPresence.rendered);
  const pinnedMessage = pinnedMessageId ? byId.get(pinnedMessageId) ?? null : null;
  const query = search.trim().toLocaleLowerCase();
  const unhiddenMessages = messages.filter((message) => !hiddenMessageIds.includes(message.id));
  const visibleMessages = query ? unhiddenMessages.filter((message) => message.body.toLocaleLowerCase().includes(query)) : unhiddenMessages;
  // Topology is read from the conversation itself rather than declared by the
  // host: a name above a bubble earns its place only once a second voice has
  // actually spoken in the window we are showing.
  const attribution = senderAttribution(unhiddenMessages);
  const host = hostStatus(snapshot?.host);
  // Session facts belong to the conversation's own agent. With exactly one
  // incoming voice we know who that is; in a group thread we do not.
  const soleIncomingActorId = attribution.incomingActorIds.length === 1 ? attribution.incomingActorIds[0] : null;
  const identitySource = identityActorId
    ? unhiddenMessages.find((message) => message.actorId === identityActorId && !message.isOperator)
    : undefined;
  const identityPresence = useOverlayPresence(identityActorId != null);
  const identity = useRetainedValue(
    identityActorId
      ? identityFor({
          actorId: identityActorId,
          name: identitySource?.authorLabel ?? config.title,
          kind: identitySource?.authorKind ?? "agent",
          mode: config.mode,
          soleIncomingActorId: identitySource ? soleIncomingActorId : identityActorId,
          session: snapshot?.session?.session,
          hostName: snapshot?.host?.name,
        })
      : null,
    identityPresence.rendered,
  );
  const infoPresence = useOverlayPresence(infoOpen);
  const trayPresence = useOverlayPresence(trayOpen, MOTION_QUICK_MS);
  const technicalTurns = snapshot?.session?.turns ?? [];
  const working = Boolean(snapshot?.session?.currentTurnId);
  const lastOutgoingId = [...messages].reverse().find((message) => message.isOperator)?.id ?? null;
  const lastOutgoingIndex = lastOutgoingId ? messages.findIndex((message) => message.id === lastOutgoingId) : -1;
  const lastOutgoingHasReply = lastOutgoingIndex >= 0 && messages.slice(lastOutgoingIndex + 1).some((message) => !message.isOperator);
  const canLoadEarlier = Boolean(nativeHandler() && snapshot?.messages.length === historyLimit && historyLimit < 1_000);
  const timeline = [
    ...visibleMessages.map((message) => ({ kind: "message" as const, at: message.createdAt, id: `message-${message.id}`, message })),
    ...(config.mode === "techie" ? technicalTurns.map((turn) => ({ kind: "technical" as const, at: turn.startedAt + 1, id: `tech-${turn.id}`, turn })) : []),
  ].sort((left, right) => left.at - right.at);

  function clearRecoveryForEdit() {
    if (!retryClientMessageId && !sendRecoveryAction) return;
    setRetryClientMessageId(null);
    setSendRecoveryAction(null);
    setSendError(null);
  }

  function scrollToMessage(messageId: string) {
    document.getElementById(`chat-message-${CSS.escape(messageId)}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function insertUtilityDraft(text: string) {
    clearRecoveryForEdit();
    setDraft((current) => current ? `${current}\n${text}` : text);
    setTrayOpen(false);
  }

  async function toggleDictation() {
    if (!config.capabilities.includes("native.voice.toggleInput")) {
      setToast("Voice input is unavailable in this view");
      return;
    }
    clearRecoveryForEdit();
    setTrayOpen(false);
    try {
      // Establish the controller's current final-count before a new utterance.
      // This prevents a previous transcript from being appended again after
      // returning to the conversation.
      if (voiceInput.state === "idle" || voiceInput.state === "unavailable") {
        const baseline = await callNative<VoiceSnapshot>("native.voice.snapshot");
        applyVoiceSnapshot(baseline, false);
      }
      const next = await callNative<VoiceSnapshot>("native.voice.toggleInput");
      applyVoiceSnapshot(next, true);
      if (next.input.state === "unavailable" && next.input.unavailableReason) {
        setToast(next.input.unavailableReason);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Couldn’t start voice input");
      setVoiceInput(IDLE_VOICE);
    }
  }

  async function stageFiles(files: FileList | null) {
    const selected = Array.from(files ?? []).slice(0, Math.max(0, 8 - attachments.length));
    if (!selected.length) return;
    clearRecoveryForEdit();
    setTrayOpen(false);
    const additions = selected.map((file) => ({
      file,
      preview: file.type.startsWith("image/") || file.type.startsWith("audio/")
        ? URL.createObjectURL(file)
        : undefined,
      uploading: true,
    }));
    setAttachments((current) => [...current, ...additions]);
    for (const addition of additions) {
      try {
        if (addition.file.size > 12_000_000) throw new Error("Keep attachments under 12 MB for this phone build.");
        const data = await fileToBase64(addition.file);
        const hosted = await callNative<Attachment>("chat.upload", {
          data,
          mediaType: addition.file.type || "application/octet-stream",
          fileName: addition.file.name,
        });
        setAttachments((current) => current.map((row) => row.file === addition.file ? { ...row, hosted, uploading: false } : row));
      } catch (error) {
        setAttachments((current) => current.map((row) => row.file === addition.file ? { ...row, uploading: false, error: error instanceof Error ? error.message : String(error) } : row));
      }
    }
  }

  async function sendMessage() {
    const body = draft.trim();
    if ((!body && !attachments.length) || sending || attachments.some((item) => item.uploading)) return;
    if (attachments.some((item) => !item.hosted)) {
      setSendError("Remove the attachment that couldn’t upload, then try again.");
      return;
    }
    const clientMessageId = retryClientMessageId ?? `ios-chat-${requestId()}`;
    const outboundAttachments = attachments;
    const outboundReplyToId = replyTarget?.id ?? null;
    const optimistic: Message = {
      id: clientMessageId,
      conversationId: config.conversationId,
      actorId: "you",
      authorLabel: "You",
      authorKind: "person",
      body,
      createdAt: Date.now(),
      replyToMessageId: replyTarget?.id,
      isOperator: true,
      attachments: attachments.flatMap((item) => item.hosted ? [item.hosted] : []),
      clientMessageId,
      optimistic: true,
    };
    setMessages((current) => [...current.filter((message) => message.clientMessageId !== clientMessageId), optimistic]);
    setDraft("");
    setReplyToId(null);
    setAttachments([]);
    setSending(true);
    setSendError(null);
    setSendRecoveryAction(null);
    try {
      const result = await callNative<ControlResult>("chat.send", {
        // The native bridge requires a non-empty body. Keep audio-only sends
        // semantically named in storage, then suppress this sentinel in the
        // bubble so the recording—not a fake transcript—is the message.
        body: body || (optimistic.attachments.every((attachment) => attachment.mediaType.startsWith("audio/"))
          ? "Voice message"
          : attachments.map((item) => item.file.name).join(", ")),
        replyToMessageId: replyTarget?.id,
        clientMessageId,
        attachments: optimistic.attachments,
      });
      if (!result.ok) {
        const detail = result.summary || "Scout didn’t accept that message.";
        setMessages((current) => current.map((message) => message.clientMessageId === clientMessageId
          ? { ...message, deliveryIssue: "failed" }
          : message));
        setDraft(body);
        setReplyToId(outboundReplyToId);
        setAttachments(outboundAttachments);
        setRetryClientMessageId(clientMessageId);
        setSendRecoveryAction("retry");
        setSendError(detail);
        return;
      }
      const state = acceptedSendLabel(result);
      setSendStates((current) => ({ ...current, [clientMessageId]: state }));
      if (result.delivery?.state === "recoverable") {
        setSendError(result.delivery.detail || result.summary || "The message was saved, but Scout needs another route.");
        setSendRecoveryAction(result.delivery.action ?? null);
        setRetryClientMessageId(clientMessageId);
        setDraft(body);
        setReplyToId(outboundReplyToId);
        setAttachments(outboundAttachments);
      } else {
        setRetryClientMessageId(null);
        for (const item of outboundAttachments) if (item.preview) URL.revokeObjectURL(item.preview);
      }
      await refresh(true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A dropped bridge response does not prove that the broker rejected the
      // write. Keep the optimistic message and offer an idempotent retry, but
      // label delivery as unconfirmed instead of asserting a failure.
      setMessages((current) => current.map((message) => message.clientMessageId === clientMessageId
        ? { ...message, deliveryIssue: "unconfirmed" }
        : message));
      setDraft(body);
      setReplyToId(outboundReplyToId);
      setAttachments(outboundAttachments);
      setRetryClientMessageId(clientMessageId);
      setSendRecoveryAction("retry");
      setSendError(detail);
    } finally {
      setSending(false);
    }
  }

  function chooseReaction(emoji: string) {
    if (!focused) return;
    setReactions((current) => ({ ...current, [focused.id]: current[focused.id] === emoji ? "" : emoji }));
    setFocusedId(null);
    setToast("Reaction saved on this phone");
  }

  function pinFocused() {
    if (!focused) return;
    const unpinning = pinnedMessageId === focused.id;
    setPinnedMessageId(unpinning ? null : focused.id);
    setFocusedId(null);
    setToast(unpinning ? "Unpinned on this phone" : "Pinned on this phone");
  }

  async function copyFocused() {
    if (!focused) return;
    try { await navigator.clipboard.writeText(focused.body); }
    catch {
      const area = document.createElement("textarea");
      area.value = focused.body;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setFocusedId(null);
    setToast("Copied");
  }

  function replyFocused() {
    if (!focused) return;
    clearRecoveryForEdit();
    setReplyToId(focused.id);
    setFocusedId(null);
  }

  function editFocused() {
    if (!focused?.isOperator) return;
    clearRecoveryForEdit();
    setDraft(focused.body);
    setFocusedId(null);
    setToast("Copied into the composer");
  }

  function deleteFocused() {
    if (!focused) return;
    if (pinnedMessageId === focused.id) setPinnedMessageId(null);
    setHiddenMessageIds((current) => current.includes(focused.id) ? current : [...current, focused.id]);
    setFocusedId(null);
    setToast("Hidden on this phone");
  }

  async function stopWork() {
    try {
      await callNative("chat.interrupt", {});
      setToast("Stopped");
      await refresh(true);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Couldn’t stop that turn");
    }
  }

  const style = config.style;
  return (
    <main className="chat-app" data-style={style} data-mode={config.mode} data-density={config.density}>
      <header className="chat-header">
        <button className="back-button" type="button" aria-label="Back" onClick={() => void callNative("native.close").catch(() => undefined)}>
          <ArrowLeft />
        </button>
        <button className="contact-button" type="button" data-working={working} aria-label={`About ${config.title}`} onClick={() => setIdentityActorId(soleIncomingActorId ?? CONVERSATION_IDENTITY)}>
          <ChatAvatar name={config.title} />
          <strong>{config.title}</strong>
        </button>
        <div className="header-actions">
          <button type="button" aria-label="Search" onClick={() => setSearchOpen((value) => !value)}><Search /></button>
        </div>
      </header>

      {searchOpen && (
        <div className="search-row">
          <Search />
          <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search this conversation" />
          <button type="button" aria-label="Close search" onClick={() => { setSearch(""); setSearchOpen(false); }}><X /></button>
        </div>
      )}

      {config.mode === "techie" && snapshot?.session && (
        <section className="tech-strip">
          <div><span className={working ? "live-dot" : "idle-dot"} /><strong>{working ? "Working" : snapshot.session.session.status}</strong></div>
          <span>{snapshot.session.session.adapterType}</span>
          {snapshot.session.session.model && <span>{snapshot.session.session.model}</span>}
          {snapshot.session.session.cwd && <span>{snapshot.session.session.cwd.split("/").pop()}</span>}
          {working && <button type="button" onClick={stopWork}><Square /> Stop</button>}
        </section>
      )}

      <div
        className="transcript"
        ref={transcriptRef}
        // Opacity-only reveal, once, when the transcript stops being a skeleton.
        // Anything that moved here would shift content under a thumb already on
        // its way to a message. Latched (see `hasRevealed`) so a refresh or a
        // history load cannot drive the attribute false→true again and replay
        // the fade over content the operator is already reading.
        data-revealed={hasRevealed.current || undefined}
        role="log"
        aria-live="polite"
        onScroll={(event) => {
          const target = event.currentTarget;
          const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
          pinnedToBottom.current = distance < 90;
          setShowJump(distance > 170);
        }}
      >
        {style === "whatsapp"
          ? host && <div className="encryption-note" data-tone={host.tone} role="status">{host.text}</div>
          : <div className="encryption-note">Today</div>}
        {style === "whatsapp" && pinnedMessage && (
          <button className="pinned-banner" type="button" onClick={() => scrollToMessage(pinnedMessage.id)}>
            <span aria-hidden="true">⌁</span>
            <span><strong>Pinned on this phone</strong><small>{pinnedMessage.body || pinnedMessage.attachments[0]?.fileName || "Attachment"}</small></span>
            <span aria-hidden="true">›</span>
          </button>
        )}
        {canLoadEarlier && <button className="load-earlier" type="button" onClick={() => setHistoryLimit((current) => Math.min(1_000, current + 300))}>Load earlier messages</button>}
        {loading && <div className="loading-stack"><i /><i /><i /></div>}
        {loadError && (
          <div className="inline-error" role="alert" title={loadError}>
            <span className="inline-error-mark" aria-hidden="true"><Info /></span>
            <span className="inline-error-copy">
              <strong>Can’t reach this conversation</strong>
              <small>The paired Scout host didn’t return it. Check the connection, then try again.</small>
            </span>
            <button type="button" onClick={() => void refresh()}>Retry</button>
          </div>
        )}
        {!loading && !loadError && !visibleMessages.length && (
          <div className="empty-chat"><ChatAvatar name={config.title} scale="large" /><strong>Say hi to {config.title}</strong><p>This is a normal conversation. Ask a question, share something, or just check in.</p></div>
        )}
        {timeline.map((item) => {
          if (item.kind === "technical") {
            return <TechnicalTurn key={item.id} turn={item.turn} onAnswer={async (blockId, answer) => { await callNative("chat.answer", { turnId: item.turn.id, blockId, answer }); await refresh(true); }} onDecide={async (blockId, version, decision) => { await callNative("chat.decide", { turnId: item.turn.id, blockId, version, decision }); await refresh(true); }} />;
          }
          const message = item.message;
          const index = visibleMessages.findIndex((candidate) => candidate.id === message.id);
          const previous = visibleMessages[index - 1];
          const grouped = isGroupedWithPrevious(message, previous);
          const sendState = message.clientMessageId ? sendStates[message.clientMessageId] : undefined;
          return (
            <MessageBubble
              key={item.id}
              message={message}
              quoted={message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined}
              grouped={grouped}
              reaction={reactions[message.id]}
              receipt={message.isOperator && message.id === lastOutgoingId
                ? message.deliveryIssue === "failed"
                  ? "Not delivered"
                  : message.deliveryIssue === "unconfirmed"
                    ? "Delivery unconfirmed"
                  : message.optimistic
                    ? sendState ?? "Sending…"
                    : sendState ?? (lastOutgoingHasReply ? "Agent responded" : working ? "Agent is working" : "Posted")
                : undefined}
              onRetry={message.deliveryIssue ? () => {
                setDraft(message.body);
                setMessages((current) => current.filter((candidate) => candidate.id !== message.id));
                setSendError(null);
                setRetryClientMessageId(message.clientMessageId ?? null);
              } : undefined}
              style={style}
              senderLabel={showsSenderLabel({ mode: config.mode, isOperator: message.isOperator, grouped, multiSender: attribution.multiSender })
                ? { name: message.authorLabel, hue: attribution.hueIndexOf(message.actorId) }
                : undefined}
              onOpenIdentity={message.isOperator ? undefined : () => setIdentityActorId(message.actorId)}
              onFocus={() => setFocusedId(message.id)}
              onReply={() => { clearRecoveryForEdit(); setReplyToId(message.id); setToast("Replying"); }}
              onJumpToQuoted={message.replyToMessageId ? () => scrollToMessage(message.replyToMessageId!) : undefined}
            />
          );
        })}
        {working && <div className="typing-row"><ChatAvatar name={config.title} scale="tiny" /><span className="typing"><i /><i /><i /></span></div>}
      </div>

      {showJump && (
        <button
          className="jump-button"
          type="button"
          data-unseen={unseenCount > 0 || undefined}
          aria-label={unseenCount > 0 ? `Jump to latest, ${unseenCount} new ${unseenCount === 1 ? "message" : "messages"}` : "Jump to latest"}
          onClick={() => { pinnedToBottom.current = true; setUnseenCount(0); transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); }}
        >
          <ArrowDown />
          {unseenCount > 0 && <span className="jump-count">{unseenCount > 99 ? "99+" : unseenCount}</span>}
        </button>
      )}

      <footer className="composer-wrap">
        {replyTarget && (
          <div className="reply-target"><span><strong>Replying to {replyTarget.isOperator ? "yourself" : replyTarget.authorLabel}</strong><small>{replyTarget.body}</small></span><button type="button" aria-label="Cancel reply" onClick={() => { clearRecoveryForEdit(); setReplyToId(null); }}><X /></button></div>
        )}
        {!!attachments.length && (
          <div className="attachment-previews">
            {attachments.map((item) => item.file.type.startsWith("audio/") ? (
              <div className="voice-draft" key={`${item.file.name}-${item.file.lastModified}`}>
                <VoiceNote attachment={{
                  id: `draft-${item.file.name}-${item.file.lastModified}`,
                  mediaType: item.file.type,
                  fileName: item.file.name,
                  url: item.preview,
                }} localPreviewURL={item.preview} />
                <small>{item.uploading ? "Uploading recording…" : item.error ?? "Voice message ready to send"}</small>
                <button type="button" aria-label="Discard voice message" onClick={() => { if (item.preview) URL.revokeObjectURL(item.preview); clearRecoveryForEdit(); setAttachments((current) => current.filter((row) => row.file !== item.file)); }}><X /></button>
              </div>
            ) : (
              <div className="attachment-preview" key={`${item.file.name}-${item.file.lastModified}`}>
                {item.preview ? <img src={item.preview} alt="" /> : <FileText />}
                <span><strong>{item.file.name}</strong><small>{item.uploading ? "Uploading…" : item.error ?? "Ready"}</small></span>
                <button type="button" aria-label={`Remove ${item.file.name}`} onClick={() => { if (item.preview) URL.revokeObjectURL(item.preview); clearRecoveryForEdit(); setAttachments((current) => current.filter((row) => row.file !== item.file)); }}><X /></button>
              </div>
            ))}
          </div>
        )}
        {sendError && <div className="send-error"><span>{sendError}</span><button type="button" onClick={() => {
          if (sendRecoveryAction === "retry") void sendMessage();
          else if (sendRecoveryAction === "start_replacement") void callNative("native.close").catch(() => undefined);
          else setSendError(null);
        }}>{sendRecoveryAction === "retry" ? "Retry" : sendRecoveryAction === "start_replacement" ? "Chats" : "Dismiss"}</button></div>}
        <div className="composer-row" data-voice-state={voiceInput.state}>
          <button className="add-button" type="button" aria-label="Add attachment" data-open={trayOpen} onClick={() => setTrayOpen((value) => !value)}>{style === "whatsapp" ? <Paperclip /> : <Plus />}</button>
          <div className="composer-field" aria-live="polite">
            {voiceInput.state === "preparing" || voiceInput.state === "listening" || voiceInput.state === "transcribing" ? (
              <div className="voice-input" data-state={voiceInput.state}>
                <span className="voice-input-mark" aria-hidden="true"><Mic /></span>
                <span className="voice-input-wave" aria-hidden="true">
                  {Array.from({ length: 18 }, (_, index) => {
                    const shape = [0.55, 0.86, 0.66, 1, 0.72, 0.92][index % 6];
                    const energy = voiceInput.state === "listening" ? Math.max(0.08, voiceInput.audioLevel) : 0.08;
                    return <i key={index} style={{ height: `${Math.max(3, Math.min(20, energy * shape * 34))}px` }} />;
                  })}
                </span>
                <span className="voice-input-copy">
                  <strong>{voiceInput.state === "preparing" ? "Starting…" : voiceInput.state === "transcribing" ? "Transcribing…" : formatAudioTime(voiceElapsedSeconds)}</strong>
                  <small>{voiceInput.partialText || (voiceInput.state === "listening" ? "Listening" : "Turning speech into text")}</small>
                </span>
              </div>
            ) : (
              <>
                {style === "whatsapp" && <button type="button" aria-label="Insert smile" onClick={() => { clearRecoveryForEdit(); setDraft((value) => `${value}😊`); }}><Smile /></button>}
                <textarea
                  rows={1}
                  value={draft}
                  onChange={(event) => { clearRecoveryForEdit(); setDraft(event.target.value); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
                  }}
                  placeholder="Message"
                  aria-label="Message"
                />
                {style === "whatsapp" && !draft.trim() && <button type="button" aria-label="Camera" onClick={() => cameraRef.current?.click()}><Camera /></button>}
              </>
            )}
          </div>
          <button
            className="send-button"
            type="button"
            disabled={sending || voiceInput.state === "preparing" || voiceInput.state === "transcribing"}
            aria-label={voiceInput.state === "listening" ? "Finish dictation" : draft.trim() || attachments.length ? "Send message" : "Start dictation"}
            onClick={() => voiceInput.state === "listening" || (!draft.trim() && !attachments.length) ? void toggleDictation() : void sendMessage()}
          >
            {voiceInput.state === "listening" ? <Square /> : draft.trim() || attachments.length ? <Send /> : <Mic />}
          </button>
        </div>
        {trayPresence.rendered && (
          <div className="attachment-tray" data-phase={trayPresence.phase}>
            <button type="button" onClick={() => photoRef.current?.click()}><span data-tone="blue"><ImageIcon /></span>Photos</button>
            <button type="button" onClick={() => cameraRef.current?.click()}><span data-tone="teal"><Camera /></span>Camera</button>
            <button type="button" onClick={() => audioRef.current?.click()}><span data-tone="cyan"><Mic /></span>Record</button>
            <button type="button" onClick={() => fileRef.current?.click()}><span data-tone="indigo"><FileText /></span>Document</button>
            <button type="button" onClick={() => insertUtilityDraft("📊 Poll\n• Option 1\n• Option 2")}><span data-tone="purple">☷</span>Poll</button>
            <button type="button" onClick={() => insertUtilityDraft("✅ Check in with me: ")}><span data-tone="teal-deep">✓</span>Check In</button>
            <button type="button" disabled aria-label="Contact sharing unavailable"><span data-tone="gray">@</span>Contact</button>
            <button type="button" disabled aria-label="Location sharing unavailable"><span data-tone="green">⌖</span>Location</button>
          </div>
        )}
      </footer>

      <input hidden ref={photoRef} type="file" accept="image/*,video/*" multiple onChange={(event) => void stageFiles(event.target.files)} />
      <input hidden ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={(event) => void stageFiles(event.target.files)} />
      <input hidden ref={audioRef} type="file" accept="audio/*" capture="user" onChange={(event) => { void stageFiles(event.target.files); event.currentTarget.value = ""; }} />
      <input hidden ref={fileRef} type="file" accept="audio/*,.pdf,.txt,.md,.zip,.doc,.docx" multiple onChange={(event) => void stageFiles(event.target.files)} />

      {focusPresence.rendered && focused && (
        <div className="focus-layer" data-phase={focusPresence.phase} role="dialog" aria-modal="true" aria-label="Message actions" onClick={() => setFocusedId(null)} onKeyDown={(event) => { if (event.key === "Escape") setFocusedId(null); }}>
          <div className="focused-message" ref={focusDialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <div className="reaction-picker" role="group" aria-label="Reactions saved on this phone">
              {REACTIONS.map((emoji) => <button type="button" key={emoji} aria-label={REACTION_LABELS[emoji]} onClick={() => chooseReaction(emoji)}>{emoji}</button>)}
              <button type="button" aria-label="More reactions" aria-expanded={moreReactionsOpen} onClick={() => setMoreReactionsOpen((value) => !value)}><Plus /></button>
            </div>
            {moreReactionsOpen && <div className="emoji-grid" aria-label="More reactions">{MORE_REACTIONS.map((emoji) => <button type="button" key={emoji} aria-label={`React ${emoji}`} onClick={() => chooseReaction(emoji)}>{emoji}</button>)}</div>}
            <MessageBubble message={focused} quoted={focused.replyToMessageId ? byId.get(focused.replyToMessageId) : undefined} reaction={reactions[focused.id]} style={style} senderLabel={showsSenderLabel({ mode: config.mode, isOperator: focused.isOperator, grouped: false, multiSender: attribution.multiSender }) ? { name: focused.authorLabel, hue: attribution.hueIndexOf(focused.actorId) } : undefined} focused onFocus={() => undefined} onReply={replyFocused} onJumpToQuoted={focused.replyToMessageId ? () => scrollToMessage(focused.replyToMessageId!) : undefined} onRetry={focused.deliveryIssue ? () => { setDraft(focused.body); setMessages((current) => current.filter((message) => message.id !== focused.id)); setFocusedId(null); setSendError(null); setRetryClientMessageId(focused.clientMessageId ?? null); } : undefined} />
            <div className="action-menu">
              <button type="button" onClick={replyFocused}><span>Reply</span><Reply /></button>
              <button type="button" onClick={copyFocused}><span>Copy</span><Copy /></button>
              {style === "whatsapp" && <button type="button" onClick={pinFocused}><span>{pinnedMessageId === focused.id ? "Unpin" : "Pin on this phone"}</span><span aria-hidden="true">⌁</span></button>}
              {focused.isOperator && <button type="button" onClick={editFocused}><span>Edit as new</span><Ellipsis /></button>}
              <button type="button" onClick={() => { clearRecoveryForEdit(); setDraft(focused.body); setFocusedId(null); setToast("Ready to forward as a new message"); }}><span>Forward as new</span><Forward /></button>
              <button className="destructive" type="button" onClick={deleteFocused}><span>Delete for me</span><Trash2 /></button>
            </div>
          </div>
        </div>
      )}

      {identityPresence.rendered && identity && (
        <IdentityCard
          phase={identityPresence.phase}
          identity={identity}
          onClose={() => setIdentityActorId(null)}
          onViewDetails={identity.isConversationAgent ? () => { setIdentityActorId(null); setInfoOpen(true); } : undefined}
        />
      )}

      {infoPresence.rendered && (
        <div className="sheet-layer" data-phase={infoPresence.phase} role="dialog" aria-modal="true" onClick={() => setInfoOpen(false)} onKeyDown={(event) => { if (event.key === "Escape") setInfoOpen(false); }}>
          <section className="info-sheet" ref={infoDialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <div className="sheet-grab" />
            <ChatAvatar name={config.title} scale="huge" />
            <h2>{config.title}</h2>
            <p>{working ? "Typing…" : snapshot?.session?.session.status ?? "Scout conversation"}</p>
            <div className="info-actions"><button type="button" disabled><Phone />Call</button><button type="button" disabled><Video />Video</button><button type="button" onClick={() => { setSearchOpen(true); setInfoOpen(false); }}><Search />Search</button><button type="button" onClick={() => setToast("This is a Scout conversation")}><Info />Info</button></div>
            <div className="info-row"><span>Shared media and files</span><small>{messages.reduce((total, message) => total + message.attachments.length, 0)} items</small></div>
            <div className="info-row"><span>Notifications</span><small>Scout settings</small></div>
            <button className="info-row destructive" type="button" disabled><span>Block {config.title} · Unavailable</span></button>
            <button className="done-button" type="button" onClick={() => setInfoOpen(false)}>Done</button>
          </section>
        </div>
      )}
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}

function MessageBubble({ message, quoted, grouped = false, reaction, receipt, style, senderLabel, focused = false, onFocus, onReply, onJumpToQuoted, onRetry, onOpenIdentity }: { message: Message; quoted?: Message; grouped?: boolean; reaction?: string; receipt?: string; style: ChatStyle; senderLabel?: { name: string; hue: number }; focused?: boolean; onFocus: () => void; onReply?: () => void; onJumpToQuoted?: () => void; onRetry?: () => void; onOpenIdentity?: () => void }) {
  const timer = useRef<number | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const swipeRef = useRef(0);
  const [swipeX, setSwipeX] = useState(0);
  /** True only while the bubble is travelling back to rest after a release below
   * the commit threshold. Cleared on the next press so a settle in flight never
   * fights a new drag — the transition must be interruptible, not authoritative. */
  const [settling, setSettling] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const body = displayMessageBody(message);
  const bodyIsLong = body.length > 1_000 || body.split("\n").length > 18;
  const clear = () => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; };
  return (
    <div id={`chat-message-${message.id}`} className="message-row" data-own={message.isOperator} data-grouped={grouped} data-focused={focused}>
      {!focused && !message.isOperator && !grouped && (
        onOpenIdentity
          ? <button className="avatar-button" type="button" aria-label={`About ${message.authorLabel}`} onClick={(event) => { event.stopPropagation(); onOpenIdentity(); }}>
              <ChatAvatar name={message.authorLabel} scale="tiny" />
            </button>
          : <ChatAvatar name={message.authorLabel} scale="tiny" />
      )}
      <div className="bubble-stack">
        {showsSwipeCue(swipeX, { focused }) && <span className="swipe-reply-cue" aria-hidden="true"><Reply /></span>}
        <div
          className="message-hit"
          role="button"
          tabIndex={0}
          data-settling={settling || undefined}
          style={!focused && swipeX ? { transform: `translateX(${swipeX}px)` } : undefined}
          onTransitionEnd={() => setSettling(false)}
          onPointerDown={(event) => { start.current = { x: event.clientX, y: event.clientY }; swipeRef.current = 0; setSettling(false); setSwipeX(0); clear(); if (armsLongPress({ focused })) timer.current = window.setTimeout(onFocus, LONG_PRESS_MS); }}
          onPointerMove={(event) => {
            const dx = event.clientX - start.current.x;
            const dy = event.clientY - start.current.y;
            if (exceedsSlop(dx, dy)) clear();
            const offset = swipeOffset(dx, dy, { focused, canReply: Boolean(onReply) });
            if (offset !== null) { swipeRef.current = offset; setSwipeX(offset); }
          }}
          // Below the threshold the gesture is abandoned, so the bubble settles
          // back under transition rather than teleporting. A committed reply and
          // a pointer-cancel both reset instantly — there is nothing to settle.
          onPointerUp={() => { clear(); const outcome = releaseOutcome(swipeRef.current); if (outcome === "commit") onReply?.(); else if (outcome === "settle") setSettling(true); swipeRef.current = 0; setSwipeX(0); }}
          onPointerCancel={() => { clear(); swipeRef.current = 0; setSettling(false); setSwipeX(0); }}
          onContextMenu={(event) => { event.preventDefault(); onFocus(); }}
          onDoubleClick={onFocus}
          onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) onFocus(); }}
        >
          <article className="message-bubble">
            {senderLabel && (
              onOpenIdentity
                ? <button className="sender-name" data-hue={senderLabel.hue} type="button" aria-label={`About ${senderLabel.name}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpenIdentity(); }}>{senderLabel.name}</button>
                : <strong className="sender-name" data-hue={senderLabel.hue}>{senderLabel.name}</strong>
            )}
            {quoted && <button className="quoted-message" type="button" onClick={(event) => { event.stopPropagation(); onJumpToQuoted?.(); }}><strong>{quoted.isOperator ? "You" : quoted.authorLabel}</strong><span>{quoted.body}</span></button>}
            {message.attachments.map((attachment) => <AttachmentView key={attachment.id} attachment={attachment} />)}
            {body && <MessageBody body={body} collapsed={!focused && bodyIsLong && !expanded} focused={focused} />}
            {!focused && bodyIsLong && !expanded && (
              <button className="message-read-more" type="button" onClick={(event) => { event.stopPropagation(); setExpanded(true); }}>Read more</button>
            )}
            <span className="message-meta">
              {style === "whatsapp"
                ? receipt
                  ? `${formatTime(message.createdAt)} · ${receipt}`
                  : formatTime(message.createdAt)
                : receipt ?? formatTime(message.createdAt)}
              {message.deliveryIssue ? (
                <button
                  className="delivery-issue-mark"
                  type="button"
                  data-issue={message.deliveryIssue}
                  aria-label={message.deliveryIssue === "failed" ? "Retry undelivered message" : "Retry message with unconfirmed delivery"}
                  onClick={(event) => { event.stopPropagation(); onRetry?.(); }}
                >!</button>
              ) : message.isOperator ? <Check /> : null}
            </span>
          </article>
        </div>
        {reaction && <span className="reaction-badge" aria-label={`${REACTION_LABELS[reaction] ?? `Reaction ${reaction}`}, saved on this phone`} title="Saved on this phone only">{reaction}</span>}
      </div>
    </div>
  );
}

/** Compact, in-context identity. Deliberately not the large contact sheet and
 * not a technical slide-out: a name, a few true facts, and a way out. */
function IdentityCard({ identity, phase, onClose, onViewDetails }: { identity: Identity; phase: OverlayPhase; onClose: () => void; onViewDetails?: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => cardRef.current?.focus());
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="identity-layer"
      data-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-label={`About ${identity.name}`}
      onClick={onClose}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
    >
      <div className="identity-card" ref={cardRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <ChatAvatar name={identity.name} scale="large" />
        <strong>{identity.name}</strong>
        {identity.status && <span className="identity-state">{identity.status}</span>}
        {identity.facts.length > 0 && (
          <div className="identity-facts">
            {identity.facts.map((fact) => (
              <div className="identity-fact" key={fact.label}>
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
        )}
        {onViewDetails && (
          <button className="identity-details" type="button" onClick={onViewDetails}>View details</button>
        )}
        <button className="identity-dismiss" type="button" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function displayMessageBody(message: Message) {
  const body = cleanChatBody(message.body);
  const isAudioOnlySentinel = body.toLocaleLowerCase() === "voice message"
    && message.attachments.some((attachment) => attachment.mediaType.startsWith("audio/"));
  return isAudioOnlySentinel ? "" : body;
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const image = attachment.mediaType.startsWith("image/");
  if (attachment.mediaType.startsWith("audio/")) return <VoiceNote attachment={attachment} />;
  const contents = <><span>{image ? <ImageIcon /> : <FileText />}</span><span><strong>{attachment.fileName ?? (image ? "Shared image" : "Attachment")}</strong><small>{attachment.mediaType}</small></span><span className="file-open" aria-hidden="true"><ArrowDown /></span></>;
  return attachment.url
    ? <a className="file-card" href={attachment.url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.fileName ?? "attachment"}`}>{contents}</a>
    : <div className="file-card" aria-label={`${attachment.fileName ?? "Attachment"}, unavailable`}>{contents}</div>;
}

const fetchNativeAttachment = createNativeAttachmentFetcher(callNative);

function VoiceNote({ attachment, localPreviewURL }: { attachment: Attachment; localPreviewURL?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const loaderRef = useRef<HostedVoiceSource | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [sourceState, setSourceState] = useState<"idle" | "loading" | "ready" | "error">(
    localPreviewURL ? "ready" : "idle",
  );
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  useEffect(() => {
    const audio = audioRef.current;
    const source = resolveVoicePlaybackSource(attachment, localPreviewURL);
    setPlaying(false);
    setDuration(0);
    setElapsed(0);
    setSourceState(source.kind === "local" ? "ready" : "idle");
    loaderRef.current?.dispose();
    loaderRef.current = null;

    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.preload = "none";
      if (source.kind === "local") {
        audio.src = source.url;
        audio.preload = "metadata";
        audio.load();
      }
    }

    if (source.kind === "hosted") {
      loaderRef.current = new HostedVoiceSource(source, {
        fetchAttachment: fetchNativeAttachment,
        createObjectURL: (bytes, mediaType) => URL.createObjectURL(new Blob([
          new Uint8Array(bytes).buffer,
        ], { type: mediaType })),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      });
    }

    return () => {
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      loaderRef.current?.dispose();
      loaderRef.current = null;
    };
  }, [attachment.id, attachment.mediaType, localPreviewURL]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio || sourceState === "loading") return;
    if (!audio.paused) {
      audio.pause();
      return;
    }

    try {
      if (!audio.hasAttribute("src")) {
        const loader = loaderRef.current;
        if (!loader) throw new Error("Audio unavailable");
        setSourceState("loading");
        const objectURL = await loader.load();
        if (loader !== loaderRef.current) return;
        audio.src = objectURL;
        audio.preload = "metadata";
        audio.load();
      }
      await audio.play();
      setSourceState("ready");
    } catch {
      setSourceState("error");
    }
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = value * audio.duration;
    setElapsed(audio.currentTime);
  };

  const playbackError = () => {
    setPlaying(false);
    setSourceState("error");
    if (!localPreviewURL) {
      const audio = audioRef.current;
      audio?.removeAttribute("src");
      audio?.load();
      loaderRef.current?.reset();
    }
  };

  const sourceLabel = sourceState === "loading"
    ? "Loading…"
    : sourceState === "error"
      ? "Tap to retry"
      : sourceState === "idle"
        ? "Tap to play"
        : formatAudioTime(playing ? elapsed : duration || elapsed);

  return (
    <div className="voice-note" data-unavailable={sourceState === "error"} data-loading={sourceState === "loading"}>
      <audio
        ref={audioRef}
        preload="none"
        onLoadedMetadata={(event) => {
          const next = event.currentTarget.duration;
          setDuration(Number.isFinite(next) ? next : 0);
          setSourceState("ready");
        }}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setElapsed(0); }}
        onError={playbackError}
      />
      <button
        className="voice-note-toggle"
        type="button"
        disabled={sourceState === "loading"}
        aria-label={sourceState === "loading" ? "Loading voice message" : sourceState === "error" ? "Retry voice message" : playing ? "Pause voice message" : "Play voice message"}
        onClick={(event) => { event.stopPropagation(); void toggle(); }}
      >{playing ? <Pause /> : <Play />}</button>
      <div className="voice-note-track">
        <div className="voice-note-wave" aria-hidden="true">
          {Array.from({ length: 28 }, (_, index) => (
            <i key={index} data-played={(index + 1) / 28 <= progress} />
          ))}
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.005"
          value={progress}
          disabled={sourceState !== "ready" || duration === 0}
          aria-label="Voice message position"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => seek(Number(event.currentTarget.value))}
        />
        <span>{sourceLabel}</span>
      </div>
    </div>
  );
}

function formatAudioTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function TechnicalTurn({ turn, onAnswer, onDecide }: { turn: Turn; onAnswer: (blockId: string, answer: string[]) => Promise<void>; onDecide: (blockId: string, version: number, decision: "approve" | "deny") => Promise<void> }) {
  const [pendingBlockId, setPendingBlockId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const technical = turn.blocks.map(({ block }) => block).filter((block) => block.type !== "text" && block.type !== "reasoning");
  if (!technical.length) return null;
  const submit = async (blockId: string, action: () => Promise<void>) => {
    if (pendingBlockId) return;
    setPendingBlockId(blockId);
    setActionError(null);
    try { await action(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setPendingBlockId(null); }
  };
  return (
    <section className="technical-turn" aria-label="Agent activity">
      <header><span className={turn.status === "streaming" ? "live-dot" : "idle-dot"} /><strong>{turn.status === "streaming" ? "Working" : "Work details"}</strong><small>{formatTime(turn.startedAt)}</small></header>
      {technical.map((block) => {
        if (block.type === "question") return <div className="question-card" key={block.id}><strong>{block.header ?? "Quick question"}</strong><p>{block.question}</p><div>{block.options?.map((option) => <button type="button" disabled={pendingBlockId === block.id} key={option.label} onClick={() => void submit(block.id, () => onAnswer(block.id, [option.label]))}>{option.label}</button>)}</div></div>;
        const approval = block.action?.approval;
        return <div className="technical-block" key={block.id}><span><FileText /></span><span><strong>{block.action?.command ?? block.action?.path ?? block.action?.toolName ?? block.name ?? block.type}</strong><small>{block.action?.status ?? block.status}{block.action?.output ? ` · ${block.action.output.slice(0, 90)}` : ""}</small></span>{approval && <span className="approval-buttons"><button type="button" disabled={pendingBlockId === block.id} onClick={() => void submit(block.id, () => onDecide(block.id, approval.version, "deny"))}>Deny</button><button type="button" disabled={pendingBlockId === block.id} onClick={() => void submit(block.id, () => onDecide(block.id, approval.version, "approve"))}>Approve</button></span>}</div>;
      })}
      {actionError && <p className="technical-error" role="alert">{actionError}</p>}
    </section>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<StrictMode><ChatApp /></StrictMode>);
