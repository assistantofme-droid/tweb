// Builds the bundled Persian lang pack (src/lib/sevenNine/lang/fa.ts).
//
// Sources, first wins:
//   1. src/scripts/in/sevenNine-fa-extra.json — our own translations (keys
//      Telegram's translators haven't done, or ones we word differently)
//   2. Telegram's "webk" Persian pack, 3. its "android" Persian pack
//      (downloaded from translations.telegram.org, or passed as files:
//      node src/scripts/sevenNine_lang_fa.js [webk.strings] [android.xml])
//
// Only keys the app has in English (src/scripts/out/langPack.strings) are
// kept; "Telegram" becomes "7eve9Chat" and links follow the English ones. A
// translation whose placeholders differ from the English is dropped (the
// English stays), so formatting never breaks.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EN_FILE = path.join(ROOT, 'src/scripts/out/langPack.strings');
const EXTRA_FILE = path.join(ROOT, 'src/scripts/in/sevenNine-fa-extra.json');
const OUT_FILE = path.join(ROOT, 'src/lib/sevenNine/lang/fa.ts');
const EXPORT_URL = 'https://translations.telegram.org/fa/%s/export';
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL_SUFFIX = new RegExp(`_(${PLURAL_FORMS.join('|')})$`);

function parseStrings(text) {
  const out = new Map();
  const re = /^"((?:[^"\\]|\\.)+)"\s*=\s*"((?:[^"\\]|\\.)*)";/gm;
  let m;
  while((m = re.exec(text))) {
    out.set(m[1], m[2].replace(/\\(["\\n])/g, (_, c) => c === 'n' ? '\n' : c));
  }

  return out;
}

function parseAndroidXml(text) {
  const out = new Map();
  const re = /<string name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
  let m;
  while((m = re.exec(text))) {
    const value = m[2]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&')
    .replace(/\\n/g, '\n').replace(/\\'/g, '\'').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    out.set(m[1], value);
  }

  return out;
}

async function loadExport(platform, file) {
  const text = file ?
    fs.readFileSync(file, 'utf8') :
    await fetch(EXPORT_URL.replace('%s', platform)).then((response) => {
      if(!response.ok) throw new Error(`${platform} export: HTTP ${response.status}`);
      return response.text();
    });
  return text.trimStart().startsWith('<?xml') ? parseAndroidXml(text) : parseStrings(text);
}

// key -> {plural: false, value} | {plural: true, forms: {one: ..., other: ...}}
function group(strings) {
  const out = new Map();
  for(const [key, value] of strings) {
    const m = key.match(PLURAL_SUFFIX);
    if(!m) {
      if(!out.has(key)) out.set(key, {plural: false, value});
      continue;
    }

    const base = key.slice(0, -m[0].length);
    let entry = out.get(base);
    if(!entry || !entry.plural) out.set(base, entry = {plural: true, forms: {}});
    entry.forms[m[1]] = value;
  }

  return out;
}

const PLACEHOLDER = /%(\d+\$)?[sdf@]|\bun\d\b|\*\*|__|~~|\[|\]\(/g;
const placeholders = (s) => (s.match(PLACEHOLDER) || []).sort().join(' ');
const URL_RE = /https?:\/\/[^\s)\]"']+/g;
const TELEGRAM_URL = /^https?:\/\/(?:[\w-]+\.)*(?:telegram\.(?:org|me)|t\.me)(?:\/|$)/;

function rebrand(fa, en) {
  const enUrls = en.match(URL_RE) || [];
  let i = 0;
  return fa
  .replace(URL_RE, (url) => enUrls[i++] || (TELEGRAM_URL.test(url) ? 'https://7eve9craft.ir' : url))
  // link texts: the site, as in the English
  .replace(/\b(?:getdesktop\.telegram\.org|telegram\.org\/dl)\/?(?=[\])\s]|$)/g, '7eve9craft.ir')
  .replace(/(^|[\s[(])t\.me\//g, (match, before) => en.includes('t.me/') ? match : before + '7eve9craft.ir/')
  .replace(/تلگرامی/g, '7eve9Chat')
  .replace(/تلگرام/g, '7eve9Chat')
  .replace(/Telegram/g, '7eve9Chat');
}

// the Persian value for one English entry, or undefined to keep the English
function translate(enEntry, faEntry) {
  if(!faEntry) return;
  const pick = (form) => faEntry.plural ? (faEntry.forms[form] ?? faEntry.forms.other ?? faEntry.forms.one) : faEntry.value;

  if(!enEntry.plural) {
    const value = pick('other');
    if(value === undefined || placeholders(value) !== placeholders(enEntry.value)) return;
    return rebrand(value, enEntry.value);
  }

  const out = {};
  // Persian has "one" and "other"; every English form gets a value
  for(const form of Object.keys(enEntry.forms)) {
    const value = pick(form === 'one' ? 'one' : 'other');
    const en = enEntry.forms[form];
    if(value === undefined) return;
    // "one" may spell the number out instead of using %d
    const sameShape = placeholders(value) === placeholders(en) ||
      (form === 'one' && placeholders(value.replace(/%d/g, '')) === placeholders(en.replace(/%d/g, '')));
    if(!sameShape) return;
    out[form + '_value'] = rebrand(value, en);
  }

  return out;
}

const quote = (s) => '\'' + s.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\n/g, '\\n') + '\'';

function serialize(version, entries) {
  const lines = entries.map(([key, value]) => {
    if(typeof(value) === 'string') return `  ${quote(key)}: ${quote(value)}`;
    const forms = Object.entries(value).map(([form, v]) => `    ${quote(form)}: ${quote(v)}`);
    return `  ${quote(key)}: {\n${forms.join(',\n')}\n  }`;
  });

  return [
    '// Generated by src/scripts/sevenNine_lang_fa.js from Telegram\'s Persian',
    '// translations and src/scripts/in/sevenNine-fa-extra.json. Do not edit.',
    '',
    `export const FA_LANG_PACK_VERSION = ${version};`,
    '',
    'const fa: Record<string, string | {[form: string]: string}> = {',
    lines.join(',\n'),
    '};',
    '',
    'export default fa;',
    ''
  ].join('\n');
}

(async() => {
  const [webkFile, androidFile] = process.argv.slice(2);
  const en = group(parseStrings(fs.readFileSync(EN_FILE, 'utf8')));
  const extra = group(new Map(Object.entries(JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8')))));
  const sources = [
    extra,
    group(await loadExport('webk', webkFile)),
    group(await loadExport('android', androidFile))
  ];

  const entries = [];
  const dropped = [];
  let untranslated = 0;
  for(const [key, enEntry] of en) {
    let value;
    let found = false;
    for(const source of sources) {
      const faEntry = source.get(key);
      if(!faEntry) continue;
      found = true;
      value = translate(enEntry, faEntry);
      if(value !== undefined) break;
    }

    if(value !== undefined) entries.push([key, value]);
    else if(found) dropped.push(key);
    else ++untranslated;
  }

  entries.sort(([a], [b]) => a.localeCompare(b));
  // yyyymmddhh: newer than any pack a client already has, so they refetch it
  const now = new Date();
  const pad = (n) => ('0' + n).slice(-2);
  const version = +`${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;

  fs.mkdirSync(path.dirname(OUT_FILE), {recursive: true});
  fs.writeFileSync(OUT_FILE, serialize(version, entries));
  console.log(`fa: ${entries.length}/${en.size} translated, ${untranslated} missing, ${dropped.length} dropped (placeholders differ)`);
  if(dropped.length) console.log('dropped: ' + dropped.join(' '));
})();
