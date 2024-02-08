import path from 'node:path'

const rewrites = new Map()
const trimSlash = x => x.charCodeAt(x.length - 1) === 47 ? x.slice(0, -1) : x
const notFound = x => x.code === 'ENOENT' || x.code === 'EISDIR'
const hasOwn = {}.hasOwnProperty

export default function(Ey) {
  return function files(folder, o = {}) {
    if (!o && typeof folder !== 'string') {
      o = folder || {}
      folder = ''
    }

    hasOwn.call(o, 'rewrite') || (o.rewrite = true)
    hasOwn.call(o, 'fallthrough') || (o.fallthrough = true)

    folder = path.isAbsolute(folder)
      ? folder
      : path.join(process.cwd(), folder)

    return Ey().get(cache, file, index)

    function cache(r) {
      const url = trimSlash(r.pathname)

      if (o.rewrite && r.headers.accept && r.headers.accept.indexOf('text/html') === 0 && rewrites.has(url))
        return r.url = rewrites.get(url)
    }

    async function file(r) {
      return r.file(resolve(r.url), o)
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
        if (!fallthrough || !notFound(error))
          throw error

        if (r.ended || !trimSlash(r.url))
          return

        try {
          await r.file(url = resolve(r.url + '.html'))
          rewrites.set(trimSlash(r.pathname), url)
        } catch (error) {
          if (!fallthrough || !notFound(error))
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
