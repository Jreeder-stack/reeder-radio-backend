import { useState, useRef, useEffect } from 'react';

export default function VoiceMessage({ audioUrl, duration, transcription, onTranscribe, isOwn }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [showTranscription, setShowTranscription] = useState(false);
  const audioRef = useRef(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      if (audio.duration) {
        setProgress((audio.currentTime / audio.duration) * 100);
      }
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(0);
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(err => console.error('Playback failed:', err));
    }
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

  const formatDuration = (secs) => {
    if (!secs) return '0:00';
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return `${mins}:${remainingSecs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-w-[200px]">
      <audio ref={audioRef} src={audioUrl} preload="metadata" />
      
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            isOwn 
              ? 'bg-blue-500 hover:bg-blue-400' 
              : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600'
          }`}
        >
          {isPlaying ? (
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
              className={`h-full transition-all ${isOwn ? 'bg-blue-300' : 'bg-blue-500'}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className={`text-xs mt-1 ${isOwn ? 'text-blue-200' : 'text-gray-500 dark:text-gray-400'}`}>
            {formatDuration(duration)}
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
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
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
