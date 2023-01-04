import { STATUS_CODES } from 'node:http'

import { symbols as $, hasOwn } from './shared.js'
import Request from './request.js'
import files from './files.js'
import mimes from './mimes.js'

import uWS from 'uWebSockets.js'


export default function ey({
  methods = ['head', 'get', 'put', 'post', 'delete', 'patch', 'options', 'trace', 'all'],
  ...o
} = {}) {
  let uws
    , listener

  const handlers = new Map()
      , connects = new Set()
      , wss = new Set()
      , asn = new Set()
      , msn = new Set()
      , rsn = new Set()

  hasOwn.call(o, 'compressions') || (o.compressions = o.secure ? ['br', 'gzip', 'deflate'] : ['gzip', 'deflate'])
  methods.forEach(register)

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
  router.unlisten = () => listener && uWS.us_listen_socket_close(listener)

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

      try {
        let result = x.handler({ error: r[$.error], r, match })
        r[$.req] && r[$.read](x.options)
        if (result && typeof result.then === 'function') {
          r.onAborted()
          r.last = await result
        }
      } catch (error) {
        r[$.error] = error
      }

      if (r.handled)
        break
    }

    return listener && !r.handled && ( // Ensure we only use default in listening router
      hasOwn.call(r, $.error)
        ? (r.end(STATUS_CODES[500], 500), console.error('Uncaught route error', r[$.error]))
        : r.end(STATUS_CODES[404], 404)
    )
  }

  function listen({ cert, key }) {
    return (port, options) => {
      return new Promise((resolve, reject) => {
        let address

        port = parseInt(port)
        typeof options === 'string' && (address = options, options = null)

        router.unlisten()
        uws = cert ? uWS.SSLApp({}) : uWS.App()
        asn.forEach(xs => uws.addServerName(...xs))
        msn.forEach(xs => uws.missingServerName(...xs))
        rsn.forEach(xs => uws.removeServerName(...xs))
        connects.forEach((xs) => uws.connect(...xs))
        wss.forEach(xs => uws.ws(...xs))
        uws.any('/*', router)

        address
          ? uws.listen(port, address, callback)
          : options
          ? uws.listen(port, options, callback)
          : uws.listen(port, callback)

        function callback(handle) {
          if (!handle)
            return reject(new Error('Could not listen on', port))

          listener = handle
          resolve({ port: uWS.us_socket_local_port(handle), handle })
        }
      })
    }
  }

  function ws(pattern, options, fn) {
    typeof pattern !== 'string' && (fn = options, options = pattern, pattern = '/*')
    typeof options === 'function' && (fn = options, options = {})

    wss.add([
      pattern,
      {
        open: ws => {
          ws[Symbol.asyncIterator] = () => ({
            next: () => new Promise(r => ws[$.resolve] = r)
          })
          fn(ws)
        },
        close: ws => hasOwn.call(ws, $.resolve) && ws[$.resolve]({ done: true }),
        message: (ws, data, binary) => ws[$.resolve]({
          value: {
            data,
            binary,
            get buffer() { return Buffer.from(data) },
            get json() { return tryJSON(data) },
            get text() { return Buffer.from(data).toString() }
          }
        }),
        ...options,
        ...(options.upgrade ? { upgrade: upgrader(pattern, options) } : {})
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
    r[$.read](options)
    let x = options.upgrade(r)
    x && typeof x.then === 'function' && (res.onAborted(), x = await x)
    if (x.aborted || x.handled)
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
