import { createInterface } from 'node:readline/promises';

/** Writes one line to stdout. */
export const out = (text = '') => process.stdout.write(`${text}\n`);

/**
 * Reads one line from the terminal without echoing it.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    let value = '';
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

export function requireTerminal() {
  if (!process.stdin.isTTY) throw new Error('run this in an interactive terminal');
}

/**
 * Asks a question and reads the answer, with echo.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export async function readLine(prompt) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
}
