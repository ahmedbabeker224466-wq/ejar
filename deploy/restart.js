'use strict';

// Restarts the app on cPanel: Passenger restarts a Node app when the
// modification time of tmp/restart.txt (in the application root) changes.
// Run with `npm run restart`, or from "Setup Node.js App" -> "Run JS script".

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'tmp');
const file = path.join(dir, 'restart.txt');

fs.mkdirSync(dir, { recursive: true });
const now = new Date();
fs.writeFileSync(file, `${now.toISOString()}\n`);
fs.utimesSync(file, now, now);
console.log(`Touched ${path.relative(process.cwd(), file) || file}; the app restarts on its next request.`);
