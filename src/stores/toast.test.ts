// Toast stack behaviour: repeated messages collapse, the oldest fall off.

import { beforeEach, describe, expect, it } from "vitest";
import { toast, useToasts } from "./toast";

beforeEach(() => {
  useToasts.setState({ items: [] });
});

describe("toast store", () => {
  it("stacks different messages and exposes them in order", () => {
    toast.error("一");
    toast.success("二");
    expect(useToasts.getState().items.map((t) => t.text)).toEqual(["一", "二"]);
  });

  it("refreshes instead of duplicating a repeated message", () => {
    toast.error("boom");
    toast.error("boom");
    expect(useToasts.getState().items).toHaveLength(1);
  });

  it("keeps at most four toasts", () => {
    for (let i = 0; i < 6; i++) toast.info(`m${i}`);
    expect(useToasts.getState().items.map((t) => t.text)).toEqual(["m2", "m3", "m4", "m5"]);
  });

  it("dismisses by id and ignores blank text", () => {
    toast.success("ok");
    toast.error("  ");
    const [item] = useToasts.getState().items;
    expect(useToasts.getState().items).toHaveLength(1);
    useToasts.getState().dismiss(item.id);
    expect(useToasts.getState().items).toHaveLength(0);
  });
});