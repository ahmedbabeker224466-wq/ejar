import { describe, expect, it } from "vitest";
import { areaForPath, destinationFor } from "./roles";

describe("areaForPath", () => {
  it("maps role areas", () => {
    expect(areaForPath("/office")).toBe("office");
    expect(areaForPath("/office/account")).toBe("office");
    expect(areaForPath("/landlord")).toBe("landlord");
    expect(areaForPath("/tenant/account")).toBe("tenant");
  });

  it("does not match look-alike paths", () => {
    expect(areaForPath("/offices")).toBeNull();
    expect(areaForPath("/tenantx")).toBeNull();
    expect(areaForPath("/welcome")).toBeNull();
    expect(areaForPath("/")).toBeNull();
  });
});

describe("destinationFor", () => {
  it("sends users without a role to welcome", () => {
    expect(destinationFor({ role: null, hasOffice: false })).toBe("/welcome");
  });

  it("sends an office without an office row back to welcome", () => {
    expect(destinationFor({ role: "office", hasOffice: false })).toBe("/welcome");
    expect(destinationFor({ role: "office", hasOffice: true })).toBe("/office");
  });

  it("sends landlords and tenants to their area", () => {
    expect(destinationFor({ role: "landlord", hasOffice: false })).toBe("/landlord");
    expect(destinationFor({ role: "tenant", hasOffice: false })).toBe("/tenant");
  });
});
