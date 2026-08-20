/**
 * Minimal separator for SidebarSeparator.
 * Built on @base-ui-components/react/separator (not @base-ui/react).
 */
import type * as React from "react";
import { Separator as SeparatorPrimitive } from "@base-ui-components/react/separator";
import { cn } from "../../lib/utils.ts";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive>) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
