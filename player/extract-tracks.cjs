// Usage: node player/extract-tracks.cjs <track page url>
// Writes the track list shown on that page to player/tracks.local.json. Metadata only.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];
  if (!url) throw new Error('Pass a track URL');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const tracks = await page.$$eval('ul li figure', figures => figures.map(figure => {
    const links = [...figure.querySelectorAll('a')];
    const track = links.find(a => a.href.includes('/track/'));
    if (!track) return null;
    return {
      id: track.href.match(/\/track\/(\d+)/)[1],
      title: track.textContent.trim(),
      artists: links.filter(a => a.href.includes('/artist/')).map(a => a.textContent.trim()),
    };
  }).filter(Boolean));
  await browser.close();
  const file = path.join(__dirname, 'tracks.local.json');
  fs.writeFileSync(file, JSON.stringify(tracks, null, 2) + '\n');
  console.log(`Wrote ${tracks.length} tracks to ${file}`);
})().catch(error => { console.error(error); process.exit(1); });
