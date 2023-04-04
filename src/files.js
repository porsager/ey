import path from 'node:path'

const rewrites = new Map()
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
      ...options
    } = o || {}

    folder = path.isAbsolute(folder)
      ? folder
      : path.join(process.cwd(), folder)

    return Ey().get(cache, file, index)

    function cache(r) {
      const url = trimSlash(r.pathname)

      if (rewrite && r.headers.accept && r.headers.accept.indexOf('text/html') === 0 && rewrites.has(url))
        return r.url = rewrites.get(url)
    }

    async function file(r) {
      try {
        await r.file(resolve(r.url), options)
      } catch (error) {
        if (notFound(error))
          return r.handled = false

        throw error
      }
    }

    function index(r) {
      if (r.headers.accept && r.headers.accept.indexOf('text/html') === 0)
        return tryHtml(r)
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
