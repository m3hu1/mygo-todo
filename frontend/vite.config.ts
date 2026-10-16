import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // The app loads this address during `mygo dev` (devUrl in
    // mygo.config.ts).
    port: 5173,
    strictPort: true,
    // The built frontend is not the page's while it is being developed.
    watch: { ignored: ["**/dist/**"] },
  },
});
