import path             from 'node:path'
import fsp              from 'node:fs/promises'

const rewrites = new Map()
const redirects = new Map()
const trimSlash = x => x.charCodeAt(x.length - 1) === 47 ? x.slice(0, -1) : x
const notFound = x => x.code === 'ENOENT' || x.code === 'EISDIR'

export default function(Ey) {
  return function files(folder, o) {
    if (!o && typeof folder !== 'string') {
      o = folder || {}
      folder = ''
    }

    const {
      rewrite = true,
      redirect = true,
      ...options
    } = o || {}

    folder = path.isAbsolute(folder)
      ? folder
      : path.join(process.cwd(), folder)

    return Ey().get(cache, file, index)

    function cache(r) {
      const url = trimSlash(r.pathname)

      if (redirect && redirects.has(url))
        return r.end(...redirects.get(url))

      if (rewrite && rewrites.has(url))
        return r.url = rewrites.get(url)
    }

    async function file(r) {
      try {
        await r.file(resolve(r.url), options)
      } catch (error) {
        if (notFound(error))
          return

        throw error
      }
    }

    async function index(r) {
      if (r.headers.accept.indexOf('text/html') === 0)
        return tryHtml(r)

      if (r.headers.accept === '*/*')
        return tryJs(r)
    }

    function tryJs(r) {
      return fsp
        .stat(resolve(path.join(r.url, 'index.js')))
        .then(x => x.isFile() && r.pathname + '/index.js')
        .catch(() => null)
        .then(x => x || fsp.stat(resolve(r.url + '.js')).then(x => x.isFile() && r.pathname + '.js'))
        .catch(() => null)
        .then(Location => {
          if (!Location)
            return

          const response = [302, { Location }]
          redirect && redirects.set(trimSlash(r.pathname), response)
          return r.end(...response)
        })
    }

    async function tryHtml(r) {
      let url = resolve(path.join(r.url, 'index.html'))
      try {
        await r.file(url)
        rewrites.set(trimSlash(r.pathname), url)
      } catch (error) {
        if (!notFound(error))
          throw error

        if (!trimSlash(r.url))
          return

        try {
          await r.file(url = resolve(r.url + '.html'))
          rewrites.set(trimSlash(r.pathname), url)
        } catch (error) {
          if (notFound(error))
            return

          throw error
        }
      }
    }

    function resolve(x) {
      x = path.join(folder, x)
      if (x.indexOf(folder) !== 0)
        throw new Error('Resolved path is outside root folder')

      return x
    }
  }
}
