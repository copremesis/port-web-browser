// Usage: node player/server.cjs   (optional: YT_API_KEY=... for in-app search)
// The IFrame player needs a real http origin, so it can't run from file://.
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT) || 4817;
const API_KEY = process.env.YT_API_KEY;
// A personal tracks.local.json (not committed) replaces the empty default list.
const TRACKS_FILE = fs.existsSync(path.join(__dirname, 'tracks.local.json')) ? 'tracks.local.json' : 'tracks.json';
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/tracks.json': [TRACKS_FILE, 'application/json'],
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function search(query) {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({
    part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '5', q: query, key: API_KEY,
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`YouTube search failed with status ${response.status}`);
  const { items } = await response.json();
  return items.map(item => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
  }));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/config') return sendJson(res, 200, { search: Boolean(API_KEY) });
  if (url.pathname === '/api/search') {
    if (!API_KEY) return sendJson(res, 501, { error: 'YT_API_KEY is not set' });
    try {
      return sendJson(res, 200, await search(url.searchParams.get('q') || ''));
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }
  const file = FILES[url.pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': file[1] });
  fs.createReadStream(path.join(__dirname, file[0])).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Player: http://localhost:${PORT}`));
