// Singleton tRPC client connecting from the bridge process to the broker's
// tail.events subscription. Fans every TailEvent out to every local subscriber
// (the bridge router's `tail.events` and the legacy auto-fanout).
//
// Phones receive these via the bridge's trusted Noise channel — they never
// connect to the broker directly.
//
// See docs/tail-firehose.md.

import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { BrokerRouter } from "@openscout/runtime/broker-trpc-router";
import type { TailEvent } from "@openscout/runtime/tail";

import { resolveScoutBrokerUrl } from "../../../broker/service.ts";
import { log } from "./log.ts";

type Listener = (event: TailEvent) => void;

class TailFanout {
  private wsClient: ReturnType<typeof createWSClient> | null = null;
  private trpc: ReturnType<typeof createTRPCClient<BrokerRouter>> | null = null;
  private subscription: { unsubscribe: () => void } | null = null;
  private listeners = new Set<Listener>();

  /**
   * Subscribe to TailEvents. Returns an unsubscribe function. The first
   * subscriber triggers connection; the connection stays open until the
   * process exits (broker is local, reconnects are cheap and handled by the
   * tRPC WS link).
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.ensureConnected();
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private wsUrl(): string {
    const httpUrl = resolveScoutBrokerUrl();
    const wsBase = httpUrl.replace(/^http/i, "ws").replace(/\/$/, "");
    return `${wsBase}/trpc`;
  }

  private ensureConnected(): void {
    if (this.subscription) return;
    const url = this.wsUrl();

    if (!this.wsClient) {
      this.wsClient = createWSClient({
        url,
        onOpen: () => log.info("tail-fanout", "connected", { url }),
        onClose: () => log.info("tail-fanout", "disconnected", { url }),
        onError: (event) => log.warn("tail-fanout", "ws error", { url, event: String(event) }),
      });
      this.trpc = createTRPCClient<BrokerRouter>({
        links: [wsLink({ client: this.wsClient })],
      });
    }

    this.subscription = this.trpc!.tail.events.subscribe(undefined, {
      onData: (data) => {
        // tRPC `tracked` envelope: `{ id, data }`. The id is TailEvent.id.
        const event = (data as { data: TailEvent }).data;
        this.fanout(event);
      },
      onError: (err) => {
        log.warn("tail-fanout", "subscription error", { error: String(err) });
      },
    });
  }

  private fanout(event: TailEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn("tail-fanout", "listener threw", { error: String(error) });
      }
    }
  }
}

let singleton: TailFanout | null = null;

export function getTailFanout(): TailFanout {
  if (!singleton) singleton = new TailFanout();
  return singleton;
}
