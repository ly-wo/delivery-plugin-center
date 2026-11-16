import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
await build({configFile:false,base:'/plugin-center/',plugins:[vue()],build:{rollupOptions:{output:{entryFileNames:'center.js',chunkFileNames:'center.js',assetFileNames:'center.css'}}}});
