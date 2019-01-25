const pathRegex = /[#?].*/
const methodNames = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS']

function Crouter() {
  const handlers = methodNames.reduce((acc, method) => {
    acc[method] = {
      matchers: [],
      handlers: []
    }
    return acc
  }, {})

  const crouter = function(req, res) {
    next(handlers[req.method], 0, req, res)
  }

  methodNames.concat('all', 'use').forEach(method => {
    const handler = handlers[method]

    crouter[method.toLowerCase()] = function Add(match, ...fns) {
      if (typeof match === 'function') {
        fns.unshift(match)
        match = true
      }

      fns.forEach(fn => {
        if (method === 'all' || method === 'use') {
          for (const key in handlers) {
            handlers[key].matchers.push(prepare(match, method === 'use'))
            handlers[key].length = handlers[key].handlers.push(fn)
          }
        } else {
          handler.matchers.push(prepare(match))
          handler.length = handler.handlers.push(fn)
        }
      })

      return crouter
    }
  })

  return crouter
}

module.exports = Crouter

function next(method, i, req, res) {
  if (i >= method.length)
    return

  method.matchers[i](req, res)
    ? method.handlers[i](req, res, () => next(method, i + 1, req, res))
    : next(method, i + 1, req, res)
}

function matcher(req, res, match, use) {
  const result = use
    ? req.url.replace(pathRegex, '').indexOf(match) === 0
    : req.url.replace(pathRegex, '') === match

  use && (req.url = req.url.slice(match.length))

  return result
}

function prepareString(match, use) {
  const named = match.match(/\/:([a-z0-9]+)?/g)

  if (!named)
    return (req, res) => matcher(req, res, match, use)

  const names = named.map(n => n.slice(2))
  const regex = new RegExp('^' + match.replace(/:.+?(\/|$)/g, '(.*?)/') + '?$')

  return function(req, res) {
    const result = req.url.replace(pathRegex, '').match(regex)
    if (result) {
      req.params = req.params || {}
      req.path = result[0]
      names.forEach((n, i) => req.params[n] = result[i + 1])
    }
    use && (req.url = req.url.slice(result[0].length))
    return result
  }
}

function prepareRegex(match) {
  return function(req, res) {
    const result = req.url.match(match)
    req.params = req.params || {}
    result && result.forEach((m, i) => req.params[i] = m)
    return result
  }
}

function prepareArray(match, use) {
  match = match.map(m => prepare(m, use))
  return function(req, res) {
    return match.some(fn => fn(req, res))
  }
}

function prepare(match, use) {
  if (typeof match === 'string')
    return prepareString(match, use)
  else if (match instanceof RegExp)
    return prepareRegex(match, use)
  else if (Array.isArray(match))
    return prepareArray(match, use)
  else if (match === true)
    return () => true

  throw new Error('Unknown match type')
}
