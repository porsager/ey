#!/usr/bin/env node

/* eslint-disable no-console */

import { Worker, isMainThread, threadId } from 'worker_threads'
import os from 'os'
import path from 'path'
import ey from '../src/index.js'

const argv = process.argv.slice(2)
    , cwd = process.cwd()
    , cpus = parseInt(argv.find((x, i, xs) => xs[i - 1] === '--threads') || os.cpus().length)
    , folder = argv.find(x => x[0] !== '-') || '.'
    , abs = folder[0] === '/' ? folder : path.join(cwd, folder)
    , port = process.env.PORT || (process.env.SSL_CERT ? 443 : 80)
    , supportsThreads = process.platform === 'linux'

const options = {
  cert: process.env.SSL_CERT,
  key: process.env.SSL_KEY,
  cache: false || !!argv.find(x => x === '--cache')
}

argv.find(x => x === '--no-compress') && (options.compressions = [])

if (supportsThreads && isMainThread) {
  for (let i = 0; i < cpus; i++)
    new Worker(new URL(import.meta.url), { argv }) // eslint-disable-line
} else {
  const app = ey(options)
  app.get(app.files(abs, options))
  try {
    const x = await app.listen(port)
    if (isMainThread || threadId === cpus)
      console.log('Serving', abs === cwd ? './' : abs.replace(cwd + '/', ''), 'on', x.port, ...(supportsThreads ? ['with', threadId, 'workers'] : []))
  } catch (error) {
    console.log('Could not open port', port, '@', threadId)
  }
}
