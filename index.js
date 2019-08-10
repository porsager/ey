const pathRegex = /[#?].*/
const methodNames = ['HEAD', 'GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS']

function Ey() {
  const methods = methodNames.concat('all').reduce((acc, method) => {
    acc[method] = {
      matchers: [],
      handlers: []
    }
    return acc
  }, {})

  const router = function(req, res, n) {
    req.pathname = req.url.replace(pathRegex, '')
    tryRoute(req.method in methods ? methods[req.method] : methods.all, 0, req, res, n)
  }

  methodNames.concat('all', 'use').forEach(methodName => {
    const method = methods[methodName]

    router[methodName.toLowerCase()] = function(match, ...fns) {
      if (typeof match === 'function') {
        fns.unshift(match)
        match = true
      }

      fns.forEach(fn => {
        if (typeof fn !== 'function')
          throw new Error(fn + ' is not a function')

        const matcher = prepare(match, methodName === 'use')
        if (methodName === 'all' || methodName === 'use') {
          for (const key in methods) {
            methods[key].matchers.push(matcher)
            methods[key].length = methods[key].handlers.push(fn)
          }
        } else {
          method.matchers.push(matcher)
          method.length = method.handlers.push(fn)
          if (methodName === 'GET') {
            methods.HEAD.matchers.push(matcher)
            methods.HEAD.length = methods.HEAD.handlers.push(fn)
          }
        }
      })

      return router
    }
  })

  return router
}

module.exports = Ey

function tryRoute(method, i, req, res, next) { // eslint-disable-line
  if (!method.length || i >= method.length)
    return next && next()

  const matcher = method.matchers[i]
      , match = matcher(req, res)

  if (!match)
    return tryRoute(method, i + 1, req, res, next)

  if (matcher.use) {
    req.originalUrl = req.originalUrl || req.url
    req._url = req._url || []
    req._url.push(req.url)
    req.url = req.url.slice(match.length)
  }

  method.handlers[i](req, res, () => {
    matcher.use && (req.url = req._url.pop() || req.url)
    tryRoute(method, i + 1, req, res, next)
  })
}

function prepareString(match, use) {
  const named = match.match(/\/:([a-z0-9_]+)?/g)

  if (!named) {
    return use
      ? (req, res) => req.url.indexOf(match) === 0 && match
      : (req, res) => (req.url === match || req.pathname === match) && match
  }

  const names = named.map(n => n.slice(2))
  const regex = new RegExp('^' + match.replace(/:.+?(\/|$)/g, '([^/]+?)/') + '?$')
  return function(req, res) {
    const result = req.pathname.match(regex)
    if (result) {
      req.params = req.params || {}
      req.path = result[0]
      names.forEach((n, i) => req.params[n] = decodeURIComponent(result[i + 1]))
    }
    return result && result[0]
  }
}

function prepareRegex(match) {
  return function(req, res) {
    const result = req.pathname.match(match)
    req.params = req.params || {}
    result && result.forEach((m, i) => req.params[i] = m)
    return result && result[0]
  }
}

function prepareArray(match, use) {
  match = match.map(m => prepare(m, use))
  return function(req, res) {
    return match.some(fn => fn(req, res))
  }
}

function prepare(match, use) {
  const fn = typeof match === 'string'
    ? prepareString(match, use)
    : match instanceof RegExp
      ? prepareRegex(match, use)
      : Array.isArray(match)
        ? prepareArray(match, use)
        : match === true && (() => true)

  if (!fn)
    throw new Error('Unknown match type')

  fn.use = use
  return fn
}
