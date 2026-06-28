const { app, BrowserWindow } = require('electron');
const path = require('path');

// Load .env before requiring server.js so routes/config.js sees the vars.
// app.isPackaged is true inside the distributed exe, false during `npm run dev`.
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

let mainWindow;

async function createWindow() {
  const { start } = require('./server');
  const PORT = parseInt(process.env.PORT) || 3000;
  await start(PORT);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Hotel Finder',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
