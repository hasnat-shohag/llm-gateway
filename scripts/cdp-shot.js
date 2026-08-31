/**
 * Screenshot + console capture for the running app over CDP.
 *
 * Usage: node scripts/cdp-shot.js <ws-url> <out.png> [tabName] [themeSource] [scrollY]
 *
 * Kept in scripts/ rather than test/ because it needs a live window: it drives the
 * real renderer through the real preload, which is the only way to see what the
 * design actually looks like with real data in it.
 */
const { writeFileSync } = require('node:fs')

const [wsUrl, outPath, tabName, themeSource, scrollY] = process.argv.slice(2)
if (!wsUrl || !outPath) {
  console.error('usage: node scripts/cdp-shot.js <ws-url> <out.png> [tab] [dark|light|system] [scrollY]')
  process.exit(2)
}

let nextId = 1
const pending = new Map()
const problems = []

const socket = new WebSocket(wsUrl)

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    problems.push(`EXCEPTION ${d.text} ${d.exception?.description ?? ''}`.trim())
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    problems.push(`CONSOLE.${msg.params.type} ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`)
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    problems.push(`LOG ${msg.params.entry.source}: ${msg.params.entry.text}`)
  }
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

socket.addEventListener('open', async () => {
  try {
    await send('Runtime.enable')
    await send('Log.enable')
    await send('Page.enable')

    if (themeSource) {
      // Emulate rather than write settings.json: a screenshot pass must not mutate
      // the user's stored preference.
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: themeSource }],
      })
    }

    // Always reload: the point of this script is to see the code as it is on disk,
    // and the window may have been open since before the last edit.
    const loaded = new Promise((resolve) => {
      const onLoad = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          socket.removeEventListener('message', onLoad)
          resolve()
        }
      }
      socket.addEventListener('message', onLoad)
    })
    await send('Page.reload', { ignoreCache: true })
    await loaded
    await wait(1200)

    if (tabName) {
      // Boot finishes by calling switchView('providers'), so a click that lands
      // mid-boot gets overwritten. Click until the tab reports itself selected.
      let selected = false
      for (let attempt = 0; attempt < 10 && !selected; attempt++) {
        await send('Runtime.evaluate', {
          expression: `document.getElementById('tab-${tabName}')?.click()`,
        })
        await wait(400)
        const check = await send('Runtime.evaluate', {
          expression: `document.getElementById('tab-${tabName}')?.getAttribute('aria-selected') === 'true'`,
          returnByValue: true,
        })
        selected = check.result.value === true
      }
      if (!selected) {
        console.error(`could not select tab-${tabName}`)
        process.exit(1)
      }
      // Let the view's own fetches land before capturing.
      await wait(1600)
    } else {
      await wait(700)
    }

    if (scrollY) {
      // Panels below the fold need their own frame: captureBeyondViewport would stretch
      // the window, and the charts measure themselves against it.
      await send('Runtime.evaluate', {
        expression: `(() => {
          const scroller = [...document.querySelectorAll('*')]
            .find((n) => n.scrollHeight > n.clientHeight + 40 && getComputedStyle(n).overflowY !== 'visible')
          ;(scroller ?? document.scrollingElement).scrollTop = ${Number(scrollY)}
        })()`,
      })
      await wait(600)
    }

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'))

    const size = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({ w: innerWidth, h: innerHeight, scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" })',
      returnByValue: true,
    })

    console.log(`wrote ${outPath} ${size.result.value}`)
    console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no console errors')
    socket.close()
    process.exit(problems.length ? 1 : 0)
  } catch (err) {
    console.error('cdp failed:', err.message)
    process.exit(1)
  }
})

socket.addEventListener('error', () => {
  console.error('websocket error — is the app running with --remote-debugging-port?')
  process.exit(1)
})
