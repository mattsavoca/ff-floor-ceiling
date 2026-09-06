import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#12304A",
        action: "#1264A3",
      },
    },
  },
  plugins: [],
};

export default config;
