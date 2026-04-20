import { useState, useRef, useEffect } from 'react';

const ERROR_LABELS = {
  network: 'Network error',
  serverError: 'Server error',
  notFound: 'Audio not available',
  unsupported: 'Audio not available',
  decode: 'Audio not available',
  autoplayBlocked: 'Tap play again',
  generic: 'Playback failed',
};

const RETRYABLE_KINDS = new Set(['network', 'serverError', 'autoplayBlocked', 'generic']);

function mapHttpStatus(status) {
  if (status === 404) return 'notFound';
  if (status === 415 || status === 422) return 'unsupported';
  if (status >= 500 && status < 600) return 'serverError';
  if (status >= 400 && status < 500) return 'unsupported';
  return null;
}

function mapMediaError(err) {
  if (!err) return { kind: 'generic', detail: 'Unknown audio error' };
  switch (err.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return { kind: 'aborted', detail: 'Playback aborted' };
    case MediaError.MEDIA_ERR_NETWORK:
      return { kind: 'network', detail: 'Audio element reported MEDIA_ERR_NETWORK' };
    case MediaError.MEDIA_ERR_DECODE:
      return { kind: 'decode', detail: 'Audio element reported MEDIA_ERR_DECODE' };
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return { kind: 'unsupported', detail: 'Audio element reported MEDIA_ERR_SRC_NOT_SUPPORTED (server returned non-OK status, empty body, or unrecognized format)' };
    default:
      return { kind: 'generic', detail: `MediaError code ${err.code}` };
  }
}

function mapPlayRejection(err) {
  if (!err) return { kind: 'generic', detail: 'play() rejected with no reason' };
  switch (err.name) {
    case 'AbortError':
      return { kind: 'aborted', detail: 'play() aborted (likely paused before start)' };
    case 'NotAllowedError':
      return { kind: 'autoplayBlocked', detail: 'play() blocked by browser autoplay policy' };
    case 'NotSupportedError':
      return { kind: 'unsupported', detail: 'play() said source is not supported' };
    default:
      return { kind: 'generic', detail: `play() rejected: ${err.name || ''} ${err.message || ''}`.trim() };
  }
}

export default function VoiceMessage({ audioUrl, duration, transcription, onTranscribe, isOwn }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorKind, setErrorKind] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [showTranscription, setShowTranscription] = useState(false);
  const audioRef = useRef(null);
  const mountedRef = useRef(true);
  const probeRef = useRef({ status: null, error: null, controller: null });

  const finalizeError = (mappedKind, detail) => {
    if (!mountedRef.current) return;
    const probe = probeRef.current;
    let kind = mappedKind;
    if (probe.error && (kind === 'unsupported' || kind === 'decode' || kind === 'generic')) {
      kind = 'network';
    } else if (probe.status != null) {
      const fromStatus = mapHttpStatus(probe.status);
      if (fromStatus && (kind === 'unsupported' || kind === 'decode' || kind === 'generic')) {
        kind = fromStatus;
      }
    }
    console.warn('[VoiceMessage] playback failed:', detail, {
      audioUrl,
      mappedKind,
      finalKind: kind,
      probeStatus: probe.status,
      probeError: probe.error?.message || null,
    });
    setIsPlaying(false);
    setIsLoading(false);
    setErrorKind(kind);
  };

  useEffect(() => {
    mountedRef.current = true;
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      if (audio.duration && Number.isFinite(audio.duration)) {
        setProgress((audio.currentTime / audio.duration) * 100);
      }
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(0);
    };
    const handlePlay = () => {
      setIsPlaying(true);
      setIsLoading(false);
    };
    const handlePause = () => setIsPlaying(false);
    const handleWaiting = () => setIsLoading(true);
    const handlePlaying = () => setIsLoading(false);
    const handleCanPlay = () => setIsLoading(false);
    const handleError = () => {
      if (!mountedRef.current) return;
      const mapped = mapMediaError(audio.error);
      if (mapped.kind === 'aborted') return;
      finalizeError(mapped.kind, mapped.detail);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('playing', handlePlaying);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('error', handleError);

    return () => {
      mountedRef.current = false;
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('playing', handlePlaying);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('error', handleError);
      if (probeRef.current.controller) {
        try { probeRef.current.controller.abort(); } catch (_) { /* ignore */ }
      }
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch (_) { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (probeRef.current.controller) {
      try { probeRef.current.controller.abort(); } catch (_) { /* ignore */ }
    }
    probeRef.current = { status: null, error: null, controller: null };

    setErrorKind(null);
    setProgress(0);
    setIsLoading(true);

    try {
      if (audio.src !== audioUrl) {
        audio.src = audioUrl;
      } else {
        try { audio.currentTime = 0; } catch (_) { /* ignore */ }
      }
    } catch (err) {
      console.warn('[VoiceMessage] failed to set audio src:', err, { audioUrl });
      setIsLoading(false);
      setErrorKind('generic');
      return;
    }

    const playPromise = audio.play();

    const controller = new AbortController();
    probeRef.current.controller = controller;
    fetch(audioUrl, { method: 'HEAD', credentials: 'include', signal: controller.signal })
      .then((res) => {
        if (!mountedRef.current) return;
        probeRef.current.status = res.status;
        if (!res.ok) {
          const kind = mapHttpStatus(res.status) || 'generic';
          finalizeError(kind, `HEAD probe returned HTTP ${res.status}`);
        }
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        if (err && err.name === 'AbortError') return;
        probeRef.current.error = err;
        finalizeError('network', `HEAD probe failed: ${err.message || err.name || 'unknown'}`);
      });

    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch((err) => {
        if (!mountedRef.current) return;
        const mapped = mapPlayRejection(err);
        if (mapped.kind === 'aborted') {
          setIsLoading(false);
          return;
        }
        if (audio.error) {
          const mediaMapped = mapMediaError(audio.error);
          if (mediaMapped.kind !== 'aborted') {
            finalizeError(mediaMapped.kind, mediaMapped.detail);
            return;
          }
        }
        finalizeError(mapped.kind, mapped.detail);
      });
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      return;
    }

    startPlayback();
  };

  const handleRetry = () => {
    setErrorKind(null);
    startPlayback();
  };

  const handleTranscribe = async () => {
    if (transcription) {
      setShowTranscription(!showTranscription);
      return;
    }
    setTranscribing(true);
    try {
      await onTranscribe();
      setShowTranscription(true);
    } finally {
      setTranscribing(false);
    }
  };

  const formatDuration = (ms) => {
    if (!ms) return '0:00';
    const totalSecs = Math.round(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const errorLabel = errorKind ? ERROR_LABELS[errorKind] || ERROR_LABELS.generic : null;
  const isRetryable = !!errorKind && RETRYABLE_KINDS.has(errorKind);

  return (
    <div className="min-w-[200px]">
      <audio ref={audioRef} preload="none" />

      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          disabled={isLoading}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            errorLabel
              ? 'bg-red-500 hover:bg-red-400'
              : isOwn
                ? 'bg-blue-500 hover:bg-blue-400'
                : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600'
          } ${isLoading ? 'opacity-60 cursor-wait' : ''}`}
          title={errorLabel || (isPlaying ? 'Pause' : 'Play')}
        >
          {isLoading ? (
            <svg className={`w-5 h-5 animate-spin ${isOwn ? 'text-white' : 'text-gray-700 dark:text-gray-200'}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          ) : errorLabel ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />
            </svg>
          ) : isPlaying ? (
            <svg xmlns="http://www.w3.org/2000/svg" className={`w-5 h-5 ${isOwn ? 'text-white' : 'text-gray-700 dark:text-gray-200'}`} fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className={`w-5 h-5 ${isOwn ? 'text-white' : 'text-gray-700 dark:text-gray-200'}`} fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex-1">
          <div className="h-1 bg-gray-300 dark:bg-gray-600 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${errorLabel ? 'bg-red-400' : isOwn ? 'bg-blue-300' : 'bg-blue-500'}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className={`text-xs mt-1 flex items-center gap-2 ${errorLabel ? 'text-red-400' : isOwn ? 'text-blue-200' : 'text-gray-500 dark:text-gray-400'}`}>
            <span>{errorLabel || formatDuration(duration)}</span>
            {errorLabel && isRetryable && (
              <button
                onClick={handleRetry}
                className="underline hover:no-underline text-xs"
                title="Retry"
              >
                Retry
              </button>
            )}
          </div>
        </div>

        <button
          onClick={handleTranscribe}
          disabled={transcribing}
          className={`p-2 rounded-full transition-colors ${
            isOwn
              ? 'hover:bg-blue-500 text-blue-200'
              : 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400'
          } ${transcription ? 'opacity-100' : 'opacity-70'}`}
          title={transcription ? (showTranscription ? 'Hide transcript' : 'Show transcript') : 'Transcribe'}
        >
          {transcribing ? (
            <svg className="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          )}
        </button>
      </div>

      {showTranscription && transcription && (
        <div className={`mt-2 p-2 rounded text-sm italic ${
          isOwn
            ? 'bg-blue-500/50 text-blue-100'
            : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
        }`}>
          "{transcription}"
        </div>
      )}
    </div>
  );
}
