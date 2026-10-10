import { describe, expect, test } from "bun:test";
import { readHolders, vmRows } from "../gpu";

const now = 1_000_000;
const file = (holders: unknown[]) => JSON.stringify({ at: now, holders });
const rowsOf = (holders: unknown[]) => {
  const read = readHolders(file(holders), now, () => true);
  return vmRows(1000, read, []).map((r) => r.what);
};

describe("Why for prifly's rows", () => {
  test("a known which and model reads description · model", () => {
    expect(
      rowsOf([
        {
          pid: 1,
          which: "final",
          mib: 800,
          parts: [{ model: "whisper turbo", mib: 800 }],
        },
        { pid: 2, which: "grey", model: "parakeet-tdt-0.6b", mib: 200 },
      ]),
    ).toEqual([
      "Detects which language you speak; turns Swedish speech into text · whisper turbo",
      "Shows your words in grey while you're still speaking · parakeet-tdt-0.6b",
    ]);
  });

  test("an unknown combination shows the model alone", () => {
    expect(
      rowsOf([
        { pid: 1, which: "intent", model: "bert", mib: 500 },
        { pid: 2, which: "grey", model: "whisper turbo", mib: 500 },
      ]),
    ).toEqual(["bert", "whisper turbo"]);
  });

  test("a role in the file wins, on a part and on a single-model holder", () => {
    expect(
      rowsOf([
        {
          pid: 1,
          which: "final",
          mib: 500,
          parts: [{ model: "whisper turbo", mib: 500, role: "Own words" }],
        },
        { pid: 2, which: "grey", model: "parakeet-tdt-0.6b", mib: 500, role: "Host's words" },
      ]),
    ).toEqual(["Own words · whisper turbo", "Host's words · parakeet-tdt-0.6b"]);
  });

  test("a role that is not a string is ignored", () => {
    expect(rowsOf([{ pid: 1, which: "grey", model: "x", mib: 1000, role: 5 }])).toEqual(["x"]);
  });
});
