const fs = require("fs");
const path = require("path");

const logPath = path.join(__dirname, "../logs");

const getFileName = async () => {
  if (!fs.existsSync(logPath)) {
    await fs.promises.mkdir(logPath);
  }
  return path.join(logPath, `log-${new Date().toISOString().slice(0, 10)}.log`);
};

async function writeLog(content) {
  if (!content) return;
  const fileName = await getFileName();
  await fs.promises.appendFile(fileName, `${new Date().toISOString()}: ${content}\n`);
}

module.exports = { writeLog };
