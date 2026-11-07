const fs = require('fs');
const path = require('path');
const { app, BaseWindow, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, shell } = require('electron');

const BACKGROUND = '#15171a';
const TAB_BAR_HEIGHT = 40;
const SERVER_WAIT_MS = 5000;
const MAX_NUMBERED_TABS = 9;
const IS_MAC = process.platform === 'darwin';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DARK_READER = fs.readFileSync(require.resolve('darkreader/darkreader.js'), 'utf8');
const DARK_READER_WORLD = 1001; // a separate script world, so the page's own code never sees it
const DARK_THEME = JSON.stringify({ darkSchemeBackgroundColor: BACKGROUND, darkSchemeTextColor: '#eceef0' });

// The tab bar is drawn from this list. Port tabs are added and removed at runtime.
const tabs = [
  { id: 'music', label: 'Music', url: 'http://localhost:4817/', health: 'tracks.json', server: 'player/server.cjs' },
  { id: 'ports', label: 'Ports', url: 'http://localhost:4818/', health: 'api/ports', server: 'port-viewer/server.cjs' },
];

// Apps opened from the Dock don't inherit the shell's PATH, and the port viewer needs docker and lsof.
process.env.PATH = [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/sbin', '/sbin'].join(':');
// Auto-advance starts the next track with no click, which Chromium would otherwise block.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let window;
let tabBar;
let activeTab = tabs[0];
const loginPrompts = new Map(); // one prompt per site and realm, however many requests are waiting
const attemptedLogins = new Set();

const isUp = tab => fetch(tab.url + tab.health).then(response => response.ok, () => false);

// A copy started from the terminal may already be running, so only start one if needed.
async function ensureServer(tab) {
  if (await isUp(tab)) return;
  // Packaged builds copy the servers next to this file. From source they're one level up.
  require(path.join(__dirname, app.isPackaged ? '' : '..', tab.server));
  const deadline = Date.now() + SERVER_WAIT_MS;
  while (!await isUp(tab)) {
    if (Date.now() > deadline) throw new Error(`${tab.label} server did not start on ${tab.url}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function openExternally(url) {
  if (/^https?:/.test(url)) shell.openExternal(url);
}

function applyDarkMode(tab) {
  const code = tab.dark
    ? `if (!globalThis.DarkReader) { ${DARK_READER} }
       DarkReader.setFetchMethod(window.fetch);
       DarkReader.enable(${DARK_THEME});`
    : 'globalThis.DarkReader?.disable();';
  tab.view.webContents.executeJavaScriptInIsolatedWorld(DARK_READER_WORLD, [{ code: `${code}\n0;` }]).catch(() => {});
}

function toggleDarkMode(id) {
  const tab = tabs.find(item => item.id === id);
  if (!tab || tab.server) return;
  tab.dark = !tab.dark;
  applyDarkMode(tab);
  publishTabs();
}

function publishTabs() {
  tabBar.webContents.send('tabs-changed', {
    active: activeTab.id,
    tabs: tabs.map(tab => ({ id: tab.id, label: tab.label, closable: !tab.server, dark: Boolean(tab.dark) })),
  });
  buildMenu();
}

function createTabView(tab) {
  // Music must keep playing and advancing while hidden. Port tabs can be throttled like any background tab.
  const view = new WebContentsView({
    webPreferences: {
      backgroundThrottling: !tab.server,
      ...(tab.server ? {} : { preload: path.join(__dirname, 'port-tab-preload.cjs') }),
    },
  });
  view.setBackgroundColor(BACKGROUND);
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) openLocalTab(url);
    else openExternally(url);
    return { action: 'deny' };
  });
  if (tab.server) {
    view.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith(tab.url)) return;
      event.preventDefault();
      openExternally(url);
    });
  } else {
    // Port tabs navigate freely so login redirects work, and are named after their page.
    const { port } = new URL(tab.url);
    view.webContents.on('dom-ready', () => { if (tab.dark) applyDarkMode(tab); });
    view.webContents.on('page-title-updated', (event, title) => {
      tab.label = `${port} ${title}`;
      publishTabs();
    });
  }
  view.webContents.loadURL(tab.url).catch(() => {}); // a failed load stays blank, and Cmd+R retries it
  window.contentView.addChildView(view);
  tab.view = view;
}

function layout() {
  const { width, height } = window.getContentBounds();
  tabBar.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT });
  for (const tab of tabs) tab.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: height - TAB_BAR_HEIGHT });
}

function selectTab(id) {
  const next = tabs.find(tab => tab.id === id);
  if (!next) return;
  activeTab = next;
  for (const tab of tabs) tab.view.setVisible(tab === next);
  next.view.webContents.focus();
  publishTabs();
}

function openLocalTab(url) {
  const { origin, port } = new URL(url);
  const existing = tabs.find(tab => new URL(tab.url).origin === origin);
  if (existing) return selectTab(existing.id);
  const tab = { id: origin, label: port, url, dark: true };
  tabs.push(tab);
  createTabView(tab);
  layout();
  selectTab(tab.id);
}

function closeTab(id) {
  const index = tabs.findIndex(tab => tab.id === id);
  const tab = tabs[index];
  if (!tab || tab.server) return;
  tabs.splice(index, 1);
  window.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (activeTab === tab) selectTab(tabs[index - 1].id);
  else publishTabs();
}

function finishLogin(key, credentials) {
  const prompt = loginPrompts.get(key);
  if (!prompt) return;
  loginPrompts.delete(key);
  if (credentials) attemptedLogins.add(key);
  else attemptedLogins.delete(key);
  for (const callback of prompt.callbacks) {
    if (credentials) callback(credentials.username, credentials.password);
    else callback();
  }
  if (!prompt.window.isDestroyed()) prompt.window.close();
}

function askForLogin(key, authInfo, callback) {
  const waiting = loginPrompts.get(key);
  if (waiting) return waiting.callbacks.push(callback);
  const prompt = new BrowserWindow({
    parent: window, modal: true, show: false, width: 360, height: 320,
    resizable: false, minimizable: false, maximizable: false, backgroundColor: BACKGROUND,
    webPreferences: { preload: path.join(__dirname, 'auth-preload.cjs') },
  });
  loginPrompts.set(key, { window: prompt, callbacks: [callback] });
  prompt.once('ready-to-show', () => prompt.show());
  prompt.on('closed', () => finishLogin(key));
  prompt.loadFile(path.join(__dirname, 'auth.html'), {
    query: {
      host: `${authInfo.host}:${authInfo.port}`,
      realm: authInfo.realm || '',
      retry: attemptedLogins.has(key) ? '1' : '',
    },
  });
}

function buildMenu() {
  const history = () => activeTab.view.webContents.navigationHistory;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: !activeTab.server, click: () => closeTab(activeTab.id) },
        ...(IS_MAC ? [] : [{ role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...tabs.slice(0, MAX_NUMBERED_TABS).map((tab, index) => ({
          label: tab.label, accelerator: `CmdOrCtrl+${index + 1}`, click: () => selectTab(tab.id),
        })),
        { type: 'separator' },
        {
          label: 'Dark Mode for This Tab', type: 'checkbox', accelerator: 'CmdOrCtrl+Shift+D',
          enabled: !activeTab.server, checked: Boolean(activeTab.dark), click: () => toggleDarkMode(activeTab.id),
        },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => history().canGoBack() && history().goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => history().canGoForward() && history().goForward() },
        { label: 'Reload Tab', accelerator: 'CmdOrCtrl+R', click: () => activeTab.view.webContents.reload() },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => activeTab.view.webContents.toggleDevTools() },
      ],
    },
    { label: 'Window', submenu: IS_MAC ? [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] : [{ role: 'minimize' }] },
  ]));
}

async function start() {
  await Promise.all(tabs.map(ensureServer));
  window = new BaseWindow({
    width: 1280, height: 860, minWidth: 480, minHeight: 500,
    title: 'Dev Deck', backgroundColor: BACKGROUND,
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } } : {}),
  });
  tabBar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.cjs') } });
  tabBar.setBackgroundColor(BACKGROUND);
  window.contentView.addChildView(tabBar);
  tabs.forEach(createTabView);
  window.on('resize', layout);
  layout();
  ipcMain.on('select-tab', (event, id) => selectTab(id));
  ipcMain.on('close-tab', (event, id) => closeTab(id));
  ipcMain.on('toggle-dark', (event, id) => toggleDarkMode(id));
  ipcMain.on('auth-response', (event, credentials) => {
    for (const [key, prompt] of loginPrompts) {
      if (prompt.window.webContents === event.sender) finishLogin(key, credentials);
    }
  });
  tabBar.webContents.once('did-finish-load', () => selectTab(activeTab.id));
  tabBar.webContents.loadFile(path.join(__dirname, 'tabs.html'));
}

// Electron cancels HTTP basic auth unless the app answers it. Passwords are never
// written to disk: Chromium keeps them in memory until Dev Deck quits.
app.on('login', (event, contents, details, authInfo, callback) => {
  event.preventDefault();
  askForLogin(`${authInfo.host}:${authInfo.port}/${authInfo.realm}`, authInfo, callback);
});

// Local dev servers usually use self-signed certificates. Everywhere else keeps normal checks.
app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
  if (!isLocalUrl(url)) return callback(false);
  event.preventDefault();
  callback(true);
});

app.setName('Dev Deck');
app.whenReady().then(start).catch(error => {
  dialog.showErrorBox('Dev Deck could not start', error.message);
  app.quit();
});
// The servers live in this process, so closing the window ends everything.
app.on('window-all-closed', () => app.quit());
