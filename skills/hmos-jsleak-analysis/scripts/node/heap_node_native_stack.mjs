#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildNodeAddressLookupFromMap,
  normalizeMapAddress,
  prepareNativeStackCase,
  readJsMap,
} from './lib/native-stack-case.js';
import { analyzeNativeStackDatabase } from './lib/native-stack-db.js';
import {
  appendAggregateMarkdown,
  buildAggregateReport,
} from './lib/native-stack-aggregate-report.js';

const defaultNodeId = '66977';
const objectIdMapMarker = Buffer.from('"objectIdMap"');
const nodesMarker = Buffer.from('"nodes":[');
const edgesMarker = Buffer.from('"edges":[');
const stringsMarker = Buffer.from('"strings":[');
const searchChunkSize = 16 * 1024 * 1024;

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const message = typeof warning === 'string' ? warning : String(warning?.message || warning);
  const type = typeof args[0] === 'string' ? args[0] : warning?.name;
  if (type === 'ExperimentalWarning' && message.includes('SQLite')) {
    return;
  }
  originalEmitWarning(warning, ...args);
};

process.on('warning', warning => {
  if (
    warning.name === 'ExperimentalWarning' &&
    String(warning.message || '').includes('SQLite')
  ) {
    return;
  }
  console.warn(warning.stack || warning.message || String(warning));
});

function usage() {
  return [
    'Usage:',
    '  node heap_node_native_stack.mjs --case-dir <dir> [--node-id <id>]',
    '',
    'Options:',
    '  --case-dir <dir>           Legacy case or rawheap + htrace + js_map*.txt directory',
    '  --rawheap <file>           Explicit rawheap path for three-in-one analysis',
    '  --htrace <file>            Explicit htrace path for three-in-one analysis',
    '  --js-map <file>            Explicit js_map*.txt path',
    '  --trace-streamer <file>    Override NativeLeak trace_streamer path',
    '  --snapshot <file>          Explicit heapsnapshot path',
    '  --native-hook-db <file>    Explicit native hook db path',
    '  --node-id <id>             One node id; may be repeated',
    '  --node-ids <ids>           Comma/space separated node ids',
    '  --node-ids-file <file>     JSON or text file containing node ids',
    '  --cluster-json <file>      heap_cluster.js sidecar JSON; uses distance=0 node ids',
    '  --group-by-name            Use each input node id as a seed name, aggregate same-name stacks, output Top1',
    '  --out-dir <dir>            Output directory; defaults to case dir/snapshot dir',
    '  --help                     Show this help',
    '',
    `Default node id when none is provided: ${defaultNodeId}`,
  ].join('\n');
}

const nativeStackValueOptions = new Set([
  '--case-dir', '--rawheap', '--htrace', '--js-map', '--trace-streamer',
  '--snapshot', '--native-hook-db', '--node-id', '--node-ids',
  '--node-ids-file', '--cluster-json', '--out-dir',
]);

function splitNativeStackOption(rawArg) {
  const equalsIndex = rawArg.indexOf('=');
  return equalsIndex >= 0
    ? { option: rawArg.slice(0, equalsIndex), inlineValue: rawArg.slice(equalsIndex + 1) }
    : { option: rawArg, inlineValue: null };
}

function readNativeStackOptionValue(argv, index, option, inlineValue) {
  if (inlineValue !== null) {
    return { value: inlineValue, nextIndex: index };
  }
  const nextIndex = index + 1;
  if (nextIndex >= argv.length) {
    throw new Error(`Missing value for ${option}`);
  }
  return { value: argv[nextIndex], nextIndex };
}

function applyNativeStackOption(options, option, value) {
  const propertyByOption = {
    '--case-dir': 'caseDir',
    '--rawheap': 'rawheap',
    '--htrace': 'htrace',
    '--js-map': 'jsMap',
    '--trace-streamer': 'traceStreamer',
    '--snapshot': 'snapshot',
    '--native-hook-db': 'nativeHookDb',
    '--cluster-json': 'clusterJson',
    '--out-dir': 'outDir',
  };
  if (propertyByOption[option]) {
    options[propertyByOption[option]] = value;
    return;
  }
  if (option === '--node-id' || option === '--node-ids') {
    options.nodeIds.push(...(option === '--node-id' ? [value] : splitNodeIds(value)));
    options.explicitNodeInput = true;
    return;
  }
  if (option === '--node-ids-file') {
    options.nodeIdsFiles.push(value);
    options.explicitNodeInput = true;
    return;
  }
  throw new Error(`Unknown option: ${option}`);
}

function parseArgs(argv) {
  const options = { nodeIds: [], nodeIdsFiles: [], explicitNodeInput: false };
  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];
    if (rawArg === '--help' || rawArg === '-h') {
      options.help = true;
      continue;
    }
    if (!rawArg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${rawArg}`);
    }
    const { option, inlineValue } = splitNativeStackOption(rawArg);
    if (option === '--group-by-name') {
      options.groupByName = true;
      continue;
    }
    if (!nativeStackValueOptions.has(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const optionValue = readNativeStackOptionValue(argv, index, option, inlineValue);
    index = optionValue.nextIndex;
    applyNativeStackOption(options, option, optionValue.value);
  }
  return options;
}

function splitNodeIds(input) {
  return String(input)
    .split(/[\s,;]+/u)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeNodeId(value) {
  const s = String(value).trim();
  if (!s) {
    throw new Error('Empty node id');
  }
  if (/^0x[0-9a-f]+$/iu.test(s)) {
    return BigInt(s).toString(10);
  }
  if (/^[0-9]+$/u.test(s)) {
    return BigInt(s).toString(10);
  }
  throw new Error(`Invalid node id: ${value}`);
}

async function readNodeIdsFile(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json' || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return collectNodeIdsFromJson(JSON.parse(trimmed));
  }

  return splitNodeIds(trimmed);
}

function collectNodeIdJsonValue(item, nodeIds) {
  if (item == null) {
    return;
  }
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'bigint') {
    nodeIds.push(String(item));
    return;
  }
  if (Array.isArray(item)) {
    item.forEach(value => collectNodeIdJsonValue(value, nodeIds));
    return;
  }
  for (const key of ['node_id', 'nodeId', 'node_ids', 'nodeIds', 'id', 'ids']) {
    if (typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, key)) {
      collectNodeIdJsonValue(item[key], nodeIds);
      return;
    }
  }
}

function collectNodeIdsFromJson(value) {
  const nodeIds = [];
  collectNodeIdJsonValue(value, nodeIds);
  return nodeIds;
}

function camelCaseKey(value) {
  return value.replace(/_([a-z0-9])/gu, (ignored, character) => character.toUpperCase());
}

function normalizeExternalValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeExternalValue);
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    camelCaseKey(key),
    normalizeExternalValue(item),
  ]));
}

function getDistanceZeroEntries(item) {
  if (Array.isArray(item.distance0Entries)) {
    return item.distance0Entries;
  }
  return Array.isArray(item.pathEntries)
    ? item.pathEntries.filter(entry => Number(entry.distance) === 0)
    : [];
}

function serializeClusterPathEntry(pathEntry) {
  return {
    name: pathEntry.name || '',
    retainedSize: pathEntry.retainedSize ?? null,
    retainedSizeText: pathEntry.retainedSizeText || '',
    distance: Number(pathEntry.distance ?? 0),
  };
}

function serializeClusterSeed(entry, item, fallbackCategory) {
  return {
    nodeId: normalizeNodeId(entry.nodeId ?? entry.id),
    objectName: entry.name || '',
    distance: Number(entry.distance ?? 0),
    retainedSize: entry.retainedSize ?? null,
    retainedSizeText: entry.retainedSizeText || '',
    category: item.category || fallbackCategory,
    rank: item.rank ?? null,
    clusterKey: item.key || '',
    clusterGroupNames: Array.isArray(item.groupNames) ? item.groupNames : [],
    clusterCount: item.count ?? null,
    clusterRetainedSize: item.totalRetainedSize ?? null,
    clusterRetainedSizeText: item.totalRetainedSizeText || '',
    heapPercent: item.heapPercent ?? null,
    rootType: item.rootType || '',
    pathEntries: Array.isArray(item.pathEntries)
      ? item.pathEntries.map(serializeClusterPathEntry)
      : [],
  };
}

function appendClusterSeeds(seeds, items, fallbackCategory) {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    for (const entry of getDistanceZeroEntries(item)) {
      const nodeId = entry.nodeId ?? entry.id;
      if (nodeId != null) {
        seeds.push(serializeClusterSeed(entry, item, fallbackCategory));
      }
    }
  }
}

async function readClusterDistance0Seeds(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const data = normalizeExternalValue(parsed);
  const seeds = [];
  appendClusterSeeds(seeds, data.businessTop5, 'business');
  appendClusterSeeds(seeds, data.commonTop5, 'common');
  if (seeds.length === 0) {
    throw new Error(`No distance=0 node ids found in cluster JSON: ${filePath}`);
  }

  return seeds;
}

function groupClusterSourcesByNodeId(seeds) {
  const result = new Map();
  for (const seed of seeds) {
    const sources = result.get(seed.nodeId) || [];
    sources.push(seed);
    result.set(seed.nodeId, sources);
  }
  return result;
}

async function resolveInputs(opts) {
  const prepared = await prepareNativeStackCase(opts);
  const clusterJson = prepared.clusterJson || null;
  const clusterSeeds = clusterJson ? await readClusterDistance0Seeds(clusterJson) : [];
  const clusterSourcesByNodeId = groupClusterSourcesByNodeId(clusterSeeds);
  const nodeIdInputs = [...opts.nodeIds];
  if (clusterSeeds.length > 0) {
    nodeIdInputs.push(...clusterSeeds.map(seed => seed.nodeId));
  }
  for (const file of opts.nodeIdsFiles) {
    nodeIdInputs.push(...await readNodeIdsFile(path.resolve(file)));
  }
  if (!opts.explicitNodeInput && !clusterJson && nodeIdInputs.length === 0) {
    nodeIdInputs.push(defaultNodeId);
  }
  if ((opts.explicitNodeInput || clusterJson) && nodeIdInputs.length === 0) {
    throw new Error('No node ids were provided by CLI or file');
  }

  const nodeIds = [...new Set(nodeIdInputs.map(normalizeNodeId))];

  return {
    ...prepared,
    nodeIds,
    groupByName: Boolean(opts.groupByName || clusterJson),
    clusterJson,
    clusterSeeds,
    clusterSourcesByNodeId,
  };
}

async function findMarkerFromEnd(filePath, marker) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let position = stat.size;
    let carry = Buffer.alloc(0);

    while (position > 0) {
      const readLength = Math.min(searchChunkSize, position);
      position -= readLength;

      const chunk = Buffer.allocUnsafe(readLength);
      await handle.read(chunk, 0, readLength, position);
      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      const idx = combined.lastIndexOf(marker);
      if (idx >= 0) {
        return position + idx;
      }
      carry = chunk.subarray(0, Math.min(marker.length - 1, chunk.length));
    }
  } finally {
    await handle.close();
  }
  return -1;
}

async function findMarkerFromStart(filePath, marker, startOffset = 0) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let position = startOffset;
    let carry = Buffer.alloc(0);

    while (position < stat.size) {
      const readLength = Math.min(searchChunkSize, stat.size - position);
      const chunk = Buffer.allocUnsafe(readLength);
      await handle.read(chunk, 0, readLength, position);
      const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const idx = combined.indexOf(marker);
      if (idx >= 0) {
        return position - carry.length + idx;
      }
      carry = chunk.subarray(Math.max(0, chunk.length - marker.length + 1));
      position += readLength;
    }
  } finally {
    await handle.close();
  }
  return -1;
}

async function loadObjectIdMap(snapshotPath) {
  const markerOffset = await findMarkerFromEnd(snapshotPath, objectIdMapMarker);
  if (markerOffset < 0) {
    throw new Error(`objectIdMap not found in ${snapshotPath}`);
  }

  const handle = await fs.open(snapshotPath, 'r');
  try {
    const stat = await handle.stat();
    const readLength = stat.size - markerOffset;
    const buffer = Buffer.allocUnsafe(readLength);
    await handle.read(buffer, 0, readLength, markerOffset);
    const text = buffer.toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) {
      throw new Error('Malformed objectIdMap property');
    }
    const objectStart = text.indexOf('{', colon + 1);
    if (objectStart < 0) {
      throw new Error('Malformed objectIdMap value');
    }
    const objectText = extractBalancedJsonObject(text, objectStart);
    return JSON.parse(objectText);
  } finally {
    await handle.close();
  }
}

function recordHeapNodeNameMetadata(node, state) {
  state.nameIndexCounts.set(
    node.nameIndex, (state.nameIndexCounts.get(node.nameIndex) || 0) + 1,
  );
  if (state.seedNodeIds.has(node.id)) {
    state.seedNameIndexes.set(node.id, node.nameIndex);
  }
  if (state.objectNodeIds.has(node.id)) {
    state.linkableNodeNameIndexes.set(node.id, node.nameIndex);
  }
}

function compareDecimalNodeIds(a, b) {
  return BigInt(a) < BigInt(b) ? -1 : (BigInt(a) > BigInt(b) ? 1 : 0);
}

function findSameNameNodeIds(linkableNodeNameIndexes, nameIndex) {
  const nodeIds = [];
  for (const [nodeId, linkableNameIndex] of linkableNodeNameIndexes) {
    if (linkableNameIndex === nameIndex) {
      nodeIds.push(nodeId);
    }
  }
  return nodeIds.sort(compareDecimalNodeIds);
}

function buildNameGroup(seedNodeId, state, resolvedNames) {
  const nameIndex = state.seedNameIndexes.get(seedNodeId);
  if (nameIndex == null) {
    return {
      seedNodeId: seedNodeId,
      objectName: null,
      nameIndex: null,
      sameNameTotalNodeCount: 0,
      sameNameNodeIds: [],
      error: 'seed_node_not_found',
    };
  }
  return {
    seedNodeId: seedNodeId,
    objectName: resolvedNames.get(nameIndex) ?? null,
    nameIndex: nameIndex,
    sameNameTotalNodeCount: state.nameIndexCounts.get(nameIndex) || 0,
    sameNameNodeIds: findSameNameNodeIds(state.linkableNodeNameIndexes, nameIndex),
    error: null,
  };
}

async function loadNameGroupMetadata(snapshotPath, seedNodeIds, linkableNodeIds) {
  const state = {
    objectNodeIds: new Set(linkableNodeIds),
    seedNodeIds: new Set(seedNodeIds),
    seedNameIndexes: new Map(),
    linkableNodeNameIndexes: new Map(),
    nameIndexCounts: new Map(),
  };
  console.log(`[name] Scanning heap nodes for ${seedNodeIds.length} seed node id(s)`);
  await scanHeapNodes(snapshotPath, node => recordHeapNodeNameMetadata(node, state));
  const missingSeeds = seedNodeIds.filter(nodeId => !state.seedNameIndexes.has(nodeId));
  if (missingSeeds.length > 0) {
    console.warn(`[name] Seed node id(s) not found in nodes array: ${missingSeeds.join(', ')}`);
  }
  const resolvedNames = await loadStringIndexes(snapshotPath, new Set(state.seedNameIndexes.values()));
  const groups = new Map();
  for (const seedNodeId of seedNodeIds) {
    groups.set(seedNodeId, buildNameGroup(seedNodeId, state, resolvedNames));
  }
  return groups;
}

function emitHeapNode(fields, visit) {
  visit({
    typeIndex: fields[0],
    nameIndex: fields[1],
    id: normalizeNodeId(fields[2]),
    selfSize: fields[3],
    edgeCount: fields[4],
  });
  fields.length = 0;
}

function consumeHeapNodeByte(byte, state, visit) {
  if (byte >= 48 && byte <= 57) {
    state.currentNumber += String.fromCharCode(byte);
    return false;
  }
  if (byte !== 44 && byte !== 93) {
    return false;
  }
  if (state.currentNumber) {
    state.fields.push(Number(state.currentNumber));
    state.currentNumber = '';
    if (state.fields.length === 8) {
      emitHeapNode(state.fields, visit);
    }
  }
  return byte === 93;
}

function scanHeapNodeChunk(chunk, state, visit) {
  for (const byte of chunk) {
    if (consumeHeapNodeByte(byte, state, visit)) {
      return true;
    }
  }
  return false;
}

async function scanHeapNodes(snapshotPath, visit) {
  const markerOffset = await findMarkerFromStart(snapshotPath, nodesMarker);
  if (markerOffset < 0) {
    throw new Error(`nodes array not found in ${snapshotPath}`);
  }

  const startOffset = markerOffset + nodesMarker.length;
  const handle = await fs.open(snapshotPath, 'r');
  try {
    const stat = await handle.stat();
    let position = startOffset;
    const state = { currentNumber: '', fields: [] };
    while (position < stat.size) {
      const readLength = Math.min(searchChunkSize, stat.size - position);
      const chunk = Buffer.allocUnsafe(readLength);
      await handle.read(chunk, 0, readLength, position);
      if (scanHeapNodeChunk(chunk, state, visit)) {
        return;
      }
      position += readLength;
    }
  } finally {
    await handle.close();
  }

  throw new Error('Unterminated nodes array');
}

function finishHeapString(state, wanted, result, maxIndex) {
  state.stringIndex += 1;
  if (wanted.has(state.stringIndex)) {
    const encoded = Buffer.from(state.encodedBytes).toString('utf8');
    result.set(state.stringIndex, JSON.parse(`"${encoded}"`));
  }
  state.inString = false;
  return result.size === wanted.size || state.stringIndex >= maxIndex;
}

function consumeHeapStringByte(byte, state, wanted, result, maxIndex) {
  if (!state.inString) {
    if (byte === 34) {
      state.inString = true;
      state.escaped = false;
      state.encodedBytes = [];
    }
    return byte === 93;
  }
  if (state.escaped) {
    state.encodedBytes.push(byte);
    state.escaped = false;
    return false;
  }
  if (byte === 92) {
    state.encodedBytes.push(byte);
    state.escaped = true;
    return false;
  }
  if (byte === 34) {
    return finishHeapString(state, wanted, result, maxIndex);
  }
  state.encodedBytes.push(byte);
  return false;
}

function scanHeapStringChunk(chunk, state, wanted, result, maxIndex) {
  for (const byte of chunk) {
    if (consumeHeapStringByte(byte, state, wanted, result, maxIndex)) {
      return true;
    }
  }
  return false;
}

async function loadStringIndexes(snapshotPath, indexes) {
  const wanted = new Set(indexes);
  const result = new Map();
  if (wanted.size === 0) {
    return result;
  }
  const maxIndex = Math.max(...wanted);
  const markerOffset = await findMarkerFromStart(snapshotPath, stringsMarker);
  if (markerOffset < 0) {
    throw new Error(`strings array not found in ${snapshotPath}`);
  }

  const handle = await fs.open(snapshotPath, 'r');
  try {
    const stat = await handle.stat();
    let position = markerOffset + stringsMarker.length;
    const state = { stringIndex: -1, inString: false, escaped: false, encodedBytes: [] };
    while (position < stat.size) {
      const readLength = Math.min(searchChunkSize, stat.size - position);
      const chunk = Buffer.allocUnsafe(readLength);
      await handle.read(chunk, 0, readLength, position);

      if (scanHeapStringChunk(chunk, state, wanted, result, maxIndex)) {
        return result;
      }
      position += readLength;
    }
  } finally {
    await handle.close();
  }

  throw new Error('Unterminated strings array');
}

function consumeJsonStringCharacter(character, state) {
  if (state.escaped) {
    state.escaped = false;
  } else if (character === '\\') {
    state.escaped = true;
  } else if (character === '"') {
    state.inString = false;
  }
}

function consumeBalancedJsonCharacter(character, state) {
  if (state.inString) {
    consumeJsonStringCharacter(character, state);
    return false;
  }
  if (character === '"') {
    state.inString = true;
  } else if (character === '{') {
    state.depth += 1;
  } else if (character === '}') {
    state.depth -= 1;
    return state.depth === 0;
  }
  return false;
}

function extractBalancedJsonObject(text, start) {
  const state = { depth: 0, inString: false, escaped: false };
  for (let i = start; i < text.length; i += 1) {
    if (consumeBalancedJsonCharacter(text[i], state)) {
      return text.slice(start, i + 1);
    }
  }
  throw new Error('Unterminated objectIdMap JSON object');
}

function buildNodeAddressLookup(objectIdMap, nodeIds) {
  const wanted = new Set(nodeIds);
  const nodeAddresses = new Map(nodeIds.map(id => [id, []]));

  for (const [hexAddress, rawNodeId] of Object.entries(objectIdMap)) {
    const nodeId = normalizeNodeId(rawNodeId);
    if (!wanted.has(nodeId)) {
      continue;
    }
    const normalizedAddress = normalizeMapAddress(hexAddress);
    nodeAddresses.get(nodeId).push({
      nativeAddressHex: normalizedAddress.nativeAddressHex,
      nativeAddressDecimal: normalizedAddress.nativeAddressDecimal,
    });
  }

  for (const addresses of nodeAddresses.values()) {
    addresses.sort((a, b) => a.nativeAddressDecimal.localeCompare(b.nativeAddressDecimal));
  }

  return nodeAddresses;
}

async function loadAddressMapping(inputs) {
  if (inputs.jsMap) {
    console.log(`[1/5] Loading JS map from ${inputs.jsMap}`);
    const mapData = await readJsMap(inputs.jsMap);
    return {
      objectIdMap: null,
      mapData,
      source: 'js_map',
      entryCount: mapData.entryCount,
      uniqueNodeCount: mapData.uniqueNodeCount,
      invalidLineCount: mapData.invalidLineCount,
      duplicateLineCount: mapData.duplicateLineCount,
    };
  }
  console.log(`[1/5] Loading objectIdMap from ${inputs.snapshot}`);
  const objectIdMap = await loadObjectIdMap(inputs.snapshot);
  return {
    objectIdMap,
    mapData: null,
    source: 'objectIdMap',
    entryCount: Object.keys(objectIdMap).length,
    uniqueNodeCount: new Set(Object.values(objectIdMap).map(normalizeNodeId)).size,
    invalidLineCount: 0,
    duplicateLineCount: 0,
  };
}

function buildFallbackNameGroups(inputs) {
  const groups = new Map();
  for (const nodeId of inputs.nodeIds) {
    const source = inputs.clusterSourcesByNodeId.get(nodeId)?.[0];
    groups.set(nodeId, {
      seedNodeId: nodeId,
      objectName: source?.objectName || null,
      nameIndex: null,
      sameNameTotalNodeCount: 1,
      sameNameNodeIds: [nodeId],
      error: null,
    });
  }
  return groups;
}

async function loadAnalysisNameGroups(inputs, mapping) {
  if (!inputs.groupByName) {
    return null;
  }
  if (!inputs.snapshot) {
    console.log('[name] Snapshot not supplied; using cluster distance=0 node ids without same-name expansion');
    return buildFallbackNameGroups(inputs);
  }
  const linkableNodeIds = mapping.mapData
    ? mapping.mapData.entries.map(entry => entry.nodeId)
    : Object.values(mapping.objectIdMap).map(normalizeNodeId);
  return loadNameGroupMetadata(inputs.snapshot, inputs.nodeIds, linkableNodeIds);
}

function expandAnalysisNodeIds(inputs, nameGroups) {
  if (!inputs.groupByName) {
    return inputs.nodeIds;
  }
  const expanded = [...new Set(
    [...nameGroups.values()].flatMap(group => group.sameNameNodeIds),
  )];
  console.log(
    `[name] Expanded ${inputs.nodeIds.length} seed node id(s) to ` +
    `${expanded.length} linkable same-name node id(s)`,
  );
  return expanded;
}

function appendDatabaseMetadata(report, inputs, mapping, databaseAnalysis) {
  report.metadata.associationMode = databaseAnalysis.associationMode;
  report.metadata.schemaAdapter = databaseAnalysis.schemaAdapter;
  report.metadata.rawheap = inputs.rawheap || null;
  report.metadata.htrace = inputs.htrace || null;
  report.metadata.jsMap = inputs.jsMap || null;
  report.metadata.traceStreamer = inputs.traceStreamer || null;
  report.metadata.addressMapSource = mapping.source;
  report.metadata.addressMapEntries = mapping.entryCount;
  report.metadata.addressMapUniqueNodeCount = mapping.uniqueNodeCount;
  report.metadata.addressMapInvalidLineCount = mapping.invalidLineCount;
  report.metadata.addressMapDuplicateLineCount = mapping.duplicateLineCount;
  report.metadata.pipelineStages = inputs.pipelineStages;
  report.metadata.databaseTables = databaseAnalysis.databaseTables;
  return report;
}

function buildExactReport(inputs, mapping, nameGroups, nodeAddresses, databaseAnalysis) {
  const { latestEvents, framesByStackId } = databaseAnalysis;
  const report = inputs.groupByName
    ? buildNameGroupedReport(
      inputs, mapping, nameGroups, nodeAddresses, latestEvents, framesByStackId,
    )
    : buildReport(inputs, mapping, nodeAddresses, latestEvents, framesByStackId);
  return appendDatabaseMetadata(report, inputs, mapping, databaseAnalysis);
}

async function analyze(inputs) {
  const mapping = await loadAddressMapping(inputs);
  const nameGroups = await loadAnalysisNameGroups(inputs, mapping);
  const analysisNodeIds = expandAnalysisNodeIds(inputs, nameGroups);
  const nodeAddresses = mapping.mapData
    ? buildNodeAddressLookupFromMap(mapping.mapData, analysisNodeIds)
    : buildNodeAddressLookup(mapping.objectIdMap, analysisNodeIds);
  const addressToNodeRefs = buildAddressToNodeRefs(nodeAddresses);
  console.log(`[2/5] Opening native hook db ${inputs.nativeHookDb}`);
  const databaseAnalysis = await analyzeNativeStackDatabase(
    inputs.nativeHookDb,
    addressToNodeRefs,
  );
  console.log(
    `[db] Adapter ${databaseAnalysis.schemaAdapter}, ` +
    `association mode ${databaseAnalysis.associationMode}`,
  );
  if (databaseAnalysis.associationMode === 'aggregate') {
    return buildAggregateReport(
      inputs,
      mapping,
      nameGroups,
      nodeAddresses,
      databaseAnalysis,
    );
  }
  return buildExactReport(inputs, mapping, nameGroups, nodeAddresses, databaseAnalysis);
}

function buildAddressToNodeRefs(nodeAddresses) {
  const addressToNodeRefs = new Map();
  for (const [nodeId, addresses] of nodeAddresses) {
    for (const address of addresses) {
      const refs = addressToNodeRefs.get(address.nativeAddressDecimal) || [];
      refs.push({ nodeId: nodeId, ...address });
      addressToNodeRefs.set(address.nativeAddressDecimal, refs);
    }
  }
  return addressToNodeRefs;
}

function buildNativeAddressReport(address, latestEvents, framesByStackId) {
  const event = latestEvents.get(address.nativeAddressDecimal) || null;
  if (!event) {
    return {
      ...address,
      event: null,
      callStackId: null,
      frames: [],
      error: 'no_native_event_match',
    };
  }
  const stackId = String(event.callStackId);
  const frames = framesByStackId.get(stackId) || [];
  return {
    ...address,
    event,
    callStackId: stackId,
    frames,
    error: frames.length === 0 ? 'no_call_stack_frames' : null,
  };
}

function buildNodeIdReportResult(nodeId, nodeAddresses, latestEvents, framesByStackId) {
  const addresses = nodeAddresses.get(nodeId) || [];
  const nativeAddresses = addresses.map(address =>
    buildNativeAddressReport(address, latestEvents, framesByStackId));
  return {
    nodeId: nodeId,
    nativeAddresses: nativeAddresses,
    event: null,
    callStackId: null,
    frames: [],
    error: addresses.length === 0 ? 'no_object_id_map_match' : null,
  };
}

function buildNodeIdReportMetadata(inputs, mapping, nodeAddresses, results) {
  const matchedAddressCount = results.reduce(
    (sum, item) => sum + item.nativeAddresses.filter(address => address.event != null).length,
    0,
  );
  return {
    mode: 'node_id',
    generatedAt: new Date().toISOString(),
    snapshot: inputs.snapshot,
    nativeHookDb: inputs.nativeHookDb,
    nodeIds: inputs.nodeIds,
    objectIdMapEntries: mapping.source === 'objectIdMap' ? mapping.entryCount : 0,
    addressMapEntries: mapping.entryCount,
    requestedNodeCount: inputs.nodeIds.length,
    nativeAddressCount: [...nodeAddresses.values()].reduce((sum, list) => sum + list.length, 0),
    matchedNativeAddressCount: matchedAddressCount,
  };
}

function buildReport(inputs, mapping, nodeAddresses, latestEvents, framesByStackId) {
  console.log('[5/5] Building report payload');
  const results = inputs.nodeIds.map(nodeId =>
    buildNodeIdReportResult(nodeId, nodeAddresses, latestEvents, framesByStackId));
  return {
    metadata: buildNodeIdReportMetadata(inputs, mapping, nodeAddresses, results),
    results,
  };
}

function buildMissingNameGroupResult(seedNodeId, group, clusterSources) {
  return {
    seedNodeId: seedNodeId,
    clusterSources: clusterSources,
    objectName: group?.objectName ?? null,
    nameIndex: group?.nameIndex ?? null,
    sameNameTotalNodeCount: group?.sameNameTotalNodeCount || 0,
    sameNameLinkableNodeCount: 0,
    sameNameNodeCount: 0,
    nativeAddressCount: 0,
    matchedNativeAddressCount: 0,
    candidateStackCount: 0,
    topStack: null,
    topStacks: [],
    error: group?.error || 'seed_node_not_found',
  };
}

function createNameGroupStackBucket(event, frames) {
  return {
    count: 0,
    nodeIds: new Set(),
    nativeAddresses: [],
    callStackIds: new Set(),
    latestEvent: event,
    frames,
  };
}

function updateNameGroupStackBucket(bucket, nodeId, address, event, stackId, frames) {
  bucket.count += 1;
  bucket.nodeIds.add(nodeId);
  bucket.nativeAddresses.push({ nodeId: nodeId, ...address, event, callStackId: stackId });
  bucket.callStackIds.add(stackId);
  if (event.timestamp > bucket.latestEvent.timestamp) {
    bucket.latestEvent = event;
  }
  if (bucket.frames.length === 0 && frames.length > 0) {
    bucket.frames = frames;
  }
}

function collectNodeNameGroupStacks(nodeId, addresses, context) {
  for (const address of addresses) {
    const event = context.latestEvents.get(address.nativeAddressDecimal);
    if (!event) {
      continue;
    }
    context.matchedAddressCount += 1;
    const stackId = String(event.callStackId);
    const frames = context.framesByStackId.get(stackId) || [];
    const signature = buildStackSignature(frames, stackId);
    const bucket = context.stackBuckets.get(signature) ||
      createNameGroupStackBucket(event, frames);
    context.stackBuckets.set(signature, bucket);
    updateNameGroupStackBucket(bucket, nodeId, address, event, stackId, frames);
  }
}

function collectNameGroupStacks(group, nodeAddresses, latestEvents, framesByStackId) {
  const context = {
    latestEvents, framesByStackId, stackBuckets: new Map(), matchedAddressCount: 0,
  };
  let nativeAddressCount = 0;
  for (const nodeId of group.sameNameNodeIds) {
    const addresses = nodeAddresses.get(nodeId) || [];
    nativeAddressCount += addresses.length;
    collectNodeNameGroupStacks(nodeId, addresses, context);
  }
  return {
    stackBuckets: context.stackBuckets,
    matchedAddressCount: context.matchedAddressCount,
    nativeAddressCount,
  };
}

function compareNativeAddressRecords(a, b) {
  return compareDecimalNodeIds(a.nativeAddressDecimal, b.nativeAddressDecimal);
}

function serializeNameGroupStackBucket(bucket) {
  return {
    count: bucket.count,
    nodeIds: [...bucket.nodeIds].sort(compareDecimalNodeIds),
    nativeAddresses: bucket.nativeAddresses.sort(compareNativeAddressRecords),
    callStackIds: [...bucket.callStackIds].sort(compareDecimalNodeIds),
    latestEvent: bucket.latestEvent,
    frames: bucket.frames,
  };
}

function compareNameGroupStackSummaries(a, b) {
  if (b.count !== a.count) {
    return b.count - a.count;
  }
  if (b.latestEvent.timestamp !== a.latestEvent.timestamp) {
    return b.latestEvent.timestamp > a.latestEvent.timestamp ? 1 : -1;
  }
  return a.callStackIds[0].localeCompare(b.callStackIds[0]);
}

function buildNameGroupedResult(seedNodeId, inputs, nameGroups, analysisData) {
  const group = nameGroups.get(seedNodeId);
  const clusterSources = inputs.clusterSourcesByNodeId?.get(seedNodeId) || [];
  if (!group || group.error) {
    return buildMissingNameGroupResult(seedNodeId, group, clusterSources);
  }
  const collected = collectNameGroupStacks(
    group, analysisData.nodeAddresses, analysisData.latestEvents, analysisData.framesByStackId,
  );
  const stackSummaries = [...collected.stackBuckets.values()]
    .map(serializeNameGroupStackBucket)
    .sort(compareNameGroupStackSummaries);
  return {
    seedNodeId: seedNodeId,
    clusterSources: clusterSources,
    objectName: group.objectName,
    nameIndex: group.nameIndex,
    sameNameTotalNodeCount: group.sameNameTotalNodeCount,
    sameNameLinkableNodeCount: group.sameNameNodeIds.length,
    sameNameNodeCount: group.sameNameNodeIds.length,
    sameNameNodeIds: group.sameNameNodeIds,
    nativeAddressCount: collected.nativeAddressCount,
    matchedNativeAddressCount: collected.matchedAddressCount,
    candidateStackCount: stackSummaries.length,
    topStack: stackSummaries[0] || null,
    topStacks: stackSummaries.slice(0, 3),
    error: stackSummaries.length === 0 ? 'no_stack_for_same_name_nodes' : null,
  };
}

function buildNameGroupedMetadata(inputs, mapping, results) {
  return {
    mode: inputs.clusterJson ? 'cluster_group_by_name' : 'group_by_name',
    generatedAt: new Date().toISOString(),
    snapshot: inputs.snapshot,
    nativeHookDb: inputs.nativeHookDb,
    clusterJson: inputs.clusterJson || null,
    nodeIds: inputs.nodeIds,
    clusterSeedCount: inputs.clusterSeeds?.length || 0,
    clusterSourceCount: [...(inputs.clusterSourcesByNodeId?.values() || [])]
      .reduce((sum, sources) => sum + sources.length, 0),
    objectIdMapEntries: mapping.source === 'objectIdMap' ? mapping.entryCount : 0,
    addressMapEntries: mapping.entryCount,
    requestedNodeCount: inputs.nodeIds.length,
    nativeAddressCount: results.reduce((sum, item) => sum + item.nativeAddressCount, 0),
    matchedNativeAddressCount: results.reduce(
      (sum, item) => sum + item.matchedNativeAddressCount, 0,
    ),
  };
}

function buildNameGroupedReport(inputs, mapping, nameGroups, nodeAddresses, latestEvents, framesByStackId) {
  console.log('[5/5] Building name-grouped report payload');
  const analysisData = { nodeAddresses, latestEvents, framesByStackId };
  const results = inputs.nodeIds.map(seedNodeId =>
    buildNameGroupedResult(seedNodeId, inputs, nameGroups, analysisData));
  return { metadata: buildNameGroupedMetadata(inputs, mapping, results), results };
}

function buildStackSignature(frames, fallbackStackId) {
  if (!frames || frames.length === 0) {
    return `call_stack_id:${fallbackStackId}`;
  }
  return frames
    .map(frame => [
      formatValue(frame.symbolNameId),
      formatValue(frame.filePathId),
      formatValue(frame.symbolOffset),
      frame.symbolName || '',
      frame.filePath || '',
    ].join(':'))
    .join('|');
}

function formatValue(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return String(value);
}

function formatBytes(value, fallbackText = '') {
  if (fallbackText) {
    return fallbackText;
  }
  if (value == null || Number.isNaN(Number(value))) {
    return '';
  }
  const bytes = Number(value);
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

function formatFrame(frame, index) {
  const ip = frame.ipHex || '';
  const file = frame.filePath || '';
  const symbol = frame.symbolName || '';
  const symbolOffset =
    frame.symbolOffset != null && BigInt(frame.symbolOffset) !== 0n
      ? `+0x${BigInt(frame.symbolOffset).toString(16)}`
      : '';

  if (file && symbol) {
    return `   #${String(index).padStart(2, '0')} ${ip} ${file}(${symbol}${symbolOffset})`;
  }
  if (symbol) {
    return `   #${String(index).padStart(2, '0')} ${ip} ${symbol}${symbolOffset}`;
  }
  return `   #${String(index).padStart(2, '0')} ${ip}`;
}

function appendNodeIdReportMetadata(lines, report) {
  lines.push(`- Mode: ${report.metadata.mode}`);
  lines.push(`- Snapshot: ${report.metadata.snapshot}`);
  lines.push(`- Native hook DB: ${report.metadata.nativeHookDb}`);
  lines.push(`- Generated at: ${report.metadata.generatedAt}`);
  lines.push(`- Requested node ids: ${report.metadata.nodeIds.join(', ')}`);
  lines.push(`- Address map source: ${report.metadata.addressMapSource || 'objectIdMap'}`);
  lines.push(`- Address map entries: ${report.metadata.addressMapEntries}`);
  lines.push(`- Native addresses found: ${report.metadata.nativeAddressCount}`);
  lines.push(`- Native addresses matched to events: ${report.metadata.matchedNativeAddressCount}`);
  lines.push('');
}

function appendStackFrames(lines, frames, emptyText = '(no frames)') {
  lines.push('```text');
  if (frames.length === 0) {
    lines.push(emptyText);
  } else {
    frames.forEach((frame, index) => lines.push(formatFrame(frame, index)));
  }
  lines.push('```', '');
}

function appendNativeAddressMarkdown(lines, address) {
  lines.push(`### ${address.nativeAddressHex} (${address.nativeAddressDecimal})`, '');
  if (address.error && !address.event) {
    lines.push(`- error: ${address.error}`, '');
    return;
  }
  const event = address.event;
  lines.push(`- event id: ${formatValue(event.id)}`);
  lines.push(`- timestamp: ${formatValue(event.timestamp)}`);
  lines.push(`- event_type: ${formatValue(event.eventType)}`);
  lines.push(`- pid/tid: ${formatValue(event.pid)}/${formatValue(event.tid)}`);
  lines.push(`- size: ${formatValue(event.size)}`);
  lines.push(`- call_stack_id: ${formatValue(address.callStackId)}`);
  if (address.error) {
    lines.push(`- error: ${address.error}`);
  }
  lines.push('');
  appendStackFrames(lines, address.frames);
}

function appendNodeIdResultMarkdown(lines, result) {
  lines.push(`## Node ${result.nodeId}`, '');
  if (result.error) {
    lines.push(`- error: ${result.error}`, '');
    return;
  }
  for (const address of result.nativeAddresses) {
    appendNativeAddressMarkdown(lines, address);
  }
}

function renderMarkdown(report) {
  let markdown;
  if (report.metadata.mode === 'cluster_group_by_name') {
    markdown = renderClusterGroupedMarkdown(report);
  } else if (report.metadata.mode === 'group_by_name') {
    markdown = renderNameGroupedMarkdown(report);
  } else {
    const lines = ['# Node ID Native Stack Report', ''];
    appendNodeIdReportMetadata(lines, report);
    report.results.forEach(result => appendNodeIdResultMarkdown(lines, result));
    markdown = `${lines.join('\n')}\n`;
  }
  return report.metadata.associationMode === 'aggregate'
    ? appendAggregateMarkdown(markdown, report)
    : markdown;
}

function clusterCategoryText(category) {
  if (category === 'business') {
    return '业务对象';
  }
  if (category === 'common') {
    return '公共对象';
  }
  return category || '聚类对象';
}

function renderClusterSourceTitle(source) {
  return `${clusterCategoryText(source.category)} Top${formatValue(source.rank)}`;
}

function renderClusterReferenceChain(lines, source) {
  const entries = Array.isArray(source.pathEntries) ? source.pathEntries : [];
  if (entries.length === 0) {
    lines.push('  (无引用链)');
    return;
  }

  entries.forEach((entry, index) => {
    const isLast = index === entries.length - 1;
    const prefix = index === 0 ? '  * ' : (isLast ? '  `- ' : '  |- ');
    const size = formatBytes(entry.retainedSize, entry.retainedSizeText);
    const sizeText = size ? ` [${size}]` : '';
    lines.push(`${prefix}${entry.name}${sizeText} 距离 ${formatValue(entry.distance)}`);
  });
}

function markdownCell(value) {
  const text = formatValue(value);
  return (text || '-').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

function pushKeyValueTable(lines, rows) {
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  for (const [key, value] of rows) {
    lines.push(`| ${markdownCell(key)} | ${markdownCell(value)} |`);
  }
  lines.push('');
}

function appendClusterGroupedOverview(lines, report) {
  lines.push('## 总览');
  lines.push('');
  pushKeyValueTable(lines, [
    ['快照文件', report.metadata.snapshot],
    ['Native Hook 数据库', report.metadata.nativeHookDb],
    ['聚类 JSON', report.metadata.clusterJson],
    ['生成时间', report.metadata.generatedAt],
    ['distance=0 聚类来源数', report.metadata.clusterSourceCount],
    ['报告对象数', report.results.length],
    ['地址映射来源', report.metadata.addressMapSource || 'objectIdMap'],
    ['地址映射条目数', report.metadata.addressMapEntries],
    ['关联模式', report.metadata.associationMode || 'exact'],
    ['数据库适配器', report.metadata.schemaAdapter || 'native_hook_event'],
    ['Native 栈展示规则', '每个对象最多展示出现次数最高的 Top 3 调用栈'],
  ]);
  if (report.metadata.associationMode === 'aggregate') {
    lines.push(
      '> 注意：当前数据库没有可用的地址级关联数据。对象与引用链仍按原方式展示，' +
      'Native 栈仅在文末按 `RES_ARK_GLOBAL_HANDLE` 整体统计展示。',
      '',
    );
  }
}

function getClusterTopStacks(result) {
  if (Array.isArray(result.topStacks)) {
    return result.topStacks;
  }
  return result.topStack ? [result.topStack] : [];
}

function appendClusterResultHeader(lines, result, index, total, titleName, sourceLabels) {
  if (index > 0) {
    lines.push('---');
    lines.push('');
  }
  lines.push(`## 对象 ${index + 1}/${total}: ${titleName}`);
  lines.push('');
  if (sourceLabels) {
    lines.push(`> 聚类来源: ${sourceLabels}`);
    lines.push('');
  }
}

function appendClusterResultOverview(lines, result, topStacks, associationMode) {
  let stackStatus = `可展示 Top 栈数: ${topStacks.length}`;
  if (associationMode === 'aggregate') {
    stackStatus = '仅支持 GlobalHandle 聚合，无法精确关联到该对象';
  } else if (result.error) {
    stackStatus = `未关联到可展示栈: ${result.error}`;
  }
  lines.push('### 对象概览');
  lines.push('');
  pushKeyValueTable(lines, [
    ['同名对象总数', result.sameNameTotalNodeCount],
    ['可关联同名对象数', result.sameNameLinkableNodeCount],
    ['候选调用栈数', result.candidateStackCount],
    ['Native 关联状态', stackStatus],
  ]);
}

function appendClusterSourceMarkdown(lines, source, titleName) {
  lines.push(`#### ${renderClusterSourceTitle(source)}`);
  lines.push('');
  pushKeyValueTable(lines, [
    ['distance=0 对象', source.objectName || titleName],
    ['聚类对象数量', formatValue(source.clusterCount)],
    ['保留大小', formatBytes(source.clusterRetainedSize, source.clusterRetainedSizeText)],
    ['堆占比', source.heapPercent != null ? `${formatValue(source.heapPercent)}%` : ''],
    ['根节点类型', source.rootType || ''],
    ['来源分组', source.clusterGroupNames?.length ? source.clusterGroupNames.join(', ') : ''],
  ]);
  lines.push('引用链:');
  renderClusterReferenceChain(lines, source);
  lines.push('');
}

function appendClusterTopStackMarkdown(lines, top, topIndex) {
  lines.push(`#### Top ${topIndex + 1}: 出现 ${top.count} 次`);
  lines.push('');
  pushKeyValueTable(lines, [
    ['调用栈 ID', top.callStackIds.join(', ')],
    ['最新时间戳', top.latestEvent?.timestamp],
    ['最新事件类型', top.latestEvent?.eventType],
    ['栈帧数量', top.frames.length],
  ]);
  appendStackFrames(lines, top.frames, '(无栈帧)');
}

function appendClusterGroupedResult(lines, result, index, total, associationMode) {
  const sources = Array.isArray(result.clusterSources) ? result.clusterSources : [];
  const sourceLabels = sources.map(renderClusterSourceTitle).join(', ');
  const titleName = result.objectName || sources[0]?.objectName || '(未知对象)';
  const topStacks = getClusterTopStacks(result);
  appendClusterResultHeader(lines, result, index, total, titleName, sourceLabels);
  appendClusterResultOverview(lines, result, topStacks, associationMode);
  if (sources.length > 0) {
    lines.push('### 聚类来源与引用链');
    lines.push('');
  }
  for (const source of sources) {
    appendClusterSourceMarkdown(lines, source, titleName);
  }
  lines.push('### Native Top 3 调用栈');
  lines.push('');
  if (associationMode === 'aggregate') {
    lines.push('- 当前数据库不支持对象级精确关联，请查看文末 GlobalHandle 聚合 Native Top 栈。');
    lines.push('');
    return;
  }
  if (result.error || topStacks.length === 0) {
    lines.push(`- 未关联到可展示栈: ${result.error || 'no_top_stack'}`);
    lines.push('');
    return;
  }
  topStacks.slice(0, 3).forEach((top, topIndex) => {
    appendClusterTopStackMarkdown(lines, top, topIndex);
  });
}

function renderClusterGroupedMarkdown(report) {
  const lines = ['# Heap 聚类与 Native 调用栈关联报告', ''];
  appendClusterGroupedOverview(lines, report);
  report.results.forEach((result, index) => {
    appendClusterGroupedResult(
      lines,
      result,
      index,
      report.results.length,
      report.metadata.associationMode,
    );
  });
  return `${lines.join('\n')}\n`;
}

function appendNameGroupedMetadata(lines, report) {
  lines.push(`- Mode: ${report.metadata.mode}`);
  lines.push(`- Snapshot: ${report.metadata.snapshot}`);
  lines.push(`- Native hook DB: ${report.metadata.nativeHookDb}`);
  if (report.metadata.clusterJson) {
    lines.push(`- Cluster JSON: ${report.metadata.clusterJson}`);
  }
  lines.push(`- Generated at: ${report.metadata.generatedAt}`);
  lines.push(`- Seed node ids: ${report.metadata.nodeIds.join(', ')}`);
  if (report.metadata.clusterJson) {
    lines.push(`- Cluster distance=0 source count: ${report.metadata.clusterSourceCount}`);
  }
  lines.push(`- Address map source: ${report.metadata.addressMapSource || 'objectIdMap'}`);
  lines.push(`- Address map entries: ${report.metadata.addressMapEntries}`);
  lines.push(`- Association mode: ${report.metadata.associationMode || 'exact'}`);
  lines.push(`- Database adapter: ${report.metadata.schemaAdapter || 'native_hook_event'}`);
  lines.push(`- Native addresses found: ${report.metadata.nativeAddressCount}`);
  lines.push(`- Native addresses matched to events: ${report.metadata.matchedNativeAddressCount}`);
  lines.push('');
}

function appendNameGroupClusterSources(lines, result) {
  const sources = Array.isArray(result.clusterSources) ? result.clusterSources : [];
  if (sources.length === 0) {
    return;
  }
  lines.push('- cluster sources:');
  for (const source of sources) {
    const groups = source.clusterGroupNames?.length
      ? ` groups=${source.clusterGroupNames.join(', ')}`
      : '';
    const summary = `  - ${source.category} Top${source.rank}: ` +
      `count=${formatValue(source.clusterCount)} ` +
      `retained=${formatValue(source.clusterRetainedSize)}${groups}`;
    lines.push(summary);
  }
}

function appendNameGroupedSummary(lines, result) {
  if (result.objectName != null) {
    lines.push(`- object name: ${result.objectName}`);
  }
  if (result.nameIndex != null) {
    lines.push(`- name index: ${result.nameIndex}`);
  }
  lines.push(`- same-name total node count: ${result.sameNameTotalNodeCount}`);
  lines.push(`- same-name linkable node count: ${result.sameNameLinkableNodeCount}`);
  lines.push(`- native addresses found: ${result.nativeAddressCount}`);
  lines.push(`- native addresses matched to events: ${result.matchedNativeAddressCount}`);
  lines.push(`- candidate stack count: ${result.candidateStackCount}`);
}

function appendNativeAddresses(lines, addresses) {
  lines.push('- native addresses:');
  for (const address of addresses) {
    const addressText = `  - node ${address.nodeId}: ${address.nativeAddressHex} ` +
      `(${address.nativeAddressDecimal}), event ${formatValue(address.event.id)}, ` +
      `timestamp ${formatValue(address.event.timestamp)}`;
    lines.push(addressText);
  }
}

function appendNameGroupTopStack(lines, top) {
  lines.push('');
  lines.push('### Top Stack');
  lines.push('');
  lines.push(`- occurrence count: ${top.count}`);
  lines.push(`- node ids: ${top.nodeIds.join(', ')}`);
  lines.push(`- call_stack_ids: ${top.callStackIds.join(', ')}`);
  lines.push(`- latest timestamp: ${formatValue(top.latestEvent.timestamp)}`);
  lines.push(`- latest event_type: ${formatValue(top.latestEvent.eventType)}`);
  appendNativeAddresses(lines, top.nativeAddresses);
  lines.push('');
  appendStackFrames(lines, top.frames);
}

function appendNameGroupedResult(lines, result) {
  lines.push(`## Seed Node ${result.seedNodeId}`);
  lines.push('');
  appendNameGroupClusterSources(lines, result);
  appendNameGroupedSummary(lines, result);
  if (result.error || !result.topStack) {
    lines.push(`- error: ${result.error || 'no_top_stack'}`);
    lines.push('');
    return;
  }
  appendNameGroupTopStack(lines, result.topStack);
}

function renderNameGroupedMarkdown(report) {
  const lines = ['# Node Name Top Native Stack Report', ''];
  appendNameGroupedMetadata(lines, report);
  for (const result of report.results) {
    appendNameGroupedResult(lines, result);
  }
  return `${lines.join('\n')}\n`;
}

function snakeCaseKey(value) {
  return value.replace(/[A-Z]/gu, character => `_${character.toLowerCase()}`);
}

function serializeReportValue(value) {
  if (Array.isArray(value)) {
    return value.map(serializeReportValue);
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    snakeCaseKey(key),
    serializeReportValue(item),
  ]));
}

function jsonReplacer(ignoredKey, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

async function writeOutputs(inputs, report) {
  await fs.mkdir(inputs.outDir, { recursive: true });
  const baseInput = inputs.snapshot || inputs.clusterJson || inputs.rawheap || 'jsleak-native';
  const base = path.basename(baseInput, path.extname(baseInput))
    .replace(/\.clusters$/u, '');
  const suffix = inputs.clusterJson ? 'cluster-native-stacks' : 'node-native-stacks';
  const jsonPath = path.join(inputs.outDir, `${base}.${suffix}.json`);
  const mdPath = path.join(inputs.outDir, `${base}.${suffix}.md`);
  const serializedReport = serializeReportValue(report);

  await fs.writeFile(jsonPath, `${JSON.stringify(serializedReport, jsonReplacer, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, `\uFEFF${renderMarkdown(report)}`, 'utf8');

  return { jsonPath, mdPath };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const inputs = await resolveInputs(opts);
  const report = await analyze(inputs);
  const outputs = await writeOutputs(inputs, report);

  console.log(`Markdown report: ${outputs.mdPath}`);
  console.log(`JSON report: ${outputs.jsonPath}`);
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
