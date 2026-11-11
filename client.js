/**
 * @hmydk/dsh-notify — browser half.
 *
 * Runs in the Harness Web page. It opens one SSE stream to the Host half,
 * applies the configured focus condition, and shows a native Notification.
 * Every delivery attempt is acknowledged back to the Host so an installation
 * can be verified end-to-end (`GET /notify/status`).
 *
 * It also adds a **Notifications** page to the Settings dialog. The page reads
 * and writes the plugin row's volatile config through the client `configForms`
 * service, so a change made here lands in the profile patch and is streamed to
 * the Host half without editing YAML by hand. The page only mounts where that
 * service exists; notification delivery keeps working without it.
 *
 * Loaded through the client module table: the factory runs at materialization
 * time and registers the plugin on the page's Cordis tree.
 */
window.__ModuleLoader__.load({
  id: '@hmydk/dsh-notify',
  factory(require) {
    /** Host plugin entry id the settings page reads and writes. */
    const NAMESPACE = 'dsh-notify'
    /** Notification event ids the config accepts. */
    const EVENT_IDS = ['turn-complete', 'approval-requested']
    /** A one-line turn summary shorter than this reads as noise, so prefer the prompt. */
    const TURN_BODY_MIN = 8
    /** Client locale namespace for the settings page copy. */
    const LOCALE_NS = 'dsh-notify'

    /** Settings page dictionaries; the shared locale service picks the active one. */
    const DICTIONARIES = {
      en: {
        nav: 'Notifications',
        title: 'Notifications',
        description:
          'Native desktop notifications when a root session finishes a turn, or when a tool call is waiting for your approval.',
        enable: 'Desktop notifications',
        enableHint: 'When off, nothing is announced; approval requests keep waiting as before.',
        condition: 'When to alert',
        conditionHint:
          'The default only alerts while the Harness window is in the background, so a run you are watching stays quiet.',
        conditionUnfocused: 'Only when unfocused',
        conditionAlways: 'Always',
        events: 'Events',
        turnComplete: 'Turn complete',
        approvalRequested: 'Approval needed',
        grace: 'Approval grace',
        graceHint:
          'How long an approval request may wait before it is announced (0–60000 ms); requests that resolve themselves stay silent.',
        graceUnit: 'ms',
        test: 'Send a test notification',
        testHint: 'Bypasses the focus condition and raises one test notification now.',
        readonly:
          'This profile fixes the configuration in a higher layer (home patch or command-line overlay); the page is read-only.',
        unavailable: 'The Host exposes no editable configuration for this plugin right now.',
        loading: 'Reading configuration…',
        saveFailed: 'Save failed: the Host rejected this change; try again.',
        invalidGrace: 'Enter a number between 0 and 60000 milliseconds.',
      },
      zh: {
        nav: '通知',
        title: '通知',
        description: '根会话完成一轮任务、或工具调用需要你审批时，弹出系统桌面通知。',
        enable: '桌面通知',
        enableHint: '关闭后不再弹通知；审批请求仍然按原有流程等待。',
        condition: '提醒时机',
        conditionHint: '默认只在 Harness 窗口不在前台时提醒，避免盯着屏幕时被打扰。',
        conditionUnfocused: '仅窗口失焦时',
        conditionAlways: '总是提醒',
        events: '提醒事件',
        turnComplete: '任务完成',
        approvalRequested: '需要审批',
        grace: '审批提醒延迟',
        graceHint: '审批请求等待多久仍在挂起才提醒（0–60000 毫秒）；自动放行的请求不会打扰。',
        graceUnit: '毫秒',
        test: '发送测试通知',
        testHint: '忽略失焦条件，立即弹一条测试通知。',
        readonly: '当前 profile 的配置由上层（home patch 或命令行覆盖）决定，这里只能查看。',
        unavailable: 'Host 没有提供该插件的可变配置，暂时无法在此修改。',
        loading: '正在读取配置…',
        saveFailed: '保存失败：Host 拒绝了这次修改，请稍后重试。',
        invalidGrace: '请输入 0–60000 之间的毫秒数。',
      },
    }

    /** Detect the notification language once; the settings page follows the app locale. */
    const navigatorLanguage =
      typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string'
        ? navigator.language.toLowerCase()
        : ''
    const zh = navigatorLanguage.startsWith('zh')

    /**
     * Mount the Notifications page in the Settings dialog.
     *
     * The page is optional: it registers only when the client exposes `slots`,
     * `locale` and the settings `configForms` service, and a failure here never
     * affects notification delivery.
     * @param ctx - the browser plugin context.
     * @param requireModule - the client module table's `require`.
     */
    const mountSettingsPage = (ctx, requireModule) => {
      if (typeof requireModule !== 'function' || typeof ctx.inject !== 'function') return
      ctx.inject(['slots', 'locale', 'configForms'], (scope) => {
        try {
          const react = requireModule('react')
          const primitives = requireModule('@deepseek-ai/dsh-client-ui-primitives')
          const form = scope.configForms.get(NAMESPACE)
          const translate = scope.locale.bind(LOCALE_NS)
          const NotificationsPage = createNotificationsPage(react, primitives, form, scope.locale, translate)
          scope.effect(() => scope.locale.register(LOCALE_NS, DICTIONARIES), 'dsh-notify: dictionaries')
          scope.effect(
            () =>
              scope.configForms.whileServed([NAMESPACE], () =>
                scope.slots.inject('settings.section', () =>
                  scope.slots.register(
                    {
                      name: 'settings.section',
                      id: 'notifications',
                      order: 18,
                      label: () => translate('nav'),
                    },
                    NotificationsPage,
                  ),
                ),
              ),
            'dsh-notify: settings page',
          )
        } catch (error) {
          console.warn('[dsh-notify] settings page unavailable:', error)
        }
      })
    }

    /**
     * Build the Settings page component over one config form.
     * @param react - React.
     * @param primitives - the shared UI primitives.
     * @param form - `configForms.get('dsh-notify')`.
     * @param locale - the client locale service (rerenders the page on a language switch).
     * @param translate - namespace-bound translation function.
     * @returns the page component.
     */
    function createNotificationsPage(react, primitives, form, locale, translate) {
      const h = react.createElement
      const styles = {
        page: {
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          maxWidth: '720px',
          padding: '4px 0 24px',
        },
        header: { display: 'flex', flexDirection: 'column', gap: '6px' },
        title: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
        description: {
          margin: 0,
          fontSize: '13px',
          lineHeight: 1.5,
          color: 'var(--dsw-alias-label-tertiary, inherit)',
        },
        card: {
          display: 'flex',
          flexDirection: 'column',
          padding: '0 16px',
          border: '0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
          borderRadius: '12px',
          background: 'var(--dsw-alias-settings-card-fill, transparent)',
        },
        row: (last) => ({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '24px',
          padding: '14px 0',
          borderBottom: last ? 'none' : '0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))',
        }),
        rowText: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
        rowTitle: { fontSize: '13.5px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, inherit)' },
        rowHint: {
          fontSize: '12px',
          lineHeight: 1.45,
          color: 'var(--dsw-alias-label-tertiary, inherit)',
        },
        control: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' },
        grace: { display: 'flex', alignItems: 'center', gap: '8px' },
        unit: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
        note: {
          margin: 0,
          fontSize: '12px',
          lineHeight: 1.45,
          color: 'var(--dsw-alias-label-tertiary, inherit)',
        },
        error: { margin: 0, fontSize: '12px', lineHeight: 1.45, color: 'var(--dsw-alias-state-error-primary, #d14343)' },
      }

      /** One titled row with a control on its trailing edge. */
      const row = (key, title, hint, control, last = false) =>
        h(
          'div',
          { key, style: styles.row(last) },
          h(
            'div',
            { style: styles.rowText },
            h('span', { style: styles.rowTitle }, title),
            hint === undefined ? null : h('span', { style: styles.rowHint }, hint),
          ),
          h('div', { style: styles.control }, control),
        )

      /**
       * The page itself: reads the form snapshot and writes single fields back.
       * @returns the rendered page.
       */
      return function NotificationsPage() {
        const snapshot = react.useSyncExternalStore(
          (listener) => form.subscribe(listener),
          () => form.getSnapshot(),
          () => form.getSnapshot(),
        )
        // A language switch re-renders the page with the next dictionary.
        react.useSyncExternalStore(
          (listener) => locale.subscribe(listener),
          () => locale.getSnapshot(),
          () => locale.getSnapshot(),
        )
        const [graceDraft, setGraceDraft] = react.useState(undefined)
        const [error, setError] = react.useState('')
        const [sending, setSending] = react.useState(false)

        const value = snapshot.status === 'ready' ? snapshot.value : undefined
        const writable = snapshot.writable !== false && value !== undefined

        /** Write one field and surface a rejected write. */
        const write = (field, next) => {
          setError('')
          Promise.resolve(form.set(field, next)).then(
            (accepted) => {
              if (accepted) return
              setError(translate('saveFailed'))
            },
            () => setError(translate('saveFailed')),
          )
        }

        /** Commit the grace input, keeping an invalid draft visible. */
        const commitGrace = () => {
          if (graceDraft === undefined) return
          const parsed = Number(graceDraft)
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60000) {
            setError(translate('invalidGrace'))
            return
          }
          setGraceDraft(undefined)
          write('approvalGraceMs', Math.round(parsed))
        }

        /** Raise one forced test notification through the Host route. */
        const sendTest = () => {
          setSending(true)
          let url
          try {
            url = new URL('notify/test?kind=turn-complete', document.baseURI).toString()
          } catch {
            setSending(false)
            setError(translate('saveFailed'))
            return
          }
          fetch(url)
            .catch(() => {})
            .finally(() => setSending(false))
        }

        if (snapshot.status === 'loading' && value === undefined) {
          return h('p', { style: styles.note }, translate('loading'))
        }
        if (snapshot.status === 'unavailable' || value === undefined) {
          return h('p', { style: styles.note }, translate('unavailable'))
        }

        const events = Array.isArray(value.events) ? value.events : EVENT_IDS
        const grace = graceDraft === undefined ? String(value.approvalGraceMs) : graceDraft

        return h(
          'div',
          { style: styles.page },
          h(
            'header',
            { style: styles.header },
            h('h2', { style: styles.title }, translate('title')),
            h('p', { style: styles.description }, translate('description')),
          ),
          h(
            'section',
            { style: styles.card },
            row(
              'enabled',
              translate('enable'),
              translate('enableHint'),
              h(primitives.Switch, {
                checked: value.enabled === true,
                label: translate('enable'),
                disabled: !writable,
                onChange: (checked) => write('enabled', checked),
              }),
            ),
            row(
              'condition',
              translate('condition'),
              translate('conditionHint'),
              h(primitives.SegmentedControl, {
                label: translate('condition'),
                value: value.condition === 'always' ? 'always' : 'unfocused',
                disabled: !writable,
                options: [
                  { value: 'unfocused', label: translate('conditionUnfocused') },
                  { value: 'always', label: translate('conditionAlways') },
                ],
                onChange: (next) => write('condition', next),
              }),
            ),
            row(
              'events',
              translate('events'),
              undefined,
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' } },
                h(primitives.Checkbox, {
                  label: translate('turnComplete'),
                  checked: events.includes('turn-complete'),
                  disabled: !writable,
                  onChange: (checked) => {
                    const next = checked
                      ? [...new Set([...events, 'turn-complete'])]
                      : events.filter((event) => event !== 'turn-complete')
                    write('events', next)
                  },
                }),
                h(primitives.Checkbox, {
                  label: translate('approvalRequested'),
                  checked: events.includes('approval-requested'),
                  disabled: !writable,
                  onChange: (checked) => {
                    const next = checked
                      ? [...new Set([...events, 'approval-requested'])]
                      : events.filter((event) => event !== 'approval-requested')
                    write('events', next)
                  },
                }),
              ),
            ),
            row(
              'grace',
              translate('grace'),
              translate('graceHint'),
              h(
                'div',
                { style: styles.grace },
                h(primitives.Input, {
                  type: 'number',
                  'aria-label': translate('grace'),
                  min: 0,
                  max: 60000,
                  step: 100,
                  value: grace,
                  disabled: !writable,
                  onChange: (event) => setGraceDraft(event.target.value),
                  onBlur: commitGrace,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitGrace()
                    } else if (event.key === 'Escape') {
                      setGraceDraft(undefined)
                    }
                  },
                  style: { width: '96px' },
                }),
                h('span', { style: styles.unit }, translate('graceUnit')),
              ),
              false,
            ),
            row(
              'test',
              translate('test'),
              translate('testHint'),
              h(
                primitives.Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  disabled: sending,
                  onClick: sendTest,
                },
                translate('test'),
              ),
              true,
            ),
          ),
          error === '' ? null : h('p', { style: styles.error }, error),
          writable ? null : h('p', { style: styles.note }, translate('readonly')),
        )
      }
    }

    return {
      apply(ctx) {
        const NotificationApi = typeof Notification === 'undefined' ? undefined : Notification
        if (NotificationApi === undefined) return

        let config = {
          enabled: true,
          condition: 'unfocused',
          events: EVENT_IDS,
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
          // The body describes the turn that just ended: the Host half sends a
          // display-ready preview of its closing reply and its request. Fall
          // back to the request, then to the session title.
          const response = typeof event.response === 'string' && event.response !== '' ? event.response : undefined
          const prompt = typeof event.prompt === 'string' && event.prompt !== '' ? event.prompt : undefined
          const body =
            (response !== undefined && response.length >= TURN_BODY_MIN ? response : undefined) ??
            prompt ??
            response ??
            title
          return { title: zh ? '任务完成' : 'Task complete', body }
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

        // The settings page is additive: without the settings client services
        // it is skipped, and notification delivery above is unaffected.
        try {
          mountSettingsPage(ctx, require)
        } catch (error) {
          console.warn('[dsh-notify] settings page unavailable:', error)
        }
      },
    }
  },
})
