// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { installContextMenuGuard } from "./contextMenu";

let cleanupGuard: (() => void) | null = null;

afterEach(() => {
  cleanupGuard?.();
  cleanupGuard = null;
});

it("blocks the native context menu but allows the event to reach handlers", () => {
  cleanupGuard = installContextMenuGuard();
  let seen = false;
  const observer = () => {
    seen = true;
  };
  document.addEventListener("contextmenu", observer);

  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);

  document.removeEventListener("contextmenu", observer);
  expect(seen).toBe(true);
  expect(event.defaultPrevented).toBe(true);
});