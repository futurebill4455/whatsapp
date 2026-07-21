/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        ink: '#0f1f2e',
        mist: '#e8eef3',
        sea: '#0d7377',
        seaDark: '#095456',
        sand: '#f7f4ef',
        coral: '#c45c26',
      },
      fontFamily: {
        display: ['"Fraunces"', 'Georgia', 'serif'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
