import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
        hmr: {
            overlay: false,
        },
        proxy: {
            "/api": {
                target: "http://localhost:8787",
                changeOrigin: true,
                configure: (proxy) => {
                    proxy.on("error", (err, _req, _res) => {
                        // Backend offline in demo — suppress ECONNREFUSED spam, let client fallback handle it
                        if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
                            console.error("[vite proxy]", err);
                        }
                    });
                },
            },
        },
    },
});