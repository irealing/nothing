// Dropdown menu on Radix: renders in a portal (so it is never clipped by
// `overflow: auto` containers such as the view tab strip), supports keyboard
// navigation, typeahead, and alignment.

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

export function Menu({
  trigger,
  children,
  align = "start",
  sideOffset = 4,
  ariaLabel,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  sideOffset?: number;
  ariaLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-menu ui-menu"
          align={align}
          sideOffset={sideOffset}
          aria-label={ariaLabel}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
  className,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <DropdownMenu.Item
      className={["ui-menu-item", danger ? "danger" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      onSelect={() => onSelect?.()}
      disabled={disabled}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="dropdown-sep" />;
}

/** A nested menu (e.g. an emoji palette) that keeps focus inside the menu. */
export function MenuSub({
  label,
  children,
  contentClassName,
  ariaLabel,
}: {
  label: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  ariaLabel?: string;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="ui-menu-item ui-menu-sub-trigger">
        {label}
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          className={
            contentClassName ? `dropdown-menu ui-menu ${contentClassName}` : "dropdown-menu ui-menu"
          }
          sideOffset={4}
          aria-label={ariaLabel}
        >
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
