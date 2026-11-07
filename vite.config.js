import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import localApi from './dev/local-api.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localApi()],
})
