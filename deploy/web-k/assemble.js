// Puts the servable app together: the build (dist/) over the static files
// of public/ that the build keeps (images, manifests, recorder workers...) —
// the same selection build.js makes. Usage: node deploy/web-k/assemble.js <out>

const fs = require('fs');
const path = require('path');
const keepAsset = require('../../keepAsset');

const root = path.join(__dirname, '..', '..');
const out = path.resolve(process.argv[2] || path.join(root, 'web-k'));

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

for(const entry of fs.readdirSync(path.join(root, 'public'), {withFileTypes: true})) {
  if(entry.isDirectory() || keepAsset(entry.name)) {
    fs.cpSync(path.join(root, 'public', entry.name), path.join(out, entry.name), {recursive: true});
  }
}

fs.cpSync(path.join(root, 'dist'), out, {recursive: true});
console.log('assembled', out);
