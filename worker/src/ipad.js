// Wireless iPad. The Calenduel Link iPad app sends its screen here, and the
// signed-in calenduel.com page running a session receives it. No Mac app.
//
// One Durable Object per user (named by the auth subject) holds the iPad's
// WebSocket and the page's WebSockets and passes frames between them. Nothing
// is stored but a hash of the iPad's pairing secret: frames are relayed and
// forgotten.
//
// Pairing: the page asks for a device token (`<subject>.<secret>`) and shows it
// as a QR code. The iPad app keeps it and presents it when connecting. Pairing
// again or unpairing replaces the secret, which cuts the old iPad off.
//
// Messages: iPad → page: binary JPEG frames. Page → relay: "want" / "idle" (a
// session is or isn't asking for the iPad). Relay → iPad: "want" / "idle", the
// combined answer, so the iPad only encodes while some page wants frames.
// Relay → page: JSON {"type":"ipad","connected":bool}.

export const MAX_FRAME = 1_000_000 // bytes; the app sends ~100 KB JPEGs

export function parseDeviceToken(token) {
  if (typeof token !== 'string' || token.length > 300) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const subject = token.slice(0, dot)
  const secret = token.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null
  return { subject, secret }
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Constant-time compare of two hex digests.
export function same(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Routes /ipad/* from the Worker. `authenticate(token)` resolves the signed-in
// subject or null; `limit(key)` applies the per-user rate limit.
export async function handleIpad(request, env, { path, origin, allowed, headers, authenticate, limit }) {
  const reply = (body, status = 200) => Response.json(body, { status, headers })
  const relayFor = subject => env.IPAD_RELAY.get(env.IPAD_RELAY.idFromName(subject))

  // The iPad app: a native client, so no Origin. Its device token is the key.
  if (path === '/ipad/connect') {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    const device = parseDeviceToken(request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1])
    if (!device) return new Response('Not paired', { status: 401 })
    return relayFor(device.subject).fetch('https://relay/ipad', {
      headers: { Upgrade: 'websocket', 'X-Secret': device.secret },
    })
  }

  // Everything else comes from the calenduel.com page.
  if (!allowed) return reply({ error: 'Origin not allowed' }, 403)
  if (path === '/ipad/watch') {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    // Browsers can't set headers on a WebSocket, so the token rides in the
    // subprotocol list: ["calenduel", <token>].
    const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(s => s.trim())
    const subject = offered[0] === 'calenduel' ? await authenticate(offered[1]) : null
    if (!subject) return new Response('Sign in again', { status: 401 })
    return relayFor(subject).fetch('https://relay/page', { headers: { Upgrade: 'websocket' } })
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  const action = { '/ipad/pair': 'pair', '/ipad/unpair': 'unpair', '/ipad/status': 'status' }[path]
  if (request.method !== 'POST' || !action) return reply({ error: 'Not found' }, 404)
  const subject = await authenticate(request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1])
  if (!subject) return reply({ error: 'Sign in again to connect an iPad.' }, 401)
  if (!(await limit(`ipad:${subject}`))) return reply({ error: 'Too many requests. Try again in a minute.' }, 429)
  const result = await (await relayFor(subject).fetch(`https://relay/${action}`, { method: 'POST' })).json()
  if (action === 'pair') return reply({ token: `${subject}.${result.secret}` })
  return reply(result)
}
