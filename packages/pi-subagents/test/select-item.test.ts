import { describe, expect, it } from "vitest";
import { selectItem } from "../src/ui/select-item.js";

describe("selectItem", () => {
  it("returns the item paired with a duplicate-looking formatted row", async () => {
    let offered: string[] = [];
    const selected = await selectItem(
      {
        select: async (_title, options) => {
          offered = options;
          return options[1];
        },
      },
      "Jobs",
      [{ id: "first" }, { id: "second" }],
      () => "same label",
    );

    expect(offered).toEqual(["1. same label", "2. same label"]);
    expect(selected).toEqual({ id: "second" });
  });
});
