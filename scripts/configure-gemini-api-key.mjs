import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env.local');
const variableName = 'GEMINI_API_KEY';

function readHidden(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const chunks = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdout.write(prompt);

    let value = '';
    function onKeypress(character, key = {}) {
      if (key.name === 'return' || key.name === 'enter') {
        process.stdin.setRawMode(false);
        process.stdin.off('keypress', onKeypress);
        process.stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (key.ctrl && key.name === 'c') {
        process.stdin.setRawMode(false);
        process.stdin.off('keypress', onKeypress);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (character) value += character;
    }

    process.stdin.on('keypress', onKeypress);
  });
}

function updateEnvContent(content, key) {
  const assignment = `${variableName}=${key}`;
  const lines = content.split(/\r?\n/u);
  const index = lines.findIndex((line) => new RegExp(`^\\s*${variableName}\\s*=`).test(line));

  if (index >= 0) {
    lines[index] = assignment;
    return lines.join('\n');
  }

  const suffix = content && !content.endsWith('\n') ? '\n' : '';
  return `${content}${suffix}${assignment}\n`;
}

const apiKey = await readHidden('Paste Gemini API key: ');

if (!apiKey) {
  console.error('No key provided. .env.local was not changed.');
  process.exit(1);
}

if (/[\r\n]/u.test(apiKey)) {
  console.error('Invalid key: newline characters are not allowed.');
  process.exit(1);
}

const currentContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const nextContent = updateEnvContent(currentContent, apiKey);

fs.writeFileSync(envPath, nextContent, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);

console.log(`${variableName} configured in ${envPath}`);
