// A tiny Electron app for EZTest's Electron rung tests.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600, show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs') } });
  win.loadFile(path.join(__dirname, 'index.html'), { query: { variant: process.argv.includes('--variant=renamed') ? 'renamed' : 'standard' } });
  ipcMain.on('open-report', () => {
    const r = new BrowserWindow({ width: 500, height: 400, show: true });
    r.loadFile(path.join(__dirname, 'report.html'));
  });
});
app.on('window-all-closed', () => app.quit());
