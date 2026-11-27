/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        finops: {
          canvas: '#f2f3ed',
          surface: '#fcfcf7',
          soft: '#f3f6f1',
          line: '#d7ded4',
          outline: '#8b9f94',
          ink: '#1e312a',
          muted: '#52665e',
          forest: '#203a30',
          sage: '#e7f0e8',
          intake: '#dfeee2',
          'intake-hover': '#d3e7d8',
          'intake-line': '#6b9a7b',
          lime: '#d9ed85',
          'note': '#faf0cf',
          'note-line': '#dfc985',
        },
      },
      boxShadow: {
        'finops-card': '0 12px 32px -16px rgb(32 58 48 / 22%)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out forwards',
        'fade-in-up': 'fadeInUp 0.6s ease-out forwards',
        'gradient-x': 'gradientX 3s ease infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        gradientX: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        loading: {
          '0%': { transform: 'translateX(-100%)' },
          '50%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
    },
  },
  plugins: [],
}
