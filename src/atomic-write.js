const fs = require('node:fs');
const path = require('node:path');

function atomicWriteFileSync(filePath, data, options) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, data, options);
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw e;
  }
}

module.exports = { atomicWriteFileSync };
