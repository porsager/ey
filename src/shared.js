export const hasOwn = {}.hasOwnProperty

export const state = {
  OPEN: 1,
  RECEIVING: 2,
  SENT_STATUS: 3,
  SENT_HEADERS: 4,
  ENDED: 5
}

export const symbols = {
  ip: Symbol('ip'),
  req: Symbol('req'),
  res: Symbol('res'),
  body: Symbol('body'),
  data: Symbol('data'),
  abort: Symbol('abort'),
  error: Symbol('error'),
  query: Symbol('query'),
  state: Symbol('state'),
  onData: Symbol('onData'),
  status: Symbol('status'),
  headers: Symbol('headers'),
  options: Symbol('options'),
  reading: Symbol('reading'),
  working: Symbol('working'),
  readable: Symbol('readable'),
  writable: Symbol('writable'),
  readBody: Symbol('readBody'),
  headersRead: Symbol('headers'),
  readHeaders: Symbol('readHeaders')
}
