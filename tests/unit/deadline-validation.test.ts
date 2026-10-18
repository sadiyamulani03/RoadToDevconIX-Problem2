import { describe, expect, test } from "vitest";
import {
  MAX_DEADLINE_HORIZON_MS,
  MIN_DEADLINE_LEAD_MS,
  parseIsoInstant,
  validateDeadline,
  validateQuestion,
} from "../../src/lib/domain/semantic-validation";

/**
 * Check 2 — the close time must be compared with the current time in
 * application code. These tests exercise the injected-clock comparison
 * directly, including equality, timezone parsing and invalid inputs.
 */

const NOW = new Date("2026-10-17T12:00:00.000Z");

function codes(issues: ReturnType<typeof validateDeadline>): string[] {
  return issues.map((issue) => issue.code);
}

describe("validateDeadline (current-time comparison)", () => {
  test("rejects a deadline in the past", () => {
    const issues = validateDeadline("2026-10-16T12:00:00.000Z", NOW);
    expect(codes(issues)).toContain("deadline_in_past");
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });

  test("rejects a deadline equal to the current time", () => {
    const issues = validateDeadline(NOW.toISOString(), NOW);
    expect(codes(issues)).toContain("deadline_in_past");
  });

  test("rejects a deadline one millisecond in the past", () => {
    const issues = validateDeadline(new Date(NOW.getTime() - 1).toISOString(), NOW);
    expect(codes(issues)).toContain("deadline_in_past");
  });

  test("accepts a deadline comfortably in the future", () => {
    const issues = validateDeadline("2027-03-01T12:00:00.000Z", NOW);
    expect(issues).toEqual([]);
  });

  test("flags a deadline less than one hour in the future as too soon", () => {
    const almostNow = new Date(NOW.getTime() + MIN_DEADLINE_LEAD_MS - 60_000).toISOString();
    const issues = validateDeadline(almostNow, NOW);
    expect(codes(issues)).toContain("deadline_too_soon");
  });

  test("accepts a deadline exactly one hour in the future", () => {
    const exactly = new Date(NOW.getTime() + MIN_DEADLINE_LEAD_MS).toISOString();
    const issues = validateDeadline(exactly, NOW);
    expect(issues).toEqual([]);
  });

  test("rejects an invalid timestamp", () => {
    expect(codes(validateDeadline("not-a-date", NOW))).toContain("deadline_invalid");
    expect(codes(validateDeadline("2027-02-30T12:00:00.000Z", NOW))).toContain("deadline_invalid");
  });

  test("rejects a timestamp without an explicit timezone", () => {
    const issues = validateDeadline("2027-03-01T12:00:00", NOW);
    expect(codes(issues)).toContain("deadline_missing_timezone");
    expect(codes(issues)).not.toContain("deadline_in_past");
  });

  test("accepts explicit positive and negative offsets", () => {
    expect(validateDeadline("2027-03-01T12:00:00+05:30", NOW)).toEqual([]);
    expect(validateDeadline("2027-03-01T12:00:00-08:00", NOW)).toEqual([]);
  });

  test("compares offsets against the actual instant, not the wall-clock string", () => {
    // 2026-10-17T17:30:00+05:30 == 2026-10-17T12:00:00Z exactly -> equal to now.
    const issues = validateDeadline("2026-10-17T17:30:00+05:30", NOW);
    expect(codes(issues)).toContain("deadline_in_past");
  });

  test("warns (but does not block) on a deadline more than five years out", () => {
    const far = new Date(NOW.getTime() + MAX_DEADLINE_HORIZON_MS + 24 * 60 * 60 * 1000).toISOString();
    const issues = validateDeadline(far, NOW);
    expect(codes(issues)).toContain("deadline_too_far");
    expect(issues.some((issue) => issue.severity === "error")).toBe(false);
  });
});

describe("parseIsoInstant", () => {
  test("returns null for timezone-less or invalid values", () => {
    expect(parseIsoInstant("2027-01-01T00:00:00")).toBeNull();
    expect(parseIsoInstant("soon")).toBeNull();
    expect(parseIsoInstant("")).toBeNull();
  });

  test("normalises offset timestamps to the same instant", () => {
    const zulu = parseIsoInstant("2027-01-01T00:00:00Z");
    const offset = parseIsoInstant("2027-01-01T05:30:00+05:30");
    expect(zulu?.getTime()).toBe(offset?.getTime());
  });
});

describe("deadline consistency with the question", () => {
  test("rejects a close year before the event year in the question", () => {
    const issues = validateQuestion(
      "Will the launch happen in 2029?",
      "2027-01-01T00:00:00.000Z",
    );
    expect(issues.map((issue) => issue.code)).toContain("deadline_before_question_event");
    expect(issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  test("accepts a close time in the same year as the referenced event", () => {
    const issues = validateQuestion(
      "Will the launch happen in 2027?",
      "2027-06-01T00:00:00.000Z",
    );
    expect(issues.map((issue) => issue.code)).not.toContain("deadline_before_question_event");
  });
});
