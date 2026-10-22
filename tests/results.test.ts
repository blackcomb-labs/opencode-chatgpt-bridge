import { describe, expect, it } from "vitest";
import { safeTool } from "../src/mcp/results.js";

describe("safeTool", () => {
  it("marks thrown tool errors as MCP errors", async () => {
    const result = await safeTool(async () => {
      throw new Error("denied");
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: "denied" });
  });
});
