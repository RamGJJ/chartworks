import { defineConfig } from 'vite';

export default defineConfig({
	server: { port: 5181, strictPort: false },
	build: { outDir: 'dist', emptyOutDir: true },
});
