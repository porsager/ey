import uWS from 'uWebSockets.js'

import fsp                      from 'node:fs/promises'
import zlib                     from 'node:zlib'
import { promisify }            from 'node:util'
import path                     from 'node:path'
import { STATUS_CODES }         from 'node:http'
import { Readable, Writable }   from 'node:stream'

import mimes, { compressable }  from './mimes.js'
import { state, symbols as $ }  from './shared.js'

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
    this.paused = false
    this.last = null
    this[$.res] = res
    this[$.req] = req
    this[$.state] = 1
    this[$.query] = req.getQuery() || ''
    this[$.corked] = false
    this[$.readable] = null
    this[$.writable] = null
    this[$.abort] = null
    this[$.status] = null
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
    if (this[$.state] > state.RECEIVING)
        return

    if (this[$.reading])
      return this[$.reading]

    buffer && (this[$.data] = [])
    return this[$.reading] = this[$.working] = new Promise((resolve, reject) => {
      this[$.res].onData((data, isLast) => {
        this[$.onData]
          ? this[$.onData](Buffer.from(data), isLast)
          : this[$.data].push(Buffer.from(Buffer.from(data)))
        isLast && resolve()
      })
    }).finally(() =>
      this[$.reading] = this[$.working] = null
    )
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
      this[$.state] = state.ENDED
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

    const stream = r[$.readable] = new Readable({
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

    const writable = r[$.writable] = new Writable({
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
    if (!this.paused || this[$.state] === state.ENDED)
      return
    this.paused = false
    this[$.res].resume()
  }

  pause() {
    if (this.paused || this[$.state] === state.ENDED)
      return
    this.paused = true
    this[$.res].pause()
  }

  cookie(name, value, options = {}) {
    if (arguments.length === 1)
      return getCookie(name, this.headers.cookie)

    if (options.Expires && options.Expires instanceof Date)
      options.Expires = options.Expires.toUTCString()

    return this.header(
      'Set-Cookie',
      encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; '
        + Object.entries({
          HttpOnly: true,
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

  close() {
    this[$.state] = state.ENDED
    this[$.res].close()
    return this
  }

  end(x, status, headers) {
    typeof status === 'object' && (headers = status, status = null)
    status && this.status(status)
    headers && this.header(headers)
    this.cork(() => {
      this[$.state] = state.ENDED

      if (this.method !== 'head')
        return this[$.res].end(x)

      x && this[$.res].writeHeader('Content-Length', '' + Buffer.byteLength(x))
      this[$.res].endWithoutBody()
    })
    return this
  }

  statusEnd(status, headers) {
    return this.end(STATUS_CODES[status], status, headers)
  }

  status(x) {
    this[$.status] = x
    return this
  }

  header(h, v, x) {
    if (typeof h === 'number') {
      this.status(h)
      h = v
      v = x
    }
    typeof h === 'object'
      ? Object.entries(h).forEach(xs => this.header(...xs))
      : v && (this[$.headers]
        ? this[$.headers].push(['' + h, '' + v])
        : this[$.headers] = [['' + h, '' + v]]
      )
    return this
  }

  set(...xs) {
    return this.header(...xs)
  }

  cork(fn) {
    if (this[$.state] === state.ENDED)
      return

    if (this[$.corked])
      return fn()

    let result
    this[$.res].cork(() => {
      if (this[$.state] < state.SENT_HEADERS) {
        if (this[$.state] < state.SENT_STATUS) {
          this[$.state] = state.SENT_STATUS
          const status = this[$.status]
          status && this[$.res].writeStatus(typeof status === 'number'
            ? status + (status in STATUS_CODES ? ' ' + STATUS_CODES[status] : '')
            : status
          )
        }
        this[$.state] = state.SENT_HEADERS
        this[$.headers] && this[$.headers].forEach(([header, value]) => {
          value && this[$.res].writeHeader(
            header,
            value instanceof Date
              ? value.toUTCString()
              : value
          )
        })
      }
      result = fn()
    })
    return result
  }

  getWriteOffset() {
    return this[$.state] === state.ENDED
      ? -1
      : this[$.res].getWriteOffset()
  }

  onWritable(fn) {
    return this[$.res].onWritable(x => {
      this[$.corked] = true
      const result = fn(x)
      this[$.corked] = false
      return result
    })
  }

  tryEnd(x, total) {
    if (this[$.state] === state.ENDED)
      return [true, true]

    try {
      return this.cork(() => {
        if (this.method === 'head') {
          this[$.state] = state.ENDED
          this[$.res].endWithoutBody(total)
          return [true, true]
        }

        const xs = this[$.res].tryEnd(x, total)
        xs[1] && (this[$.state] = state.ENDED)
        return xs
      })
    } catch (err) {
      this[$.state] = state.ENDED
      return [true, true]
    }
  }

  write(x) {
    if (this[$.state] === state.ENDED)
      return true

    return this.cork(() =>
      this.method === 'head'
        ? this.end()
        : this[$.res].write(x)
    )
  }

  json(body, ...xs) {
    this.header('Content-Type', 'application/json')
    return this.end(JSON.stringify(body), ...xs)
  }

  html(body) {
    this.header('Content-Type', 'text/html')
    return this.end(body)
  }

  file(file, options) {
    options = Object.assign({
      lastModified: true,
      etag: true,
      minStreamSize: process.env.EY_MIN_STREAM_SIZE || (512 * 1024),
      maxCacheSize: process.env.EY_MIN_CACHE_SIZE || (128 * 1024),
      minCompressSize: process.env.EY_MIN_COMPRESS_SIZE || 1280,
      cache: true
    }, options)

    file = path.isAbsolute(file) ? file : path.join(cwd, file)
    const compressions = options.compressions ?? this[$.res].options.compressions
        , cache = options.cache || this[$.res].options.cache
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
    , resolve

  r[$.working] = new Promise(r => resolve = r)
  try {
    handle = await fsp.open(file)
    const stat = await handle.stat()

    if (stat.size < o.minCompressSize)
      compressor = null

    if (r.headers.range || (stat.size >= o.minStreamSize && stat.size > o.maxCacheSize))
      return await stream(r, file, type, { handle, stat, compressor }, o)

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

    const headers = {
      ETag: createEtag(stat.mtime, stat.size, compressor),
      'Last-Modified': stat.mtime.toUTCString(),
      'Content-Encoding': compressor,
      'Content-Type': type
    }

    const response = [bytes, 200, headers]
    o.cache && stat.size < o.maxCacheSize && caches[compressor || 'identity'].set(file, response)
    r.end(...response)
  } finally {
    resolve()
    handle && handle.close()
  }
}

async function stream(r, file, type, { handle, stat, compressor }, options) {
  r[$.res].options.cert && (compressor = null)
  const { size, mtime } = stat
      , range = r.headers.range || ''
      , highWaterMark = options.highWaterMark || options.minStreamSize
      , end = parseInt(range.slice(range.indexOf('-') + 1)) || size - 1
      , start = parseInt(range.slice(6, range.indexOf('-')) || size - end - 1)
      , total = end - start + 1

  if (end >= size)
    return r.header(416, { 'Content-Range': 'bytes */' + (size - 1) }).end('Range Not Satisfiable')

  r.header(range ? 206 : 200, {
    'Accept-Ranges': range ? undefined : 'bytes',
    'Last-Modified': mtime.toUTCString(),
    'Content-Encoding': compressor,
    'Content-Range': range && 'bytes ' + start + '-' + end + '/' + size,
    'Content-Type': type,
    Connection: 'keep-alive', // really ? needed ?
    ETag: createEtag(mtime, size, compressor)
  })

  if (r.method === 'head') {
    compressor
      ? r.header('Transfer-Encoding', 'chunked')
      : r.header('Content-Length', size)
    return r.end()
  }

  compressor
    ? await streamCompressed(r, handle, compressor, highWaterMark, total, start)
    : await streamRaw(r, handle, highWaterMark, total, start)
}

async function streamRaw(r, handle, highWaterMark, total, start) {
  let lastOffset = 0
    , read = 0
    , buffer = Buffer.allocUnsafe(highWaterMark)
    , aborted

  r.onAborted(() => aborted && aborted())

  while (read < total) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(highWaterMark, total - read), start + read)
    read += bytesRead
    lastOffset = r.getWriteOffset()
    const [ok] = r.tryEnd(buffer.subarray(0, bytesRead), total)
    ok || await new Promise(resolve => {
      aborted = resolve
      r.onWritable(offset => {
        const [ok] = r.tryEnd(buffer.subarray(offset - lastOffset, bytesRead), total)
        ok && resolve()
        return ok
      })
    })
  }
}

async function streamCompressed(r, handle, compressor, highWaterMark, total, start) {
  let read = 0
    , ok = true
    , buffer = Buffer.allocUnsafe(highWaterMark)
    , compressStream = streamingCompressors[compressor]({ chunkSize: highWaterMark, finishFlush: zlib.constants.Z_SYNC_FLUSH })
    , resolve
    , reject
    , resume

  const promise = new Promise((r, e) => (resolve = r, reject = e))

  compressStream.on('data', x => ok = r.write(x))
  compressStream.on('drain', () => resume && resume())
  compressStream.on('close', resolve)
  compressStream.on('error', reject)

  while (read < total) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(highWaterMark, total - read), start + read)
    read += bytesRead
    compressStream.write(buffer.slice(0, bytesRead))
    ok || await new Promise(x => r.onWritable(() => (x(), true)))
    compressStream.writableNeedDrain && await new Promise(r => resume = r)
  }
  compressStream.end()
  await promise
  r.end()
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
