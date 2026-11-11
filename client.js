/**
 * @hmydk/dsh-notify — browser half.
 *
 * Runs in the Harness Web page. It opens one SSE stream to the Host half,
 * applies the configured focus condition, and shows a native Notification.
 * Every delivery attempt is acknowledged back to the Host so an installation
 * can be verified end-to-end (`GET /notify/status`).
 *
 * Loaded through the client module table: the factory runs at materialization
 * time and registers the plugin on the page's Cordis tree.
 */
window.__ModuleLoader__.load({
  id: '@hmydk/dsh-notify',
  factory() {
    return {
      apply(ctx) {
        const NotificationApi = typeof Notification === 'undefined' ? undefined : Notification
        if (NotificationApi === undefined) return

        const navigatorLanguage =
          typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string'
            ? navigator.language.toLowerCase()
            : ''
        const zh = navigatorLanguage.startsWith('zh')

        let config = {
          enabled: true,
          condition: 'unfocused',
          events: ['turn-complete', 'approval-requested'],
          approvalGraceMs: 2000,
        }
        let permission = NotificationApi.permission

        const requestPermission = async () => {
          if (permission === 'granted') return true
          if (permission === 'denied') return false
          try {
            permission = await NotificationApi.requestPermission()
          } catch {
            return false
          }
          return permission === 'granted'
        }

        const routeUrl = (path) => {
          try {
            return new URL(path, document.baseURI).toString()
          } catch {
            return undefined
          }
        }

        const ack = (event, state) => {
          const url = routeUrl('notify/ack')
          if (url === undefined) return
          try {
            void fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: event.id, type: event.type, state }),
              keepalive: true,
            }).catch(() => {})
          } catch {
            // Diagnostics only; a failed ack never affects delivery.
          }
        }

        const compose = (event) => {
          if (event.type === 'test') {
            return zh
              ? { title: 'DSH 通知测试', body: '通知已接通：任务完成或需要审批时会提醒你。' }
              : {
                  title: 'DSH notification test',
                  body: 'Notifications are connected. You will be alerted when a turn finishes or needs your approval.',
                }
          }
          const title =
            typeof event.title === 'string' && event.title.trim() !== ''
              ? event.title.trim()
              : zh
                ? 'DSH 会话'
                : 'DSH session'
          if (event.type === 'approval-requested') {
            const tool = typeof event.toolName === 'string' && event.toolName !== '' ? event.toolName : undefined
            const reason = typeof event.reason === 'string' && event.reason !== '' ? event.reason : undefined
            const head = tool === undefined ? title : `${title} · ${tool}`
            return {
              title: zh ? '需要审批' : 'Approval needed',
              body: reason === undefined ? head : `${head}\n${reason}`,
            }
          }
          return { title: zh ? '任务完成' : 'Task complete', body: title }
        }

        const show = (event) => {
          if (event.type !== 'test') {
            if (config.enabled === false) {
              ack(event, 'disabled')
              return
            }
            if (Array.isArray(config.events) && !config.events.includes(event.type)) {
              ack(event, 'filtered')
              return
            }
          }
          const focused =
            typeof document !== 'undefined' &&
            document.visibilityState === 'visible' &&
            document.hasFocus()
          const forced = event.force === true || event.type === 'test'
          if (!forced && config.condition !== 'always' && focused) {
            ack(event, 'suppressed')
            return
          }
          void requestPermission().then((granted) => {
            if (!granted) {
              ack(event, 'unsupported')
              return
            }
            const { title, body } = compose(event)
            let notification
            try {
              notification = new NotificationApi(title, {
                body,
                tag: typeof event.sessionId === 'string' ? `dsh-notify:${event.sessionId}` : 'dsh-notify',
                silent: false,
              })
            } catch {
              ack(event, 'failed')
              return
            }
            notification.onclick = () => {
              try {
                window.focus()
              } catch {
                // Browsers may refuse to focus a background window.
              }
              try {
                notification.close()
              } catch {
                // Ignore a double close.
              }
              ack(event, 'clicked')
            }
            ack(event, 'shown')
          })
        }

        ctx.effect(() => {
          const url = routeUrl('notify/events')
          if (url === undefined) return
          let source
          try {
            source = new EventSource(url)
          } catch {
            return
          }
          const onConfig = (raw) => {
            try {
              const parsed = JSON.parse(raw.data)
              if (parsed !== null && typeof parsed === 'object') config = { ...config, ...parsed }
            } catch {
              // Ignore malformed config frames.
            }
          }
          const onNotify = (raw) => {
            try {
              const event = JSON.parse(raw.data)
              if (event !== null && typeof event === 'object' && typeof event.type === 'string') show(event)
            } catch {
              // Ignore malformed notification frames.
            }
          }
          source.addEventListener('config', onConfig)
          source.addEventListener('notify', onNotify)
          return () => {
            try {
              source.close()
            } catch {
              // Already closed.
            }
          }
        })
      },
    }
  },
})

// client-half revision bump: forces the client module registry to republish this bundle.
