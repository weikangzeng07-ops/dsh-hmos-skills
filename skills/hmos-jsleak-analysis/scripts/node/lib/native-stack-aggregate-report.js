function formatValue(value) {
  return value == null ? '' : String(value);
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
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
  const filePath = frame.filePath || '';
  const symbolName = frame.symbolName || '';
  const symbolOffset = frame.symbolOffset != null && BigInt(frame.symbolOffset) !== 0n
    ? `+0x${BigInt(frame.symbolOffset).toString(16)}`
    : '';
  if (filePath && symbolName) {
    return `   #${String(index).padStart(2, '0')} ${ip} ${filePath}(${symbolName}${symbolOffset})`;
  }
  if (symbolName) {
    return `   #${String(index).padStart(2, '0')} ${ip} ${symbolName}${symbolOffset}`;
  }
  return `   #${String(index).padStart(2, '0')} ${ip}`;
}

function markdownCell(value) {
  const text = formatValue(value) || '-';
  return text.replace(/\r?\n/gu, '<br>').replace(/\|/gu, '\\|');
}

function appendKeyValueTable(lines, rows) {
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  for (const [key, value] of rows) {
    lines.push(`| ${markdownCell(key)} | ${markdownCell(value)} |`);
  }
  lines.push('');
}

function mappedNodeCount(nodeAddresses) {
  let count = 0;
  for (const addresses of nodeAddresses.values()) {
    if (addresses.length > 0) {
      count += 1;
    }
  }
  return count;
}

function mappedRequestedNodeCount(nodeAddresses, nodeIds) {
  return nodeIds.filter(nodeId => (nodeAddresses.get(nodeId) || []).length > 0).length;
}

function nativeAddressCount(nodeAddresses) {
  let count = 0;
  for (const addresses of nodeAddresses.values()) {
    count += addresses.length;
  }
  return count;
}

function groupNodeIds(group, seedNodeId) {
  if (group && Array.isArray(group.sameNameNodeIds)) {
    return group.sameNameNodeIds;
  }
  return [seedNodeId];
}

function countGroupAddresses(nodeIds, nodeAddresses) {
  return nodeIds.reduce(
    (count, nodeId) => count + (nodeAddresses.get(nodeId) || []).length,
    0,
  );
}

function buildAggregateResult(seedNodeId, inputs, nameGroups, nodeAddresses) {
  const group = nameGroups?.get(seedNodeId);
  const clusterSources = inputs.clusterSourcesByNodeId?.get(seedNodeId) || [];
  const sameNameNodeIds = groupNodeIds(group, seedNodeId);
  return {
    seedNodeId,
    clusterSources,
    objectName: group?.objectName ?? clusterSources[0]?.objectName ?? null,
    nameIndex: group?.nameIndex ?? null,
    sameNameTotalNodeCount: group?.sameNameTotalNodeCount ?? 1,
    sameNameLinkableNodeCount: sameNameNodeIds.length,
    sameNameNodeCount: sameNameNodeIds.length,
    sameNameNodeIds,
    nativeAddressCount: countGroupAddresses(sameNameNodeIds, nodeAddresses),
    matchedNativeAddressCount: 0,
    candidateStackCount: 0,
    topStack: null,
    topStacks: [],
    error: 'aggregate_only',
  };
}

function serializeAggregateStack(stack, rank) {
  return {
    rank,
    callStackId: stack.callStackId,
    applyCount: stack.applyCount,
    releaseCount: stack.releaseCount,
    unreleasedCount: stack.unreleasedCount,
    applySize: stack.applySize,
    releaseSize: stack.releaseSize,
    unreleasedSize: stack.unreleasedSize,
    frames: stack.frames,
  };
}

function buildAggregateMetadata(inputs, mapping, nodeAddresses, databaseAnalysis, results) {
  return {
    mode: inputs.clusterJson ? 'cluster_group_by_name' : 'group_by_name',
    associationMode: 'aggregate',
    schemaAdapter: databaseAnalysis.schemaAdapter,
    generatedAt: new Date().toISOString(),
    snapshot: inputs.snapshot || null,
    rawheap: inputs.rawheap || null,
    htrace: inputs.htrace || null,
    jsMap: inputs.jsMap || null,
    nativeHookDb: inputs.nativeHookDb,
    clusterJson: inputs.clusterJson,
    nodeIds: inputs.nodeIds,
    clusterSeedCount: inputs.clusterSeeds.length,
    clusterSourceCount: inputs.clusterSeeds.length,
    addressMapSource: mapping.source,
    addressMapEntries: mapping.entryCount,
    addressMapUniqueNodeCount: mapping.uniqueNodeCount,
    addressMapInvalidLineCount: mapping.invalidLineCount || 0,
    addressMapDuplicateLineCount: mapping.duplicateLineCount || 0,
    requestedNodeCount: inputs.nodeIds.length,
    mappedSeedNodeCount: mappedRequestedNodeCount(nodeAddresses, inputs.nodeIds),
    mappedExpandedNodeCount: mappedNodeCount(nodeAddresses),
    nativeAddressCount: nativeAddressCount(nodeAddresses),
    matchedNativeAddressCount: 0,
    reportObjectCount: results.length,
    pipelineStages: inputs.pipelineStages,
    databaseTables: databaseAnalysis.databaseTables,
  };
}

export function buildAggregateReport(
  inputs,
  mapping,
  nameGroups,
  nodeAddresses,
  databaseAnalysis,
) {
  const results = inputs.nodeIds.map(nodeId =>
    buildAggregateResult(nodeId, inputs, nameGroups, nodeAddresses));
  return {
    metadata: buildAggregateMetadata(
      inputs,
      mapping,
      nodeAddresses,
      databaseAnalysis,
      results,
    ),
    results,
    clusterCandidates: inputs.clusterSeeds,
    aggregateGlobalHandleStacks: databaseAnalysis.aggregateStacks
      .map((stack, index) => serializeAggregateStack(stack, index + 1)),
  };
}

function appendFrames(lines, frames) {
  lines.push('```text');
  if (frames.length === 0) {
    lines.push('(无栈帧)');
  } else {
    frames.forEach((frame, index) => lines.push(formatFrame(frame, index)));
  }
  lines.push('```', '');
}

function appendAggregateStack(lines, stack) {
  lines.push(`### Top ${stack.rank}: Callchain ${stack.callStackId}`, '');
  appendKeyValueTable(lines, [
    ['申请次数', stack.applyCount],
    ['释放次数', stack.releaseCount],
    ['未释放数量', stack.unreleasedCount],
    ['申请大小', formatBytes(stack.applySize)],
    ['释放大小', formatBytes(stack.releaseSize)],
    ['未释放大小', formatBytes(stack.unreleasedSize)],
    ['栈帧数量', stack.frames.length],
  ]);
  appendFrames(lines, stack.frames);
}

export function appendAggregateMarkdown(markdown, report) {
  const lines = [markdown.trimEnd(), '', '## GlobalHandle 聚合 Native Top 栈', ''];
  lines.push(
    '> 注意：以下调用栈来自 `RES_ARK_GLOBAL_HANDLE` 整体统计，' +
    '不能归因到上述任一具体 JS 对象。',
    '',
  );
  for (const stack of report.aggregateGlobalHandleStacks) {
    appendAggregateStack(lines, stack);
  }
  return `${lines.join('\n')}\n`;
}
