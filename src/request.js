import uWS from 'uWebSockets.js'

import fsp                      from 'node:fs/promises'
import zlib                     from 'node:zlib'
import { promisify }            from 'node:util'
import path                     from 'node:path'
import { STATUS_CODES }         from 'node:http'
import { Readable, Writable }   from 'node:stream'
import { pipeline }             from 'node:stream/promises'

import mimes, { compressable }  from './mimes.js'
import { symbols as $, copy, isPromise }  from './shared.js'

const stateSymbol = Object.getOwnPropertySymbols(new Response()).find(sym => sym.toString() === 'Symbol(state)')
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
  constructor(res, req, options) {
    this.options = options
    this.method = req.getMethod()
    try {
      this.url = decodeURIComponent(req.getUrl())
    } catch (error) {
      this.url = req.getUrl()
      this[$.error] = error
    }
    this.pathname = this.url
    this.last = null
    this.ended = false
    this.paused = false
    this.handled = false
    this.aborted = false
    this.sentStatus = false
    this.sentHeaders = false
    this.rawQuery = req.getQuery() || ''
    this[$.ip] = null
    this[$.res] = res
    this[$.req] = req
    this[$.body] = null
    this[$.data] = null
    this[$.head] = null
    this[$.ended] = null
    this[$.query] = null
    this[$.length] = null
    this[$.status] = null
    this[$.corked] = false
    this[$.onData] = null
    this[$.handled] = null
    this[$.aborted] = null
    this[$.headers] = null
    this[$.reading] = null
    this[$.readable] = null
    this[$.writable] = null
  }

  async onData(fn) {
    this[$.onData] = fn
    if (this[$.data] !== null) {
      this[$.data].forEach(({ buffer, last }) => fn(buffer, last))
      this[$.data] = null
    }
    return read(this)
  }

  async body(type) {
    if (this[$.body] !== null)
      return this[$.body]

    const length = parseInt(header(this, 'content-length'))
        , contentType = header(this, 'content-type')
        , known = Number.isNaN(length) === false

    let full = known
      ? Buffer.allocUnsafe(parseInt(length))
      : []

    let offset = 0
    return this[$.body] = this.onData(buffer => {
      known
        ? Buffer.from(buffer).copy(full, offset)
        : full.push(buffer)
      offset += buffer.byteLength
    }).then(() => {
      known || (full = Buffer.concat(full))
      if (known && offset !== full.byteLength)
        throw new Error('Expected data of length', full.byteLength, 'but only got', offset)

      return this[$.body] = type === 'json'
        ? JSON.parse(full)
        : type === 'text'
        ? full.toString()
        : type === 'multipart'
        ? uWS.getParts(full, contentType)
        : full
    })
  }

  onAborted(fn) {
    fn && (this[$.aborted] ? this[$.aborted].push(fn) : this[$.aborted] = [fn])
    if (!this[$.req])
      return

    this.method.charCodeAt(0) === 112 && read(this) // (p) cache reading on post, put, patch
    this.ip // ensure IP is read on first tick
    this.headers // ensure headers are read on first tick
    this[$.req] = null
    return this[$.res].onAborted(() => aborted(this))
  }

  get headers() {
    if (this[$.head] !== null)
      return this[$.head]

    this.options.headers != null
      ? (this.options.headers && (this[$.head] = {}), this.options.headers.forEach(k => this[$.head][k] = this[$.req].getHeader(k)))
      : (this[$.head] = {}, this[$.req].forEach((k, v) => this[$.head][k] = v))

    return this[$.head]
  }

  get secure() {
    return this.protocol === 'https'
  }

  get protocol() {
    return this.options.cert
      ? 'https'
      : header(this, 'x-forwarded-proto')
  }

  get query() {
    return this[$.query]
      ? this[$.query]
      : this[$.query] = new URLSearchParams(this.rawQuery)
  }

  get ip() {
    if (this[$.ip] !== null)
      return this[$.ip]

    const proxyIP = header(this, 'x-forwarded-for')
        , remoteIP = Buffer.from(this[$.res].getRemoteAddress())

    return this[$.ip] = (proxyIP
      ? proxyIP.replace(/::ffff:/g, '').split(',')[0].trim()
      : Buffer.compare(ipv4, remoteIP.subarray(0, 12)) === 0
        ? [...remoteIP.subarray(12)].join('.')
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
        await r.onData(buffer => stream.push(Buffer.from(buffer)) || r.pause())
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

    r.onAborted(() => writable.destroy())

    return writable
  }

  resume() {
    if (!this.paused || this.ended)
      return
    this.paused = false
    this[$.res].resume()
  }

  pause() {
    if (this.paused || this.ended)
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
          Path: '/',
          ...options
        }).map(([k, v]) => k + (v === true ? '' : '=' + v)).join('; ')
    )
  }

  onEnded(fn) {
    this[$.ended] === null
      ? this[$.ended] = [fn]
      : this[$.ended].push(fn)
  }

  onHandled(fn) {
    this[$.handled] === null
      ? this[$.handled] = [fn]
      : this[$.handled].push(fn)
  }

  close() {
    this[$.res].close()
    ended(this)
    return this
  }

  end(x, status, headers) {
    x instanceof Response
      ? (
        this.status(x.status),
        x.headers.forEach((v, h) => this.header(h, v))
      )
      : (
        typeof status === 'object' && (headers = status, status = null),
        status && this.status(status),
        headers && this.header(headers)
      )

    return this.cork(async() => {
      handled(this)
      if (this.method === 'head') {
        x instanceof Response
          ? x[stateSymbol].body.length !== undefined && !x.headers.has('content-length') && this[$.res].writeHeader('Content-Length', '' + x[stateSymbol].body.length)
          : x && this[$.length] === null && this[$.res].writeHeader('Content-Length', '' + Buffer.byteLength(x))
        this[$.res].endWithoutBody()
      } else if (x instanceof Response) {
        const length = this[$.length] === null ? x[stateSymbol].body.length !== undefined && x[stateSymbol].body.length : this[$.length]
        length === 0
          ? this[$.res].end()
          : length
          ? await streamEnd(this, Readable.fromWeb(x.body), length)
          : await pipeline(Readable.fromWeb(x.body), this.writable)
      } else if (x instanceof Readable) {
        this[$.length] === 0
          ? this[$.res].end()
          : this[$.length]
          ? await streamEnd(this, x, this[$.length])
          : await pipeline(x, this.writable)
      } else {
        this[$.res].end(x)
      }
      ended(this)
    })
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
      : (h.toLowerCase() === 'content-length' && (this[$.length] = v), (v || v === 0) && (this[$.headers]
        ? this[$.headers].push(['' + h, '' + v])
        : this[$.headers] = [['' + h, '' + v]]
      ))
    return this
  }

  set(...xs) {
    return this.header(...xs)
  }

  cork(fn) {
    if (this.ended)
      return

    if (this[$.corked])
      return fn()

    let result
    this[$.res].cork(() => {
      if (!this.sentHeaders) {
        if (!this.sentStatus) {
          this.sentStatus = true
          const status = this[$.status]
          status && this[$.res].writeStatus(typeof status === 'number'
            ? status + (status in STATUS_CODES ? ' ' + STATUS_CODES[status] : '')
            : status
          )
        }
        this.sentHeaders = true
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
    return this.ended
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
    if (this.ended)
      return [true, true]

    try {
      return this.cork(() => {
        if (this.method === 'head') {
          ended(this)
          this[$.res].endWithoutBody(total)
          return [true, true]
        }

        const xs = this[$.res].tryEnd(x, total)
        xs[1] && ended(this)
        return xs
      })
    } catch (err) {
      ended(this)
      return [true, true]
    }
  }

  write(x) {
    if (this.ended)
      return true

    handled(this)
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
    const compressions = options.compressions || this.options.compressions
        , cache = options.cache || this.options.cache
        , ext = path.extname(file).slice(1)
        , type = mimes.get(ext)

    const compressor = compressions && compressions.length
      ? getEncoding(this.headers['accept-encoding'], compressions, type)
      : null

    return cache && caches[compressor || 'identity'].has(file)
      ? this.end(...caches[compressor || 'identity'].get(file))
      : readFile(this, file, type, compressor, options)
  }
}

async function readFile(r, file, type, compressor, o) {
  r.onAborted()
  let handle

    handle = await fsp.open(file)
    const stat = await handle.stat()

    if (stat.size < o.minCompressSize)
      compressor = null

    if (r.headers.range || (stat.size >= o.minStreamSize && stat.size > o.maxCacheSize))
      return stream(r, type, { handle, stat, compressor }, o).finally(() => handle.close())

    let bytes = await handle.readFile()

    handle.close()

    if (o.transform) {
      bytes = o.transform(bytes, file, type, r)
      if (isPromise(bytes))
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
}

function stream(r, type, { handle, stat, compressor }, options) {
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

  return compressor
    ? streamCompressed(r, handle, compressor, highWaterMark, total, start)
    : streamRaw(r, handle, highWaterMark, total, start)
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

async function streamEnd(r, stream, total) {
  let lastOffset = 0
    , resolve
    , reject
    , promise = new Promise((r, e) => (resolve = r, reject = e))

  stream.on('readable', read)
  stream.on('error', reject)

  read()

  return promise

  function read() {
    let buffer
    while ((buffer = stream.read()) !== null) {
      lastOffset = r.getWriteOffset()
      const [ok, last] = r.tryEnd(buffer, total)
      if (last)
        return resolve()

      if (!ok) {
        stream.pause()
        r.onWritable(offset => {
          const [ok, last] = r.tryEnd(buffer.subarray(offset - lastOffset), total)
          last
            ? resolve()
            : ok && stream.resume()
          return ok
        })
      }
    }
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

function aborted(r) {
  r.aborted = true
  r[$.aborted] === null || r[$.aborted].forEach(x => x())
  ended(r)
}

function handled(r) {
  if (r.handled)
    return

  r.handled = true
  r[$.handled] === null || r[$.handled].forEach(x => x())
}

function ended(r) {
  r.ended = r.handled = true
  r[$.ended] === null || r[$.ended].forEach(x => x())
}

function header(r, header) {
  return r[$.req] && r[$.req].getHeader(header) || r.headers[header] || ''
}

function read(r) {
  if (r[$.reading] !== null)
    return r[$.reading]

  return r.handled || (r[$.reading] = new Promise((resolve, reject) =>
    r[$.res].onData((x, last) => {
      try {
        r[$.onData]
          ? r[$.onData](x, last)
          : (r[$.data] === null && (r[$.data] = []), r[$.data].push({ buffer: copy(x), last })) // must copy - uws clears memory in next tick
        last && resolve()
      } catch (error) {
        reject(error)
      }
    })
  ))
}
