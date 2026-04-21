/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{html,ts}'
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#751013',
          dark: '#5a0c0e',
          light: '#8b1a1e',
        },
        bg: {
          DEFAULT: 'var(--bg)',
          subtle: 'var(--bg-subtle)',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        txt: {
          DEFAULT: 'var(--text)',
          muted: 'var(--text-muted)',
          subtle: 'var(--text-subtle)',
          strong: 'var(--text)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
          text: 'var(--accent-text)',
        },
        success: {
          DEFAULT: 'var(--success)',
          soft: 'var(--success-soft)',
        },
        warn: {
          DEFAULT: 'var(--warn)',
          soft: 'var(--warn-soft)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          soft: 'var(--danger-soft)',
        },
        wa: {
          bg: 'var(--wa-bg)',
          sent: 'var(--wa-sent)',
          recv: 'var(--wa-recv)',
          header: 'var(--wa-header)',
          surface: {
            DEFAULT: 'var(--wa-surface)',
            alt: 'var(--wa-surface-alt)',
          },
          hover: 'var(--wa-hover)',
          'chat-bg': 'var(--wa-chat-bg)',
          pink: {
            DEFAULT: 'var(--wa-pink)',
            subtle: 'var(--wa-pink-subtle)',
          },
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        lg: 'var(--shadow-lg)',
      },
      fontFamily: {
        ui: ['var(--font-ui)'],
      },
    }
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  }
};
