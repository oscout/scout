/**
 * The space switcher: which room-set you are in, and how to make another.
 *
 * It sits above the channel list because that is what it governs — the list
 * below it is this space's channels and nothing else. It is deliberately the
 * quietest control in the column: a name, a caret, and a menu. A space is
 * changed rarely, so it earns one line, not a rail of its own.
 *
 * Nothing here is inferred. The list comes off `/api/chat/bootstrap`; a space
 * the server did not send is not drawn, and the count beside each name is the
 * server's count of the channels this viewer can see in it. When the server
 * sends one space, the switcher renders as a plain label rather than as a menu
 * that opens onto a single choice.
 *
 * Creating a space creates its first channel with it. A space with no room in
 * it is a dead end the operator has to notice and fix, so the form asks for
 * both and the server defaults the second to `general`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatSpaceView } from "./chat-api.ts";
import { useChatCapabilities } from "./chat-transport.tsx";

/** The rail has room for one glyph. A space gets its initial. */
function spaceGlyph(title: string): string {
  return title.trim().slice(0, 1).toUpperCase() || "?";
}

export function SpaceSwitcher({
  spaces,
  activeSlug,
  canCreate,
  railed,
  onSelect,
  onCreate,
  onDelete,
  onExpandRail,
}: {
  spaces: ChatSpaceView[];
  activeSlug: string;
  canCreate: boolean;
  railed: boolean;
  onSelect: (slug: string) => void;
  onCreate: (input: { title: string; channel: string }) => Promise<void>;
  /** Absent where the server has no deletion endpoint; the item is not drawn. */
  onDelete: ((slug: string) => Promise<void>) | null;
  onExpandRail: () => void;
}) {
  const capabilities = useChatCapabilities();
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Deleting a space is irreversible, so it is armed by name rather than by a
  // single click: the item asks, and the second press is the one that acts.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const active = spaces.find((space) => space.slug === activeSlug)
    ?? spaces[0]
    ?? null;

  // Closing the menu disarms the confirmation; a menu reopened later must not
  // still be one click away from deleting something.
  useEffect(() => {
    if (!menuOpen) setConfirmingDelete(false);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const submit = useCallback(async () => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ title: name, channel: channel.trim() });
      setTitle("");
      setChannel("");
      setCreating(false);
      setMenuOpen(false);
    } catch (cause) {
      // The server owns the refusal — a duplicate slug, a name with no usable
      // slug in it. Rendered verbatim rather than replaced with a guess.
      setError(cause instanceof Error ? cause.message : "That space could not be created.");
    } finally {
      setBusy(false);
    }
  }, [busy, channel, onCreate, title]);

  if (!active) return null;

  if (railed) {
    return (
      <div className="chat-space-switch" data-railed="true" ref={rootRef}>
        <button
          type="button"
          className="chat-rail-row chat-space-rail"
          aria-label={`${active.title} — switch space`}
          title={active.title}
          onClick={() => onExpandRail()}
        >
          <span className="chat-rail-glyph">{spaceGlyph(active.title)}</span>
        </button>
      </div>
    );
  }

  // One space is not a choice. Drawing a menu for it would promise somewhere
  // else to go and then open onto the room you are already in.
  const switchable = spaces.length > 1 || canCreate;

  return (
    <div className="chat-space-switch" ref={rootRef}>
      <button
        type="button"
        className="chat-space-current"
        aria-expanded={switchable ? menuOpen : undefined}
        aria-haspopup={switchable ? "menu" : undefined}
        disabled={!switchable}
        onClick={() => switchable && setMenuOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            event.preventDefault();
            event.stopPropagation();
            setMenuOpen(false);
          }
        }}
      >
        <span className="chat-space-name">{active.title}</span>
        {switchable ? (
          <span className="chat-space-caret" aria-hidden="true">{menuOpen ? "⌄" : "⌃"}</span>
        ) : null}
      </button>

      {menuOpen ? (
        <div className="chat-space-menu" role="menu" aria-label="Spaces">
          {spaces.map((space) => (
            <button
              key={space.slug}
              type="button"
              role="menuitemradio"
              aria-checked={space.slug === active.slug}
              className="chat-space-menu-item"
              data-active={space.slug === active.slug}
              onClick={() => {
                setMenuOpen(false);
                if (space.slug !== active.slug) onSelect(space.slug);
              }}
            >
              <span className="chat-space-menu-name">{space.title}</span>
              {/* A server that does not count another space's channels gets no
                  number here, rather than a zero that reads as "empty". */}
              {space.channelCount === undefined ? null : (
                <span className="label-sm chat-space-menu-count">
                  {space.channelCount}
                </span>
              )}
            </button>
          ))}

          {canCreate ? (
            <>
              <div className="chat-space-menu-rule" />
              {creating ? (
                <div className="chat-create-form">
                  <input
                    className="chat-input"
                    value={title}
                    autoFocus
                    placeholder="Space name"
                    aria-label="Space name"
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
                  {/* Offered only where the server honors it. Where the server
                      names the first channel itself, a field whose value is
                      discarded is worse than no field. */}
                  {capabilities.namedFirstChannel ? (
                    <input
                      className="chat-input"
                      value={channel}
                      placeholder="First channel (general)"
                      aria-label="First channel"
                      onChange={(event) => setChannel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submit();
                        }
                      }}
                    />
                  ) : null}
                  {error ? <p className="chat-space-error">{error}</p> : null}
                  <div className="chat-create-actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy || !title.trim()}
                      onClick={() => void submit()}
                    >
                      {busy ? "Creating…" : "Create"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setCreating(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="chat-space-menu-item chat-space-menu-new"
                  onClick={() => setCreating(true)}
                >
                  + New space
                </button>
              )}
            </>
          ) : null}

          {onDelete && capabilities.spaceDelete ? (
            <>
              <div className="chat-space-menu-rule" />
              <button
                type="button"
                className="chat-space-menu-item chat-space-menu-danger"
                disabled={busy}
                onClick={() => {
                  if (!confirmingDelete) {
                    setConfirmingDelete(true);
                    return;
                  }
                  setBusy(true);
                  setError(null);
                  void onDelete(active.slug)
                    .then(() => {
                      setConfirmingDelete(false);
                      setMenuOpen(false);
                    })
                    .catch((cause: unknown) => {
                      setConfirmingDelete(false);
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "That space could not be deleted.",
                      );
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {confirmingDelete
                  ? `Delete ${active.title} and everything in it`
                  : "Delete this space"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
