import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CooperationLog } from "../src/runtime/cooperation-log";

const roots: string[] = [];
const logs: CooperationLog[] = [];

afterEach(async () => {
  await Promise.all(logs.splice(0).map((log) => log.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cooperation-log-test-"));
  roots.push(root);
  return path.join(root, "cooperation.jsonl");
}

function started(id: string, from = "main", to = "owner-a") {
  return {
    type: "send_started" as const,
    operationId: `operation-${id}`,
    message: {
      id,
      from,
      to,
      body: `body ${id}`,
      ts: Number(id.replace(/\D/g, "")) || 1,
      wakeRelay: true,
    },
  };
}

function completed(id: string, outcome: "injected" | "woken" | "revived" | "failed" = "injected") {
  return {
    type: "send_completed" as const,
    operationId: `operation-${id}`,
    message: { id, from: "main", to: "owner-a", body: `body ${id}`, ts: 1 },
    receipt: { to: "owner-a", outcome },
  };
}

function open(
  file: string,
  writer?: (file: string, line: string) => Promise<void>,
  knownOwnerIds: string[] = ["owner-a", "owner-b"],
) {
  return CooperationLog.open({
    file,
    knownOwnerIds,
    resolveOwnerIds: (from, to) =>
      from === "main" || to === "main" ? ["owner-a"] : ["owner-a", "owner-b"],
    ...(writer ? { writer } : {}),
  }).then((log) => {
    logs.push(log);
    return log;
  });
}

describe("CooperationLog", () => {
  test("default writer creates a nested observations directory and records survive reopen", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cooperation-log-nested-"));
    roots.push(root);
    const directory = path.join(root, "project", "observations", "nested");
    const file = path.join(directory, "cooperation.jsonl");
    await expect(fs.access(directory)).rejects.toThrow();

    const log = await open(file);
    log.record(started("nested-message"));
    await log.close();

    const firstRead = await log.read();
    expect(firstRead.items.map((item) => item.id)).toEqual(["nested-message"]);
    expect(firstRead.coverage.hasGaps).toBe(false);

    const reopened = await open(file);
    const reopenedPage = await reopened.read();
    expect(reopenedPage.items.map((item) => item.id)).toEqual(["nested-message"]);
    expect(reopenedPage.coverage.hasGaps).toBe(false);
  });

  test("persists complete IRC message identity and merges completion without changing start order", async () => {
    const file = await fixture();
    const log = await open(file);
    log.record(started("message-1"));
    log.record(started("message-2", "owner-a", "owner-b"));
    log.record(completed("message-1", "woken"));
    await log.close();

    const page = await log.read();
    expect(page.items.map((message) => [message.id, message.delivery.outcome])).toEqual([
      ["message-1", "woken"],
      ["message-2", "unknown"],
    ]);
    expect(page.items[0]?.relatedOwnerIds).toEqual(["owner-a"]);
    expect(page.items[0]?.wakeRelay).toBe(true);
    expect(page.coverage.recordedSince).toEqual(expect.any(Number));
  });

  test("owner filter, pagination and invalid cursors preserve the same message identity", async () => {
    const file = await fixture();
    const log = await open(file);
    for (let i = 1; i <= 3; i++) log.record(started(`message-${i}`, "owner-a", "owner-b"));
    await log.close();

    const first = await log.read({ ownerId: "owner-b", limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["message-2", "message-3"]);
    expect(first.nextBefore).toBeTruthy();
    expect(
      (await log.read({ ownerId: "owner-a", before: first.nextBefore!, limit: 2 })).items.map(
        (item) => item.id,
      ),
    ).toEqual(["message-1"]);
    await expect(log.read({ ownerId: "unknown" })).rejects.toThrow("Unknown ownerId");
    await expect(log.read({ before: "not-a-cursor" })).rejects.toThrow(
      "Invalid cooperation cursor",
    );
  });

  test("known owner validation follows runtime owner roster updates", async () => {
    const file = await fixture();
    const log = await open(file, undefined, ["owner-a"]);
    await expect(log.read({ ownerId: "owner-b" })).rejects.toThrow("Unknown ownerId");
    log.setKnownOwnerIds(["owner-a", "owner-b"]);
    expect((await log.read({ ownerId: "owner-b" })).items).toEqual([]);
    log.setKnownOwnerIds(["owner-a"]);
    await expect(log.read({ ownerId: "owner-b" })).rejects.toThrow("Unknown ownerId");
  });

  test("malformed tail is reported and remains intact when new records are appended", async () => {
    const file = await fixture();
    await Bun.write(file, `${JSON.stringify({ kind: "header", recordedSince: 123 })}\n{"broken":`);
    const log = await open(file);
    expect((await log.read()).coverage.hasGaps).toBe(true);
    log.record(started("message-1"));
    await log.close();

    expect(await Bun.file(file).text()).toContain('{"broken":\n');
    expect((await log.read()).items.map((item) => item.id)).toEqual(["message-1"]);
  });

  test("valid JSON with invalid record shapes and duplicate or unsafe sequences is skipped with a gap", async () => {
    const file = await fixture();
    const validRecord = {
      kind: "started",
      sequence: 1,
      operationId: "operation-good",
      message: { id: "message-good", from: "main", to: "owner-a", body: "valid", ts: 1 },
      relatedOwnerIds: ["owner-a"],
    };
    await Bun.write(
      file,
      [
        JSON.stringify({ kind: "header", recordedSince: 123 }),
        JSON.stringify({ kind: "started", sequence: 2, operationId: "missing-message" }),
        JSON.stringify({ kind: "completed", operationId: "bad", messageId: "x", outcome: "maybe" }),
        JSON.stringify(validRecord),
        JSON.stringify({
          ...validRecord,
          message: { ...validRecord.message, id: "message-duplicate-seq" },
        }),
        JSON.stringify({
          ...validRecord,
          sequence: Number.MAX_SAFE_INTEGER + 1,
          message: { ...validRecord.message, id: "message-unsafe-seq" },
        }),
        JSON.stringify({
          ...validRecord,
          sequence: 3,
          message: { ...validRecord.message, id: "message-valid-2" },
        }),
      ].join("\n") + "\n",
    );
    const log = await open(file);

    const page = await log.read();
    expect(page.items.map((item) => item.id)).toEqual(["message-good", "message-valid-2"]);
    expect(page.coverage.hasGaps).toBe(true);
    expect(page.coverage.warnings.some((warning) => warning.includes("invalid record shape"))).toBe(
      true,
    );
    expect(
      page.coverage.warnings.some((warning) => warning.includes("duplicate message sequence")),
    ).toBe(true);
  });

  test("a blocked writer cannot grow the queue past 8 MiB and close reports timeout", async () => {
    const file = await fixture();
    let releaseWriter: (() => void) | undefined;
    let signalWriterEntered: (() => void) | undefined;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writerEntered = new Promise<void>((resolve) => {
      signalWriterEntered = resolve;
    });
    let first = true;
    const writer = async (_target: string, line: string): Promise<void> => {
      if (first && line.includes('"kind":"started"')) {
        first = false;
        signalWriterEntered?.();
        await writerGate;
      }
    };
    const health: boolean[] = [];
    const log = await CooperationLog.open({
      file,
      knownOwnerIds: ["owner-a"],
      resolveOwnerIds: () => ["owner-a"],
      writer,
      closeDrainTimeoutMs: 10,
      onHealth: (coverage) => health.push(coverage.hasGaps),
    });
    logs.push(log);
    log.record(started("message-blocked"));
    await writerEntered;
    const largeBody = "😀".repeat(600 * 1024);
    for (let i = 0; i < 4; i++) {
      log.record({
        ...started(`message-${i}`),
        message: { ...started(`message-${i}`).message, body: largeBody },
      });
    }
    try {
      await log.close();
      expect(health).toContain(true);
    } finally {
      releaseWriter?.();
    }
    await log.close();
    expect((await log.read()).coverage.warnings.some((warning) => warning.includes("8 MiB"))).toBe(
      true,
    );
  });

  test("append failure marks a gap and later appends recover without poisoning the queue", async () => {
    const file = await fixture();
    let fail = true;
    const writer = async (target: string, line: string): Promise<void> => {
      if (fail && line.includes('"kind":"started"')) {
        fail = false;
        throw new Error("disk unavailable");
      }
      await fs.appendFile(target, line, "utf8");
    };
    const log = await open(file, writer);
    log.record(started("message-1"));
    log.record(started("message-2"));
    await log.close();

    const page = await log.read();
    expect(page.items.map((item) => item.id)).toEqual(["message-2"]);
    expect(page.coverage.hasGaps).toBe(true);
  });

  test("a final append failure is flushed as a gap on close and survives reopen", async () => {
    const file = await fixture();
    let failDataWrite = true;
    const writer = async (target: string, line: string): Promise<void> => {
      if (failDataWrite && line.includes('"kind":"started"')) {
        failDataWrite = false;
        throw new Error("disk unavailable");
      }
      await fs.appendFile(target, line, "utf8");
    };
    const log = await open(file, writer);
    log.record(started("message-lost"));
    await log.close();
    expect((await log.read()).coverage.hasGaps).toBe(true);

    const reopened = await open(file);
    const page = await reopened.read();
    expect(page.items).toEqual([]);
    expect(page.coverage.hasGaps).toBe(true);
    expect(
      page.coverage.warnings.some((warning) =>
        warning.includes("One or more cooperation log appends failed"),
      ),
    ).toBe(true);
  });
});
