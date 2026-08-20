import { createContext, useContext, type ReactNode } from "react";

const MessageComposerEmbeddedContext = createContext(false);

/**
 * Marks a subtree as hosted inside another surface that owns the message input.
 *
 * MessageComposer consumes this once at the shared atom boundary, so embedded
 * screens do not each need their own `showComposer` prop or URL escape hatch.
 */
export function MessageComposerEmbedBoundary({ children }: { children: ReactNode }) {
  return (
    <MessageComposerEmbeddedContext.Provider value={true}>
      {children}
    </MessageComposerEmbeddedContext.Provider>
  );
}

export function useMessageComposerEmbedded(): boolean {
  return useContext(MessageComposerEmbeddedContext);
}
