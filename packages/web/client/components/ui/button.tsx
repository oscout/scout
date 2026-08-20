/**
 * Minimal button used by SidebarTrigger. Full shadcn button family is not required.
 * Built on @base-ui-components/react/button (not @base-ui/react).
 */
import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui-components/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-sidebar-accent text-sidebar-accent-foreground hover:opacity-90",
        outline:
          "border border-sidebar-border bg-transparent hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        secondary: "bg-sidebar-accent/60 text-sidebar-foreground hover:bg-sidebar-accent",
        ghost: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        destructive: "bg-red-600 text-white hover:bg-red-600/90",
        link: "text-sidebar-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3",
        xs: "h-6 gap-1 px-2 text-xs",
        sm: "h-7 gap-1 px-2.5 text-xs",
        lg: "h-9 px-4",
        icon: "size-8",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof ButtonPrimitive> &
  VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
