// Usage: node port-viewer/server.cjs   then open http://localhost:4818
// Lists ports with lsof, maps Docker ports to their containers, and can stop, start,
// pause or resume them. Actions are re-checked against the live listing, never trusted from the client.
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 4818;
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map(host => `http://${host}`));
const USERNAME = os.userInfo().username;
const PROTECTED_PATHS = /^(\/System\/|\/usr\/(libexec|sbin)\/|\/Applications\/|\/Library\/Apple\/)/;
const EXIT_WAIT_MS = 3000;
const PROBE_TIMEOUT_MS = 1500;

// lsof exits non-zero when anything is unmatched, so keep whatever it printed.
const run = (command, args) => new Promise(resolve => {
  execFile(command, args, { maxBuffer: 32 * 1024 * 1024, timeout: 10000 }, (error, stdout) => resolve(stdout || ''));
});

const docker = (...args) => new Promise((resolve, reject) => {
  execFile('docker', args, { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || error.message));
    else resolve(stdout);
  });
});

const displayPath = value => value && value.startsWith(os.homedir()) ? `~${value.slice(os.homedir().length)}` : value;

function parseListeners(output) {
  const listeners = new Map();
  let pid, command, user, protocol;
  for (const line of output.split('\n')) {
    const field = line[0], value = line.slice(1);
    if (field === 'p') pid = Number(value);
    else if (field === 'c') command = value.replace(/\\x([0-9a-f]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    else if (field === 'L') user = value;
    else if (field === 'P') protocol = value;
    else if (field === 'n') {
      const match = value.match(/^(.*):(\d+)$/);
      if (!match) continue; // skips unbound UDP sockets (*:*) and connected ones (a->b)
      const [, address, port] = match;
      const key = `${pid}/${protocol}/${port}`;
      if (!listeners.has(key)) listeners.set(key, { pid, command, user, protocol, port: Number(port), addresses: new Set() });
      listeners.get(key).addresses.add(address);
    }
  }
  return [...listeners.values()];
}

async function workingDirs(pids) {
  const dirs = new Map();
  let pid;
  for (const line of (await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'])).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') dirs.set(pid, line.slice(1));
  }
  return dirs;
}

async function processDetails(pids) {
  const details = new Map();
  for (const line of (await run('ps', ['-ww', '-o', 'pid=,pcpu=,rss=,state=,command=', '-p', pids.join(',')])).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (match) {
      details.set(Number(match[1]), {
        cpu: Number(match[2]), memory: Number(match[3]) * 1024, paused: match[4].startsWith('T'), commandLine: match[5],
      });
    }
  }
  return details;
}

const MEMORY_UNITS = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, KB: 1e3, MB: 1e6, GB: 1e9 };

function parseMemory(usage) {
  const match = (usage || '').match(/^([\d.]+)\s*([a-z]+)/i);
  return match ? Number(match[1]) * (MEMORY_UNITS[match[2].toUpperCase()] || 0) : null;
}

// The Docker backend process owns every published port, so its own usage says
// nothing about one container. Ask Docker for per-container numbers instead.
async function containerStats() {
  const stats = new Map();
  const output = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
  for (const line of output.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    stats.set(entry.Name, { cpu: parseFloat(entry.CPUPerc), memory: parseMemory(entry.MemUsage) });
  }
  return stats;
}

async function dockerPorts() {
  const containers = new Map();
  const output = await run('docker', ['ps', '--format', '{{json .}}']);
  for (const line of output.split('\n').filter(Boolean)) {
    const container = JSON.parse(line);
    const workingDir = (container.Labels || '').match(/com\.docker\.compose\.project\.working_dir=([^,]*)/)?.[1];
    for (const [, hostPort, containerPort, protocol] of (container.Ports || '').matchAll(/:(\d+)->(\d+)\/(tcp|udp)/g)) {
      containers.set(`${protocol.toUpperCase()}/${hostPort}`, {
        name: container.Names, image: container.Image, workingDir, containerPort, paused: container.State === 'paused',
      });
    }
  }
  return containers;
}

async function stoppedContainers() {
  const output = await run('docker', ['ps', '-a', '--filter', 'status=exited', '--format', '{{json .}}']);
  return output.split('\n').filter(Boolean).map(line => {
    const container = JSON.parse(line);
    const workingDir = (container.Labels || '').match(/com\.docker\.compose\.project\.working_dir=([^,]*)/)?.[1];
    return { name: container.Names, status: container.Status, location: displayPath(workingDir) || `Docker image ${container.Image}` };
  });
}

// Containers can always be started again. Plain processes can't, so only offer
// them for the user's own TCP servers, never system services, apps or Docker itself.
// Pausing uses the same rule: freezing a system service is as harmful as stopping it.
function canStop(listener, commandLine, container) {
  if (container) return true;
  return listener.protocol === 'TCP'
    && listener.user === USERNAME
    && listener.pid !== process.pid
    && !listener.command.startsWith('com.docker')
    && !PROTECTED_PATHS.test(commandLine);
}

// Paused rows copy the resume command: a plain kill wouldn't reach a frozen process.
function copyCommand(listener, container, paused) {
  if (container) return `docker ${paused ? 'unpause' : 'stop'} ${container.name}`;
  if (listener.command.startsWith('com.docker')) return null; // would take down every container
  return `${listener.user === USERNAME ? '' : 'sudo '}kill ${paused ? '-CONT ' : ''}${listener.pid}`;
}

// How to make a network-reachable port local-only, for the row's tooltip.
function networkFix(listener, commandLine, container) {
  const { port, command } = listener;
  if (container?.workingDir) {
    return {
      summary: `In the compose file in ${displayPath(container.workingDir)}, change this port mapping, then run docker compose up -d.`,
      code: `"127.0.0.1:${port}:${container.containerPort}"`,
    };
  }
  if (container) {
    return {
      summary: 'Recreate the container with the port published on 127.0.0.1 only.',
      code: `docker run -p 127.0.0.1:${port}:${container.containerPort} ...`,
    };
  }
  if (command === 'ControlCenter') {
    return { summary: 'This is AirPlay Receiver. If you don\'t use it, turn it off in System Settings > General > AirDrop & Handoff.' };
  }
  if (PROTECTED_PATHS.test(commandLine)) {
    return { summary: 'This belongs to macOS or an installed app, so it can\'t be rebound here. Check that app\'s settings if you don\'t need it.' };
  }
  if (/\bvite\b/.test(commandLine)) return { summary: 'Start Vite bound to 127.0.0.1.', code: 'vite --host 127.0.0.1' };
  if (command === 'node') {
    return { summary: 'Pass 127.0.0.1 as the host where the server starts listening.', code: `app.listen(${port}, '127.0.0.1')` };
  }
  if (command === 'ruby') return { summary: 'Start the server bound to 127.0.0.1.', code: 'rails server -b 127.0.0.1' };
  return { summary: 'Set the host or bind address to 127.0.0.1 in its start command or config.' };
}

// On Linux, lsof reports the thread name (Node shows up as "MainThread"), so use the command.
function processName(listener, commandLine) {
  if (process.platform !== 'linux' || !commandLine) return listener.command;
  return path.basename(commandLine.split(/\s+/)[0]);
}

const isLocalOnly = addresses => [...addresses].every(address => /^(127\.|\[::1\]|localhost)/.test(address));

// A cwd of "/" says nothing (macOS apps and daemons), so fall back to the executable.
function locate(listener, cwd, commandLine, container) {
  if (container) return container.workingDir || `Docker image ${container.image}`;
  if (cwd && cwd !== '/') return cwd;
  return commandLine ? commandLine.split(/\s+-/)[0].trim() : 'Unknown';
}

async function listPorts() {
  const [tcp, udp, containers, stats] = await Promise.all([
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcLPn']),
    run('lsof', ['-nP', '-iUDP', '-FpcLPn']),
    dockerPorts(),
    containerStats(),
  ]);
  const listeners = [...parseListeners(tcp), ...parseListeners(udp)];
  const pids = [...new Set(listeners.map(listener => listener.pid))];
  if (!pids.length) return [];
  const [dirs, details] = await Promise.all([workingDirs(pids), processDetails(pids)]);
  return listeners.map(listener => {
    const container = containers.get(`${listener.protocol}/${listener.port}`);
    const detail = details.get(listener.pid);
    const commandLine = detail?.commandLine || '';
    listener.command = processName(listener, commandLine);
    const usage = container ? stats.get(container.name) : detail;
    const paused = Boolean(container ? container.paused : detail?.paused);
    const localOnly = isLocalOnly(listener.addresses);
    return {
      port: listener.port,
      protocol: listener.protocol,
      pid: listener.pid,
      user: listener.user,
      process: listener.command,
      container: container?.name || null,
      location: displayPath(locate(listener, dirs.get(listener.pid), commandLine, container)),
      commandLine,
      cpu: usage?.cpu ?? null,
      memory: usage?.memory ?? null,
      stoppable: canStop(listener, commandLine, container),
      paused,
      copyCommand: copyCommand(listener, container, paused),
      localOnly,
      networkFix: localOnly ? null : networkFix(listener, commandLine, container),
      addresses: [...listener.addresses],
    };
  }).sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

const isRunning = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitForExit(pid) {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (isRunning(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  return !isRunning(pid);
}

async function findControllable({ port, protocol, pid }) {
  const ports = await listPorts();
  const entry = ports.find(item => item.port === port && item.protocol === protocol && item.pid === pid);
  if (!entry) throw new Error(`Port ${port} is no longer held by PID ${pid}. Nothing was changed.`);
  if (!entry.stoppable) throw new Error(`${entry.process} is protected and can't be changed here.`);
  return entry;
}

async function pausePort(target) {
  const entry = await findControllable(target);
  if (entry.container) await docker('pause', entry.container);
  else process.kill(entry.pid, 'SIGSTOP');
  return `Paused ${entry.container || entry.process}. Requests to it will hang until you resume it.`;
}

async function resumePort(target) {
  const entry = await findControllable(target);
  if (entry.container) await docker('unpause', entry.container);
  else process.kill(entry.pid, 'SIGCONT');
  return `Resumed ${entry.container || entry.process}.`;
}

async function stopPort(target) {
  const entry = await findControllable(target);
  if (entry.container) {
    if (entry.paused) await docker('unpause', entry.container);
    await docker('stop', entry.container);
    return `Stopped ${entry.container}.`;
  }
  process.kill(entry.pid, 'SIGTERM');
  // A frozen process can't act on SIGTERM until it's woken.
  if (entry.paused) process.kill(entry.pid, 'SIGCONT');
  if (!await waitForExit(entry.pid)) throw new Error(`${entry.process} (PID ${entry.pid}) was asked to stop but is still running.`);
  return `Stopped ${entry.process} on port ${entry.port}.`;
}

async function startContainer({ name }) {
  if (!(await stoppedContainers()).some(container => container.name === name)) {
    throw new Error(`${name} is not a stopped container.`);
  }
  await docker('start', name);
  return `Started ${name}.`;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10000) throw new Error('Request too large');
  }
  return JSON.parse(body);
}

const answersHttp = url => new Promise(resolve => {
  const client = url.startsWith('https:') ? https : http;
  // Local dev certificates are usually self-signed. This only checks that something answers.
  const request = client.get(url, { timeout: PROBE_TIMEOUT_MS, rejectUnauthorized: false }, response => {
    response.destroy();
    resolve(true);
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => resolve(false));
});

async function findWebUrl(port) {
  for (const scheme of ['http', 'https']) {
    const url = `${scheme}://localhost:${port}/`;
    if (await answersHttp(url)) return url;
  }
  return null;
}

const ACTIONS = { '/api/stop': stopPort, '/api/start': startContainer, '/api/pause': pausePort, '/api/resume': resumePort };

http.createServer(async (req, res) => {
  // Command lines can hold secrets: refuse requests from other hostnames (DNS rebinding).
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('Forbidden'); }
  const { pathname } = new URL(req.url, 'http://localhost');
  if (ACTIONS[pathname]) {
    // Any website can POST to localhost, and the Host check won't catch that. Origin will.
    if (req.method !== 'POST' || !ALLOWED_ORIGINS.has(req.headers.origin)) { res.writeHead(403); return res.end('Forbidden'); }
    res.setHeader('Content-Type', 'application/json');
    try {
      const message = await ACTIONS[pathname](await readJson(req));
      res.writeHead(200);
      return res.end(JSON.stringify({ message }));
    } catch (error) {
      res.writeHead(409);
      return res.end(JSON.stringify({ error: error.message }));
    }
  }
  if (pathname === '/api/web-url') {
    const port = new URL(req.url, 'http://localhost').searchParams.get('port') || '';
    if (!/^\d{1,5}$/.test(port)) { res.writeHead(400); return res.end('Bad port'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ url: await findWebUrl(port) }));
  }
  if (pathname === '/api/ports') {
    try {
      const [ports, stopped] = await Promise.all([listPorts(), stoppedContainers()]);
      const body = JSON.stringify({ ports, stopped });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: error.message }));
    }
  }
  if (pathname !== '/') { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Port viewer: http://localhost:${PORT}`));
