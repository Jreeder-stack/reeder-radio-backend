// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordingLogs from "../RecordingLogs.jsx";

class FakeAudio {
  static instances = [];

  constructor() {
    this.src = "";
    this.preload = "";
    this.error = null;
    this.onended = null;
    this.onerror = null;
    this.onplaying = null;
    this.play = vi.fn(() => Promise.resolve());
    this.pause = vi.fn();
    this.load = vi.fn();
    this.removeAttribute = vi.fn();
    FakeAudio.instances.push(this);
  }
}

function jsonResponse(data) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => data,
  });
}

describe("RecordingLogs playback", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("alert", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        if (String(url).startsWith("/api/recording-logs/filters")) {
          return jsonResponse({ success: true, units: ["UNIT-1"], channels: ["OPS"] });
        }
        if (String(url).startsWith("/api/recording-logs/search")) {
          return jsonResponse({
            success: true,
            total: 1,
            logs: [
              {
                id: 42,
                sender: "UNIT-1",
                channel: "OPS",
                audio_url: "/api/messages/audio/OPS_42_UNIT-1.wav",
                audio_duration: 1500,
                audio_available: true,
                created_at: "2026-07-31T04:00:00.000Z",
              },
            ],
          });
        }
        if (options.method === "HEAD") {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers({
              "content-type": "audio/wav",
              "content-length": "48044",
            }),
          });
        }
        throw new Error(`Unexpected fetch: ${options.method || "GET"} ${url}`);
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts native audio playback directly in the Play click without fetching a blob first", async () => {
    render(<RecordingLogs isMobile={false} />);

    const playButton = await screen.findByRole("button", { name: "▶ Play" });

    act(() => {
      fireEvent.click(playButton);
    });

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe("/api/messages/audio/OPS_42_UNIT-1.wav");
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/messages/audio/OPS_42_UNIT-1.wav",
        expect.objectContaining({ method: "HEAD", credentials: "include" })
      );
    });

    expect(
      fetch.mock.calls.some(
        ([url, options = {}]) =>
          url === "/api/messages/audio/OPS_42_UNIT-1.wav" && (!options.method || options.method === "GET")
      )
    ).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
