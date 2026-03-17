#!/usr/bin/env node
const path = require('path');
const { consola } = require('@farever/cli-utils');

function runAsKnownPaks(invokedAs, subcommand) {
  return invokedAs.includes('extract-known-paks') || subcommand === 'extract-known-paks';
}

function main() {
  const invokedAs = path.basename(process.argv[1] || '').toLowerCase();
  const subcommand = process.argv[2] || null;

  if (runAsKnownPaks(invokedAs, subcommand)) {
    if (subcommand === 'extract-known-paks') process.argv.splice(2, 1);
    return require('./extract-known-paks.cjs').run();
  }

  if (subcommand === 'extract-pak') process.argv.splice(2, 1);
  return require('./extract-pak.cjs').main(process.argv);
}

module.exports = {
  main,
};

if (require.main === module) {
  Promise.resolve(main()).catch((err) => {
    consola.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
