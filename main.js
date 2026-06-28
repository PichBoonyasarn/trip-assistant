const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');

// Load .env before requiring any server so routes see the env vars.
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

const LAUNCHER_PORT      = parseInt(process.env.PORT) || 3000;
const HOTEL_FINDER_PORT  = 3001;
const HOTEL_INFO_PORT    = 3002;
const GENBA_INFO_PORT    = 3003;

// Tell the launcher which localhost URLs each sub-app is on.
// This overrides any Render URLs that might be in .env when running as Electron.
process.env.HOTEL_FINDER_URL = `http://localhost:${HOTEL_FINDER_PORT}`;
process.env.HOTEL_INFO_URL   = `http://localhost:${HOTEL_INFO_PORT}`;
process.env.GENBA_INFO_URL   = `http://localhost:${GENBA_INFO_PORT}`;

let mainWindow;

async function startAllServers() {
  const launcher    = require('./server');
  const hotelFinder = require('./apps/hotel-finder/server');
  const hotelInfo   = require('./apps/hotel-info/server');
  const genbaInfo   = require('./apps/genba-info/server');

  await Promise.all([
    launcher.start(LAUNCHER_PORT),
    hotelFinder.start(HOTEL_FINDER_PORT),
    hotelInfo.start(HOTEL_INFO_PORT),
    genbaInfo.start(GENBA_INFO_PORT),
  ]);
}

async function createWindow() {
  await startAllServers();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: '出張アシスタント',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${LAUNCHER_PORT}`);

  // Ctrl+Home / Cmd+Home → return to launcher from any sub-app
  app.whenReady().then(() => {
    globalShortcut.register('CommandOrControl+Home', () => {
      if (mainWindow) mainWindow.loadURL(`http://localhost:${LAUNCHER_PORT}`);
    });
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
