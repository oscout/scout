/**
 * Minimal Base UI tooltip wrappers used by the shadcn sidebar family.
 * Ports the registry tooltip API onto @base-ui-components/react (not @base-ui/react).
 */
import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui-components/react/tooltip";
import { cn } from "../../lib/utils.ts";

function TooltipProvider({
  // Hover intent, not transit: zero delay opened a label for every pointer
  // pass across the rail, and a fast swipe could orphan one open (the close
  // never fires once the trigger re-renders under it). 500ms means labels
  // appear only on a settled hover.
  delay = 500,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  // SCO-088c: a slightly larger, consistent gap from the (48px) rail edge.
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  children,
  hidden,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof TooltipPrimitive.Positioner>,
    "align" | "alignOffset" | "side" | "sideOffset"
  > & {
    hidden?: boolean;
  }) {
  if (hidden) return null;

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-[80]"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            // SCO-088c: dark surface fill + a single low-ink hairline (no light
            // border); a step larger in type + padding so it doesn't read cramped;
            // vertically centered on the trigger (align="center").
            "z-[80] w-fit max-w-xs rounded-md border border-[var(--hud-border)] bg-[var(--hud-surface)] px-2.5 py-1.5 text-sm font-medium text-sidebar-foreground shadow-md",
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
