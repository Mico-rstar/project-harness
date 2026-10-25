import { describe, expect, test } from "bun:test";
import { parseLaunchOptions } from "../src/main";

describe("CLI launch flags", () => {
  test("defaults to TUI while parsing Web and explicit port options", () => {
    expect(parseLaunchOptions([])).toEqual({
      resume: false,
      web: false,
    });
    expect(parseLaunchOptions(["--web", "--port", "0", "--project", "demo"])).toEqual({
      project: "demo",
      resume: false,
      web: true,
      port: 0,
    });
  });

  test("rejects ports outside the valid range and ports without Web mode", () => {
    expect(() => parseLaunchOptions(["--web", "--port", "65536"])).toThrow(
      "--port must be an integer from 0 to 65535",
    );
    expect(() => parseLaunchOptions(["--port", "4173"])).toThrow(
      "--port can only be used with --web",
    );
  });
});
