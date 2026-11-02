#!/usr/bin/env node
// Builds the installable package of the Homebridge plugin: one tarball with
// the core library inside, so that users install a single npm package.
//
// npm does not bundle workspace packages by itself (they are symlinks), so
// the package is assembled in `pack/homebridge-much-smarther/`: the plugin's
// compiled files, and the core copied as a real directory into its
// `node_modules`, listed in `bundleDependencies`. Source maps and type
// declarations are left out. The staged files are scanned with gitleaks.
//
// Usage: npm run pack:plugin   → pack/homebridge-much-smarther-<version>.tgz

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'packages', 'homebridge-plugin');
const core = join(root, 'packages', 'core');
const out = join(root, 'pack');
const stage = join(out, 'homebridge-much-smarther');

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
/** @param {string} file @param {unknown} value */
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
/** Compiled JavaScript only: no source maps, no type declarations. @param {string} source */
const jsOnly = (source) => !source.endsWith('.map') && !source.endsWith('.d.ts');
/** @param {string} command @param {string[]} args */
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

run('npm', ['run', 'build', '--silent']);
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const corePackage = readJson(join(core, 'package.json'));
const pluginPackage = readJson(join(plugin, 'package.json'));
if (pluginPackage.dependencies[corePackage.name] !== corePackage.version) {
  throw new Error(`the plugin must depend on ${corePackage.name}@${corePackage.version}`);
}

cpSync(join(plugin, 'dist'), join(stage, 'dist'), { recursive: true, filter: jsOnly });
cpSync(join(plugin, 'homebridge-ui'), join(stage, 'homebridge-ui'), { recursive: true });
for (const file of ['config.schema.json', 'README.md']) cpSync(join(plugin, file), join(stage, file));
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
const published = { ...pluginPackage, bundleDependencies: [corePackage.name] };
delete published.devDependencies;
delete published.scripts;
writeJson(join(stage, 'package.json'), published);

const bundled = join(stage, 'node_modules', ...corePackage.name.split('/'));
cpSync(join(core, 'dist'), join(bundled, 'dist'), { recursive: true, filter: jsOnly });
cpSync(join(core, 'README.md'), join(bundled, 'README.md'));
cpSync(join(root, 'LICENSE'), join(bundled, 'LICENSE'));
const coreManifest = { ...corePackage };
delete coreManifest.scripts;
writeJson(join(bundled, 'package.json'), coreManifest);

run('gitleaks', ['dir', '--redact', '--no-banner', stage]);
const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], stage));
if (packed.bundled?.[0] !== corePackage.name) throw new Error('the core library was not bundled');
const tarball = join(out, basename(packed.filename));
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
process.stdout.write(
  `${tarball}\n${packed.entryCount} files, ${(packed.size / 1024).toFixed(1)} KiB, sha256 ${sha256}\n`,
);
