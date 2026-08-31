import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { WorkerAdapter } from "../src/worker-adapter.ts";

test("worker runtime serializes request and response", async () => {
  const entry = resolve(import.meta.dir, "../fixtures/echo-mcp/dist/server.js");
  const worker = new WorkerAdapter(entry, 5_000);
  try {
    await worker.waitUntilReady();
    const response = await worker.fetch(
      new Request("http://worker.local/echo", {
        method: "POST",
        body: "hello",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: "POST",
      path: "/echo",
      body: "hello",
    });
  } finally {
    worker.terminate();
  }
});

test("worker rejects oversized responses", async () => {
  const worker = new WorkerAdapter(
    resolve(import.meta.dir, "../fixtures/echo-mcp/dist/server.js"),
  );
  try {
    await expect(
      worker.fetch(new Request("http://worker.local/huge")),
    ).rejects.toThrow("WORKER_RESPONSE_TOO_LARGE");
  } finally {
    worker.terminate();
  }
});

test("worker timeout terminates the adapter", async () => {
  let fatal = "";
  const worker = new WorkerAdapter(
    resolve(import.meta.dir, "../fixtures/echo-mcp/dist/server.js"),
    50,
    (error) => {
      fatal = error.message;
    },
  );
  await worker.waitUntilReady();
  await expect(
    worker.fetch(new Request("http://worker.local/slow")),
  ).rejects.toThrow("WORKER_TIMEOUT");
  expect(fatal).toBe("WORKER_TIMEOUT");
});
