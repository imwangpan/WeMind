import { describe, it, expect } from "vitest";
import { PKG } from "./pkg.js";

describe("pkg", () => {
  it("reads version and ilink_appid from the package's own package.json", () => {
    expect(PKG.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(PKG.ilinkAppId).toBe("bot");
  });
});
