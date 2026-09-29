import assert from "node:assert/strict";
import test from "node:test";
import { dashboardDateRange } from "../dashboard-range.js";

const now = Date.parse("2026-09-29T18:30:00.000Z"); // 2026-09-30 00:30 in Dhaka
test("dashboard today uses Dhaka midnight at backend query level", () => {
  const value = dashboardDateRange("today", undefined, undefined, now)!;
  assert.equal(value.from.toISOString(), "2026-09-29T18:00:00.000Z");
  assert.equal(value.to.toISOString(), "2026-09-29T18:30:00.000Z");
});
test("dashboard yesterday and rolling windows are bounded", () => {
  const yesterday = dashboardDateRange("yesterday", undefined, undefined, now)!;
  assert.equal(yesterday.to.toISOString(), "2026-09-29T18:00:00.000Z");
  assert.equal(
    dashboardDateRange("7d", undefined, undefined, now)!.from.toISOString(),
    "2026-09-23T18:00:00.000Z",
  );
});
test("dashboard rejects invalid or excessive custom ranges", () => {
  assert.equal(dashboardDateRange("custom", "bad", "also-bad", now), null);
  assert.equal(
    dashboardDateRange("custom", "2024-01-01", "2026-01-01", now),
    null,
  );
  assert.ok(dashboardDateRange("custom", "2026-09-01", "2026-09-30", now));
});
