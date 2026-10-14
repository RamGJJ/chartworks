import { defineConfig } from 'vite';

// GitHub Pages serves a project site under /<repo>/, every other host at the
// root. VITE_BASE lets the build target either without editing this file.
export default defineConfig({
	base: process.env.VITE_BASE ?? '/',
	server: { port: 5181, strictPort: false },
	build: { outDir: 'dist', emptyOutDir: true },
});
