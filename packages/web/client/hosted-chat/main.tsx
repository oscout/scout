/**
 * Hosted Scout Chat — the browser entry for the Cloudflare Worker.
 *
 * It mounts the same `ChatSpaceSurface` that `/chat` mounts on a local Scout,
 * with the same stylesheet and the same interactions, and hands it a transport
 * pointed at the Worker instead of the local server. There is no second copy of
 * the interface here and nothing in this file draws anything.
 *
 * The operator broker shell is deliberately absent — as it is for local
 * `/chat` — so none of the local broker surface is reachable from this page.
 * `/admin` is a separate hosted-only operations screen, not that shell.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ChatSpaceSurface } from "../screens/chat-space/ChatSpaceSurface.tsx";
import { ChatTransportProvider } from "../screens/chat-space/chat-transport.tsx";
import { createPathChatAddress } from "../screens/chat-space/chat-address.ts";
import {
  applyScoutThemeToDocument,
  resolveScoutStartupAppearanceDetails,
  resolveScoutStartupTemplate,
  resolveScoutStartupTheme,
} from "../lib/theme.ts";

import { HostedChatAdmin } from "./HostedChatAdmin.tsx";
import { HostedChatLanding } from "./HostedChatLanding.tsx";
import { createHostedChatApi, HOSTED_CHAT_CAPABILITIES } from "./hosted-chat-api.ts";

import "../styles/tokens.css";
import "../styles/primitives.css";
import "../arc-tailwind.css";
import "../app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

applyScoutThemeToDocument(
  resolveScoutStartupTheme(),
  resolveScoutStartupTemplate(),
  resolveScoutStartupAppearanceDetails(),
);

if (window.location.pathname === "/admin") {
  createRoot(root).render(
    <StrictMode>
      <HostedChatAdmin />
    </StrictMode>,
  );
} else {
  // Built once, outside render: the transport is identity for the surface, and a
  // new object every render would restart every poll.
  const api = createHostedChatApi();
  // Hosted spaces live at `/<slug>`; the Worker serves this page for both `/`
  // and that path, so the address grammar is the only thing that has to know.
  const address = createPathChatAddress("");
  createRoot(root).render(
    <StrictMode>
      <ChatTransportProvider
        api={api}
        capabilities={HOSTED_CHAT_CAPABILITIES}
        address={address}
      >
        {/* Hosted Chat has its own door: the address-first entrance rather than
            the shared gate card. Local `/chat` mounts the surface with no
            `signedOut` and keeps the card it has always had. */}
        <ChatSpaceSurface signedOut={(view) => <HostedChatLanding {...view} />} />
      </ChatTransportProvider>
    </StrictMode>,
  );
}
