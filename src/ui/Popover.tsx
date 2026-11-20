// Radix popover wrapper: portal + outside-click + Escape + focus return are
// handled by the primitive; callers own the trigger element and the content.

import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ReactNode } from "react";

export function Popover({
  trigger,
  open,
  onOpenChange,
  align = "start",
  className,
  children,
}: {
  trigger: ReactNode;
  /** Controlled open state; omit to let Radix manage it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  className?: string;
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className={className ? `ui-popover ${className}` : "ui-popover"}
          sideOffset={6}
          align={align}
          collisionPadding={8}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}