import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    include: ['client/src/**/__tests__/**/*.test.{js,jsx}', 'src/**/__tests__/**/*.test.{js,jsx}'],
    coverage: {
      provider: 'v8',
      include: ['client/src/audio/OpusBrowserEncoder.js', 'client/src/audio/AudioTransportManager.js'],
    },
  },
});
