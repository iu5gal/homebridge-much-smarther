import {
  CONFIGURATION_FILE,
  parseConfiguration,
  parseProgramProfile,
  programFileName,
  WEEKDAYS,
} from '@much-smarther/core';
import { checksumDiagnosis, personalCandidates } from './file-report.mjs';

// The steps of tools/read-files.mjs, apart from the terminal, so that tests
// can run them against the simulator. Only GET requests are sent.

/** @param {unknown} error */
export const describe = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** @param {object} value */
const fields = (value) =>
  Object.entries(value)
    .map(([key, entry]) => `${key}=${typeof entry === 'object' ? JSON.stringify(entry) : String(entry)}`)
    .join(' · ');

/** @param {(line?: string) => void} out @param {readonly string[]} issues */
const printIssues = (out, issues) => {
  if (issues.length > 0) out(`  issues: ${issues.join('; ')}`);
};

/** @param {(line?: string) => void} out @param {import('@much-smarther/core').ProgramProfile} program */
function printProgram(out, program) {
  out(`  program ${program.number ?? '?'} "${program.name ?? '?'}" (${program.type ?? '?'}, valid=${program.valid ?? '?'})`);
  for (const day of WEEKDAYS) {
    const slots = program.days[day].map((slot) => `${slot.time} ${slot.preset}`).join(', ');
    out(`    ${day.padEnd(9)} ${slots || '(no slots)'}`);
  }
}

/**
 * Prints the result of the checksum check; on a mismatch, what may explain it.
 * @param {(line?: string) => void} out
 * @param {import('@much-smarther/core').DeviceFile} file
 */
function printChecksum(out, file) {
  out(`  checksum: ${file.checksum}`);
  if (file.checksum !== 'mismatch' || file.sha256sum === undefined) return;
  const { facts, matching } = checksumDiagnosis(file.text, file.sha256sum);
  out(`    text: ${facts.join('; ')}`);
  out(`    variants with the expected checksum: ${matching.length > 0 ? matching.join(', ') : 'none'}`);
}

/**
 * Reads diagnostics, configuration and programs, printing a summary with
 * `out` and handing the text of each file to `recordStructure`. A failed
 * step is reported and the next one still runs.
 * @param {import('@much-smarther/core').XOpenClient} client an authenticated client
 * @param {(line?: string) => void} out
 * @param {(name: string, text: string) => void} recordStructure
 * @returns {Promise<{ field: string, value: string }[] | undefined>} values that identify the
 *   installation, or `undefined` if the configuration could not be read
 */
export async function runProbe(client, out, recordStructure) {
  /** @type {{ field: string, value: string }[] | undefined} */
  let candidates;
  out('Diagnostics:');
  try {
    const { value, issues } = await client.getDiagnostic();
    out(`  ${fields(value) || '(no known fields)'}`);
    printIssues(out, issues);
  } catch (error) {
    out(`  failed: ${describe(error)}`);
  }

  out('\nConfiguration:');
  try {
    const file = await client.readDeviceFile(CONFIGURATION_FILE);
    printChecksum(out, file);
    recordStructure(CONFIGURATION_FILE, file.text);
    const { value, issues } = parseConfiguration(file.text);
    out(`  heating: ${fields(value.heating) || '?'}`);
    out(`  cooling: ${fields(value.cooling) || '?'}`);
    const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'heating' && key !== 'cooling'));
    out(`  other:   ${fields(rest) || '?'}`);
    printIssues(out, issues);
    candidates = personalCandidates(file.text);
  } catch (error) {
    out(`  failed: ${describe(error)}`);
  }

  out('\nPrograms:');
  try {
    const present = (await client.getProgramList()).filter((slot) => slot.present).map((slot) => slot.number);
    for (const number of present) {
      try {
        const file = await client.readDeviceFile(programFileName(number));
        recordStructure(programFileName(number), file.text);
        const { value, issues } = parseProgramProfile(file.text);
        printProgram(out, value);
        printChecksum(out, file);
        printIssues(out, issues);
      } catch (error) {
        out(`  program ${number} failed: ${describe(error)}`);
      }
    }
  } catch (error) {
    out(`  program list failed: ${describe(error)}`);
  }
  return candidates;
}
