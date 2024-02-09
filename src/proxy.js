import { symbols as $ } from './shared.js'
import net from 'node:net'
import tls from 'node:tls'

const nets = new Map()
const tlss = new Map()
const keepAlive = parseInt(process.env.EY_PROXY_KEEP_ALIVE || (2 * 60 * 1000))

export default function(r, url, options = {}) {
  url = new URL(url)
  url.secure = url.protocol === 'https:'
  const xs = url.secure ? tlss : nets
  const headers = options.headers ? { ...r.headers, ...options.headers } : r.headers
  const head = r.method.toUpperCase() + ' '
    + url.pathname + url.search + ' HTTP/1.1\r\n'
    + Object.entries(headers).map(([h, v]) => h + ': ' + v).join('\r\n')
    + '\r\n\r\n'

  return xs.has(url.host)
    ? reuse(r, url, xs, head)
    : open(r, url, url.secure ? tls : net, xs, head)
}

function reuse(r, url, xs, head) {
  const sockets = xs.get(url.host)
  const socket = sockets.pop()
  sockets.length || xs.delete(url.host)
  socket(r, url, head)
}

function remove(xs, host, x) {
  if (!xs.has(host))
    return

  const sockets = xs.get(host)
  const socket = sockets.remove(x)
  sockets.length || xs.delete(host)
  return socket
}

function open(r, url, x, xs, head) {
  let i = -1
  let header = -1
  let body = -1
  let colon = -1
  let char = -1
  let space = -1
  let name = ''
  let value = ''
  let offset = -1
  let aborted = null
  let timer = null

  const s = x.connect({
    host: url.hostname,
    port: url.port || (url.secure ? 443 : 80),
    servername: url.secure && !net.isIP(url.host) ? url.host : undefined,
    onread: {
      buffer: Buffer.alloc(128 * 1024),
      callback: (length, buffer) => {
        if (body !== -1)
          return write(r, buffer.subarray(0, length))

        i = 0
        if (header === -1) {
          while (header === -1 && i++ < length) {
            if (buffer[i] === 10)
              header = i = i + 1
            else if (buffer[i] === 13)
              header = i = i + 2
          }
        }
        r.status(buffer.toString('utf8', 9, header).trim())
        if (body === -1) {
          while (body === -1 && i++ < length) {
            char = buffer[i]
            if (char === 10) {
              name = buffer.toString('utf8', header, colon)
              value = buffer.toString('utf8', colon > space ? colon : space, i - 1)
              name.toLowerCase() === 'host'
                ? r.set('Host', url.hostname)
                : r.set(name, value)
              header = i + 1
              buffer[i + 1] === 10
                ? body = i + 2
                : buffer[i + 2] === 10
                ? body = i + 3
                : null
            } else if (colon < header && char === 58) {
              colon = i
            } else if (space < header && char === 32) {
              space = i + 1
            }
          }
        }
        if (body !== -1)
          write(r, buffer.subarray(body, length))
      }
    }
  })

  r.onAborted(() => (aborted && aborted(), s.destroy()))
  s.setKeepAlive(true, keepAlive)
  s.once('connect', () => s.write(head))
  s.once('error', error)
  s.once('close', close)

  function error(error) {
    r.end(error, 500)
  }

  function close() {
    clearTimeout(timer)
    remove(xs, url.host, start)
    r.end()
  }

  function finished() {
    timer = setTimeout(() => s.destroy(), keepAlive)
    xs.has(url.host)
      ? xs.get(url.host).push(start)
      : xs.set(url.host, Stack([start]))
  }

  function start(...xs) {
    [r, url, head] = xs
    clearTimeout(timer)
    i = header = body = colon = char = space = offset = -1
    name = value = ''
    aborted = null
    r.onAborted(() => (aborted && aborted(), s.destroy()))
    s.write(head)
  }

  async function write(r, buffer) {
    if (r[$.length]) {
      offset = r.getWriteOffset()
      const [ok, done] = r.tryEnd(buffer, r[$.length])
      if (done)
        return finished()

      ok || await new Promise(resolve => {
        s.pause()
        aborted = resolve
        r.onWritable(i => {
          const [ok] = r.tryEnd(buffer.subarray(i - offset), r[$.length])
          ok && resolve()
          return ok
        })
      })
      s.resume()
    } else {
      r.write(buffer)
    }
  }
}

function Stack(xs = []) {
  let top = xs.pop()

  return {
    get length() { return top === undefined ? 0 : xs.length + 1 },
    remove,
    clear,
    push,
    peek,
    pop
  }

  function remove(x) {
    if (top === x)
      return pop()

    const i = xs.indexOf(x)
    return i === -1
      ? undefined
      : xs.splice(i, 1)[0]
  }

  function clear() {
    xs = []
    top = undefined
  }

  function push(x) {
    xs.push(top)
    top = x
    return x
  }

  function pop() {
    const x = top
    top = xs.pop()
    return x
  }

  function peek() {
    return top
  }

}
