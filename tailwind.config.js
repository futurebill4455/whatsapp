/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        mist: '#e2e8f0',
        sand: '#f8fafc',
        sea: '#0d9488',
        coral: '#f43f5e',
        violet: '#7c3aed',
        amber: '#f59e0b',
      },
      fontFamily: {
        display: ['"DM Sans"', 'system-ui', 'sans-serif'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 10px 40px -12px rgba(15, 23, 42, 0.18)',
      },
    },
  },
  plugins: [],
};
