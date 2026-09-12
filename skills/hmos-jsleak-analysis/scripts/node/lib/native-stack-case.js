import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputTailLimit = 64 * 1024;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const analysisRoot = path.resolve(moduleDir, '..', '..', '..', '..');
const nativeStackScript = path.join(analysisRoot, 'jsleak-analysis', 'scripts', 'node', 'heap_node_native_stack.mjs');

function resolveInputBase(opts) {
  const explicitInput = opts.rawheap || opts.htrace || opts.jsMap ||
    opts.snapshot || opts.clusterJson || opts.nativeHookDb;
  return opts.caseDir
    ? path.resolve(opts.caseDir)
    : (explicitInput ? path.dirname(path.resolve(explicitInput)) : process.cwd());
}

function resolveOutDir(opts, caseDir) {
  return path.resolve(opts.outDir || opts.caseDir || caseDir);
}

async function ensureDirectory(dirPath, label) {
  const stat = await fs.stat(dirPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dirPath}`);
  }
}

async function ensureFile(filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`${label} does not exist or is not a file: ${filePath}`);
  }
  return filePath;
}

async function listCaseFiles(caseDir) {
  const entries = await fs.readdir(caseDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(caseDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function selectSingleFile(files, predicate, label) {
  const matches = files.filter(filePath => predicate(path.basename(filePath)));
  if (matches.length > 1) {
    throw new Error(`Found multiple ${label} files:\n${matches.map(item => `  ${item}`).join('\n')}`);
  }
  return matches[0] || null;
}

function selectJsMap(files) {
  const primary = selectSingleFile(
    files,
    fileName => /^js_map.*\.txt$/iu.test(fileName),
    'js map',
  );
  if (primary) {
    return primary;
  }
  return selectSingleFile(files, fileName => /^map\.txt$/iu.test(fileName), 'map');
}

function isClusterJsonName(fileName) {
  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith('.clusters.json') &&
    !lowerName.endsWith('.cluster-native-stacks.json');
}

function resolveExplicitPath(value) {
  return value ? path.resolve(value) : null;
}

function chooseExpectedArtifact(expectedPath, discoveredPath) {
  return expectedPath || discoveredPath || null;
}

async function discoverCaseInputs(opts, caseDir, outDir) {
  const files = await listCaseFiles(caseDir);
  const rawheap = resolveExplicitPath(opts.rawheap) || selectSingleFile(
    files, fileName => fileName.toLowerCase().endsWith('.rawheap'), 'rawheap',
  );
  const htrace = resolveExplicitPath(opts.htrace) || selectSingleFile(
    files, fileName => fileName.toLowerCase().endsWith('.htrace'), 'htrace',
  );
  const jsMap = resolveExplicitPath(opts.jsMap) || selectJsMap(files);
  const snapshot = resolveExplicitPath(opts.snapshot) || findSnapshot(files, rawheap, outDir);
  const clusterJson = resolveExplicitPath(opts.clusterJson) ||
    findClusterJson(files, snapshot, outDir);
  const nativeHookDb = resolveExplicitPath(opts.nativeHookDb) ||
    findNativeHookDb(files, htrace, outDir);
  return {
    rawheap,
    htrace,
    jsMap,
    snapshot,
    clusterJson,
    nativeHookDb,
    explicit: {
      snapshot: Boolean(opts.snapshot),
      clusterJson: Boolean(opts.clusterJson),
      nativeHookDb: Boolean(opts.nativeHookDb),
    },
  };
}

function findSnapshot(files, rawheap, outDir) {
  if (rawheap) {
    const expected = path.join(outDir, `${path.basename(rawheap, path.extname(rawheap))}.heapsnapshot`);
    const sameDir = path.join(path.dirname(rawheap), path.basename(expected));
    return chooseExpectedArtifact(
      files.includes(expected) ? expected : (files.includes(sameDir) ? sameDir : null),
      selectSingleFile(files, fileName => fileName.toLowerCase().endsWith('.heapsnapshot'), 'heapsnapshot'),
    );
  }
  return selectSingleFile(files, fileName => fileName.toLowerCase().endsWith('.heapsnapshot'), 'heapsnapshot');
}

function findClusterJson(files, snapshot, outDir) {
  if (snapshot) {
    const baseName = path.basename(snapshot, path.extname(snapshot));
    const expected = path.join(outDir, `${baseName}.clusters.json`);
    if (files.includes(expected)) {
      return expected;
    }
  }
  return selectSingleFile(files, isClusterJsonName, 'cluster JSON');
}

function findNativeHookDb(files, htrace, outDir) {
  if (htrace) {
    const expected = path.join(outDir, `${path.basename(htrace, path.extname(htrace))}.db`);
    return files.includes(expected) ? expected : null;
  }
  const namedDb = selectSingleFile(
    files,
    fileName => fileName.toLowerCase().endsWith('.db') &&
      fileName.toLowerCase().includes('native_hook'),
    'native hook db',
  );
  if (namedDb) {
    return namedDb;
  }
  return htrace
    ? null
    : selectSingleFile(files, fileName => fileName.toLowerCase().endsWith('.db'), 'SQLite db');
}

function isThreeInOneMode(opts, discovered) {
  const explicitNewInput = Boolean(opts.rawheap || opts.htrace || opts.jsMap || opts.traceStreamer);
  const completeRawInput = Boolean(discovered.rawheap && discovered.htrace);
  const resumeInput = Boolean(
    discovered.jsMap &&
    (opts.snapshot || opts.clusterJson || opts.nativeHookDb),
  );
  return explicitNewInput || completeRawInput || resumeInput;
}

async function validateExplicitInputs(opts, discovered) {
  const validations = [
    [opts.rawheap, discovered.rawheap, 'rawheap'],
    [opts.htrace, discovered.htrace, 'htrace'],
    [opts.jsMap, discovered.jsMap, 'js map'],
    [opts.snapshot, discovered.snapshot, 'heapsnapshot'],
    [opts.clusterJson, discovered.clusterJson, 'cluster JSON'],
    [opts.nativeHookDb, discovered.nativeHookDb, 'native hook db'],
  ];
  for (const [explicitValue, resolvedValue, label] of validations) {
    if (explicitValue) {
      await ensureFile(resolvedValue, label);
    }
  }
}

async function isFreshArtifact(outputPath, sourcePaths) {
  const outputStat = await fs.stat(outputPath).catch(() => null);
  if (!outputStat?.isFile() || outputStat.size === 0) {
    return false;
  }
  for (const sourcePath of sourcePaths.filter(Boolean)) {
    const sourceStat = await fs.stat(sourcePath);
    if (outputStat.mtimeMs < sourceStat.mtimeMs) {
      return false;
    }
  }
  return true;
}

async function readFilePrefix(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function isFreshSqliteDatabase(databasePath, sourcePaths) {
  if (!await isFreshArtifact(databasePath, sourcePaths)) {
    return false;
  }
  const prefix = await readFilePrefix(databasePath);
  return prefix.startsWith('SQLite format 3\u0000');
}

async function validateExecutable(filePath, label) {
  await ensureFile(filePath, label);
  const prefix = await readFilePrefix(filePath);
  if (prefix.startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new Error(`${label} is a Git LFS pointer; run git lfs pull: ${filePath}`);
  }
}

function platformToolNames() {
  if (process.platform === 'win32') {
    return {
      traceStreamer: 'trace_streamer_windows.exe',
      rawheapTranslator: path.join('windows', 'rawheap_translator.exe'),
    };
  }
  if (process.platform === 'linux') {
    return {
      traceStreamer: 'trace_streamer_linux',
      rawheapTranslator: path.join('linux', 'rawheap_translator'),
    };
  }
  const translatorName = process.arch === 'arm64'
    ? 'rawheap_translator_arm64'
    : 'rawheap_translator_x64';
  return {
    traceStreamer: 'trace_streamer_mac',
    rawheapTranslator: path.join('macos', translatorName),
  };
}

function resolveToolPaths(opts) {
  const names = platformToolNames();
  return {
    traceStreamer: opts.traceStreamer
      ? path.resolve(opts.traceStreamer)
      : path.join(analysisRoot, 'nativeleak-analysis', 'scripts', names.traceStreamer),
    rawheapTranslator: path.join(
      analysisRoot,
      'jsleak-analysis',
      'scripts',
      names.rawheapTranslator,
    ),
  };
}

function appendOutputTail(current, chunk) {
  const combined = `${current}${chunk.toString('utf8')}`;
  return combined.length > outputTailLimit
    ? combined.slice(combined.length - outputTailLimit)
    : combined;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutTail = '';
    let stderrTail = '';
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      stdoutTail = appendOutputTail(stdoutTail, chunk);
    });
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      stderrTail = appendOutputTail(stderrTail, chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdoutTail, stderrTail }));
  });
}

function commandFailure(label, result) {
  const status = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
  const detail = result.stderrTail.trim() || result.stdoutTail.trim();
  return new Error(`${label} failed with ${status}${detail ? `\n${detail}` : ''}`);
}

async function replaceArtifact(tempPath, outputPath) {
  const stat = await fs.stat(tempPath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`Generated artifact is missing or empty: ${tempPath}`);
  }
  await fs.rm(outputPath, { force: true });
  await fs.rename(tempPath, outputPath);
}

async function moveOptionalSidecar(tempPath, outputPath, suffix) {
  const tempSidecar = `${tempPath}${suffix}`;
  const sidecarStat = await fs.stat(tempSidecar).catch(() => null);
  if (!sidecarStat?.isFile()) {
    return;
  }
  const outputSidecar = `${outputPath}${suffix}`;
  await fs.rm(outputSidecar, { force: true });
  await fs.rename(tempSidecar, outputSidecar);
}

function temporaryArtifactPath(outputPath) {
  const extension = path.extname(outputPath);
  const baseName = path.basename(outputPath, extension);
  return path.join(
    path.dirname(outputPath),
    `${baseName}.tmp-${process.pid}-${Date.now()}${extension}`,
  );
}

async function convertHtrace(htrace, outputPath, traceStreamer) {
  await validateExecutable(traceStreamer, 'trace_streamer');
  const tempPath = temporaryArtifactPath(outputPath);
  await fs.rm(tempPath, { force: true });
  const result = await runCommand(traceStreamer, [htrace, '-e', tempPath]);
  if (result.code !== 0) {
    await fs.rm(tempPath, { force: true });
    throw commandFailure('htrace conversion', result);
  }
  await replaceArtifact(tempPath, outputPath);
  await moveOptionalSidecar(tempPath, outputPath, '.ohos.ts');
}

function resumeCommand(inputs, outputDir, nativeHookDb) {
  const snapshotArg = inputs.snapshot || '<converted.heapsnapshot>';
  return [
    `node "${nativeStackScript}"`,
    `--snapshot "${snapshotArg}"`,
    `--native-hook-db "${nativeHookDb}"`,
    `--js-map "${inputs.jsMap}"`,
    inputs.clusterJson ? `--cluster-json "${inputs.clusterJson}"` : '',
    `--out-dir "${outputDir}"`,
  ].filter(Boolean).join(' ');
}

async function convertRawheap(rawheap, outputPath, translator, resumeContext) {
  await validateExecutable(translator, 'rawheap_translator');
  const tempPath = temporaryArtifactPath(outputPath);
  await fs.rm(tempPath, { force: true });
  const result = await runCommand(translator, [rawheap, tempPath]);
  if (result.code === 0) {
    await replaceArtifact(tempPath, outputPath);
    return;
  }
  await fs.rm(tempPath, { force: true });
  const failure = commandFailure('rawheap conversion', result);
  throw new Error([
    failure.message,
    `Preserved native hook DB: ${resumeContext.nativeHookDb}`,
    `Resume after obtaining a valid heapsnapshot: ${resumeContext.command}`,
  ].join('\n'));
}

async function moveGeneratedFiles(stagingDir, outputDir) {
  const entries = await fs.readdir(stagingDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const sourcePath = path.join(stagingDir, entry.name);
    const outputPath = path.join(outputDir, entry.name);
    await fs.rm(outputPath, { force: true });
    await fs.rename(sourcePath, outputPath);
  }
}

async function runHeapCluster(snapshot, outputDir) {
  const clusterScript = path.join(analysisRoot, 'jsleak-analysis', 'scripts', 'node', 'heap_cluster.js');
  const stagingDir = path.join(outputDir, `.native-stack-cluster-${process.pid}-${Date.now()}`);
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    const result = await runCommand(process.execPath, [clusterScript, snapshot, stagingDir]);
    const baseName = path.basename(snapshot, path.extname(snapshot));
    const stagedJson = path.join(stagingDir, `${baseName}.clusters.json`);
    if (result.code !== 0 || !await isFreshArtifact(stagedJson, [snapshot])) {
      throw commandFailure('heap clustering', result);
    }
    await moveGeneratedFiles(stagingDir, outputDir);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

async function prepareDatabase(inputs, outDir, tools, stages) {
  const freshnessSources = inputs.explicit.nativeHookDb ? [] : [inputs.htrace];
  if (inputs.nativeHookDb &&
      await isFreshSqliteDatabase(inputs.nativeHookDb, freshnessSources)) {
    stages.push({ name: 'htrace_to_db', status: 'reused', output: inputs.nativeHookDb });
    return inputs.nativeHookDb;
  }
  if (inputs.explicit.nativeHookDb) {
    throw new Error(`Explicit native hook db is empty or invalid: ${inputs.nativeHookDb}`);
  }
  if (!inputs.htrace) {
    throw new Error('Three-in-one analysis requires --htrace or --native-hook-db');
  }
  await ensureFile(inputs.htrace, 'htrace');
  const outputPath = path.join(outDir, `${path.basename(inputs.htrace, path.extname(inputs.htrace))}.db`);
  if (await isFreshSqliteDatabase(outputPath, [inputs.htrace])) {
    stages.push({ name: 'htrace_to_db', status: 'reused', input: inputs.htrace, output: outputPath });
    return outputPath;
  }
  console.log(`[prepare] Converting htrace to SQLite DB: ${outputPath}`);
  await convertHtrace(inputs.htrace, outputPath, tools.traceStreamer);
  stages.push({ name: 'htrace_to_db', status: 'generated', input: inputs.htrace, output: outputPath });
  return outputPath;
}

async function prepareSnapshot(inputs, outDir, tools, stages, nativeHookDb) {
  const freshnessSources = inputs.explicit.snapshot ? [] : [inputs.rawheap];
  if (inputs.snapshot && await isFreshArtifact(inputs.snapshot, freshnessSources)) {
    stages.push({ name: 'rawheap_to_snapshot', status: 'reused', output: inputs.snapshot });
    return inputs.snapshot;
  }
  if (inputs.explicit.snapshot) {
    throw new Error(`Explicit heapsnapshot is empty or invalid: ${inputs.snapshot}`);
  }
  if (!inputs.rawheap) {
    throw new Error('Three-in-one analysis requires --rawheap, --snapshot, or --cluster-json');
  }
  await ensureFile(inputs.rawheap, 'rawheap');
  const outputPath = path.join(
    outDir,
    `${path.basename(inputs.rawheap, path.extname(inputs.rawheap))}.heapsnapshot`,
  );
  if (await isFreshArtifact(outputPath, [inputs.rawheap])) {
    stages.push({ name: 'rawheap_to_snapshot', status: 'reused', input: inputs.rawheap, output: outputPath });
    return outputPath;
  }
  console.log(`[prepare] Converting rawheap to heapsnapshot: ${outputPath}`);
  const resumeInputs = { ...inputs, snapshot: outputPath };
  const context = {
    nativeHookDb,
    command: resumeCommand(resumeInputs, outDir, nativeHookDb),
  };
  await convertRawheap(inputs.rawheap, outputPath, tools.rawheapTranslator, context);
  stages.push({ name: 'rawheap_to_snapshot', status: 'generated', input: inputs.rawheap, output: outputPath });
  return outputPath;
}

async function prepareClusterJson(inputs, snapshot, outDir, stages) {
  const freshnessSources = inputs.explicit.clusterJson ? [] : [snapshot];
  if (inputs.clusterJson && await isFreshArtifact(inputs.clusterJson, freshnessSources)) {
    stages.push({ name: 'heap_cluster', status: 'reused', output: inputs.clusterJson });
    return inputs.clusterJson;
  }
  if (inputs.explicit.clusterJson) {
    throw new Error(`Explicit cluster JSON is empty or invalid: ${inputs.clusterJson}`);
  }
  const baseName = path.basename(snapshot, path.extname(snapshot));
  const outputPath = path.join(outDir, `${baseName}.clusters.json`);
  if (await isFreshArtifact(outputPath, [snapshot])) {
    stages.push({ name: 'heap_cluster', status: 'reused', input: snapshot, output: outputPath });
    return outputPath;
  }
  console.log(`[prepare] Running heap cluster: ${snapshot}`);
  await runHeapCluster(snapshot, outDir);
  await ensureFile(outputPath, 'cluster JSON');
  stages.push({ name: 'heap_cluster', status: 'generated', input: snapshot, output: outputPath });
  return outputPath;
}

async function prepareLegacyCase(inputs, caseDir, outDir, opts) {
  if (!inputs.snapshot) {
    throw new Error(`Cannot find heapsnapshot in ${caseDir}`);
  }
  if (!inputs.nativeHookDb) {
    throw new Error(`Cannot find native hook db in ${caseDir}`);
  }
  await ensureFile(inputs.snapshot, 'heapsnapshot');
  await ensureFile(inputs.nativeHookDb, 'native hook db');
  return {
    ...inputs,
    caseDir,
    outDir,
    clusterJson: opts.clusterJson ? inputs.clusterJson : null,
    threeInOne: false,
    pipelineStages: [],
  };
}

async function prepareThreeInOneCase(inputs, caseDir, outDir, opts) {
  if (!inputs.jsMap) {
    throw new Error(`Cannot find js_map*.txt in ${caseDir}`);
  }
  await ensureFile(inputs.jsMap, 'js map');
  await fs.mkdir(outDir, { recursive: true });
  const tools = resolveToolPaths(opts);
  const stages = [];
  const nativeHookDb = await prepareDatabase(inputs, outDir, tools, stages);
  let snapshot = inputs.snapshot;
  let clusterJson = inputs.clusterJson;
  const clusterSources = inputs.explicit.clusterJson
    ? []
    : [inputs.snapshot || inputs.rawheap];
  const canReuseCluster = clusterJson &&
    await isFreshArtifact(clusterJson, clusterSources);
  if (!canReuseCluster) {
    if (inputs.explicit.clusterJson) {
      throw new Error(`Explicit cluster JSON is empty or invalid: ${clusterJson}`);
    }
    snapshot = await prepareSnapshot(inputs, outDir, tools, stages, nativeHookDb);
    clusterJson = null;
    clusterJson = await prepareClusterJson(inputs, snapshot, outDir, stages);
  } else {
    stages.push({ name: 'heap_cluster', status: 'reused', output: clusterJson });
  }
  return {
    ...inputs,
    caseDir,
    outDir,
    nativeHookDb,
    snapshot,
    clusterJson,
    traceStreamer: tools.traceStreamer,
    threeInOne: true,
    pipelineStages: stages,
  };
}

export async function prepareNativeStackCase(opts) {
  const caseDir = resolveInputBase(opts);
  const outDir = resolveOutDir(opts, caseDir);
  await ensureDirectory(caseDir, 'case directory');
  const discovered = await discoverCaseInputs(opts, caseDir, outDir);
  await validateExplicitInputs(opts, discovered);
  if (!isThreeInOneMode(opts, discovered)) {
    return prepareLegacyCase(discovered, caseDir, outDir, opts);
  }
  return prepareThreeInOneCase(discovered, caseDir, outDir, opts);
}

export function normalizeMapAddress(value) {
  const text = String(value).trim().replace(/^0x/iu, '');
  if (!/^[0-9a-f]+$/iu.test(text)) {
    throw new Error(`Invalid native address: ${value}`);
  }
  const numeric = BigInt(`0x${text}`);
  return {
    nativeAddressHex: `0x${numeric.toString(16)}`,
    nativeAddressDecimal: numeric.toString(10),
  };
}

function parseMapLine(line, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const match = trimmed.match(/^(?:0x)?([0-9a-f]+)\s+([0-9]+)(?:\s+.*)?$/iu);
  if (!match) {
    return { error: `line ${lineNumber}: ${trimmed}` };
  }
  const address = normalizeMapAddress(match[1]);
  return {
    nodeId: BigInt(match[2]).toString(10),
    nativeAddressHex: address.nativeAddressHex,
    nativeAddressDecimal: address.nativeAddressDecimal,
  };
}

export async function readJsMap(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const entries = [];
  const invalidLines = [];
  const seenPairs = new Set();
  let duplicateLineCount = 0;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const parsed = parseMapLine(line, index + 1);
    if (!parsed) {
      continue;
    }
    if (parsed.error) {
      invalidLines.push(parsed.error);
      continue;
    }
    const pairKey = `${parsed.nativeAddressDecimal}:${parsed.nodeId}`;
    if (seenPairs.has(pairKey)) {
      duplicateLineCount += 1;
      continue;
    }
    seenPairs.add(pairKey);
    entries.push(parsed);
  }
  if (entries.length === 0) {
    throw new Error(`No valid address-to-node mappings found in ${filePath}`);
  }
  return {
    entries,
    entryCount: entries.length,
    uniqueNodeCount: new Set(entries.map(entry => entry.nodeId)).size,
    invalidLineCount: invalidLines.length,
    duplicateLineCount,
    invalidLines: invalidLines.slice(0, 20),
  };
}

function compareAddressEntries(left, right) {
  const leftValue = BigInt(left.nativeAddressDecimal);
  const rightValue = BigInt(right.nativeAddressDecimal);
  return leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
}

export function buildNodeAddressLookupFromMap(mapData, nodeIds) {
  const wanted = new Set(nodeIds);
  const nodeAddresses = new Map(nodeIds.map(nodeId => [nodeId, []]));
  for (const entry of mapData.entries) {
    if (!wanted.has(entry.nodeId)) {
      continue;
    }
    nodeAddresses.get(entry.nodeId).push({
      nativeAddressHex: entry.nativeAddressHex,
      nativeAddressDecimal: entry.nativeAddressDecimal,
    });
  }
  for (const addresses of nodeAddresses.values()) {
    addresses.sort(compareAddressEntries);
  }
  return nodeAddresses;
}
