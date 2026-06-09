import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SESSION_EXPIRED_ERRCODE,
  pauseSession,
  isSessionPaused,
  getRemainingPauseMs,
  clearSessionPause,
} from "./session-guard.js";

describe("session-guard", () => {
  beforeEach(() => {
    clearSessionPause("acc");
    clearSessionPause("acc2");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes -14 as the session-expired errcode", () => {
    expect(SESSION_EXPIRED_ERRCODE).toBe(-14);
  });

  it("is not paused by default", () => {
    expect(isSessionPaused("acc")).toBe(false);
    expect(getRemainingPauseMs("acc")).toBe(0);
  });

  it("pauses for ~1h then auto-expires", () => {
    vi.useFakeTimers();
    pauseSession("acc");
    expect(isSessionPaused("acc")).toBe(true);
    expect(getRemainingPauseMs("acc")).toBeGreaterThan(0);
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(isSessionPaused("acc")).toBe(false);
    expect(getRemainingPauseMs("acc")).toBe(0);
  });

  it("clearSessionPause lifts the pause immediately", () => {
    pauseSession("acc2");
    expect(isSessionPaused("acc2")).toBe(true);
    clearSessionPause("acc2");
    expect(isSessionPaused("acc2")).toBe(false);
  });
});
