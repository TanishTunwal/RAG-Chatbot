import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./pages/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        body: ["var(--font-body)", "sans-serif"],
        display: ["var(--font-display)", "serif"],
      },
      boxShadow: {
        soft: "0 24px 70px rgba(76, 54, 29, 0.12)",
      },
      colors: {
        shell: {
          bg: "#f4efe7",
          deep: "#e5dccd",
          panel: "rgba(255, 252, 246, 0.82)",
          strong: "#fffaf2",
          border: "rgba(75, 54, 35, 0.12)",
          text: "#1f2328",
          muted: "#616161",
          accent: "#0f766e",
          accentStrong: "#115e59",
          danger: "#b45309",
        },
      },
      backgroundImage: {
        shell: "linear-gradient(160deg, var(--bg) 0%, var(--bg-deep) 100%)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          "0%": { transform: "translateX(100%)" },
          "100%": { transform: "translateX(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        rise: "rise 260ms ease both",
        "slide-in": "slide-in 220ms ease-out",
        "fade-in": "fade-in 180ms ease-out",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
