#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [cmd, ...argv] = process.argv.slice(2);
const available = fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort();
if (!available.includes(cmd)) {
  console.log('Available commands: ' + available.join(', '));
  process.exitCode = cmd && cmd !== '--help' ? 1 : 0;
} else Promise.resolve().then(() => {
  if (cmd === 'doctor' && process.platform !== 'win32') console.log('Optional gifsicle: brew install gifsicle (macOS) or sudo apt install gifsicle (Linux). Linux ARM64 gifski: build from source; Pillow is available as fallback.');
  return require('./commands/' + cmd + '.js').run(argv);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
