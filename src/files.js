import path from 'node:path'

const rewrites = new Map()
const trimSlash = x => x.charCodeAt(x.length - 1) === 47 ? x.slice(0, -1) : x
const notFound = x => x.code === 'ENOENT' || x.code === 'EISDIR'

export default function(Ey) {
  return function files(folder, options) {
    if (!options && typeof folder !== 'string') {
      options = folder || {}
      folder = ''
    }

    options = {
      rewrite: true,
      fallthrough: true,
      ...options
    }

    folder = path.isAbsolute(folder)
      ? folder
      : path.join(process.cwd(), folder)

    return Ey().get(cache, file, index)

    function cache(r) {
      const url = trimSlash(r.pathname)

      if (options.rewrite && r.headers.accept && r.headers.accept.indexOf('text/html') === 0 && rewrites.has(url))
        return r.url = rewrites.get(url)
    }

    async function file(r) {
      return r.file(resolve(r.url), options)
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
        if (!options.fallthrough || !notFound(error))
          throw error

        if (r.ended || !trimSlash(r.url))
          return

        try {
          await r.file(url = resolve(r.url + '.html'))
          rewrites.set(trimSlash(r.pathname), url)
        } catch (error) {
          if (!options.fallthrough || !notFound(error))
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
