// Hallow Shield 1.6 test stand-in for the bridge (Linux CI, where HallowShieldBridge.exe can't run): a native messaging
// host that appends every message, exactly as it arrived, to $HALLOW_SHIELD_TEST_LOG (one JSON per line) and answers
// like the bridge does. Same framing: 4-byte little-endian length + UTF-8 JSON.
import fs from 'node:fs';
const log = process.env.HALLOW_SHIELD_TEST_LOG;
let buf = Buffer.alloc(0);
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const msg = buf.subarray(4, 4 + n).toString('utf8'); buf = buf.subarray(4 + n);
    if (log) fs.appendFileSync(log, JSON.stringify(JSON.parse(msg)) + '\n');
    const out = Buffer.from(JSON.stringify({ ok: true, version: '1.8' }));
    const len = Buffer.alloc(4); len.writeUInt32LE(out.length);
    process.stdout.write(Buffer.concat([len, out]));
  }
});
process.stdin.on('end', () => process.exit(0));
