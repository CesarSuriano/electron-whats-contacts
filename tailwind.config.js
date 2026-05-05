/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{html,ts}'
  ],
  // Habilita variants `dark:` em qualquer classe Tailwind. Em runtime, o tema é
  // ativado por `[data-theme="dark"]` ou `body.theme-dark` (como já é hoje em
  // styles.scss). Para utility-classes Tailwind nativas, basta usar `dark:bg-X`
  // em qualquer elemento dentro do escopo escuro.
  darkMode: ['class', '[data-theme="dark"], body.theme-dark'],
  theme: {
    extend: {
      colors: {
        // Paleta da marca: valores fixos, não mudam com o tema. Valores
        // anteriormente em `:root --brand-*` migrados pra cá.
        brand: {
          50: '#fdf7f8',
          100: '#f8ecef',
          500: '#9a3651',
          600: '#7d2238',
          700: '#6b1b2e',
          800: '#5d1426',
          900: '#4a0f1e',
        },
        primary: {
          DEFAULT: '#751013',
          dark: '#5a0c0e',
          light: '#8b1a1e',
        },
        // Tokens semânticos: mudam com tema (light/dark). Apontam pra CSS vars
        // definidas em styles.scss. Esse padrão (CSS vars + Tailwind colors)
        // é o mesmo usado por shadcn/ui, Vercel etc — permite trocar tema em
        // runtime sem reescrever classes nos componentes.
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
      // Tokens estáticos: valores literais. Antes vinham de `var(--radius-*)`
      // / `var(--shadow-*)` / `var(--font-ui)` no :root. Como essas vars não
      // mudavam com o tema, foram movidas pra cá. Componentes legados podem
      // ainda referenciar `var(--radius)` etc — as vars permanecem no
      // styles.scss como fallback até a migração CSS terminar.
      borderRadius: {
        sm: '6px',
        DEFAULT: '10px',
        lg: '14px',
        xl: '20px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,.04)',
        DEFAULT: '0 1px 3px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.04)',
        lg: '0 10px 30px rgba(0,0,0,.08), 0 2px 6px rgba(0,0,0,.04)',
      },
      fontFamily: {
        ui: ['Inter', 'SF Pro Text', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },
      spacing: {
        // Larguras de layout que antes vinham de var(--sidebar-w*) / --topbar-h.
        // Vars permanecem em styles.scss até migração componente-a-componente
        // terminar (uso ainda em app-shell-sidebar.scss e app-page-header.scss).
        'sidebar': '64px',
        'sidebar-open': '232px',
        'topbar': '66px',
      },
    }
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  }
};
