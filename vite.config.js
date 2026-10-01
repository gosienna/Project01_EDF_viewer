import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  base: '/Project01_EDF_viewer/',
  plugins: [
    react(),
    {
      name: 'serve-test-edf',
      configureServer(server) {
        server.middlewares.use('/testEDF', (req, res, next) => {
          const fileName = path.basename(req.url || '')
          const filePath = path.join(__dirname, 'private/testEDF', fileName)

          if (!fileName || !fs.existsSync(filePath)) {
            next()
            return
          }

          res.setHeader('Content-Type', 'application/octet-stream')
          fs.createReadStream(filePath).pipe(res)
        })
      },
    },
  ],
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
