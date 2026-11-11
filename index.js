/**
 * @hmydk/dsh-notify — Host half.
 *
 * Watches the Host's agent lifecycle and approval waterfall, then streams
 * notification events to the browser half over a loopback-only SSE route on
 * the shared web server. The browser half owns the native Notification and
 * the focus condition; this half owns event detection, text sources, and the
 * small diagnostic endpoints used to verify an installation.
 *
 * Routes (all loopback-only):
 *   GET  /notify/events   SSE: one `config` event on connect, then `notify` events
 *   GET  /notify/status   JSON: connected browser halves, last acknowledgement, config
 *   GET|POST /notify/test JSON: push one forced test notification to every tab
 *   POST /notify/ack      JSON: browser half reports what it did with one event
 *
 * @module @hmydk/dsh-notify
 */

import z from '@deepseek-ai/schemastery'

/** Hard requirement: the shared web server carries the browser-half wire. */
export const inject = ['webServer']

/**
 * Plugin configuration. Every field is volatile: Settings commits a change
 * into the live reference instead of remounting the row, and this half
 * resolves the references at call time.
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('Master switch for desktop notifications.')
    .volatile(),
  condition: z
    .union(['unfocused', 'always'])
    .default('unfocused')
    .description('Show notifications only while the Harness window is unfocused, or always.')
    .volatile(),
  events: z
    .array(z.union(['turn-complete', 'approval-requested']))
    .default(['turn-complete', 'approval-requested'])
    .description('Event types that raise a notification.')
    .volatile(),
  approvalGraceMs: z
    .number()
    .min(0)
    .max(60000)
    .default(2000)
    .description('Wait this long before alerting an approval request, so automatically-resolved requests stay silent.')
    .volatile(),
})

const ROUTE_EVENTS = '/notify/events'
const ROUTE_STATUS = '/notify/status'
const ROUTE_TEST = '/notify/test'
const ROUTE_ACK = '/notify/ack'

const HEARTBEAT_MS = 15000
const ACK_BODY_LIMIT = 8 * 1024
const NOTIFICATION_EVENTS = ['turn-complete', 'approval-requested']

/** Read one config field, accepting both a live volatile reference and a plain value. */
function readField(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

/** Collapse whitespace and bound one user-facing one-liner. */
function oneLine(text, limit = 200) {
  if (typeof text !== 'string') return undefined
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized === '') return undefined
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

/** JSON response helper. */
function writeJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(JSON.stringify(body))
  } catch {
    // The socket may already be gone; nothing left to answer.
  }
}

/** Bounded request-body reader for the ack payload. */
async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return undefined
    }
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Loopback trust fence for the notification routes: the browser half must be
 * the local Harness page. Paired remote devices and proxies are refused so a
 * session title never leaves this machine through these routes.
 */
function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const loopbackAddress =
    address === '::1' || /^127\./u.test(address) || /^::ffff:127\./u.test(address)
  if (!loopbackAddress) return false
  if (req.headers['x-forwarded-for'] !== undefined || req.headers['cf-connecting-ip'] !== undefined) {
    return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === 'localhost' || hostname === '[::1]' || /^127\./u.test(hostname)
  } catch {
    return false
  }
}

/**
 * Mount event detection, the browser-half stream, and the diagnostic routes.
 * @param ctx - Host context carrying `webServer`.
 * @param config - the row's resolved config; volatile fields are live references.
 */
export function apply(ctx, config) {
  const log = (message) => {
    try {
      const logger = ctx.logger
      if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`dsh-notify: ${message}`)
    } catch {
      // Logging must never break notification delivery.
    }
  }

  /** Connected browser halves (one per open page). */
  const subscribers = new Set()
  /** Pending approval-grace timers, cleared on unload. */
  const timers = new Set()
  /** Last seen agent status, so only running -> idle transitions notify. */
  const lastStatus = new Map()
  let heartbeat
  let sequence = 0
  let lastAck
  let ackCount = 0

  // A plugin mounted while turns are already in flight must still notify when
  // those turns finish, so seed the transition map from the live roster.
  try {
    for (const agent of ctx.get('agents')?.list() ?? []) {
      if (typeof agent?.status === 'string') lastStatus.set(String(agent.id), agent.status)
    }
  } catch {
    // Status seeding is best-effort; a missing roster only skips that first alert.
  }

  const currentConfig = () => ({
    enabled: readField(config?.enabled, true) === true,
    condition: readField(config?.condition, 'unfocused') === 'always' ? 'always' : 'unfocused',
    events: (() => {
      const value = readField(config?.events, NOTIFICATION_EVENTS)
      return Array.isArray(value) ? value.filter((event) => NOTIFICATION_EVENTS.includes(event)) : NOTIFICATION_EVENTS
    })(),
    approvalGraceMs: (() => {
      const value = Number(readField(config?.approvalGraceMs, 2000))
      return Number.isFinite(value) ? Math.min(60000, Math.max(0, Math.round(value))) : 2000
    })(),
  })

  const nextId = (prefix) => {
    sequence += 1
    return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`
  }

  /** Best-effort display title for a session: folded title, else its working directory name. */
  const titleOf = (sessionId) => {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId)
      if (session === undefined) return undefined
      const snapshot = ctx.get('sessionTitle')?.get?.(session)
      if (typeof snapshot?.title === 'string' && snapshot.title.trim() !== '') {
        return snapshot.title
      }
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string') {
        const base = cwd.split(/[\\/]/u).filter(Boolean).pop()
        if (base !== undefined && base !== '') return base
      }
    } catch {
      // Title lookup is decorative; a missing title never blocks the alert.
    }
    return undefined
  }

  /** Notify only for top-level sessions; subagents and teammates stay quiet. */
  const isRootAgent = (agent) => {
    const agents = ctx.get('agents')
    if (agents === undefined) return true
    try {
      return agents.roots().some((root) => root.id === agent.id)
    } catch {
      return true
    }
  }

  const frame = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`

  const push = (event) => {
    if (subscribers.size === 0) return
    const data = frame('notify', event)
    for (const res of [...subscribers]) {
      try {
        res.write(data)
      } catch {
        subscribers.delete(res)
      }
    }
  }

  const broadcastConfig = () => {
    if (subscribers.size === 0) return
    const data = frame('config', currentConfig())
    for (const res of [...subscribers]) {
      try {
        res.write(data)
      } catch {
        subscribers.delete(res)
      }
    }
  }

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
  }

  const ensureHeartbeat = () => {
    if (heartbeat !== undefined) return
    heartbeat = setInterval(() => {
      for (const res of [...subscribers]) {
        try {
          res.write(': ping\n\n')
        } catch {
          subscribers.delete(res)
        }
      }
      if (subscribers.size === 0) stopHeartbeat()
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  const removeSubscriber = (res) => {
    subscribers.delete(res)
    if (subscribers.size === 0) stopHeartbeat()
  }

  const eventsHandler = (req, res) => {
    if (!isLocalRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'referrer-policy': 'no-referrer',
      })
      res.write('retry: 2000\n\n')
      res.write(frame('config', currentConfig()))
      subscribers.add(res)
      ensureHeartbeat()
      res.on('error', () => removeSubscriber(res))
      req.on('close', () => removeSubscriber(res))
    } catch (error) {
      log(`event stream failed: ${String(error)}`)
    }
  }

  const statusHandler = (req, res) => {
    if (!isLocalRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    writeJson(res, 200, {
      ok: true,
      value: {
        clients: subscribers.size,
        acknowledgements: ackCount,
        lastAck,
        config: currentConfig(),
      },
    })
  }

  const testHandler = (req, res) => {
    if (!isLocalRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    // `kind` previews one real event shape: the composed notification text is
    // the same one a live turn or approval produces, so an installation can be
    // checked without waiting for one.
    const kind = new URL(req.url ?? '/', 'http://localhost').searchParams.get('kind')
    const type = kind === 'turn-complete' || kind === 'approval-requested' ? kind : 'test'
    let event = { id: nextId('test'), type: 'test', force: true, at: Date.now() }
    if (type !== 'test') {
      let sessionId
      try {
        const root = ctx.get('agents')?.roots?.()[0]
        if (root !== undefined) sessionId = String(root.id)
      } catch {
        // The preview degrades to sample text without a live root session.
      }
      event = {
        id: nextId('test'),
        type,
        force: true,
        sessionId,
        title: sessionId === undefined ? 'dsh-notify' : titleOf(sessionId),
        at: Date.now(),
      }
      if (type === 'approval-requested') event.toolName = 'bash'
    }
    push(event)
    writeJson(res, 200, { ok: true, value: { subscribers: subscribers.size, event } })
  }

  const ackHandler = async (req, res) => {
    if (!isLocalRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const payload = await readJsonBody(req, ACK_BODY_LIMIT)
    if (payload !== undefined && typeof payload === 'object' && payload !== null) {
      const state = typeof payload.state === 'string' ? payload.state : 'unknown'
      ackCount += 1
      lastAck = {
        id: typeof payload.id === 'string' ? payload.id : undefined,
        type: typeof payload.type === 'string' ? payload.type : undefined,
        state,
        at: Date.now(),
      }
    }
    writeJson(res, 200, { ok: true })
  }

  // Detection: a root agent that leaves `running` for `idle` finished its work.
  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = String(agent.id)
    const previous = lastStatus.get(sessionId)
    lastStatus.set(sessionId, status)
    if (status !== 'idle' || previous !== 'running') return
    const cfg = currentConfig()
    if (!cfg.enabled || !cfg.events.includes('turn-complete')) return
    if (!isRootAgent(agent)) return
    push({ id: nextId('turn'), type: 'turn-complete', sessionId, title: titleOf(sessionId), at: Date.now() })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    lastStatus.delete(String(agent.id))
  })

  // Detection: an approval that is still pending after the grace window needs the user.
  ctx.on('approval/request', (req, next) => {
    const pending = next()
    try {
      const cfg = currentConfig()
      if (!cfg.enabled || !cfg.events.includes('approval-requested')) return pending
      if (!isRootAgent(req.agent)) return pending
      const sessionId = String(req.agent.id)
      const delay = cfg.approvalGraceMs
      const timer = setTimeout(() => {
        timers.delete(timer)
        const latest = currentConfig()
        if (!latest.enabled || !latest.events.includes('approval-requested')) return
        const reasonParts = [
          oneLine(req.reason, 160),
          oneLine(req.displayReason?.en ?? req.displayReason?.zh, 160),
        ].filter((part) => part !== undefined)
        push({
          id: nextId('approval'),
          type: 'approval-requested',
          sessionId,
          title: titleOf(sessionId),
          toolName: typeof req.toolName === 'string' ? req.toolName : undefined,
          reason: reasonParts[0],
          at: Date.now(),
        })
      }, delay)
      timers.add(timer)
      const clear = () => {
        timers.delete(timer)
        clearTimeout(timer)
      }
      Promise.resolve(pending).then(clear, clear)
    } catch (error) {
      log(`approval listener failed: ${String(error)}`)
    }
    return pending
  })

  // A committed Settings change reaches the running row without a remount.
  ctx.on('loader/volatile-update', () => {
    broadcastConfig()
  })

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: ROUTE_EVENTS, handler: eventsHandler }),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_STATUS, handler: statusHandler }),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_TEST, handler: testHandler }),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_ACK, handler: ackHandler }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Disposal races are harmless.
        }
      }
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      stopHeartbeat()
      for (const res of [...subscribers]) {
        try {
          res.end()
        } catch {
          // Already closed.
        }
      }
      subscribers.clear()
      lastStatus.clear()
    }
  })

  log('mounted: turn-complete and approval-requested alerts are available')
}
