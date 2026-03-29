// Compatibility shim: legacy imports should migrate to AudioConnectionContext.
export {
  AudioConnectionProvider,
  useAudioConnection,
  AudioConnectionContext,
  LiveKitConnectionProvider,
  useLiveKitConnection,
  LiveKitConnectionContext,
} from './AudioConnectionContext.jsx';
export { default } from './AudioConnectionContext.jsx';
