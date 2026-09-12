function formatHex(value) {
  if (value == null) {
    return null;
  }
  try {
    const numeric = BigInt(value);
    const unsigned = numeric < 0n ? BigInt.asUintN(64, numeric) : numeric;
    return `0x${unsigned.toString(16)}`;
  } catch {
    return null;
  }
}

function formatValue(value) {
  return value == null ? '' : String(value);
}

function normalizeDatabaseAddress(value, unprefixedHex = false) {
  if (value == null) {
    return null;
  }
  if (typeof value === 'bigint' || typeof value === 'number') {
    return BigInt(value).toString(10);
  }
  const text = String(value).trim();
  if (/^0x[0-9a-f]+$/iu.test(text)) {
    return BigInt(text).toString(10);
  }
  if (/^[0-9]+$/u.test(text)) {
    return BigInt(unprefixedHex ? `0x${text}` : text).toString(10);
  }
  if (/^[0-9a-f]+$/iu.test(text)) {
    return BigInt(`0x${text}`).toString(10);
  }
  return null;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/gu, '""')}"`;
}

function listTables(db) {
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type IN ('table', 'view')
  `).all();
  return new Set(rows.map(row => String(row.name)));
}

function tableColumns(db, tableName) {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
  return new Set(rows.map(row => String(row.name)));
}

function tableHasRows(db, tableName) {
  const row = db.prepare(`SELECT 1 AS found FROM ${quoteIdentifier(tableName)} LIMIT 1`).get();
  return Boolean(row?.found);
}

function hasColumns(columns, requiredColumns) {
  return requiredColumns.every(column => columns.has(column));
}

function inspectSchema(db) {
  const tables = listTables(db);
  const columns = new Map();
  for (const tableName of tables) {
    if (tableName.startsWith('native_hook') || tableName === 'data_dict') {
      columns.set(tableName, tableColumns(db, tableName));
    }
  }
  return { tables, columns };
}

function supportsTable(schema, tableName, requiredColumns = []) {
  return schema.tables.has(tableName) &&
    hasColumns(schema.columns.get(tableName) || new Set(), requiredColumns);
}

function buildAddressSet(addressToNodeRefs) {
  return new Set([...addressToNodeRefs.keys()].map(value => String(value)));
}

function selectLatestEvent(latestEvents, address, event) {
  const previous = latestEvents.get(address);
  if (!previous) {
    latestEvents.set(address, event);
    return;
  }
  const previousTimestamp = BigInt(previous.timestamp ?? 0);
  const currentTimestamp = BigInt(event.timestamp ?? 0);
  const previousId = BigInt(previous.id ?? 0);
  const currentId = BigInt(event.id ?? 0);
  if (currentTimestamp > previousTimestamp ||
      (currentTimestamp === previousTimestamp && currentId > previousId)) {
    latestEvents.set(address, event);
  }
}

function buildLegacyEvent(row, address) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.eventType,
    pid: row.pid,
    tid: row.tid,
    addr: address,
    type: row.type,
    size: row.size,
    tag: row.tag,
    threadNameId: row.threadNameId,
    callStackId: row.callStackId,
    nodeType: row.nodeType,
    nodeId: row.nodeId,
  };
}

function loadLegacyEvents(db, wantedAddresses) {
  const latestEvents = new Map();
  const statement = db.prepare(`
    SELECT id, timestamp, event_type AS eventType, pid, tid, addr, type, size, tag,
           thread_name_id AS threadNameId, call_stack_id AS callStackId,
           node_type AS nodeType, node_id AS nodeId
    FROM native_hook_event
    WHERE addr IS NOT NULL
  `);
  statement.setReadBigInts(true);
  let scannedRows = 0;
  for (const row of statement.iterate()) {
    scannedRows += 1;
    const address = normalizeDatabaseAddress(row.addr);
    if (!address || !wantedAddresses.has(address)) {
      continue;
    }
    selectLatestEvent(latestEvents, address, buildLegacyEvent(row, address));
  }
  return { latestEvents, scannedRows };
}

function dictionaryValues(db) {
  const values = new Map();
  const statement = db.prepare('SELECT id, data FROM data_dict');
  statement.setReadBigInts(true);
  for (const row of statement.iterate()) {
    values.set(formatValue(row.id), row.data == null ? '' : String(row.data));
  }
  return values;
}

function parseDictionaryAddresses(value) {
  const addresses = new Set();
  for (const part of String(value ?? '').split(',')) {
    const address = normalizeDatabaseAddress(part, true);
    if (address) {
      addresses.add(address);
    }
  }
  return [...addresses];
}

function loadDictionaryAddressIds(db, wantedAddresses) {
  const result = new Map();
  const statement = db.prepare('SELECT id, data FROM data_dict');
  statement.setReadBigInts(true);
  for (const row of statement.iterate()) {
    const addresses = parseDictionaryAddresses(row.data)
      .filter(address => wantedAddresses.has(address));
    if (addresses.length > 0) {
      result.set(formatValue(row.id), addresses);
    }
  }
  return result;
}

function buildStatisticAddressEvent(row, address, index) {
  return {
    id: row.id ?? BigInt(index + 1),
    timestamp: 0n,
    eventType: 'ARK_GLOBAL_HANDLE_STATISTIC',
    pid: null,
    tid: null,
    addr: address,
    type: null,
    size: null,
    tag: null,
    threadNameId: null,
    callStackId: row.callchainId,
    nodeType: null,
    nodeId: null,
  };
}

function loadStatisticAddressEvents(db, wantedAddresses) {
  const addressByDictionaryId = loadDictionaryAddressIds(db, wantedAddresses);
  const latestEvents = new Map();
  const statement = db.prepare(`
    SELECT id, addr_id AS addrId, callchain_id AS callchainId
    FROM native_hook_statistic
  `);
  statement.setReadBigInts(true);
  let scannedRows = 0;
  for (const row of statement.iterate()) {
    scannedRows += 1;
    const addresses = addressByDictionaryId.get(formatValue(row.addrId)) || [];
    if (addresses.length === 0 || row.callchainId == null) {
      continue;
    }
    for (const address of addresses) {
      const event = buildStatisticAddressEvent(row, address, scannedRows);
      selectLatestEvent(latestEvents, address, event);
    }
  }
  return { latestEvents, scannedRows };
}

function rowValue(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) {
      return row[name];
    }
  }
  return null;
}

function buildNativeHookEvent(row, address, index) {
  return {
    id: rowValue(row, ['id']) ?? BigInt(index + 1),
    timestamp: rowValue(row, ['ts', 'timestamp']) ?? 0n,
    eventType: rowValue(row, ['event_type', 'type']) ?? 'NATIVE_HOOK',
    pid: rowValue(row, ['ipid', 'pid']),
    tid: rowValue(row, ['itid', 'tid']),
    addr: address,
    type: rowValue(row, ['type']),
    size: rowValue(row, ['size', 'apply_size']),
    tag: rowValue(row, ['tag']),
    threadNameId: rowValue(row, ['thread_name_id']),
    callStackId: rowValue(row, ['callchain_id', 'call_stack_id']),
    nodeType: rowValue(row, ['node_type']),
    nodeId: rowValue(row, ['node_id']),
  };
}

function loadNativeHookEvents(db, wantedAddresses) {
  const latestEvents = new Map();
  const statement = db.prepare('SELECT * FROM native_hook WHERE addr IS NOT NULL');
  statement.setReadBigInts(true);
  let scannedRows = 0;
  for (const row of statement.iterate()) {
    scannedRows += 1;
    const address = normalizeDatabaseAddress(row.addr);
    const callStackId = rowValue(row, ['callchain_id', 'call_stack_id']);
    if (!address || !wantedAddresses.has(address) || callStackId == null) {
      continue;
    }
    selectLatestEvent(latestEvents, address, buildNativeHookEvent(row, address, scannedRows));
  }
  return { latestEvents, scannedRows };
}

function collectStackIds(events) {
  const stackIds = new Set();
  for (const event of events.values()) {
    if (event.callStackId != null) {
      stackIds.add(formatValue(event.callStackId));
    }
  }
  return stackIds;
}

function buildTraceFrame(row, dictionary) {
  const ip = rowValue(row, ['ip']);
  const symbolId = rowValue(row, ['symbol_id']);
  const fileId = rowValue(row, ['file_id']);
  return {
    frameSn: rowValue(row, ['depth']),
    frameId: rowValue(row, ['id']),
    ip,
    ipHex: formatHex(ip),
    sp: null,
    offset: rowValue(row, ['offset']),
    symbolOffset: rowValue(row, ['symbol_offset']),
    symbolNameId: symbolId,
    filePathId: fileId,
    symbolName: dictionary.get(formatValue(symbolId)) || '',
    filePath: dictionary.get(formatValue(fileId)) || '',
  };
}

function traceFrameOrderColumn(schema) {
  const columns = schema.columns.get('native_hook_frame') || new Set();
  if (columns.has('depth')) {
    return 'depth';
  }
  if (columns.has('id')) {
    return 'id';
  }
  return 'rowid';
}

function loadTraceFrames(db, schema, stackIds) {
  const framesByStackId = new Map();
  const dictionary = dictionaryValues(db);
  const orderColumn = traceFrameOrderColumn(schema);
  const statement = db.prepare(`
    SELECT *
    FROM native_hook_frame
    WHERE callchain_id = ?
    ORDER BY ${quoteIdentifier(orderColumn)} ASC
  `);
  statement.setReadBigInts(true);
  for (const stackId of stackIds) {
    const frames = [];
    for (const row of statement.iterate(stackId)) {
      frames.push(buildTraceFrame(row, dictionary));
    }
    framesByStackId.set(stackId, frames);
  }
  return framesByStackId;
}

function buildLegacyFrame(row) {
  return {
    frameSn: row.frameSn,
    frameId: row.frameId,
    ip: row.ip,
    ipHex: formatHex(row.ip),
    sp: row.sp,
    offset: row.offset,
    symbolOffset: row.symbolOffset,
    symbolNameId: row.symbolNameId,
    filePathId: row.filePathId,
    symbolName: row.symbolName || '',
    filePath: row.filePath || '',
  };
}

function loadLegacyFrames(db, stackIds) {
  const framesByStackId = new Map();
  const statement = db.prepare(`
    SELECT cs.frame_sn AS frameSn, cs.frame_id AS frameId,
           fd.ip, fd.sp, fd.offset, fd.symbol_offset AS symbolOffset,
           fd.symbol_name_id AS symbolNameId, fd.file_path_id AS filePathId,
           sd.name AS symbolName,
           pd.name AS filePath
    FROM native_hook_call_stack cs
    LEFT JOIN native_hook_frame_detail fd ON fd.id = cs.frame_id
    LEFT JOIN native_hook_dict sd ON sd.id = fd.symbol_name_id AND sd.type = 'SymbolName'
    LEFT JOIN native_hook_dict pd ON pd.id = fd.file_path_id AND pd.type = 'FilePath'
    WHERE cs.stack_id = ?
    ORDER BY cs.frame_sn ASC
  `);
  statement.setReadBigInts(true);
  for (const stackId of stackIds) {
    const frames = [];
    for (const row of statement.iterate(stackId)) {
      frames.push(buildLegacyFrame(row));
    }
    framesByStackId.set(stackId, frames);
  }
  return framesByStackId;
}

function supportsTraceFrames(schema) {
  return supportsTable(
    schema,
    'native_hook_frame',
    ['callchain_id', 'symbol_id'],
  ) && supportsTable(schema, 'data_dict', ['id', 'data']);
}

function supportsLegacyFrames(schema) {
  return supportsTable(schema, 'native_hook_call_stack', ['stack_id', 'frame_id']) &&
    supportsTable(schema, 'native_hook_frame_detail', ['id']) &&
    supportsTable(schema, 'native_hook_dict', ['id']);
}

function loadFrames(db, schema, stackIds, preferredKind) {
  if (preferredKind === 'trace' && supportsTraceFrames(schema)) {
    return loadTraceFrames(db, schema, stackIds);
  }
  if (supportsLegacyFrames(schema)) {
    return loadLegacyFrames(db, stackIds);
  }
  if (supportsTraceFrames(schema)) {
    return loadTraceFrames(db, schema, stackIds);
  }
  return new Map([...stackIds].map(stackId => [stackId, []]));
}

function exactResult(db, schema, adapter, eventData, frameKind) {
  const stackIds = collectStackIds(eventData.latestEvents);
  return {
    associationMode: 'exact',
    schemaAdapter: adapter,
    latestEvents: eventData.latestEvents,
    framesByStackId: loadFrames(db, schema, stackIds, frameKind),
    aggregateStacks: [],
    scannedRows: eventData.scannedRows,
  };
}

function aggregateDictionaryIds(db) {
  const ids = new Set();
  const statement = db.prepare('SELECT id, data FROM data_dict');
  statement.setReadBigInts(true);
  for (const row of statement.iterate()) {
    if (String(row.data || '').trim().toUpperCase() === 'RES_ARK_GLOBAL_HANDLE') {
      ids.add(formatValue(row.id));
    }
  }
  return ids;
}

function toBigInt(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function createAggregateBucket(row) {
  return {
    callStackId: formatValue(row.callchainId),
    applyCount: 0n,
    releaseCount: 0n,
    applySize: 0n,
    releaseSize: 0n,
    unreleasedCount: 0n,
    unreleasedSize: 0n,
    frames: [],
  };
}

function updateAggregateBucket(bucket, row) {
  bucket.applyCount += toBigInt(row.applyCount);
  bucket.releaseCount += toBigInt(row.releaseCount);
  bucket.applySize += toBigInt(row.applySize);
  bucket.releaseSize += toBigInt(row.releaseSize);
  bucket.unreleasedCount = bucket.applyCount > bucket.releaseCount
    ? bucket.applyCount - bucket.releaseCount
    : 0n;
  bucket.unreleasedSize = bucket.applySize > bucket.releaseSize
    ? bucket.applySize - bucket.releaseSize
    : 0n;
}

function compareAggregateBuckets(left, right) {
  if (left.unreleasedSize !== right.unreleasedSize) {
    return left.unreleasedSize > right.unreleasedSize ? -1 : 1;
  }
  if (left.unreleasedCount !== right.unreleasedCount) {
    return left.unreleasedCount > right.unreleasedCount ? -1 : 1;
  }
  return left.callStackId.localeCompare(right.callStackId);
}

function loadAggregateStacks(db, schema) {
  const subtypeIds = aggregateDictionaryIds(db);
  if (subtypeIds.size === 0) {
    return [];
  }
  const buckets = new Map();
  const statement = db.prepare(`
    SELECT callchain_id AS callchainId, sub_type_id AS subTypeId,
           apply_count AS applyCount, release_count AS releaseCount,
           apply_size AS applySize, release_size AS releaseSize
    FROM native_hook_statistic
  `);
  statement.setReadBigInts(true);
  for (const row of statement.iterate()) {
    if (!subtypeIds.has(formatValue(row.subTypeId)) || row.callchainId == null) {
      continue;
    }
    const stackId = formatValue(row.callchainId);
    const bucket = buckets.get(stackId) || createAggregateBucket(row);
    buckets.set(stackId, bucket);
    updateAggregateBucket(bucket, row);
  }
  const stackIds = new Set(buckets.keys());
  const framesByStackId = loadFrames(db, schema, stackIds, 'trace');
  for (const [stackId, bucket] of buckets) {
    bucket.frames = framesByStackId.get(stackId) || [];
  }
  return [...buckets.values()].sort(compareAggregateBuckets).slice(0, 3);
}

function tryStatisticAddressAdapter(db, schema, wantedAddresses) {
  const supported = supportsTable(schema, 'data_dict', ['id', 'data']) &&
    supportsTable(schema, 'native_hook_statistic', ['addr_id', 'callchain_id']) &&
    supportsTraceFrames(schema);
  if (!supported || !tableHasRows(db, 'native_hook_statistic')) {
    return null;
  }
  const eventData = loadStatisticAddressEvents(db, wantedAddresses);
  return exactResult(db, schema, 'native_hook_statistic', eventData, 'trace');
}

function tryNativeHookAdapter(db, schema, wantedAddresses) {
  const supported = supportsTable(schema, 'native_hook', ['addr', 'callchain_id']) &&
    supportsTraceFrames(schema);
  if (!supported || !tableHasRows(db, 'native_hook')) {
    return null;
  }
  const eventData = loadNativeHookEvents(db, wantedAddresses);
  return exactResult(db, schema, 'native_hook', eventData, 'trace');
}

function tryLegacyAdapter(db, schema, wantedAddresses) {
  if (!supportsTable(schema, 'native_hook_event', ['addr', 'call_stack_id'])) {
    return null;
  }
  const eventData = loadLegacyEvents(db, wantedAddresses);
  return exactResult(db, schema, 'native_hook_event', eventData, 'legacy');
}

function tryAggregateAdapter(db, schema) {
  const supported = supportsTable(schema, 'native_hook_statistic', [
    'callchain_id', 'sub_type_id', 'apply_count', 'release_count',
    'apply_size', 'release_size',
  ]) && supportsTable(schema, 'data_dict', ['id', 'data']) &&
    supportsTraceFrames(schema);
  if (!supported || !tableHasRows(db, 'native_hook_statistic')) {
    return null;
  }
  const aggregateStacks = loadAggregateStacks(db, schema);
  if (aggregateStacks.length === 0) {
    return null;
  }
  return {
    associationMode: 'aggregate',
    schemaAdapter: 'native_hook_statistic',
    latestEvents: new Map(),
    framesByStackId: new Map(),
    aggregateStacks,
    scannedRows: null,
  };
}

function chooseDatabaseResult(db, schema, wantedAddresses) {
  const adapters = [
    tryStatisticAddressAdapter,
    tryNativeHookAdapter,
    tryLegacyAdapter,
  ];
  let fallbackExactResult = null;
  for (const adapter of adapters) {
    const result = adapter(db, schema, wantedAddresses);
    if (!result) {
      continue;
    }
    fallbackExactResult ||= result;
    if (result.latestEvents.size > 0) {
      return result;
    }
  }
  const aggregateResult = tryAggregateAdapter(db, schema);
  if (aggregateResult) {
    return aggregateResult;
  }
  if (fallbackExactResult) {
    return fallbackExactResult;
  }
  const tableList = [...schema.tables].sort().join(', ');
  throw new Error(`Unsupported native hook database schema. Tables: ${tableList}`);
}

export async function analyzeNativeStackDatabase(databasePath, addressToNodeRefs) {
  const { DatabaseSync: databaseSyncClass } = await import('node:sqlite');
  const database = new databaseSyncClass(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON');
    const schema = inspectSchema(database);
    const result = chooseDatabaseResult(
      database,
      schema,
      buildAddressSet(addressToNodeRefs),
    );
    return {
      ...result,
      databaseTables: [...schema.tables].sort(),
    };
  } finally {
    database.close();
  }
}
