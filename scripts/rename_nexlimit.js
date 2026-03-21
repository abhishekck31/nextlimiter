const fs = require('fs');
const path = require('path');

const rootDir = process.cwd();
const excludeDirs = ['node_modules', '.git'];

function walk(dir) {
  let files = fs.readdirSync(dir);
  for (let file of files) {
    let fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (!excludeDirs.includes(file)) {
        walk(fullPath);
      }
    } else {
      processFile(fullPath);
    }
  }
}

function processFile(filePath) {
  if (filePath.endsWith('.js') || filePath.endsWith('.md') || filePath.endsWith('.json') || filePath.endsWith('.ts')) {
    let content = fs.readFileSync(filePath, 'utf8');
    // Regex that matches 'nextlimiter' or 'NextLimiter' but ONLY if not already followed by 'er'
    let newContent = content.replace(/nextlimiter(?!er)/g, 'nextlimiter').replace(/NextLimiter(?!er)/g, 'NextLimiter');
    if (content !== newContent) {
      fs.writeFileSync(filePath, newContent, 'utf8');
      console.log(`Updated content: ${filePath}`);
    }
  }
}

walk(rootDir);

// Rename files
const filesToRename = [
  'tests/nextlimiter.test.js'
];

for (let f of filesToRename) {
  let oldPath = path.join(rootDir, f);
  let newPath = oldPath.replace('nextlimiter', 'nextlimiter');
  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
    console.log(`Renamed file: ${oldPath} -> ${newPath}`);
  }
}
