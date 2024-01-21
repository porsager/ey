import { symbols as $, hasOwn, state } from './shared.js'
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

const monkey = {
  close() { return this.open && this._close.apply(this, arguments) },
  cork() { return this.open && this._cork.apply(this, arguments) },
  end() { return this.open && this._end.apply(this, arguments) },
  getBufferedAmount() { return this.open && this._getBufferedAmount.apply(this, arguments) },
  getRemoteAddress() { return this.open && this._getRemoteAddress.apply(this, arguments) },
  getRemoteAddressAsText() { return this.open && this._getRemoteAddressAsText.apply(this, arguments) },
  getTopics() { return this.open && this._getTopics.apply(this, arguments) },
  getUserData() { return this.open && this._getUserData.apply(this, arguments) },
  isSubscribed() { return this.open && this._isSubscribed.apply(this, arguments) },
  ping() { return this.open && this._ping.apply(this, arguments) },
  publish() { return this.open && this._publish.apply(this, arguments) },
  send() { return this.open && this._send.apply(this, arguments) },
  subscribe() { return this.open && this._subscribe.apply(this, arguments) },
  unsubscribe() { return this.open && this._unsubscribe.apply(this, arguments) }
}

export default function ey({
  methods = ['head', 'get', 'put', 'post', 'delete', 'patch', 'options', 'trace', 'all'],
  ...o
} = {}) {
  let uws
    , handle

  const handlers = new Map()
      , connects = new Set()
      , wss = new Set()
      , asn = new Set()
      , msn = new Set()
      , rsn = new Set()

  hasOwn.call(o, 'compressions') || (o.compressions = o.cert ? ['br', 'gzip', 'deflate'] : ['gzip', 'deflate'])
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

  async function router(res, req, protocol) {
    const r = res instanceof Request ? res : new Request(res, req, protocol)
    const method = handlers.has(r.method) ? handlers.get(r.method) : handlers.get('all')

    for (const x of method) {
      if (r[$.state] >= 3)
        break

      if (hasOwn.call(r, $.error) !== x.error)
        continue

      const match = x.match(r)
      if (!match)
        continue

      try {
        r[$.req] && r[$.readHeaders](x.options)
        r.last = x.handler({ error: r[$.error], r, match })
        if (r.last && typeof r.last.then === 'function') {
          r.method.charCodeAt(0) === 112 && r[$.readBody](true)
          r.onAborted()
          r.last = await r.last
        }
        r[$.working] && (r.onAborted(), await r[$.working])
      } catch (error) {
        r[$.error] = error
      }
    }

    if (!handle || r[$.state] >= 3) // Ensure we only use default in handle router
      return

    hasOwn.call(r, $.error)
      ? r[$.error] instanceof URIError
        ? (r.end('Bad URI', 400), console.error(400, r.url, '->', r[$.error]))
        : (r.statusEnd(500), console.error(500, 'Uncaught route error', r[$.error]))
      : r.statusEnd(404)
  }

  function listen(defaultOptions) {
    return (port, address, options) => {
      return new Promise((resolve, reject) => {
        typeof address === 'object' && (options = address, address = null)
        const o = {
          ...defaultOptions,
          ...(options || {})
        }

        port = parseInt(port)
        uws = o.cert
          ? uWS.SSLApp({ cert_file_name: o.cert, key_file_name: o.key, ...o })
          : uWS.App(o)
        asn.forEach(xs => uws.addServerName(...xs))
        msn.forEach(xs => uws.missingServerName(...xs))
        rsn.forEach(xs => uws.removeServerName(...xs))
        connects.forEach((xs) => uws.connect(...xs))
        wss.forEach(([pattern, handlers]) =>
          uws.ws(
            pattern,
            {
              maxPayloadLength: 128 * 1024,
              ...handlers,
              ...(handlers.upgrade ? { upgrade: upgrader(o, pattern, handlers) } : {})
            }
          )
        )
        uws.any('/*', handler)

        address
          ? uws.listen(address, port, callback)
          : uws.listen(port, o, callback)

        function callback(x) {
          if (!x)
            return reject(new Error('Could not listen on', port))

          handle = x
          resolve({ port: uWS.us_socket_local_port(handle), handle, unlisten })
        }

        function unlisten() {
          handle && uWS.us_listen_socket_close(handle)
        }

        function handler(res, req) {
          res.options = o
          router(res, req, o.cert ? 'https' : 'http')
        }
      })
    }
  }

  function ws(pattern, handlers) {
    typeof pattern !== 'string' && (handlers = pattern, pattern = '/*')
    wss.add([
      pattern,
      {
        ...handlers,
        open: catcher('open', handlers, open),
        message: catcher('message', handlers, message),
        subscription: catcher('subscription', handlers),
        drain: catcher('drain', handlers),
        ping: catcher('ping', handlers),
        pong: catcher('pong', handlers),
        close: catcher('close', handlers, close)
      }
    ])
  }

  function close(fn, ws, code, data) {
    ws.open = false
    return fn(ws, code, new Message(data, true))
  }

  function open(fn, ws) {
    patch(ws)
    return fn(ws)
  }

  function message(fn, ws, data, binary) {
    return fn(ws, new Message(data, binary))
  }

  function catcher(name, handlers, fn = (fn, ...ws) => fn(...ws)) {
    if (!(name in handlers))
      return

    const method = handlers[name]
    return function(ws, ...xs) {
      try {
        fn(method, ws, ...xs)
      } catch (error) {
        name === 'close' || ws.end(1011, 'Internal Server Error')
        console.error(500, 'Uncaught ' + name + ' error', error)
      }
    }
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
       '^('
     + match.replace(/:.+?(\/|$)/g, '([^/]+?)$1').replace(/\*/, '.*?')
     + ')'
     + (sub ? '(/|$)' : '$')
  )

  return function(r) {
    const result = r.url.match(regex)
    result && names && names.forEach((n, i) => r.params[n] = decodeURIComponent(result[i + 2]))
    return result && result[1]
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

function upgrader(options, pattern, handlers) {
  handlers.headers && handlers.headers.push('sec-websocket-key', 'sec-websocket-protocol', 'sec-websocket-extensions')
  return async function(res, req, context) {
    res.options = options
    const r = new Request(res, req, options.cert ? 'https' : 'http')
    ;(pattern.match(/\/:([^/]+|$)/g) || []).map((x, i) => r.params[x.slice(2)] = res.getParameter(i))
    r[$.readHeaders](handlers)
    let error
      , data
    try {
      data = handlers.upgrade(r)
      data && typeof data.then === 'function' && (r.onAborted(), data = await data)
    } catch (err) {
      error = err
      console.error(500, 'Uncaught upgrade error', error)
    }

    if (r[$.state] === state.ENDED)
      return

    if (error)
      return r.statusEnd(500)

    r.status(101)
    r.cork(() =>
      res.upgrade(
        data || {},
        r.headers['sec-websocket-key'],
        r.headers['sec-websocket-protocol'],
        r.headers['sec-websocket-extensions'],
        context
      )
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

function patch(ws) {
  ws.open = true
  ws._close = ws.close
  ws._cork = ws.cork
  ws._end = ws.end
  ws._getBufferedAmount = ws.getBufferedAmount
  ws._getRemoteAddress = ws.getRemoteAddress
  ws._getRemoteAddressAsText = ws.getRemoteAddressAsText
  ws._getTopics = ws.getTopics
  ws._getUserData = ws.getUserData
  ws._isSubscribed = ws.isSubscribed
  ws._ping = ws.ping
  ws._publish = ws.publish
  ws._send = ws.send
  ws._subscribe = ws.subscribe
  ws._unsubscribe = ws.unsubscribe
  Object.assign(ws, monkey)
}
