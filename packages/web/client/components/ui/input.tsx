/**
 * Minimal text input for SidebarInput (family completeness; not used by Scout chrome).
 */
import * as React from "react";
import { cn } from "../../lib/utils.ts";

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full rounded-md border border-sidebar-border bg-transparent px-2 text-sm text-sidebar-foreground outline-none placeholder:text-sidebar-foreground/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
