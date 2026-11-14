/**
 * Regression tests for the Host half's event detection.
 *
 * The plugin mounts into a real Cordis Host, but its interesting behaviour is a
 * small surface: the roster, the session store, the agent event bus, and the
 * web routes. These tests stand those up as plain objects, mount `apply()`, and
 * drive `agent/status` / `approval/request` through the same listeners the Host
 * would call.
 *
 * The case that motivated the suite: DSH removed `AgentRegistry.roots()`, the
 * root-only guard silently failed open, and every subagent turn raised a
 * desktop notification.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

/** A top-level session: no delegation markers. */
const ROOT_HEADER = { id: 'session-root', cwd: '/tmp/dsh-notify', delegationDepth: 0, isSeeded: false }
/** A delegated child: marked by `origin`. */
const SUB_HEADER = {
  id: 'session-sub',
  cwd: '/tmp/AI Native SDLC',
  origin: 'subagent',
  parentSession: 'session-root',
  delegationDepth: 1,
  isSeeded: false,
}
/** A delegated child recorded before `origin` existed: depth is the only marker. */
const LEGACY_HEADER = { id: 'session-legacy', cwd: '/tmp/legacy', delegationDepth: 2, isSeeded: false }

/** One live agent; `status` starts at `running` so the first idle transition notifies. */
function agentOf(header) {
  return { id: header.id, status: 'running', session: { header } }
}

/** Request shape the loopback fence accepts. */
function request(url) {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:60347' },
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
  }
}

/**
 * Mount the plugin over a fake Host.
 * @param headers - session headers in the live roster.
 * @param config - resolved plugin config.
 * @returns handles for driving events and reading what the browser half would see.
 */
function mount(headers, config) {
  const roster = headers.map((header) => agentOf(header))
  const byId = new Map(roster.map((agent) => [agent.id, agent]))
  const listeners = new Map()
  const routes = new Map()
  const disposers = []
  const warnings = []

  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    get(name) {
      if (name === 'agents') {
        return { list: () => roster, get: (id) => byId.get(id) }
      }
      if (name === 'sessions') {
        return {
          get: (id) => {
            const agent = byId.get(id)
            return agent === undefined ? undefined : { header: agent.session.header, deriveMessages: () => [] }
          },
        }
      }
      return undefined
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    effect(factory) {
      disposers.push(factory())
      return () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }

  apply(ctx, {
    enabled: true,
    condition: 'unfocused',
    events: ['turn-complete', 'approval-requested'],
    approvalGraceMs: 0,
    ...config,
  })

  /** One connected browser half, subscribing exactly like a real page. */
  const stream = {
    status: 0,
    chunks: [],
    writeHead(status) {
      this.status = status
    },
    write(chunk) {
      this.chunks.push(String(chunk))
    },
    on() {},
    end() {},
  }
  routes.get('/notify/events')(request('/notify/events'), stream)
  assert.equal(stream.status, 200, 'the SSE route must accept a loopback client')
  stream.chunks.length = 0

  return {
    listeners,
    routes,
    stream,
    roster,
    warnings,
    /** Notifications the browser half received since the last read. */
    notifications() {
      return stream.chunks
        .filter((chunk) => chunk.startsWith('event: notify'))
        .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6)))
    },
    /** Drive one listener the Host would invoke. */
    emit(name, payload, next) {
      const listener = listeners.get(name)
      assert.ok(listener !== undefined, `missing ${name} listener`)
      return listener(payload, next)
    },
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Disposal races are harmless.
        }
      }
    },
  }
}

/** A request that waits forever, so an approval's grace timer can fire. */
const neverSettles = () => new Promise(() => {})

/** Let the approval grace timer and the promise microtasks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

test('a subagent turn stays quiet', (t) => {
  const host = mount([ROOT_HEADER, SUB_HEADER])
  t.after(() => host.dispose())

  host.emit('agent/status', { agent: host.roster[1], status: 'idle' })

  assert.deepEqual(host.notifications(), [], 'a delegated child must not raise a turn-complete alert')
})

test('a session recorded before origin existed stays quiet', (t) => {
  const host = mount([ROOT_HEADER, LEGACY_HEADER])
  t.after(() => host.dispose())

  host.emit('agent/status', { agent: host.roster[1], status: 'idle' })

  assert.deepEqual(host.notifications(), [], 'delegationDepth alone must mark a delegated child')
})

test('a root turn notifies with its own title', (t) => {
  const host = mount([ROOT_HEADER, SUB_HEADER])
  t.after(() => host.dispose())

  host.emit('agent/status', { agent: host.roster[0], status: 'idle' })

  const [notification, ...rest] = host.notifications()
  assert.equal(rest.length, 0)
  assert.equal(notification.type, 'turn-complete')
  assert.equal(notification.sessionId, 'session-root')
  assert.equal(notification.title, 'dsh-notify')
})

test('a subagent approval stays quiet', async (t) => {
  const host = mount([ROOT_HEADER, SUB_HEADER])
  t.after(() => host.dispose())

  host.emit('approval/request', { agent: host.roster[1], toolName: 'bash', reason: 'rm -rf /' }, neverSettles)
  await settle()

  assert.deepEqual(host.notifications(), [], 'a delegated child must not raise an approval alert')
})

test('a root approval notifies', async (t) => {
  const host = mount([ROOT_HEADER, SUB_HEADER])
  t.after(() => host.dispose())

  host.emit('approval/request', { agent: host.roster[0], toolName: 'bash', reason: 'git push' }, neverSettles)
  await settle()

  const [notification, ...rest] = host.notifications()
  assert.equal(rest.length, 0)
  assert.equal(notification.type, 'approval-requested')
  assert.equal(notification.sessionId, 'session-root')
})

test('the test-notification preview borrows a live root session', (t) => {
  const host = mount([ROOT_HEADER, SUB_HEADER])
  t.after(() => host.dispose())

  let body
  host.routes.get('/notify/test')(
    request('/notify/test?kind=turn-complete'),
    {
      writeHead() {},
      write() {},
      end(chunk) {
        body = JSON.parse(String(chunk))
      },
    },
  )

  assert.equal(body.ok, true)
  assert.equal(body.value.event.sessionId, 'session-root', 'the preview must not fall back to sample copy')
  assert.equal(body.value.event.title, 'dsh-notify')
})

test('a session with no readable header still alerts', (t) => {
  const host = mount([ROOT_HEADER])
  t.after(() => host.dispose())

  // Defensive: an unreadable agent must not silence every future alert.
  const unknown = { id: 'session-unknown', status: 'running' }
  host.emit('agent/status', { agent: unknown, status: 'running' })
  host.emit('agent/status', { agent: unknown, status: 'idle' })

  const notifications = host.notifications()
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].sessionId, 'session-unknown')
})
