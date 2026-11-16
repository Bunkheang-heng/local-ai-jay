// Copies the files the extension shares with the web console into media/.
const fs = require('fs');
const path = require('path');
for (const file of ['markdown.js', 'model-menu.js']) {
  const from = path.join(__dirname, '..', '..', 'public', file);
  const to = path.join(__dirname, '..', 'media', file);
  fs.copyFileSync(from, to);
  console.log(`Copied ${path.relative(process.cwd(), from)} -> ${path.relative(process.cwd(), to)}`);
}
