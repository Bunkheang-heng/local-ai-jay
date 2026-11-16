#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`local-ai-jay needs Node 20 or newer (you have ${process.version}).`);
  process.exit(1);
}

const { main } = await import('../src/cli.js');
try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`\nlocal-ai-jay: ${err.message}\n`);
  process.exit(1);
}
