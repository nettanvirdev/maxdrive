/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./src/renderer/**/*.{js,jsx,ts,tsx,html}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        // design.json surfaces and file-type accents
        drive: {
          variant: "var(--surface-variant)",
          folder: "var(--folder-card)",
          file: "var(--file-card)",
          cardborder: "var(--card-border)",
          tertiary: "var(--text-tertiary)",
          pdf: "var(--type-pdf)",
          docs: "var(--type-docs)",
          sheets: "var(--type-sheets)",
          slides: "var(--type-slides)",
          video: "var(--type-video)",
        },
      },
      borderRadius: {
        xs: "4px",
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "24px",
      },
      boxShadow: {
        gfloat:
          "0px 1px 3px 1px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.30)",
        gdrop:
          "0px 2px 6px 2px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.30)",
        gcard:
          "0px 1px 2px 0px rgba(60, 64, 67, 0.30), 0px 1px 3px 1px rgba(60, 64, 67, 0.15)",
      },
      transitionTimingFunction: {
        standard: "var(--motion-standard)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        // Dialogs rise and settle rather than fading, which reads as "this came
        // from the thing you clicked" instead of "a layer appeared".
        "dialog-in": {
          from: { opacity: "0", transform: "translateY(12px) scale(0.97)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "scrim-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms var(--motion-standard) both",
        shimmer: "shimmer 1.6s infinite",
        "dialog-in": "dialog-in 220ms var(--motion-standard) both",
        "scrim-in": "scrim-in 150ms var(--motion-standard) both",
      },
    },
  },
  plugins: [],
};
