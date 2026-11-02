import { execFileSync } from 'node:child_process';

// Where the development tools look for the PswOpen in the macOS Keychain.
// Save it once with (it asks for the value without echo):
//   security add-generic-password -s much-smarther-pswopen -a thermostat -w
export const KEYCHAIN_SERVICE = 'much-smarther-pswopen';
export const KEYCHAIN_ACCOUNT = 'thermostat';

/**
 * Reads the PswOpen from the macOS Keychain.
 * @returns {string | undefined} undefined when not on macOS or not saved
 */
export function readPswOpenFromKeychain() {
  if (process.platform !== 'darwin') return undefined;
  try {
    const value = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return value.replace(/\r?\n$/, '') || undefined;
  } catch {
    return undefined;
  }
}
