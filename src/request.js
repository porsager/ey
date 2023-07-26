import uWS from 'uWebSockets.js'

import fsp              from 'node:fs/promises'
import zlib             from 'node:zlib'
import { promisify }    from 'node:util'
import path             from 'node:path'
import { STATUS_CODES } from 'node:http'
import Stream           from 'node:stream'

import mimes, { compressable } from './mimes.js'
import {
  symbols as $
} from './shared.js'

const cwd = process.cwd()
const ipv4 = Buffer.from('00000000000000000000ffff', 'hex')

const compressors = {
  identity: null,
  gzip: promisify(zlib.gzip),
  deflate: promisify(zlib.deflate),
  br: promisify(zlib.brotliCompress)
}

const streamingCompressors = {
  identity: null,
  gzip: zlib.createGzip,
  deflate: zlib.createDeflate,
  br: zlib.createBrotliCompress
}

const caches = {
  deflate: new Map(),
  gzip: new Map(),
  br: new Map(),
  identity: new Map()
}

export default class Request {
  constructor(res, req, options = {}) {
    this.method = req.getMethod()
    try {
      this.url = decodeURIComponent(req.getUrl())
    } catch (error) {
      this.url = req.getUrl()
      this[$.error] = error
    }
    this.pathname = this.url
    this.params = {}
    this.headers = {}
    this.reading = false
    this.handled = false
    this.aborted = false
    this.ended = false
    this.paused = false
    this.last = null
    this[$.res] = res
    this[$.req] = req
    this[$.options] = options
    this[$.query] = req.getQuery() || ''
    this[$.readable] = null
    this[$.writable] = null
    this[$.abort] = null
    this[$.headers] = null
    this[$.headersRead] = null
    this[$.onData] = null
    this[$.data] = null
    this[$.reading] = null
    this[$.body] = null
    this[$.ip] = null
  }

  async onData(fn) {
    this[$.onData] = fn

    if (this[$.data] !== null) {
      this[$.data].forEach(x => fn(x))
      this[$.data] = null
    }

    return this[$.readBody](false)
  }

  [$.readBody](buffer) {
    if (this[$.reading])
      return this[$.reading]

    buffer && (this[$.data] = [])
    return this[$.reading] = new Promise((resolve, reject) => {
      this[$.res].onData((data, isLast) => {
        this[$.onData]
          ? this[$.onData](Buffer.from(data), isLast)
          : this[$.data].push(Buffer.from(Buffer.from(data)))
        isLast && resolve()
      })
    })
  }

  async body(type) {
    if (this[$.body] !== null)
      return this[$.body]

    const length = parseInt(this.headers['content-length'] || '')
        , known = Number.isNaN(length) === false

    let full = known
      ? Buffer.allocUnsafe(parseInt(length))
      : []

    let offset = 0

    await this.onData(buffer => {
      known
        ? buffer.copy(full, offset)
        : full.push(buffer)
      offset += buffer.length
    })

    known || (full = Buffer.concat(full))

    if (known && offset !== full.length)
      throw new Error('Expected data of length', full.length, 'but only got', offset)

    return this[$.body] = type === 'json'
      ? JSON.parse(full)
      : type === 'text'
      ? full.toString()
      : type === 'multipart'
      ? uWS.getParts(full, this.headers['content-type'])
      : full
  }

  onAborted(fn) {
    fn && (this[$.abort] ? this[$.abort].push(fn) : this[$.abort] = [fn])
    if (!this[$.req])
      return

    this.ip // ensure IP is read on first tick
    this[$.req] = null
    return this[$.res].onAborted(() => {
      this.aborted = true
      this[$.abort] && this[$.abort].forEach(x => x())
    })
  }

  get query() {
    return typeof this[$.query] === 'string'
      ? this[$.query] = new URLSearchParams(this[$.query])
      : this[$.query]
  }

  get ip() {
    if (this[$.ip] !== null)
      return this[$.ip]

    const proxyIP = this.headers['x-forwarded-for']
        , remoteIP = Buffer.from(this[$.res].getRemoteAddress())

    return this[$.ip] = (proxyIP
      ? proxyIP.replace(/::ffff:/g, '').split(',')[0].trim()
      : Buffer.compare(ipv4, remoteIP.slice(0, 12)) === 0
        ? [...remoteIP.slice(12)].join('.')
        : Buffer.from(this[$.res].getRemoteAddressAsText()).toString()
    ).replace(/(^|:)0+/g, '$1').replace(/::+/g, '::')
  }

  get readable() {
    const r = this // eslint-disable-line
    if (r[$.readable] !== null)
      return r[$.readable]

    const stream = r[$.readable] = new Stream.Readable({
      read() {
        r.resume()
      }
    })

    start()

    return stream

    async function start() {
      try {
        await r.onData(buffer =>
          stream.push(r[$.data] ? buffer : Buffer.from(buffer)) || r.pause()
        )
        r.resume()
        stream.push(null)
      } catch (error) {
        stream.destroy(error)
      }
    }
  }

  get writable() {
    const r = this // eslint-disable-line
    if (r[$.writable] !== null)
      return r[$.writable]

    const writable = r[$.writable] = new Stream.Writable({
      autoDestroy: true,
      write(chunk, encoding, callback) {
        r.write(chunk)
          ? callback()
          : r.onWritable(() => (callback(), true))
      },
      destroy(error, callback) {
        callback(error)
        r.end()
      },
      final(callback) {
        r.end()
        callback()
      }
    })

    r.onAborted(() => writable.destroy(new Error('Aborted')))

    return writable
  }

  resume() {
    if (!this.paused || this.handled || this.aborted)
      return
    this.paused = false
    this[$.res].resume()
  }

  pause() {
    if (this.paused || this.handled || this.aborted)
      return
    this.paused = true
    this[$.res].pause()
  }

  cookie(name, value, options = {}) {
    if (arguments.length === 1)
      return getCookie(name, this.headers.cookie)

    if (options.Expires && options.Expires instanceof Date)
      options.Expires = options.Expires.toUTCString()

    return this.set(
      'Set-Cookie',
      encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; '
        + Object.entries({
          HttpOnly: true,
          ...{ ...(this[$.options].secure ? { Secure: this[$.options].secure } : {}) },
          ...options
        }).map(([k, v]) => k + (v === true ? '' : '=' + v)).join('; ')
    )
  }

  [$.readHeaders](options = {}) {
    if (!this[$.req] || this[$.headersRead])
      return

    options.headers
      ? options.headers.forEach(k => this.headers[k] = this[$.req].getHeader(k))
      : (this[$.headersRead] = true, this[$.req].forEach((k, v) => this.headers[k] = v))
  }

  set(h, v) {
    typeof h === 'object'
      ? Object.entries(h).forEach(xs => this.set(...xs))
      : v && (this[$.headers]
        ? this[$.headers].push(['' + h, '' + v])
        : this[$.headers] = [['' + h, '' + v]]
      )
  }

  close() {
    this.handled = true
    this[$.res].close()
    return this
  }

  end(body, status, headers) {
    if (this.aborted || this.ended)
      return this

    if (this.handled)
      return (this[$.res].cork(() => this[$.res].end(body)), this.ended = true, this)

    typeof body === 'number' && (headers = status, status = body, body = null)
    typeof status === 'object' && (headers = status, status = null)
    return this.head(status || 200, headers, () => {
      this.method === 'head'
        ? this[$.res].endWithoutBody()
        : this[$.res].end(body || '')
      this.ended = true
    })
  }

  head(status, headers, fn) {
    this.handled = true
    headers && this.set(headers)
    this.aborted || this.cork(() => {
      status && this[$.res].writeStatus(typeof status === 'number'
        ? status + (status in STATUS_CODES ? ' ' + STATUS_CODES[status] : '')
        : status
      )
      this[$.headers] && this[$.headers].forEach(xs => this[$.res].writeHeader(...xs))
      fn && fn()
    })
    return this
  }

  cork(fn) {
    let result = this.aborted
    this.handled = true
    result || this[$.res].cork(() => result = fn())
    return result
  }

  getWriteOffset() {
    return this.aborted || this[$.res].getWriteOffset()
  }

  onWritable(fn) {
    this.handled = true
    return this[$.res].onWritable(fn)
  }

  tryEnd(x, total) {
    this.handled = true
    if (this.aborted)
      return [true, true]

    try {
      return this.cork(() => this[$.res].tryEnd(x, total))
    } catch (err) {
      return [true, true]
    }
  }

  write(x) {
    return this.cork(() => this[$.res].write(x))
  }

  writeHeader(k, v) {
    return this.cork(() => this[$.res].writeHeader(k, v))
  }

  writeStatus(x) {
    return this.cork(() => this[$.res].writeStatus(x))
  }

  json(body, ...xs) {
    this.set('Content-Type', 'application/json')
    return this.end(JSON.stringify(body), ...xs)
  }

  html(body, ...xs) {
    this.set('Content-Type', 'text/html')
    return this.end(body, ...xs)
  }

  file(file, options) {
    options = Object.assign({
      lastModified: true,
      etag: true,
      minStreamSize: 512 * 1024,
      maxCacheSize: 128 * 1024,
      minCompressSize: 1280,
      cache: true
    }, options)

    file = path.isAbsolute(file) ? file : path.join(cwd, file)
    const compressions = options.compressions ?? this[$.options].compressions
        , cache = options.cache || this[$.options].cache
        , ext = path.extname(file).slice(1)
        , type = mimes.get(ext)

    const compressor = compressions && compressions.length
      ? getEncoding(this.headers['accept-encoding'], compressions, type)
      : null

    return cache && caches[compressor || 'identity'].has(file)
      ? this.end(...caches[compressor || 'identity'].get(file))
      : read(this, file, type, compressor, options)
  }
}

async function read(r, file, type, compressor, o) {
  r.onAborted()
  let handle

  try {
    handle = await fsp.open(file)
    const stat = await handle.stat()

    if (stat.size < o.minCompressSize)
      compressor = null

    if (r.headers.range || (stat.size >= o.minStreamSize && stat.size > o.maxCacheSize))
      return stream(r, file, type, { handle, stat, compressor }, o)

    const headers = {
      ETag: createEtag(stat.mtime, stat.size, compressor),
      'Last-Modified': stat.mtime.toUTCString(),
      'Content-Encoding': compressor,
      'Content-Type': type
    }

    if (r.method === 'head') {
      r.end(200, {
        ...headers,
        [compressor ? 'Transfer-Encoding' : 'Content-Length']: compressor ? 'chunked' : stat.size
      })
      return
    }

    let bytes = await handle.readFile()

    handle.close()
    handle = null

    if (o.transform) {
      bytes = o.transform(bytes, file, type, r)
      if (bytes && typeof bytes.then === 'function')
        bytes = await bytes
    }

    if (compressor)
      bytes = await compressors[compressor](bytes)

    const response = [bytes, headers]

    o.cache && stat.size < o.maxCacheSize && caches[compressor || 'identity'].set(file, response)
    r.end(bytes, headers)
  } finally {
    r.handled = r.ended
    handle && handle.close()
  }
}

async function stream(r, file, type, { handle, stat, compressor }, options) {
  let stream
    , resolve
    , reject

  const promise = new Promise((a, b) => (resolve = a, reject = b))
  r.onAborted(resolve)

  try {
    const { size, mtime } = stat
        , range = r.headers.range || ''
        , highWaterMark = options.highWaterMark || options.minStreamSize
        , end = parseInt(range.slice(range.indexOf('-') + 1)) || size - 1
        , start = parseInt(range.slice(6, range.indexOf('-')) || size - end - 1)
        , total = end - start + 1

    if (end >= size)
      return r.end('Range Not Satisfiable', 416, { 'Content-Range': 'bytes */' + (size - 1) })

    stream = handle.createReadStream({ start, end, highWaterMark })

    if (compressor)
      stream = stream.pipe(streamingCompressors[compressor]({ chunkSize: highWaterMark }))

    stream.on('close', close)
    stream.on('error', reject)
    stream.on('data', compressor ? writeData : tryData)

    const status = range ? 206 : 200
    const headers = {
      'Accept-Ranges': range ? undefined : 'bytes',
      'Last-Modified': mtime.toUTCString(),
      'Content-Encoding': compressor,
      'Content-Range': range && 'bytes ' + start + '-' + end + '/' + size,
      'Content-Type': type,
      Connection: 'keep-alive', // really ? needed ?
      ETag: createEtag(mtime, size, compressor)
    }

    if (r.method === 'head') {
      compressor
        ? headers['Transfer-Encoding'] = 'chunked'
        : headers['Content-Length'] = size
      return r.end(status, headers)
    }

    r.head(status, headers)

    let lastOffset
      , ab

    r.onWritable(compressor ? writeResume : tryResume)

    await promise

    function writeData(x) {
      const wat = r.write(x)
      wat || stream.pause()
    }

    function writeResume() {
      if (!stream)
        return
      stream.resume()
      return true
    }

    function tryData(x) {
      ab = x.buffer
      lastOffset = r.getWriteOffset()
      const [ok, done] = r.tryEnd(ab, total)
      done
        ? resolve(r.ended = true)
        : ok || stream.pause()
    }

    function tryResume(offset) {
      const [ok, done] = r.tryEnd(ab.slice(offset - lastOffset), total)
      done
        ? resolve(r.ended = true)
        : ok && stream && stream.resume()
      return ok
    }

    function close() {
      r.ended || r.end()
      resolve()
    }
  } finally {
    stream.destroy()
  }
}

function getEncoding(x, supported, type) {
  if (!x)
    return

  const accepted = parseAcceptEncoding(x, supported)
  let compressor
  for (const x of accepted) {
    if (x.type in compressors) {
      compressor = x.type === 'identity' ? null : x.type
      break
    }
  }
  return compressable.has(type) && compressor
}

function parseAcceptEncoding(x, compressions = []) {
  return (x || '').split(',')
    .map(x => (x = x.split(';q='), { type: x[0].trim(), q: parseFloat(x[1] || 1) }))
    .filter(x => x.q !== 0 && compressions.indexOf(x.type) !== -1)
    .sort((a, b) => a.q === b.q
      ? compressions.indexOf(a.type) - compressions.indexOf(b.type)
      : b.q - a.q)
}

function createEtag(mtime, size, weak) {
  return (weak ? 'W/' : '') + '"' + Math.floor(mtime.getTime() / 1000).toString(16) + '-' + size.toString(16) + '"'
}

function getCookie(name, x) {
  if (!x)
    return null

  const xs = x.match('(?:^|; )' + name + '=([^;]+)(;|$)')
  return xs ? decodeURIComponent(xs[1]) : null
}
