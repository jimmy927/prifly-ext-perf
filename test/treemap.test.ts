import { describe, expect, test } from "bun:test";
// @ts-expect-error: the panel is plain JavaScript
import { labelFit } from "../panel/treemap.js";

describe("a tile's label shows only what fits", () => {
  test("a big tile has its name, size and the line under them", () => {
    expect(labelFit("Linux file cache", "10.5 GB", "3.6 GB in RAM", 300, 120)).toBe("full");
  });

  test("a short tile drops the line under the name before the name", () => {
    expect(labelFit("Kernel caches", "1.3 GB", "173 MB in RAM", 160, 24)).toBe("main");
  });

  test("a tile too small for its name has no label", () => {
    expect(labelFit("Kernel itself", "468 MB", "158 MB in RAM", 40, 60)).toBe("none");
    expect(labelFit("Kernel itself", "468 MB", null, 200, 14)).toBe("none");
  });

  test("a long name wraps where the tile is tall enough, at spaces and hyphens", () => {
    const name = "elasticsearch · skapa-mojlighet-att-bygga-en-candidate";
    expect(labelFit(name, "4.6 GB", null, 160, 90)).toBe("main");
    expect(labelFit(name, "4.6 GB", null, 160, 30)).toBe("none");
  });

  test("a word wider than the tile is no fit, however tall", () => {
    expect(labelFit("elasticsearch", "4.6 GB", null, 60, 400)).toBe("none");
  });

  test("a group's label is one line above its children, or none", () => {
    expect(labelFit("prifly sessions", "9.6 GB", null, 300, 200, true)).toBe("main");
    expect(labelFit("prifly sessions", "9.6 GB", null, 100, 200, true)).toBe("none");
  });
});
