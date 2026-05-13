/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        wiom: {
          50:  "#fff0f7",
          100: "#ffe0f0",
          200: "#ffb3d9",
          300: "#ff66b2",
          400: "#f0198c",
          500: "#e5007d",
          600: "#c5006b",
          700: "#a00057",
          800: "#7a0043",
          900: "#550030",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
      },
      borderRadius: {
        "2xl": "16px",
        "3xl": "20px",
      },
      boxShadow: {
        "pink-glow":   "0 4px 20px rgba(229,0,125,0.25)",
        "pink-glow-lg":"0 8px 40px rgba(229,0,125,0.35)",
        "card":        "0 1px 8px rgba(0,0,0,0.06)",
        "card-dark":   "0 1px 8px rgba(0,0,0,0.4)",
      },
      animation: {
        "slide-up":   "slide-in-up 0.3s ease both",
        "fade-in":    "fade-in 0.25s ease both",
        "bar-slide":  "bar-slide 1.5s ease-in-out infinite",
        "pulse-pink": "pulse-pink 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
