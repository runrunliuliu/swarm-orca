/**
 * Render one design-draft HTML file to a PNG at 2x, so every `design-*.png`
 * next to it has a source that can be re-rendered instead of a screenshot
 * nobody can reproduce.
 *
 *   node render-design-mockup.mjs <in.html> <width> <height> <out.png>
 *
 * `width`/`height` are CSS pixels (the same numbers the design doc quotes); the
 * PNG comes out at 2x, matching the committed 2026-11-18 drafts (1180x700 ->
 * 2360x1400). Run it headless on Linux:
 *
 *   xvfb-run -a electron render-design-mockup.mjs ...
 *
 * Uses the Electron that already exists in this workspace's prepared tree
 * (`orca/node_modules/electron`); it downloads nothing, installs nothing and
 * rebuilds nothing. The switch must be set before `app.whenReady()`, which is
 * why it is a top-level call and not inside the handler.
 */
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCALE = 2

// Why the tail and not `slice(2)`: an ESM main script sees extra entries in
// `process.argv` (Electron's own argv[1] plus the script path), so indexing from
// the front silently shifts every argument by one and renders the wrong size.
const [inputArg, widthArg, heightArg, outputArg] = process.argv.slice(-4)
if (!inputArg || !widthArg || !heightArg || !outputArg) {
  console.error('usage: render-design-mockup.mjs <in.html> <width> <height> <out.png>')
  process.exit(2)
}
const input = path.resolve(inputArg)
const width = Number(widthArg)
const height = Number(heightArg)
const output = path.resolve(outputArg)

// Why a device-scale switch instead of a bigger window: a 2x window would lay
// the page out at 2x CSS pixels and reflow the draft. This keeps the layout at
// the documented CSS size and only raises the pixel density.
app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE))
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    useContentSize: true,
    backgroundColor: '#0a0a0a',
    webPreferences: { offscreen: false, javascript: true }
  })
  try {
    await win.loadURL(pathToFileURL(input).href)
    // Fonts and any CSS transition need one frame after load, or the capture
    // catches the fallback face.
    await new Promise((resolve) => setTimeout(resolve, 350))
    const image = await win.webContents.capturePage()
    writeFileSync(output, image.toPNG())
    const size = image.getSize()
    if (size.width !== width * SCALE || size.height !== height * SCALE) {
      console.error(
        `warning: captured ${size.width}x${size.height}, expected ${width * SCALE}x${height * SCALE}`
      )
    }
    console.log(`${path.basename(output)} ${size.width}x${size.height}`)
  } finally {
    win.destroy()
    app.quit()
  }
})
