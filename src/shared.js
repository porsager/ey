export const hasOwn = {}.hasOwnProperty

export function isPromise(x) {
  return x && typeof x.then === 'function'
}

export const symbols = {
  ip: Symbol('ip'),
  ws : Symbol('ws'),
  req: Symbol('req'),
  res: Symbol('res'),
  body: Symbol('body'),
  data: Symbol('data'),
  head: Symbol('head'),
  ended: Symbol('ended'),
  error: Symbol('error'),
  query: Symbol('query'),
  corked: Symbol('corked'),
  length: Symbol('length'),
  onData: Symbol('onData'),
  status: Symbol('status'),
  aborted: Symbol('aborted'),
  headers: Symbol('headers'),
  reading: Symbol('reading'),
  readable: Symbol('readable'),
  writable: Symbol('writable'),
  handling: Symbol('handling')
}
