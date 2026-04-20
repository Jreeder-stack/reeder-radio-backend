// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import VoiceMessage from '../VoiceMessage.jsx';

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

if (typeof globalThis.MediaError === 'undefined') {
  globalThis.MediaError = function MediaError() {};
  globalThis.MediaError.MEDIA_ERR_ABORTED = MEDIA_ERR_ABORTED;
  globalThis.MediaError.MEDIA_ERR_NETWORK = MEDIA_ERR_NETWORK;
  globalThis.MediaError.MEDIA_ERR_DECODE = MEDIA_ERR_DECODE;
  globalThis.MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED = MEDIA_ERR_SRC_NOT_SUPPORTED;
}

const AUDIO_URL = 'https://example.test/clip.opus';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function findAudioElement(container) {
  const audio = container.querySelector('audio');
  if (!audio) throw new Error('audio element not rendered');
  return audio;
}

function setAudioError(audio, code) {
  Object.defineProperty(audio, 'error', {
    configurable: true,
    get: () => ({ code }),
  });
}

function getPlayButton() {
  return screen.getAllByRole('button')[0];
}

function renderComponent(props = {}) {
  return render(
    <VoiceMessage
      audioUrl={AUDIO_URL}
      duration={1500}
      transcription={null}
      onTranscribe={() => {}}
      isOwn={false}
      {...props}
    />,
  );
}

describe('VoiceMessage playback error mapping', () => {
  let originalPlay;
  let originalFetch;
  let playMock;
  let fetchDeferred;
  let consoleWarnSpy;

  beforeEach(() => {
    originalPlay = window.HTMLMediaElement.prototype.play;
    originalFetch = global.fetch;
    playMock = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.play = function play(...args) {
      return playMock.apply(this, args);
    };
    window.HTMLMediaElement.prototype.pause = function pause() {};
    window.HTMLMediaElement.prototype.load = function load() {};

    fetchDeferred = deferred();
    global.fetch = vi.fn(() => fetchDeferred.promise);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    window.HTMLMediaElement.prototype.play = originalPlay;
    global.fetch = originalFetch;
    consoleWarnSpy.mockRestore();
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows no error label after a successful play', async () => {
    const { container } = renderComponent();
    const audio = findAudioElement(container);
    await act(async () => { fireEvent.click(getPlayButton()); });
    await act(async () => {
      fetchDeferred.resolve({ ok: true, status: 200 });
      fireEvent(audio, new Event('play'));
    });

    expect(screen.queryByText(/Network error/i)).toBeNull();
    expect(screen.queryByText(/Audio not available/i)).toBeNull();
    expect(screen.queryByText(/Server error/i)).toBeNull();
    expect(screen.queryByText(/Tap play again/i)).toBeNull();
    expect(screen.queryByText(/Playback failed/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('reports "Audio not available" with no Retry on a 404 from the HEAD probe', async () => {
    renderComponent();
    await act(async () => { fireEvent.click(getPlayButton()); });
    await act(async () => {
      fetchDeferred.resolve({ ok: false, status: 404 });
    });

    expect(await screen.findByText('Audio not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('reports "Server error" with a Retry button on a 5xx response', async () => {
    renderComponent();
    await act(async () => { fireEvent.click(getPlayButton()); });
    await act(async () => {
      fetchDeferred.resolve({ ok: false, status: 503 });
    });

    expect(await screen.findByText('Server error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('reports "Network error" with Retry when the HEAD probe rejects', async () => {
    renderComponent();
    await act(async () => { fireEvent.click(getPlayButton()); });
    await act(async () => {
      fetchDeferred.reject(new TypeError('Failed to fetch'));
    });

    expect(await screen.findByText('Network error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('reports "Audio not available" with no Retry on MEDIA_ERR_DECODE', async () => {
    const { container } = renderComponent();
    const audio = findAudioElement(container);
    await act(async () => { fireEvent.click(getPlayButton()); });
    await act(async () => {
      fetchDeferred.resolve({ ok: true, status: 200 });
      setAudioError(audio, MEDIA_ERR_DECODE);
      fireEvent(audio, new Event('error'));
    });

    expect(await screen.findByText('Audio not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('reports "Audio not available" with no Retry on MEDIA_ERR_SRC_NOT_SUPPORTED', async () => {
    const { container } = renderComponent();
    const audio = findAudioElement(container);
    await act(async () => { fireEvent.click(getPlayButton()); });
    await act(async () => {
      fetchDeferred.resolve({ ok: true, status: 200 });
      setAudioError(audio, MEDIA_ERR_SRC_NOT_SUPPORTED);
      fireEvent(audio, new Event('error'));
    });

    expect(await screen.findByText('Audio not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('reports "Tap play again" with Retry when play() is rejected by NotAllowedError', async () => {
    const notAllowed = Object.assign(new Error('autoplay blocked'), { name: 'NotAllowedError' });
    playMock.mockReturnValueOnce(Promise.reject(notAllowed));

    renderComponent();
    await act(async () => { fireEvent.click(getPlayButton()); });
    await act(async () => {
      fetchDeferred.resolve({ ok: true, status: 200 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('Tap play again')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
