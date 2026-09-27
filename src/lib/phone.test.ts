import { describe, expect, it } from "vitest";
import { normalizeSaudiPhone } from "./phone";

describe("normalizeSaudiPhone", () => {
  it.each([
    ["0500000001", "+966500000001"],
    ["500000001", "+966500000001"],
    ["966500000001", "+966500000001"],
    ["+966500000001", "+966500000001"],
    ["00966500000001", "+966500000001"],
    ["050 000 0001", "+966500000001"],
    ["050-000-0001", "+966500000001"],
    ["٠٥٠٠٠٠٠٠٠١", "+966500000001"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeSaudiPhone(input)).toBe(expected);
  });

  it.each(["", "050000000", "05000000011", "0400000001", "abc", "+971500000001"])(
    "rejects %s",
    (input) => {
      expect(normalizeSaudiPhone(input)).toBeNull();
    },
  );
});
