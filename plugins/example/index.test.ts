import { describe, expect, test } from "bun:test";
import plugin from "./index";

describe("example plugin", () => {
  test("declares a stable id", () => {
    expect(plugin.id).toBe("example");
  });

  test("exports a setup function", () => {
    expect(typeof plugin.setup).toBe("function");
  });
});
