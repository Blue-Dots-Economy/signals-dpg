import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const defaultNetworkTheme =
    env.VITE_DEFAULT_NETWORK_THEME ||
    (env.VITE_NETWORK_ID ? env.VITE_NETWORK_ID.split(',')[0].trim() : 'blue_dot');

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    define: {
      // Injected into index.html's pre-React bootstrap script so the first CSS
      // paint already has the right data-network attribute on <html>.
      __DEFAULT_NETWORK_THEME__: JSON.stringify(defaultNetworkTheme),
    },
    server: {
      port: 3000,
    },
  };
});
