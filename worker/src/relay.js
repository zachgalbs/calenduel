// The Durable Object behind the wireless iPad (see ipad.js for the protocol).
// Kept apart from ipad.js because it imports the Workers runtime, which the
// Node tests can't load.
import { DurableObject } from 'cloudflare:workers'
import { MAX_FRAME, randomSecret, same, sha256 } from './ipad.js'

const OPEN = 1

// Uses the WebSocket Hibernation API: between sessions the sockets stay open
// while the object sleeps, so an idle paired iPad costs nothing.
export class IpadRelay extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
  }

  sockets(tag) {
    return this.state.getWebSockets(tag).filter(ws => ws.readyState === OPEN)
  }

  async fetch(request) {
    const path = new URL(request.url).pathname
    const storage = this.state.storage
    if (path === '/pair') {
      const secret = randomSecret()
      await storage.put({ secretHash: await sha256(secret), seenAt: null })
      this.dropIpads('paired again')
      return Response.json({ secret })
    }
    if (path === '/unpair') {
      await storage.delete(['secretHash', 'seenAt'])
      this.dropIpads('unpaired')
      return Response.json({ ok: true })
    }
    if (path === '/status') {
      const { secretHash, seenAt } = Object.fromEntries(await storage.get(['secretHash', 'seenAt']))
      return Response.json({
        paired: Boolean(secretHash), seen: Boolean(seenAt), connected: this.sockets('ipad').length > 0,
      })
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    if (path === '/ipad') {
      const stored = await storage.get('secretHash')
      if (!stored || !same(stored, await sha256(request.headers.get('X-Secret') ?? ''))) {
        return new Response('Not paired', { status: 401 })
      }
      await storage.put('seenAt', Date.now())
      this.dropIpads('replaced') // one iPad at a time: the newest connection wins
      const [client, server] = Object.values(new WebSocketPair())
      this.state.acceptWebSocket(server, ['ipad'])
      server.send(this.wanted() ? 'want' : 'idle')
      this.tellPages(true)
      return new Response(null, { status: 101, webSocket: client })
    }
    if (path === '/page') {
      const [client, server] = Object.values(new WebSocketPair())
      this.state.acceptWebSocket(server, ['page'])
      server.serializeAttachment({ want: false })
      server.send(JSON.stringify({ type: 'ipad', connected: this.sockets('ipad').length > 0 }))
      return new Response(null, {
        status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'calenduel' },
      })
    }
    return new Response('Not found', { status: 404 })
  }

  webSocketMessage(ws, message) {
    const [tag] = this.state.getTags(ws)
    if (tag === 'ipad') {
      if (typeof message === 'string' || message.byteLength > MAX_FRAME) return
      for (const page of this.sockets('page')) {
        if (page.deserializeAttachment()?.want) page.send(message)
      }
    } else if (tag === 'page' && (message === 'want' || message === 'idle')) {
      ws.serializeAttachment({ want: message === 'want' })
      this.syncWant()
    }
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'closed') } catch { /* already closed */ }
    this.gone(ws)
  }

  webSocketError(ws) {
    this.gone(ws)
  }

  gone(ws) {
    const [tag] = this.state.getTags(ws)
    if (tag === 'ipad') {
      if (!this.sockets('ipad').some(other => other !== ws)) this.tellPages(false)
    } else {
      this.syncWant()
    }
  }

  wanted() {
    return this.sockets('page').some(page => page.deserializeAttachment()?.want)
  }

  syncWant() {
    const message = this.wanted() ? 'want' : 'idle'
    for (const ipad of this.sockets('ipad')) ipad.send(message)
  }

  tellPages(connected) {
    const message = JSON.stringify({ type: 'ipad', connected })
    for (const page of this.sockets('page')) page.send(message)
  }

  dropIpads(reason) {
    const had = this.sockets('ipad')
    for (const ipad of had) {
      try { ipad.close(4001, reason) } catch { /* already closed */ }
    }
    if (had.length) this.tellPages(false)
  }
}

