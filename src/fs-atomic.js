'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

// Five attempts total, with four waits. Never unlink the destination first.
async function renameWithRetry(from, to) {
  const waits = [50, 100, 200, 400];
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === waits.length) throw error;
      await delay(waits[attempt]);
    }
  }
}

async function writeFileAtomic(target, data, { mode, fsync = true } = {}) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  let created = false;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    created = true;
    await handle.writeFile(data);
    if (fsync) await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporary, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

module.exports = { writeFileAtomic, renameWithRetry };
