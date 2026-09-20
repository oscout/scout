/**
 * The sidebar: channels, direct messages, and one quiet Invite action.
 *
 * No session rows, no sort chrome, no member counts — a teammate should parse
 * this in one glance. The accent appears here for exactly one reason: a row
 * holding something addressed to the viewer that is still owed. Ordinary
 * traffic reorders quietly and decorates nothing.
 *
 * Pin, archive, sort, latest-only, search, and a docked DM well live in the
 * Studio study `/studies/chat-space-rails`, not here, until that direction
 * is picked. Collapse and resize live on the column's header band
 * (ChatSpaceSurface), the same law as Scout's Hudson rails.
 *
 * The foot carries who you are. Identity used to sit in the top bar, which put
 * it as far from the channel list as the window allows; it belongs at the
 * bottom of the column it governs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationDefinition } from "@openscout/protocol";

import type { ScoutThemePreference } from "../../lib/theme.ts";
import { useChatCapabilities } from "./chat-transport.tsx";
import { MemberCoin } from "./ChatAvatar.tsx";
import { SpaceSwitcher } from "./SpaceSwitcher.tsx";
import type { ChatSpaceView } from "./chat-api.ts";
import { channelLabel } from "./chat-space-model.ts";

const THEME_CHOICES: { value: ScoutThemePreference; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

function moveFocus(container: HTMLElement | null, from: HTMLElement, delta: number) {
  if (!container) return;
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-side-row]"));
  const index = rows.indexOf(from);
  if (index < 0) return;
  const next = rows[(index + delta + rows.length) % rows.length];
  next?.focus();
}

/** The rail has one glyph's worth of room: the hash, and the letter it starts with. */
function railGlyph(title: string): string {
  const name = title.replace(/^#/u, "").trim();
  return name.slice(0, 1).toLowerCase() || "?";
}


/**
 * Who you are, and the short menu behind it.
 *
 * Closes on Escape and on a pointer landing anywhere else — the surface's own
 * Escape handler closes the right panel, so this one stops the event once it
 * has used it.
 */
function SidebarIdentity({
  viewerName,
  viewerIsHost,
  railed,
  themePreference,
  onOpenProfile,
  onThemePreference,
  onSignOut,
}: {
  viewerName: string;
  viewerIsHost: boolean;
  railed: boolean;
  themePreference: ScoutThemePreference;
  onOpenProfile: (() => void) | null;
  onThemePreference: (next: ScoutThemePreference) => void;
  onSignOut: () => void;
}) {
  const capabilities = useChatCapabilities();
  const [menuOpen, setMenuOpen] = useState(false);
  const footRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    footRef.current?.querySelector<HTMLButtonElement>(".chat-you-menu button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && footRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const choose = useCallback((run: () => void) => {
    setMenuOpen(false);
    run();
  }, []);

  return (
    <div
      className="chat-sidebar-identity"
      ref={footRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(false);
          footRef.current?.querySelector<HTMLButtonElement>(".chat-you")?.focus();
        }
      }}
    >
      {menuOpen ? (
        <div className="chat-you-menu" role="group" aria-label={`${viewerName} menu`}>
          <div className="chat-you-menu-head">
            <MemberCoin name={viewerName} size={28} title={viewerName} />
            <span className="chat-you-menu-name">{viewerName}</span>
          </div>
          <div className="chat-you-menu-rule" />
          {onOpenProfile ? (
            <button
              type="button"
              className="chat-you-menu-item"
              onClick={() => choose(onOpenProfile)}
            >
              Your member card
            </button>
          ) : null}
          <div className="chat-you-menu-group" role="group" aria-label="Appearance">
            <span className="label-sm">Appearance</span>
            <div className="chat-you-themes">
              {THEME_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  className="btn btn--sm"
                  aria-pressed={themePreference === choice.value}
                  data-active={themePreference === choice.value}
                  onClick={() => onThemePreference(choice.value)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
          {capabilities.signOut ? (
            <>
              <div className="chat-you-menu-rule" />
              <button
                type="button"
                className="chat-you-menu-item"
                onClick={() => choose(onSignOut)}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        className="chat-you"
        aria-expanded={menuOpen}
        aria-label={railed ? `${viewerName} — account menu` : undefined}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MemberCoin name={viewerName} size={24} title={viewerName} />
        {railed ? null : (
          <>
            <span className="chat-you-who">
              <span className="chat-you-name">{viewerName}</span>
              {viewerIsHost ? <span className="label-sm chat-you-role">Host</span> : null}
            </span>
            <span className="chat-you-caret" aria-hidden="true">{menuOpen ? "⌄" : "⌃"}</span>
          </>
        )}
      </button>
    </div>
  );
}

export function ChannelSidebar({
  channels,
  directs,
  spaces,
  activeSpace,
  selectedId,
  addressedChannelIds,
  canCreate,
  viewerName,
  viewerIsHost,
  railed,
  themePreference,
  onSelect,
  onSelectSpace,
  onCreate,
  onCreateSpace,
  onDeleteSpace,
  onInvite,
  onExpandRail,
  onOpenProfile,
  onThemePreference,
  onSignOut,
}: {
  channels: ConversationDefinition[];
  directs: ConversationDefinition[];
  /** Every space this viewer can open, as the server listed them. */
  spaces: ChatSpaceView[];
  activeSpace: string;
  selectedId: string | null;
  addressedChannelIds: ReadonlySet<string>;
  canCreate: boolean;
  viewerName: string;
  viewerIsHost: boolean;
  railed: boolean;
  themePreference: ScoutThemePreference;
  onSelect: (id: string) => void;
  onSelectSpace: (slug: string) => void;
  onCreate: (input: { title: string; topic: string }) => Promise<void>;
  onDeleteSpace: ((slug: string) => Promise<void>) | null;
  onCreateSpace: (input: { title: string; channel: string }) => Promise<void>;
  onInvite: () => void;
  onExpandRail: () => void;
  /** Null while no channel is open, because the card lives in that channel's panel. */
  onOpenProfile: (() => void) | null;
  onThemePreference: (next: ScoutThemePreference) => void;
  onSignOut: () => void;
}) {
  const capabilities = useChatCapabilities();
  const listRef = useRef<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await onCreate({ title: name, topic: topic.trim() });
      setTitle("");
      setTopic("");
      setCreating(false);
    } finally {
      setBusy(false);
    }
  }, [busy, onCreate, title, topic]);

  const row = (conversation: ConversationDefinition, isChannel: boolean) => {
    const addressed = addressedChannelIds.has(conversation.id);
    const name = isChannel ? conversation.title.replace(/^#/u, "") : conversation.title;
    return (
      <button
        key={conversation.id}
        type="button"
        data-side-row
        className={railed ? "chat-rail-row" : "chat-side-row"}
        aria-label={isChannel ? channelLabel(conversation.title) : name}
        aria-current={conversation.id === selectedId}
        data-addressed={addressed}
        title={railed ? (isChannel ? channelLabel(conversation.title) : name) : undefined}
        onClick={() => onSelect(conversation.id)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveFocus(listRef.current, event.currentTarget, 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveFocus(listRef.current, event.currentTarget, -1);
          }
        }}
      >
        {railed ? (
          isChannel ? (
            <span className="chat-rail-glyph">
              <span className="chat-hash">#</span>
              {railGlyph(conversation.title)}
            </span>
          ) : (
            <MemberCoin name={name} size={22} title={name} />
          )
        ) : (
          <>
            {isChannel ? <span className="chat-hash">#</span> : null}
            <span className="chat-row-name">{name}</span>
          </>
        )}
        {addressed ? (
          <span className="dot dot--accent dot--sm" aria-label="Addressed to you, unanswered" />
        ) : null}
      </button>
    );
  };

  const switcher = spaces.length > 0 ? (
    <SpaceSwitcher
      spaces={spaces}
      activeSlug={activeSpace}
      canCreate={canCreate && capabilities.spaceCreate}
      railed={railed}
      onSelect={onSelectSpace}
      onCreate={onCreateSpace}
      onDelete={canCreate ? onDeleteSpace : null}
      onExpandRail={onExpandRail}
    />
  ) : null;

  const identity = (
    <SidebarIdentity
      viewerName={viewerName}
      viewerIsHost={viewerIsHost}
      railed={railed}
      themePreference={themePreference}
      onOpenProfile={onOpenProfile}
      onThemePreference={onThemePreference}
      onSignOut={onSignOut}
    />
  );

  if (railed) {
    return (
      <nav
        className="chat-sidebar"
        data-railed="true"
        ref={listRef}
        aria-label="Channels and direct messages"
        onDoubleClick={(event) => {
          // Double-click on empty chrome expands, as it does on every other
          // collapsed rail in Scout. It costs no pixels.
          if ((event.target as HTMLElement).closest("button, a, [role='button']")) return;
          onExpandRail();
        }}
      >
        {switcher}
        <div className="chat-side-list">
          {channels.map((channel) => row(channel, true))}
          {directs.length > 0 ? <div className="chat-rail-rule" /> : null}
          {directs.map((direct) => row(direct, false))}
        </div>

        <div className="chat-sidebar-foot">
          <button type="button" className="chat-rail-row" aria-label="Invite someone" onClick={onInvite}>
            <span className="chat-rail-glyph">+</span>
          </button>
        </div>
        {identity}
      </nav>
    );
  }

  return (
    <nav className="chat-sidebar" ref={listRef} aria-label="Channels and direct messages">
      {switcher}
      <div className="chat-side-list">
        <div className="chat-side-section">
          <span className="label-md">Channels</span>
          {canCreate && capabilities.channelCreate ? (
            <button
              type="button"
              className="chat-side-add"
              aria-label="Create a channel"
              aria-expanded={creating}
              onClick={() => setCreating((open) => !open)}
            >
              +
            </button>
          ) : null}
        </div>

        {creating ? (
          <div className="chat-create-form">
            <input
              className="chat-input"
              value={title}
              autoFocus
              placeholder="channel-name"
              aria-label="Channel name"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setCreating(false);
                }
              }}
            />
            <input
              className="chat-input"
              value={topic}
              placeholder="Topic (optional)"
              aria-label="Channel topic"
              onChange={(event) => setTopic(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="chat-create-actions">
              <button type="button" className="btn btn--sm" disabled={busy || !title.trim()} onClick={() => void submit()}>
                {busy ? "Creating…" : "Create"}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {channels.length === 0 ? (
          <p className="chat-side-empty">
            {canCreate
              ? `No channels in ${spaces.find((space) => space.slug === activeSpace)?.title ?? "this space"} yet. Create one to get started.`
              : "You are not in any channel yet. Open the invitation you were sent."}
          </p>
        ) : (
          channels.map((channel) => row(channel, true))
        )}

        {directs.length > 0 ? (
          <>
            <div className="chat-side-section">
              <span className="label-md">Direct messages</span>
            </div>
            {directs.map((direct) => row(direct, false))}
          </>
        ) : null}
      </div>

      <div className="chat-sidebar-foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onInvite}>
          + Invite
        </button>
      </div>
      {identity}
    </nav>
  );
}
