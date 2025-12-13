/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dispatch: {
          bg: 'var(--dispatch-bg)',
          panel: 'var(--dispatch-panel)',
          border: 'var(--dispatch-border)',
          text: 'var(--dispatch-text)',
          secondary: 'var(--dispatch-text-secondary)',
          tertiary: 'var(--dispatch-text-tertiary)',
          accent: '#3b82f6',
          emergency: '#dc2626',
          warning: '#eab308',
          success: '#22c55e',
        }
      },
      animation: {
        'pulse-emergency': 'pulse-emergency 0.5s ease-in-out infinite',
        'flash': 'flash 1s ease-in-out infinite',
      },
      keyframes: {
        'pulse-emergency': {
          '0%, 100%': { backgroundColor: '#dc2626' },
          '50%': { backgroundColor: '#7f1d1d' },
        },
        'flash': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.5 },
        }
      }
    },
  },
  plugins: [],
}
