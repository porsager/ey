import { symbols as $ } from './shared.js'

export class Message {
  constructor(data, binary) {
    this.data = data
    this.binary = binary
  }
  get buffer() { return Buffer.from(this.data) }
  get json() { return tryJSON(this.data) }
  get text() { return Buffer.from(this.data).toString() }
}

export class Websocket {
  constructor(ws) {
    this[$.ws] = ws
    this.open = true
    ws.data && Object.assign(this, ws.data)
  }
  close() { return this.open && this[$.ws].close.apply(this[$.ws], arguments) }
  cork() { return this.open && this[$.ws].cork.apply(this[$.ws], arguments) }
  end() { return this.open && this[$.ws].end.apply(this[$.ws], arguments) }
  getBufferedAmount() { return this.open && this[$.ws].getBufferedAmount.apply(this[$.ws], arguments) }
  getRemoteAddress() { return this.open && this[$.ws].getRemoteAddress.apply(this[$.ws], arguments) }
  getRemoteAddressAsText() { return this.open && this[$.ws].getRemoteAddressAsText.apply(this[$.ws], arguments) }
  getTopics() { return this.open && this[$.ws].getTopics.apply(this[$.ws], arguments) }
  getUserData() { return this.open && this[$.ws].getUserData.apply(this[$.ws], arguments) }
  isSubscribed() { return this.open && this[$.ws].isSubscribed.apply(this[$.ws], arguments) }
  ping() { return this.open && this[$.ws].ping.apply(this[$.ws], arguments) }
  publish() { return this.open && this[$.ws].publish.apply(this[$.ws], arguments) }
  send() { return this.open && this[$.ws].send.apply(this[$.ws], arguments) }
  subscribe() { return this.open && this[$.ws].subscribe.apply(this[$.ws], arguments) }
  unsubscribe() { return this.open && this[$.ws].unsubscribe.apply(this[$.ws], arguments) }
}

function tryJSON(data) {
  try {
    return JSON.parse(Buffer.from(data))
  } catch (x) {
    return undefined
  }
}
