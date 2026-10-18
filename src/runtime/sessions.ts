import * as fs from "node:fs/promises";
import { type SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/** Fail before SDK construction can merge unexpected restored workspace roots. */
export async function validateSessionWorkspace(
  manager: SessionManager,
  cwd: string,
  additionalDirectories: string[],
): Promise<void> {
  const header = manager.getHeader();
  if (!header?.cwd) throw new Error(`Session has no workspace header: ${manager.getSessionFile()}`);
  const recordedHeader = await fs.realpath(header.cwd);
  const recorded = await fs.realpath(manager.getCwd());
  const expectedCwd = await fs.realpath(cwd);
  if (recordedHeader !== expectedCwd || recorded !== expectedCwd) {
    throw new Error(
      `Session workspace mismatch: ${manager.getSessionFile()} records ${recorded}, expected ${cwd}`,
    );
  }
  const expected = await Promise.all(
    additionalDirectories.map((directory) => fs.realpath(directory)),
  );
  const actual = await Promise.all(
    manager.getAdditionalDirectories().map((directory) => fs.realpath(directory)),
  );
  if (
    actual.length !== expected.length ||
    actual.some((directory, index) => directory !== expected[index])
  ) {
    throw new Error(`Session additional directories mismatch: ${manager.getSessionFile()}`);
  }
}
