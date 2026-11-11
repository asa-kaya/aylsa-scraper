import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built files go to ../static/app and are served by Flask (python app.py).
// `npm run dev` serves the app with hot reload and forwards /api to Flask on :5000
// (override with FLASK_URL=http://127.0.0.1:5001 npm run dev).
export default defineConfig({
  plugins: [react()],
  base: "/static/app/",
  build: {
    outDir: "../static/app",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": process.env.FLASK_URL || "http://127.0.0.1:5000",
    },
  },
});
