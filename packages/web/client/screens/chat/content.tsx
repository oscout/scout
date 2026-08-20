import type { Route } from "../../lib/types.ts";
import type { useScout } from "../../scout/Provider.tsx";
import { ConversationScreen } from "./ConversationScreen.tsx";

import { MessagesScreen } from "./MessagesScreen.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export function ChatContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  switch (route.view) {
    case "conversation":
      return (
        <ConversationScreen
          conversationId={route.conversationId}
          initialDraft={route.composeDraft}
          navigate={navigate}
        />
      );
    // One conversation route (D6): channels resolve inside MessagesScreen by
    // conversation kind — there is no separate channels route.
    case "messages":
      return (
        <MessagesScreen
          conversationId={route.conversationId}
          navigate={navigate}
        />
      );
    default:
      return null;
  }
}
