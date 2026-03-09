/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        bebas: ['"Bebas Neue"', "sans-serif"],
        sans: ['"DM Sans"', "sans-serif"],
      },
      colors: {
        volt: "#C8FF00",
        surface: "#13131a",
        deep: "#09090f",
        sidebar: "#0d0d14",
        border: "#2a2a3a",
      },
    },
  },
  plugins: [],
};
