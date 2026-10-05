import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.APP_SECRET': JSON.stringify(env.APP_SECRET),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Permite acesso via ngrok e outros túneis externos (Vite 6: usar true, não 'all')
      allowedHosts: true,
      watch: {
        // Exclui a pasta de sessão do Puppeteer/Chrome do monitoramento do Vite.
        // Sem isso, cada arquivo salvo pelo WhatsApp Web (cookies, IndexedDB, cache)
        // disparava um "page reload" que voltava o usuário para a aba inicial.
        ignored: ['**/whatsapp-session-data/**', '**/.git/**'],
      },
    },
  };
});
