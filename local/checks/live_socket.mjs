// Helper of live_check.py: connects to the API socket like the web app does and
// prints every 'changed' event as one JSON line. Arguments: <socket url> <token|"-">
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../parisahon-client/app/package.json'));
const { io } = require('socket.io-client');

const [url, token] = process.argv.slice(2);
const socket = io(url, { transports: ['websocket'], auth: { token: token === '-' ? '' : token }, reconnection: false });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
socket.on('connect', () => out({ connected: true }));
socket.on('connect_error', (e) => { out({ connect_error: String(e?.message || e) }); process.exit(0); });
socket.on('changed', (payload) => out({ changed: payload }));
setTimeout(() => process.exit(0), Number(process.env.LIVE_SECONDS || 60) * 1000);
