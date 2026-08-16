#!/usr/bin/env node
/**
 * Demo GIF capture for dsh-plugin-subhub.
 *
 * What it does
 *  1. Boots a throwaway DSH web profile with this plugin installed from the
 *     local checkout (DSH_HOME points at a temp directory).
 *  2. Drives the UI with Playwright and saves one screenshot per step to
 *     .tmp-repro/gif-frames/.
 *  3. Assembles the frames into a GIF with ffmpeg.
 *
 * Requirements
 *  - dsh CLI on PATH (Node 18.17+)
 *  - ffmpeg on PATH
 *  - Playwright resolvable from this checkout, the repo root, or .tmp-repro
 *    (see docs/development.md for the headless-browser recipe)
 *  - pnpm install has been run in this repo (the link: install needs the deps)
 *
 * Usage
 *  node scripts/demo-gif.mjs                  # capture without signing in
 *  node scripts/demo-gif.mjs --login          # pause for a real device login
 *  node scripts/demo-gif.mjs --out assets/demo.gif
 *
 * Notes
 *  - Credentials always live in the plugin-owned directory ~/.dsh-plugin-subhub;
 *    the temp DSH_HOME does not relocate them.
 *  - Frame files keep their two-digit NN- prefix: ffmpeg reads them in
 *    lexical order, which matches the capture order.
 *  - UI texts follow the harness language setting. The SELECTORS below cover
 *    English first with Chinese fallbacks; adjust them if a step fails after
 *    a harness UI change. A missing selector logs a warning and skips that
 *    frame instead of aborting the whole capture.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRAME_DIR = join(REPO_ROOT, '.tmp-repro', 'gif-frames')
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'subhub-gif-'))

const PORT = argValue('--port') ?? '4599'
const OUT = argValue('--out') ?? join(REPO_ROOT, '.tmp-repro', 'demo.gif')
const LOGIN = process.argv.includes('--login')
const KEEP = process.argv.includes('--keep')
const LOGIN_TIMEOUT_MS = Number(argValue('--login-timeout') ?? '300000')
const GIF_FPS = argValue('--fps') ?? '4/5' // seconds per frame = 1 / 0.8 = 1.25s

/** Selector fallback lists. Tweak here when the harness UI changes. */
const SELECTORS = {
  onboarding: ['text=Get started', 'text=Skip', 'text=开始使用', 'text=跳过', 'text=Continue'],
  settingsNav: ['text=Settings', 'text=设置', '[aria-label="Settings"]', '[aria-label="设置"]'],
  subscriptionsNav: ['text=Subscriptions', 'text=第三方订阅'],
  signInButton: ['text=Sign in', 'text=登录'],
  loggedInMark: ['text=Log out', 'text=退出登录', 'text=Sign in again', 'text=重新登录'],
  modelPicker: ['text=Model', 'text=模型', 'text=Choose a model', 'text=选择模型'],
  composer: ['[contenteditable="true"]', 'textarea', 'input[type="text"]'],
}

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function spawnSyncChecked(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`)
}

function resolvePlaywright() {
  for (const anchor of [REPO_ROOT, join(REPO_ROOT, '.tmp-repro')]) {
    try {
      return createRequire(join(anchor, 'package.json')).resolve('playwright')
    } catch {
      /* try next anchor */
    }
  }
  return null
}

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`server at ${url} did not answer within ${timeoutMs}ms`)
}

async function tryClick(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first()
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      await loc.click({ timeout: 3000 }).catch(() => {})
      return true
    }
  }
  return false
}

async function frame(page, dir, name) {
  const file = join(dir, name)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`  captured ${file}`)
}

async function dismissOnboarding(page) {
  const ok = await tryClick(page, SELECTORS.onboarding)
  if (ok) await page.waitForTimeout(1500)
  else console.log('  note: no onboarding dialog found, continuing')
}

async function main() {
  const { chromium } = await import(resolvePlaywright())
  const base = `http://127.0.0.1:${PORT}`

  console.log('Step 1/4: preparing the demo profile')
  if (!existsSync(join(REPO_ROOT, 'node_modules'))) {
    throw new Error('run pnpm install in the repo first (link: install needs the deps)')
  }
  spawnSyncChecked('dsh', ['plugin', '--profile', 'demo', 'add', 'link:./'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME: TEMP_HOME },
  })

  console.log(`Step 2/4: starting DSH web on ${base}`)
  const server = spawn('dsh', ['--profile', 'demo', 'web', '--port', PORT], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME: TEMP_HOME },
    detached: true,
    stdio: 'ignore',
  })
  server.unref()
  try {
    await waitForServer(base)

    console.log('Step 3/4: capturing frames')
    rmSync(FRAME_DIR, { recursive: true, force: true })
    mkdirSync(FRAME_DIR, { recursive: true })

    const browser = await chromium.launch({ headless: !LOGIN })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    await dismissOnboarding(page)
    await frame(page, FRAME_DIR, '01-home.png')

    if (await tryClick(page, SELECTORS.settingsNav)) {
      await page.waitForTimeout(1500)
      await frame(page, FRAME_DIR, '02-settings.png')
      if (await tryClick(page, SELECTORS.subscriptionsNav)) {
        await page.waitForTimeout(1500)
        await frame(page, FRAME_DIR, '03-subscriptions.png')

        const alreadyLoggedIn = await page
          .locator(SELECTORS.loggedInMark.map((s) => `${s} >> nth=0`).join(', '))
          .first()
          .isVisible()
          .catch(() => false)

        if (LOGIN && !alreadyLoggedIn) {
          if (await tryClick(page, SELECTORS.signInButton)) {
            await page.waitForTimeout(1500)
            await frame(page, FRAME_DIR, '04-signin.png')
            console.log('  complete the sign-in in the opened browser window now')
            const deadline = Date.now() + LOGIN_TIMEOUT_MS
            let done = false
            while (Date.now() < deadline) {
              await page.waitForTimeout(3000)
              done = await page
                .locator(SELECTORS.loggedInMark.join(', '))
                .first()
                .isVisible()
                .catch(() => false)
              if (done) break
            }
            if (!done) throw new Error(`sign-in did not finish within ${LOGIN_TIMEOUT_MS}ms`)
            await page.waitForTimeout(2000)
            await frame(page, FRAME_DIR, '05-subscriptions-loggedin.png')
          } else {
            console.log('  note: sign-in button not found, skipping the login step')
          }
        } else if (alreadyLoggedIn) {
          console.log('  note: already logged in, capturing the signed-in hub')
          await frame(page, FRAME_DIR, '05-subscriptions-loggedin.png')
        }
      } else {
        console.log('  note: subscriptions nav not found, skipping hub frames')
      }
    } else {
      console.log('  note: settings entry not found, skipping settings frames')
    }

    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (await tryClick(page, SELECTORS.modelPicker)) {
      await page.waitForTimeout(1500)
      await frame(page, FRAME_DIR, '06-model-picker.png')
      await page.keyboard.press('Escape')
    } else {
      console.log('  note: model picker not found, skipping picker frame')
    }

    const composer = page.locator(SELECTORS.composer.join(', ')).first()
    if ((await composer.count()) > 0) {
      await composer.click()
      await composer.type('Summarize DeepSeek Harness in one sentence.')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(8000)
      await frame(page, FRAME_DIR, '07-chat.png')
    } else {
      console.log('  note: composer not found, skipping chat frame')
    }

    await browser.close()

    console.log('Step 4/4: assembling GIF with ffmpeg')
    spawnSyncChecked('ffmpeg', [
      '-y',
      '-framerate', GIF_FPS,
      '-pattern_type', 'glob',
      '-i', join(FRAME_DIR, '*.png'),
      '-vf', 'scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer',
      '-loop', '0',
      OUT,
    ])
    console.log(`wrote ${OUT}`)
  } finally {
    if (!KEEP) {
      try {
        process.kill(-server.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
      rmSync(TEMP_HOME, { recursive: true, force: true })
    } else {
      console.log(`keeping temp profile at ${TEMP_HOME}`)
    }
  }
}

main().catch((err) => {
  console.error(`demo-gif failed: ${err.message}`)
  process.exitCode = 1
})
