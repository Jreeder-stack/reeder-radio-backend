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
          bg: '#0a0a0f',
          panel: '#13131a',
          border: '#2a2a35',
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
