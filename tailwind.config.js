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
        }
      }
    }
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  }
};
