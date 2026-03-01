import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Замени 'vital-os' на название своего GitHub репозитория
export default defineConfig({
  plugins: [react()],
  base: '/vital-os/',
})
