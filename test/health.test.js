import assert from "node:assert/strict";
import test from "node:test";
import { SyncDatabase } from "../src/db.js";
import { createHealthMonitor } from "../src/health.js";

test("alerts at three failures and throttles repeats for 60 minutes", () => {
  const database = new SyncDatabase(":memory:");
  try {
    let currentTime = new Date("2026-07-16T12:00:00.000Z");
    const toasts = [];
    const monitor = createHealthMonitor(database, {
      toastSender: (title, message) => toasts.push({ title, message }),
      now: () => currentTime,
    });

    monitor.recordFailure(new Error("first"));
    monitor.recordFailure(new Error("second"));
    assert.equal(toasts.length, 0);

    monitor.recordFailure(new Error("third line\nmore details"));
    assert.deepEqual(toasts, [
      {
        title: "bsky sync is down",
        message: "third line\ncheck data\\syncer.log",
      },
    ]);
    assert.equal(
      database.getMeta("last_alert_at"),
      "2026-07-16T12:00:00.000Z",
    );

    currentTime = new Date("2026-07-16T12:59:59.999Z");
    monitor.recordFailure(new Error("still down"));
    assert.equal(toasts.length, 1);

    currentTime = new Date("2026-07-16T13:00:00.000Z");
    monitor.recordFailure(new Error("still down after an hour"));
    assert.equal(toasts.length, 2);
    assert.equal(
      database.getMeta("last_alert_at"),
      "2026-07-16T13:00:00.000Z",
    );
  } finally {
    database.close();
  }
});

test("resets the counter and logs recovery after successful polling", () => {
  const database = new SyncDatabase(":memory:");
  try {
    const logs = [];
    const monitor = createHealthMonitor(database, {
      toastSender: () => assert.fail("toast should not be sent"),
      logger: (message) => logs.push(message),
    });

    monitor.recordFailure(new Error("one"));
    monitor.recordFailure(new Error("two"));
    assert.equal(monitor.consecutiveFailures, 2);
    monitor.recordSuccess();
    assert.equal(monitor.consecutiveFailures, 0);
    assert.deepEqual(logs, ["[health] recovered after 2 failed polls"]);
    monitor.recordSuccess();
    assert.equal(logs.length, 1);
  } finally {
    database.close();
  }
});

test("startup alerts use the same persisted throttle", () => {
  const database = new SyncDatabase(":memory:");
  try {
    let currentTime = new Date("2026-07-16T08:00:00.000Z");
    const toasts = [];
    const monitor = createHealthMonitor(database, {
      toastSender: (...args) => toasts.push(args),
      now: () => currentTime,
    });

    assert.equal(monitor.alertStartupFailure(new Error("login failed")), true);
    assert.equal(monitor.alertStartupFailure(new Error("login failed")), false);
    currentTime = new Date("2026-07-16T09:00:00.000Z");
    assert.equal(monitor.alertStartupFailure(new Error("login failed")), true);
    assert.equal(toasts.length, 2);
  } finally {
    database.close();
  }
});
