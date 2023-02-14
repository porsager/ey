import { STATUS_CODES } from 'node:http'

import { symbols as $, hasOwn } from './shared.js'
import Request from './request.js'
import files from './files.js'
import mimes from './mimes.js'

import uWS from 'uWebSockets.js'

class Message {
  constructor(data, binary) {
    this.data = data
    this.binary = binary
  }
  get buffer() { return Buffer.from(this.data) }
  get json() { return tryJSON(this.data) }
  get text() { return Buffer.from(this.data).toString() }
}

export default function ey({
  methods = ['head', 'get', 'put', 'post', 'delete', 'patch', 'options', 'trace', 'all'],
  ...o
} = {}) {
  let uws
    , listening

  const handlers = new Map()
      , connects = new Set()
      , wss = new Set()
      , asn = new Set()
      , msn = new Set()
      , rsn = new Set()

  hasOwn.call(o, 'compressions') || (o.compressions = o.secure ? ['br', 'gzip', 'deflate'] : ['gzip', 'deflate'])
  methods.forEach(register)

  router.secure = !!o.cert
  router.route = route
  router.mimes = mimes
  router.files = files(ey)
  router.handlers = handlers
  router.ws = ws
  router.connect = (...xs) => connects.add(xs)
  router.listen = listen(o)
  router.publish = (...xs) => uws ? uws.publish(...xs) : false
  router.subscribers = (...xs) => uws ? uws.numSubscribers(...xs) : 0
  router.addServerName = (...xs) => (uws ? uws.addServerName(...xs) : asn.add(xs), router)
  router.missingServerName = (...xs) => (uws ? uws.missingServerName(...xs) : msn.add(xs), router)
  router.removeServerName = (...xs) => (uws ? uws.removeServerName(...xs) : rsn.add(xs), router)
  router.close = () => uws && uws.close()

  return router

  function route(...xs) {
    const x = xs.pop()
    if (typeof x !== 'function')
      return ey(x)

    const app = ey()
    x(app)
    router.all(...xs, app)
    return router
  }

  async function router(res, req) {
    const r = res instanceof Request ? res : new Request(res, req, o)
    const method = handlers.has(r.method) ? handlers.get(r.method) : handlers.get('all')

    for (const x of method) {
      if (hasOwn.call(r, $.error) !== x.error)
        continue

      const match = x.match(r)
      if (!match)
        continue

      await tryHandler(x, r, match)

      if (r.handled)
        break
    }

    if (!listening || r.handled) // Ensure we only use default in listening router
      return

    hasOwn.call(r, $.error)
      ? r[$.error] instanceof URIError
        ? (r.end('Bad URI', 400), console.error(400, r.url, '->', r[$.error]))
        : (r.end(STATUS_CODES[500], 500), console.error(500, 'Uncaught route error', r[$.error]))
      : r.end(STATUS_CODES[404], 404)
  }

  async function tryHandler(x, r, match) {
    try {
      r[$.req] && r[$.readHeaders](x.options)
      let result = x.handler({ error: r[$.error], r, match })
      if (result && typeof result.then === 'function') {
        r.method.charCodeAt(0) === 112 && r[$.readBody](true)
        r.onAborted()
        r.last = await result
      }
      r[$.reading] && await r[$.reading]
    } catch (error) {
      r[$.error] = error
    }
  }

  function listen(defaultOptions) {
    return (port, address, options) => {
      return new Promise((resolve, reject) => {
        let address
          , listener

        typeof address === 'object' && (options = address, address = null)
        const o = {
          ...defaultOptions,
          ...(options || {})
        }

        port = parseInt(port)
        router.secure = !!o.cert
        uws = o.cert
          ? uWS.SSLApp({ cert_file_name: o.cert, key_file_name: o.key, o })
          : uWS.App()
        asn.forEach(xs => uws.addServerName(...xs))
        msn.forEach(xs => uws.missingServerName(...xs))
        rsn.forEach(xs => uws.removeServerName(...xs))
        connects.forEach((xs) => uws.connect(...xs))
        wss.forEach(xs => uws.ws(...xs))
        uws.any('/*', router)

        address
          ? uws.listen(address, port, callback)
          : uws.listen(port, o, callback)

        function callback(handle) {
          if (!handle)
            return reject(new Error('Could not listen on', port))

          listening = true
          resolve({ port: uWS.us_socket_local_port(handle), handle, unlisten })
        }

        function unlisten() {
          listener && uWS.us_listen_socket_close(listener)
        }
      })
    }
  }

  function ws(pattern, options) {
    typeof pattern !== 'string' && (options = pattern, pattern = '/*')
    wss.add([
      pattern,
      {
        ...options,
        ...(options.upgrade ? { upgrade: upgrader(pattern, options) } : {}),
        message: (ws, data, binary) => options.message(ws, new Message(data, binary))
      }
    ])
  }

  function register(name) {
    handlers.set(name, new Set())
    router[name] = function(match, options, ...fns) {
      if (typeof options === 'function') {
        fns.unshift(options)
        options = undefined
      }

      if (typeof match === 'function') {
        fns.unshift(match)
        match = true
      }

      if (typeof match === 'object' && match instanceof RegExp === false) {
        options = match
        match = true
      }

      options = {
        ...o,
        ...options,
        headers: o.headers
          ? o.headers.concat(options.headers || [])
          : options && options.headers
      }

      fns.forEach(fn => {
        if (typeof fn !== 'function')
          throw new Error(fn + ' is not a function')

        const isRouter = hasOwn.call(fn, 'handlers')
        const route = {
          options,
          handler: handler(fn),
          error: !isRouter && fn.length === 2,
          match: prepare(match, isRouter)
        }

        if (name === 'all') {
          for (const key of handlers.keys())
            handlers.get(key).add(route)
        } else {
          handlers.get(name).add(route)
          name === 'get' && handlers.get('head').add(route)
        }
      })

      return router
    }
  }
}

function handler(fn) {
  return hasOwn.call(fn, 'handlers')
    ? sub
    : direct

  function sub(x) {
    const url = x.r.url
    x.r.url = x.r.url.slice(x.match.length)
    const result = direct(x)
    result && typeof result.then === 'function'
      ? result.finally(() => x.r.url = url)
      : x.r.url = url
    return result
  }

  function direct({ error, r, match }) {
    return error
      ? fn(error, r)
      : fn(r)
  }
}

function prepare(match, sub) {
  const fn = typeof match === 'string'
    ? prepareString(match, sub)
    : match instanceof RegExp
      ? prepareRegex(match, sub)
      : Array.isArray(match)
        ? prepareArray(match, sub)
        : match === true && (() => true)

  if (!fn)
    throw new Error('Unknown match type')

  return fn
}

function prepareString(match, sub) {
  const named = match.match(/\/:([a-z][a-z0-9_]*)?/g)
      , wildcard = match.indexOf('*') !== -1
  if (!named && !wildcard) {
    return sub
      ? (r) => r.url.indexOf(match) === 0 && match
      : (r) => (r.url === match || r.url + '/' === match) && match
  }

  const names = named && named.map(n => n.slice(2))
  const regex = new RegExp(
       '^'
     + match.replace(/:.+?(\/|$)/g, '([^/]+?)$1').replace(/\*/, '.*?')
     + '$'
  )

  return function(r) {
    const result = r.url.match(regex)
    result && names && names.forEach((n, i) => r.params[n] = decodeURIComponent(result[i + 1]))
    return result && result[0]
  }
}

function prepareRegex(match) {
  return function(r) {
    const result = r.url.match(match)
    result && result.forEach((m, i) => r.params[i] = m)
    return result && result[0]
  }
}

function prepareArray(match, sub) {
  match = match.map(m => prepare(m, sub))
  return function(r) {
    return match.some(fn => fn(r))
  }
}

function upgrader(pattern, options) {
  options.headers && options.headers.push('sec-websocket-key', 'sec-websocket-protocol', 'sec-websocket-extensions')
  return async function(res, req, context) {
    const r = new Request(res, req, options)
    ;(pattern.match(/\/:([^/]+|$)/g) || []).map((x, i) => r.params[x.slice(2)] = res.getParameter(i))
    r[$.readHeaders](options)
    let x = options.upgrade(r)
    x && typeof x.then === 'function' && (res.onAborted(), x = await x)
    if (r.aborted || r.handled)
      return

    r[$.headers] && r.head(101)
    res.upgrade(
      x || {},
      r.headers['sec-websocket-key'],
      r.headers['sec-websocket-protocol'],
      r.headers['sec-websocket-extensions'],
      context
    )
  }
}

function tryJSON(data) {
  try {
    return JSON.parse(Buffer.from(data))
  } catch (x) {
    return undefined
  }
}
