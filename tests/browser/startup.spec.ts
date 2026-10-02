import { test, expect } from '@playwright/test'

test('unconfigured checkout renders useful setup without requesting game assets', async ({ page }) => {
  const media: string[] = [], errors: string[] = []
  page.on('request', request => { if (/\.(glb|jpg|png|webp|mp3|wav|ttf)(?:\?|$)/.test(request.url())) media.push(request.url()) })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Not Halo client' })).toBeVisible()
  await expect(page.getByText('The source is installed.', { exact: false })).toBeVisible()
  expect(media).toEqual([])
  expect(errors).toEqual([])
})

test('invalid external data reports setup failure instead of an uncaught error', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/runtime-config.json', route => route.fulfill({ json: { assetsBase: '/missing-media', dataBase: '/missing-data' } }))
  await page.route('**/missing-data/**', route => route.fulfill({ contentType: 'text/html', body: '<html>SPA fallback</html>' }))
  await page.goto('/')
  await expect(page.locator('.loading-status')).toContainText('Could not prepare this level.')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  expect(errors).toEqual([])
})
