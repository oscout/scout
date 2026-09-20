/**
 * Which server the standalone Chat surface is talking to.
 *
 * The components, the model, the CSS and every interaction in
 * `screens/chat-space/` are shared verbatim between the local Scout server and
 * hosted Chat. The only thing that differs between them is the HTTP underneath,
 * so that is the only thing this module isolates: a `ChatApi` implementation and
 * the `ChatCapabilities` it can honestly claim.
 *
 * Two rules keep the seam narrow:
 *
 *  - **The transport answers, the surface renders.** A transport never changes
 *    what a control looks like or how it behaves; it changes where the bytes
 *    come from, and declares what it cannot do.
 *  - **An absent capability is stated, not simulated.** Where a backend has no
 *    endpoint for something, the capability is `false` and the affordance is not
 *    rendered. Nothing degrades into an empty list that reads as "none yet".
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  chatApi,
  DEFAULT_CHAT_SPACE,
  LOCAL_CHAT_CAPABILITIES,
  type ChatApi,
  type ChatCapabilities,
} from "./chat-api.ts";
import { createQueryChatAddress, type ChatAddress } from "./chat-address.ts";

export interface ChatTransport {
  api: ChatApi;
  capabilities: ChatCapabilities;
  /** How this deployment spells "which space, which channel" in the address bar. */
  address: ChatAddress;
}

/** The local Scout server, which answers the whole contract. */
export const LOCAL_CHAT_TRANSPORT: ChatTransport = {
  api: chatApi,
  capabilities: LOCAL_CHAT_CAPABILITIES,
  address: createQueryChatAddress(DEFAULT_CHAT_SPACE),
};

const ChatTransportContext = createContext<ChatTransport>(LOCAL_CHAT_TRANSPORT);

/**
 * Wrap the surface to point it at a different server.
 *
 * Absent, the surface runs against the local Scout server exactly as it always
 * has — `/chat` and `/invite/<token>` mount no provider and are unchanged.
 */
export function ChatTransportProvider({
  api,
  capabilities,
  address,
  children,
}: {
  api: ChatApi;
  capabilities: ChatCapabilities;
  address: ChatAddress;
  children: ReactNode;
}) {
  const value = useMemo<ChatTransport>(
    () => ({ api, capabilities, address }),
    [api, capabilities, address],
  );
  return <ChatTransportContext.Provider value={value}>{children}</ChatTransportContext.Provider>;
}

export function useChatTransport(): ChatTransport {
  return useContext(ChatTransportContext);
}

export function useChatApi(): ChatApi {
  return useContext(ChatTransportContext).api;
}

export function useChatCapabilities(): ChatCapabilities {
  return useContext(ChatTransportContext).capabilities;
}

export function useChatAddress(): ChatAddress {
  return useContext(ChatTransportContext).address;
}
