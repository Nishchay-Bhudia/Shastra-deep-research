import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        cream: {
          50: "#FCFCFA",
          100: "#FAF9F6",
          200: "#F2F0E6",
          300: "#EAE5D6",
          400: "#DED6C1",
          500: "#D1C6A9",
          700: "#9A8C6A",
          900: "#493F2D",
        },
        glass: {
          light: "rgba(250, 249, 246, 0.4)",
          medium: "rgba(250, 249, 246, 0.68)",
          heavy: "rgba(250, 249, 246, 0.88)",
        },
      },
      backdropBlur: {
        xs: "2px",
      },
      backgroundImage: {
        "mesh-pattern":
          "radial-gradient(at 14% 10%, rgba(227, 205, 153, .4) 0, transparent 42%), radial-gradient(at 88% 4%, rgba(201, 215, 190, .35) 0, transparent 39%), radial-gradient(at 70% 92%, rgba(220, 199, 175, .36) 0, transparent 43%)",
      },
      boxShadow: {
        "glass-inset":
          "inset 0 1px 1px rgba(255, 255, 255, .92), 0 24px 70px rgba(82, 68, 42, .11)",
      },
      fontFamily: {
        serif: ["Iowan Old Style", "Palatino Linotype", "Book Antiqua", "Georgia", "serif"],
        sans: ["Inter", "ui-sans-serif", "system-ui", "Arial", "sans-serif"],
      },
    },
  },
  plugins: [typography],
};

export default config;
