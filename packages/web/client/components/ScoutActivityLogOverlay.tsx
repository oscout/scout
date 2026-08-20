'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { HudLogger, HudLoggerStatusItem, HObservabilityDefault } from '@hudsonkit';

const HUD_LOGGER_MAX_EVENTS = 200;

export function ScoutActivityLogStatusButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 items-center rounded px-1 py-0.5 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title="Open activity log"
      aria-label="Open activity log"
    >
      <HudLoggerStatusItem maxEvents={HUD_LOGGER_MAX_EVENTS} showCounts />
    </button>
  );
}

export function ScoutActivityLogOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex bg-background/88 p-3 text-foreground backdrop-blur-md md:p-5"
      role="dialog"
      aria-modal="true"
      aria-label="Activity log"
    >
      <div className="flex min-h-0 w-full flex-col">
        <div className="flex h-10 shrink-0 items-center justify-between border border-border border-b-0 bg-card/95 px-3 shadow-[var(--hud-shadow-nav)]">
          <div className="min-w-0 font-mono text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
            Activity Log
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="Close activity log"
            aria-label="Close activity log"
          >
            <X size={14} />
          </button>
        </div>
        <HudLogger
          observability={HObservabilityDefault}
          maxEvents={HUD_LOGGER_MAX_EVENTS}
          title="activity"
          className="min-h-0 flex-1 rounded-t-none"
          emptyMessage="No activity yet. Connection and status events will appear here."
        />
      </div>
    </div>
  );
}