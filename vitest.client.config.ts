import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    solidPlugin({ ssr: false, exclude: /\.react\.tsx$/ }),
    react({ include: /\.react\.tsx$/ }),
  ],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.client.test.tsx'],
  },
});
