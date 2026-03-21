#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const cmd = process.argv[2];

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
  Usage: npx nextlimiter <command> [options]

  Commands:
    test <url>              Fire N requests and show rate limit behaviour
    benchmark --url <url>   Load test a URL and measure throughput
    inspect <url>           Show rate limit headers for a single request

  Examples:
    npx nextlimiter test https://api.example.com/users
    npx nextlimiter test https://api.example.com --requests 200 --delay 10
    npx nextlimiter benchmark --url http://localhost:3000 --duration 30
    npx nextlimiter inspect https://api.example.com
  `);
  process.exit(0);
}

if (cmd === '--version' || cmd === '-v') {
  const pkg = require('../package.json');
  console.log('v' + pkg.version);
  process.exit(0);
}

const commands = {
  test: require('./commands/test'),
  benchmark: require('./commands/benchmark'),
  inspect: require('./commands/inspect')
};

if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

commands[cmd]();
