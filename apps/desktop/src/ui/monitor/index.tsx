/** @jsxImportSource @opentui/react */

import React from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { ScoutMonitorApp } from "./app.tsx";

export type RunScoutMonitorAppOptions = {
  currentDirectory: string;
  channel?: string;
  limit?: number;
  refreshIntervalMs?: number;
};

const DEFAULT_REFRESH_INTERVAL_MS = 10_000;
const DEFAULT_MONITOR_LIMIT = 64;

export async function runScoutMonitorApp(options: RunScoutMonitorAppOptions): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("scout tui requires an interactive terminal");
  }

  const renderer = await createCliRenderer();
  const root = createRoot(renderer);
  let closed = false;

  await new Promise<void>((resolve) => {
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      try {
        root.unmount();
      } finally {
        renderer.destroy();
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
      }
      resolve();
    };

    process.once("SIGINT", close);
    process.once("SIGTERM", close);

    root.render(
      <ScoutMonitorApp
        currentDirectory={options.currentDirectory}
        channel={options.channel}
        limit={options.limit ?? DEFAULT_MONITOR_LIMIT}
        refreshIntervalMs={options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS}
        onQuit={close}
      />,
    );
  });
}
