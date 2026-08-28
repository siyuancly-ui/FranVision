// FranVision Job Generator -- module 6: Job Root Folder persistence.
//
// Small JSON file on disk so the chosen Job Root Folder survives quitting
// and reopening the launcher (previously server.js only kept it in a
// plain in-memory variable, which reset on every restart). The config
// path is overridable per-call so tests never touch the real file.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '.config.json');

function readConfig(configPath) {
  configPath = configPath || DEFAULT_CONFIG_PATH;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch (err) {
    return {}; // missing file, unreadable, or malformed JSON -- start fresh rather than throw
  }
}

function writeConfig(config, configPath) {
  configPath = configPath || DEFAULT_CONFIG_PATH;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function getRootFolder(defaultValue, configPath) {
  const config = readConfig(configPath);
  return (typeof config.rootFolder === 'string' && config.rootFolder) ? config.rootFolder : defaultValue;
}

function setRootFolder(rootFolder, configPath) {
  const config = readConfig(configPath);
  config.rootFolder = rootFolder;
  writeConfig(config, configPath);
  return config;
}

module.exports = { DEFAULT_CONFIG_PATH, readConfig, writeConfig, getRootFolder, setRootFolder };
