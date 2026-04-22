import { describe, expect, it } from "vitest";
import { ProjectSchema } from "../../../lib/validators/project";

describe("ProjectSchema", () => {
  it("accepts valid project input", () => {
    const parsed = ProjectSchema.safeParse({
      name: "SpinUp Demo",
      type: "NEXTJS",
    });

    expect(parsed.success).toBe(true);
  });

  it("trims surrounding whitespace from the project name", () => {
    const parsed = ProjectSchema.safeParse({
      name: "   SpinUp Demo   ",
      type: "NEXTJS",
    });

    expect(parsed.success).toBe(true);

    if (!parsed.success) {
      throw new Error("Expected valid parse result");
    }

    expect(parsed.data.name).toBe("SpinUp Demo");
  });

  it("accepts alphanumeric names with spaces", () => {
    const parsed = ProjectSchema.safeParse({
      name: "SpinUp Demo 123",
      type: "NEXTJS",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects project names shorter than 3 characters", () => {
    const parsed = ProjectSchema.safeParse({
      name: "ab",
      type: "NEXTJS",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects project names longer than 50 characters", () => {
    const parsed = ProjectSchema.safeParse({
      name: "a".repeat(51),
      type: "NEXTJS",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects invalid project types", () => {
    const parsed = ProjectSchema.safeParse({
      name: "SpinUp Demo",
      type: "VITE",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects invalid characters in project name", () => {
    const parsed = ProjectSchema.safeParse({
      name: "SpinUp@Demo",
      type: "NEXTJS",
    });

    expect(parsed.success).toBe(false);
  });
});