import path from 'path';

import { appObjectWeight, escapeHtml, formatSize, isBusinessObject, normalizeComparisonObjectName, percentOf } from './heap-cluster-core.js';

// =================多快照聚合=================
function categoryText(category) {
  if (category === 'business') {
    return '业务对象';
  }
  if (category === 'common') {
    return '公共对象';
  }
  return category || '未知分类';
}

function markdownCell(value) {
  const text = value == null || value === '' ? '-' : String(value);
  return text.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

function appendMarkdownKeyValueTable(lines, rows) {
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  for (const [key, value] of rows) {
    lines.push(`| ${markdownCell(key)} | ${markdownCell(value)} |`);
  }
  lines.push('');
}

function formatFixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : (0).toFixed(digits);
}

function formatPercentRatio(value) {
  return `${formatFixed(value * 100, 1)}%`;
}

function getCandidateList(clusterJson, category) {
  const key = category === 'business' ? 'business_candidates' : 'common_candidates';
  return Array.isArray(clusterJson?.[key]) ? clusterJson[key] : [];
}

function getPathNamesFromCandidate(item) {
  return (Array.isArray(item?.path_entries) ? item.path_entries : [])
    .map(entry => entry?.name || '');
}

function getNormalizedPathNamesFromCandidate(item) {
  return getPathNamesFromCandidate(item).map(normalizeComparisonObjectName);
}

function buildMultiSnapshotChainKey(category, item) {
  return JSON.stringify({
    category,
    'root_type': item?.root_type || '',
    'path_names': getNormalizedPathNamesFromCandidate(item),
  });
}

function isPathNameSequenceContained(shorter, longer) {
  if (!Array.isArray(shorter) || !Array.isArray(longer)) {
    return false;
  }
  if (shorter.length === 0 || shorter.length > longer.length) {
    return false;
  }

  const lastStart = longer.length - shorter.length;
  for (let start = 0; start <= lastStart; start++) {
    let matched = true;
    for (let offset = 0; offset < shorter.length; offset++) {
      if (shorter[offset] !== longer[start + offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }

  return false;
}

function areMultiSnapshotChainsSimilar(a, b) {
  if (!a || !b) {
    return false;
  }
  if ((a.category || '') !== (b.category || '')) {
    return false;
  }
  if ((a.root_type || '') !== (b.root_type || '')) {
    return false;
  }

  const aNames = Array.isArray(a.normalized_path_names)
    ? a.normalized_path_names
    : (Array.isArray(a.path_names) ? a.path_names.map(normalizeComparisonObjectName) : []);
  const bNames = Array.isArray(b.normalized_path_names)
    ? b.normalized_path_names
    : (Array.isArray(b.path_names) ? b.path_names.map(normalizeComparisonObjectName) : []);
  return isPathNameSequenceContained(aNames, bNames) ||
    isPathNameSequenceContained(bNames, aNames);
}

function groupVariantsBySimilarity(variants, isSimilar) {
  const parents = variants.map((unusedItem, index) => index);

  function find(index) {
    let root = index;
    while (parents[root] !== root) {
      root = parents[root];
    }
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parents[rootB] = rootA;
    }
  }

  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      if (isSimilar(variants[i], variants[j])) {
        union(i, j);
      }
    }
  }

  const components = new Map();
  variants.forEach((variant, index) => {
    const root = find(index);
    if (!components.has(root)) {
      components.set(root, []);
    }
    components.get(root).push(variant);
  });
  return [...components.values()];
}

function groupSimilarChainVariants(variants) {
  return groupVariantsBySimilarity(variants, areMultiSnapshotChainsSimilar);
}

function compareSnapshotCandidate(a, b) {
  const rankDiff = (a?.rank || Number.MAX_SAFE_INTEGER) - (b?.rank || Number.MAX_SAFE_INTEGER);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  return (b?.total_retained_size || 0) - (a?.total_retained_size || 0);
}

function compareMultiSnapshotAggregate(a, b) {
  const totalSizeDiff = (b.total_retained_size || 0) - (a.total_retained_size || 0);
  if (totalSizeDiff !== 0) {
    return totalSizeDiff;
  }

  const averageSizeDiff = (b.average_retained_size || 0) - (a.average_retained_size || 0);
  if (averageSizeDiff !== 0) {
    return averageSizeDiff;
  }

  const occurrenceDiff = (b.occurrence_count || 0) - (a.occurrence_count || 0);
  if (occurrenceDiff !== 0) {
    return occurrenceDiff;
  }

  const rankDiff = (a.average_rank || 0) - (b.average_rank || 0);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  const maxSizeDiff = (b.max_retained_size || 0) - (a.max_retained_size || 0);
  if (maxSizeDiff !== 0) {
    return maxSizeDiff;
  }

  return String(a.chain_key || '').localeCompare(String(b.chain_key || ''));
}

function collectMultiSnapshotChainVariants(successfulSnapshots, category) {
  const variantsByKey = new Map();
  for (const snapshot of successfulSnapshots) {
    const candidates = getCandidateList(snapshot.clusterJson, category);
    const bestByKeyInSnapshot = new Map();
    for (const candidate of candidates) {
      const chainKey = buildMultiSnapshotChainKey(category, candidate);
      const previous = bestByKeyInSnapshot.get(chainKey);
      if (!previous || compareSnapshotCandidate(candidate, previous) < 0) {
        bestByKeyInSnapshot.set(chainKey, candidate);
      }
    }
    for (const [chainKey, candidate] of bestByKeyInSnapshot.entries()) {
      let variant = variantsByKey.get(chainKey);
      if (!variant) {
        variant = {
          category,
          'chain_key': chainKey,
          'root_type': candidate.root_type || '',
          'path_names': getPathNamesFromCandidate(candidate),
          'normalized_path_names': getNormalizedPathNamesFromCandidate(candidate),
          occurrences: [],
        };
        variantsByKey.set(chainKey, variant);
      }
      variant.occurrences.push({ snapshot, candidate, 'chain_key': chainKey });
    }
  }
  return [...variantsByKey.values()];
}

function selectBestSnapshotOccurrences(
  occurrences,
  getCandidate,
  compareCandidates = compareSnapshotCandidate,
) {
  const bestBySnapshot = new Map();
  for (const occurrence of occurrences) {
    const snapshotKey = path.resolve(occurrence.snapshot.snapshotPath);
    const candidate = getCandidate(occurrence);
    const previous = bestBySnapshot.get(snapshotKey);
    if (!previous || compareCandidates(candidate, getCandidate(previous)) < 0) {
      bestBySnapshot.set(snapshotKey, occurrence);
    }
  }
  return [...bestBySnapshot.values()];
}

function compareRepresentativeChainOccurrence(a, b) {
  const depthDiff = getPathNamesFromCandidate(b.candidate).length -
    getPathNamesFromCandidate(a.candidate).length;
  if (depthDiff !== 0) {
    return depthDiff;
  }
  const sizeDiff = (b.candidate.total_retained_size || 0) -
    (a.candidate.total_retained_size || 0);
  if (sizeDiff !== 0) {
    return sizeDiff;
  }
  const candidateDiff = compareSnapshotCandidate(a.candidate, b.candidate);
  return candidateDiff !== 0
    ? candidateDiff
    : String(a.chain_key).localeCompare(String(b.chain_key));
}

function buildMultiSnapshotOccurrenceDetail(occurrence, totals, category) {
  const { snapshot, candidate } = occurrence;
  const retainedSize = candidate.total_retained_size || 0;
  const rank = candidate.rank || 0;
  const groupNames = Array.isArray(candidate.group_names) ? candidate.group_names : [];
  totals.rank += rank;
  totals.retainedSize += retainedSize;
  totals.maxRetainedSize = Math.max(totals.maxRetainedSize, retainedSize);
  groupNames.forEach(name => totals.groupNames.add(name));
  return {
    snapshot: snapshot.snapshotPath,
    'snapshot_name': path.basename(snapshot.snapshotPath),
    'cluster_json': snapshot.clusterJsonPath,
    rank,
    count: candidate.count || 0,
    'total_retained_size': retainedSize,
    'total_retained_size_text': formatSize(retainedSize),
    'heap_percent': candidate.heap_percent || '',
    'group_names': groupNames,
    'matched_chain_key': buildMultiSnapshotChainKey(category, candidate),
    'matched_path_names': getPathNamesFromCandidate(candidate),
    'matched_normalized_path_names': getNormalizedPathNamesFromCandidate(candidate),
  };
}

function serializeSimilarChainVariant(variant) {
  return {
    'chain_key': variant.chain_key,
    'path_names': variant.path_names,
    'normalized_path_names': variant.normalized_path_names,
  };
}

function serializeMultiSnapshotAggregate(context) {
  const {
    category, component, representative, representativeChainKey,
    representativePathNames, representativeNormalizedPathNames,
    occurrenceDetails, snapshotCount, totals,
  } = context;
  const occurrenceCount = occurrenceDetails.length;
  const averageRetainedSize = occurrenceCount > 0
    ? totals.retainedSize / occurrenceCount
    : 0;
  return {
    category,
    'chain_key': representativeChainKey,
    'root_type': representative.root_type || '',
    'path_names': representativePathNames,
    'normalized_path_names': representativeNormalizedPathNames,
    'group_names': [...totals.groupNames].sort(),
    'similar_chain_count': component.length,
    'similar_chains': component.map(serializeSimilarChainVariant)
      .sort((a, b) => String(a.chain_key).localeCompare(String(b.chain_key))),
    'occurrence_count': occurrenceCount,
    'occurrence_ratio': snapshotCount > 0 ? occurrenceCount / snapshotCount : 0,
    'average_rank': occurrenceCount > 0 ? totals.rank / occurrenceCount : 0,
    'total_retained_size': totals.retainedSize,
    'total_retained_size_text': formatSize(totals.retainedSize),
    'average_retained_size': averageRetainedSize,
    'average_retained_size_text': formatSize(averageRetainedSize),
    'max_retained_size': totals.maxRetainedSize,
    'max_retained_size_text': formatSize(totals.maxRetainedSize),
    'representative_path_entries': Array.isArray(representative.path_entries)
      ? representative.path_entries
      : [],
    occurrenceDetails: occurrenceDetails.sort((a, b) =>
      String(a.snapshot_name).localeCompare(String(b.snapshot_name))),
  };
}

function buildMultiSnapshotChainAggregate(component, snapshotCount, category) {
  const allOccurrences = component.flatMap(variant => variant.occurrences);
  const selectedOccurrences = selectBestSnapshotOccurrences(
    allOccurrences, occurrence => occurrence.candidate,
  );
  const representativeOccurrence = [...allOccurrences]
    .sort(compareRepresentativeChainOccurrence)[0];
  const representative = representativeOccurrence?.candidate || {};
  const totals = { rank: 0, retainedSize: 0, maxRetainedSize: 0, groupNames: new Set() };
  const occurrenceDetails = selectedOccurrences.map(occurrence =>
    buildMultiSnapshotOccurrenceDetail(occurrence, totals, category));
  return serializeMultiSnapshotAggregate({
    category, component, representative, occurrenceDetails, snapshotCount, totals,
    representativePathNames: getPathNamesFromCandidate(representative),
    representativeNormalizedPathNames: getNormalizedPathNamesFromCandidate(representative),
    representativeChainKey: buildMultiSnapshotChainKey(category, representative),
  });
}

function rankMultiSnapshotAggregates(items) {
  return items.sort(compareMultiSnapshotAggregate)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function collectMultiSnapshotAggregates(successfulSnapshots, category) {
  const variants = collectMultiSnapshotChainVariants(successfulSnapshots, category);
  const components = groupSimilarChainVariants(variants);
  const aggregates = components.map(component =>
    buildMultiSnapshotChainAggregate(component, successfulSnapshots.length, category));
  return rankMultiSnapshotAggregates(aggregates);
}

function getLegacyCandidateChains(clusterJson, category) {
  const chainKey = category === 'business' ? 'business_candidates' : 'common_candidates';
  const topKey = category === 'business' ? 'business_top5' : 'common_top5';
  return Array.isArray(clusterJson?.[chainKey]) &&
    clusterJson[chainKey].length > 0
    ? clusterJson[chainKey]
    : (Array.isArray(clusterJson?.[topKey]) ? clusterJson[topKey] : []);
}

function groupLegacyChainsByObjectName(candidateChains) {
  const chainsByGroupName = new Map();
  for (const chain of candidateChains) {
    for (const groupName of Array.isArray(chain?.group_names) ? chain.group_names : []) {
      if (!chainsByGroupName.has(groupName)) {
        chainsByGroupName.set(groupName, []);
      }
      chainsByGroupName.get(groupName).push(chain);
    }
  }
  return chainsByGroupName;
}

function isLegacyGroupInCategory(group, category) {
  const groupName = group?.group_name || '';
  const isApp = Boolean(group?.is_app) || Number(group?.weight || 0) > 1 ||
    isBusinessObject(groupName);
  return category === 'business' ? isApp : !isApp;
}

function serializeLegacyObjectCandidate(group, context) {
  const { category, chainsByGroupName, totalHeapSize } = context;
  const objectName = group.group_name || '';
  const retainedSize = group.total_size || 0;
  const weight = group.weight || (category === 'business' ? appObjectWeight : 1);
  const weightedSize = group.weighted_size || retainedSize * weight;
  const chains = chainsByGroupName.get(objectName) || [];
  return {
    category,
    'object_name': objectName,
    'normalized_object_name': normalizeComparisonObjectName(objectName),
    'object_name_variants': [...new Set([
      ...(Array.isArray(group.object_name_variants) ? group.object_name_variants : []),
      objectName,
    ].filter(Boolean))].sort(),
    count: group.count || 0,
    'total_retained_size': retainedSize,
    'total_retained_size_text': group.total_size_text || formatSize(retainedSize),
    'heap_percent': totalHeapSize > 0 ? percentOf(retainedSize, totalHeapSize) : '0.0',
    weight,
    'weighted_size': weightedSize,
    'weighted_size_text': group.weighted_size_text || formatSize(weightedSize),
    'chain_count': chains.length,
    chains,
    'candidate_source': 'legacy_filtered_groups',
  };
}

function compareLegacyObjectCandidates(a, b) {
  const sizeDiff = b.total_retained_size - a.total_retained_size;
  return sizeDiff !== 0 ? sizeDiff : a.object_name.localeCompare(b.object_name);
}

function buildLegacyObjectCandidateList(clusterJson, category) {
  const filteredGroups = Array.isArray(clusterJson?.filtered_groups)
    ? clusterJson.filtered_groups
    : [];
  if (filteredGroups.length === 0) {
    return [];
  }
  const chainsByGroupName = groupLegacyChainsByObjectName(
    getLegacyCandidateChains(clusterJson, category),
  );
  const context = {
    category,
    chainsByGroupName,
    totalHeapSize: clusterJson?.metadata?.total_heap_size || 0,
  };
  return filteredGroups.filter(group => isLegacyGroupInCategory(group, category))
    .map(group => serializeLegacyObjectCandidate(group, context))
    .sort(compareLegacyObjectCandidates)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function getObjectCandidateList(clusterJson, category) {
  const key = category === 'business'
    ? 'business_object_candidates'
    : 'common_object_candidates';
  const candidates = Array.isArray(clusterJson?.[key]) ? clusterJson[key] : [];
  if (candidates.length > 0) {
    return candidates;
  }
  return buildLegacyObjectCandidateList(clusterJson, category);
}

function getPathNamesFromSerializedChain(chain) {
  return (Array.isArray(chain?.path_entries) ? chain.path_entries : [])
    .map(entry => entry?.name || '');
}

function getNormalizedPathNamesFromSerializedChain(chain) {
  return getPathNamesFromSerializedChain(chain).map(normalizeComparisonObjectName);
}

function isPathNameOrderedSubsequence(shorter, longer) {
  if (!Array.isArray(shorter) || !Array.isArray(longer)) {
    return false;
  }
  if (shorter.length === 0 || shorter.length > longer.length) {
    return false;
  }

  let shortIndex = 0;
  for (const name of longer) {
    if (name === shorter[shortIndex]) {
      shortIndex++;
    }
    if (shortIndex === shorter.length) {
      return true;
    }
  }
  return false;
}

function areObjectRepresentativeChainsSimilar(a, b) {
  if (!a || !b) {
    return false;
  }
  if ((a.root_type || '') !== (b.root_type || '')) {
    return false;
  }

  const aNames = Array.isArray(a.normalized_path_names)
    ? a.normalized_path_names
    : (Array.isArray(a.path_names) ? a.path_names.map(normalizeComparisonObjectName) : []);
  const bNames = Array.isArray(b.normalized_path_names)
    ? b.normalized_path_names
    : (Array.isArray(b.path_names) ? b.path_names.map(normalizeComparisonObjectName) : []);
  return isPathNameOrderedSubsequence(aNames, bNames) ||
    isPathNameOrderedSubsequence(bNames, aNames);
}

function compareObjectChainCandidate(a, b) {
  const sizeDiff = (b?.total_retained_size || 0) - (a?.total_retained_size || 0);
  if (sizeDiff !== 0) {
    return sizeDiff;
  }

  const rankDiff = (a?.rank || Number.MAX_SAFE_INTEGER) -
    (b?.rank || Number.MAX_SAFE_INTEGER);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  const depthDiff = getPathNamesFromSerializedChain(b).length -
    getPathNamesFromSerializedChain(a).length;
  if (depthDiff !== 0) {
    return depthDiff;
  }

  return JSON.stringify(getPathNamesFromSerializedChain(a))
    .localeCompare(JSON.stringify(getPathNamesFromSerializedChain(b)));
}

function compareObjectRepresentativeChainAggregate(a, b) {
  const totalDiff = (b.total_retained_size || 0) - (a.total_retained_size || 0);
  if (totalDiff !== 0) {
    return totalDiff;
  }

  const averageDiff = (b.average_retained_size || 0) - (a.average_retained_size || 0);
  if (averageDiff !== 0) {
    return averageDiff;
  }

  const occurrenceDiff = (b.occurrence_count || 0) - (a.occurrence_count || 0);
  if (occurrenceDiff !== 0) {
    return occurrenceDiff;
  }

  const maxDiff = (b.max_retained_size || 0) - (a.max_retained_size || 0);
  if (maxDiff !== 0) {
    return maxDiff;
  }

  return String(a.chain_key || '').localeCompare(String(b.chain_key || ''));
}

function collectObjectChainVariants(objectOccurrences) {
  const variants = [];
  for (const { snapshot, candidate } of objectOccurrences) {
    for (const chain of candidate.chains || []) {
      variants.push({
        snapshot,
        chain,
        'root_type': chain.root_type || '',
        'path_names': getPathNamesFromSerializedChain(chain),
        'normalized_path_names': getNormalizedPathNamesFromSerializedChain(chain),
      });
    }
  }
  return variants;
}

function compareObjectRepresentativeVariant(a, b) {
  const candidateDiff = compareObjectChainCandidate(a.chain, b.chain);
  return candidateDiff !== 0
    ? candidateDiff
    : String(a.snapshot.snapshotPath).localeCompare(String(b.snapshot.snapshotPath));
}

function serializeObjectChainOccurrence(item) {
  return {
    snapshot: item.snapshot.snapshotPath,
    'snapshot_name': path.basename(item.snapshot.snapshotPath),
    rank: item.chain.rank || 0,
    count: item.chain.count || 0,
    'total_retained_size': item.chain.total_retained_size || 0,
    'total_retained_size_text': item.chain.total_retained_size_text ||
      formatSize(item.chain.total_retained_size || 0),
    'matched_path_names': item.path_names,
    'matched_normalized_path_names': item.normalized_path_names,
  };
}

function serializeObjectRepresentativeAggregate(context) {
  const {
    representativeChain, representativePathNames, representativeNormalizedPathNames,
    selected, component, snapshotCount, totalRetainedSize, maxRetainedSize,
  } = context;
  const occurrenceCount = selected.length;
  const averageRetainedSize = occurrenceCount > 0
    ? totalRetainedSize / occurrenceCount
    : 0;
  const distinctChains = new Set(component.map(item => JSON.stringify({
    'root_type': item.root_type || '',
    'path_names': item.normalized_path_names,
  })));
  return {
    'chain_key': JSON.stringify({
      'root_type': representativeChain.root_type || '',
      'path_names': representativeNormalizedPathNames,
    }),
    'root_type': representativeChain.root_type || '',
    'path_names': representativePathNames,
    'normalized_path_names': representativeNormalizedPathNames,
    'similar_chain_count': distinctChains.size,
    'occurrence_count': occurrenceCount,
    'occurrence_ratio': snapshotCount > 0 ? occurrenceCount / snapshotCount : 0,
    'total_retained_size': totalRetainedSize,
    'total_retained_size_text': formatSize(totalRetainedSize),
    'average_retained_size': averageRetainedSize,
    'average_retained_size_text': formatSize(averageRetainedSize),
    'max_retained_size': maxRetainedSize,
    'max_retained_size_text': formatSize(maxRetainedSize),
    'representative_path_entries': Array.isArray(representativeChain.path_entries)
      ? representativeChain.path_entries
      : [],
    occurrenceDetails: selected.map(serializeObjectChainOccurrence)
      .sort((a, b) => String(a.snapshot_name).localeCompare(String(b.snapshot_name))),
  };
}

function buildObjectRepresentativeChainAggregate(component, snapshotCount) {
  const selected = selectBestSnapshotOccurrences(
    component, item => item.chain, compareObjectChainCandidate,
  );
  const representative = [...component].sort(compareObjectRepresentativeVariant)[0];
  const representativeChain = representative?.chain || {};
  const totalRetainedSize = selected.reduce(
    (sum, item) => sum + (item.chain.total_retained_size || 0), 0,
  );
  const maxRetainedSize = selected.reduce(
    (max, item) => Math.max(max, item.chain.total_retained_size || 0), 0,
  );
  return serializeObjectRepresentativeAggregate({
    representativeChain, selected, component, snapshotCount, totalRetainedSize, maxRetainedSize,
    representativePathNames: getPathNamesFromSerializedChain(representativeChain),
    representativeNormalizedPathNames: getNormalizedPathNamesFromSerializedChain(
      representativeChain,
    ),
  });
}

function collectObjectRepresentativeChains(objectOccurrences, snapshotCount) {
  const variants = collectObjectChainVariants(objectOccurrences);
  const components = groupVariantsBySimilarity(variants, areObjectRepresentativeChainsSimilar);
  return components.map(component =>
    buildObjectRepresentativeChainAggregate(component, snapshotCount))
    .sort(compareObjectRepresentativeChainAggregate)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function compareMultiSnapshotObjectAggregate(a, b) {
  const totalDiff = (b.total_retained_size || 0) - (a.total_retained_size || 0);
  if (totalDiff !== 0) {
    return totalDiff;
  }

  const averageDiff = (b.snapshot_average_retained_size || 0) -
    (a.snapshot_average_retained_size || 0);
  if (averageDiff !== 0) {
    return averageDiff;
  }

  const occurrenceDiff = (b.occurrence_count || 0) - (a.occurrence_count || 0);
  if (occurrenceDiff !== 0) {
    return occurrenceDiff;
  }

  return String(a.object_name || '').localeCompare(String(b.object_name || ''));
}

function createSnapshotObjectAlias(candidate, normalizedObjectName) {
  const candidateSize = candidate.total_retained_size || 0;
  const candidateRank = candidate.rank || Number.MAX_SAFE_INTEGER;
  return {
    ...candidate,
    'normalized_object_name': normalizedObjectName,
    'object_name_variants': [...new Set([
      ...(candidate.object_name_variants || []),
      candidate.object_name || normalizedObjectName,
    ].filter(Boolean))],
    '_alias_representative_size': candidateSize,
    '_alias_representative_rank': candidateRank,
  };
}

function isSnapshotAliasRepresentative(previous, candidate, candidateSize, candidateRank) {
  const previousRepresentativeSize = previous._alias_representative_size || 0;
  const previousRepresentativeRank = previous._alias_representative_rank ||
    Number.MAX_SAFE_INTEGER;
  return candidateSize > previousRepresentativeSize ||
    (candidateSize === previousRepresentativeSize && candidateRank < previousRepresentativeRank) ||
    (
      candidateSize === previousRepresentativeSize &&
      candidateRank === previousRepresentativeRank &&
      String(candidate.object_name || '').localeCompare(String(previous.object_name || '')) < 0
    );
}

function collectSnapshotAliasVariants(previous, candidate) {
  return [...new Set([
    ...(previous.object_name_variants || []),
    previous.object_name,
    ...(candidate.object_name_variants || []),
    candidate.object_name,
  ].filter(Boolean))].sort();
}

function mergeSnapshotObjectCandidateAliases(previous, candidate, normalizedObjectName) {
  if (!previous) {
    return createSnapshotObjectAlias(candidate, normalizedObjectName);
  }
  const candidateSize = candidate.total_retained_size || 0;
  const candidateRank = candidate.rank || Number.MAX_SAFE_INTEGER;
  const candidateIsRepresentative = isSnapshotAliasRepresentative(
    previous, candidate, candidateSize, candidateRank,
  );
  const representative = candidateIsRepresentative ? candidate : previous;
  const previousRepresentativeSize = previous._alias_representative_size || 0;
  const previousRepresentativeRank = previous._alias_representative_rank ||
    Number.MAX_SAFE_INTEGER;
  const totalRetainedSize = (previous.total_retained_size || 0) + candidateSize;
  const totalWeightedSize = (previous.weighted_size || 0) + (candidate.weighted_size || 0);
  const chains = [
    ...(Array.isArray(previous.chains) ? previous.chains : []),
    ...(Array.isArray(candidate.chains) ? candidate.chains : []),
  ];
  const positiveRanks = [previous.rank, candidate.rank]
    .filter(rank => Number.isFinite(rank) && rank > 0);

  return {
    ...representative,
    'normalized_object_name': normalizedObjectName,
    'object_name_variants': collectSnapshotAliasVariants(previous, candidate),
    rank: positiveRanks.length > 0 ? Math.min(...positiveRanks) : 0,
    count: (previous.count || 0) + (candidate.count || 0),
    'total_retained_size': totalRetainedSize,
    'total_retained_size_text': formatSize(totalRetainedSize),
    'heap_percent': (previous.heap_percent || 0) + (candidate.heap_percent || 0),
    'weighted_size': totalWeightedSize,
    'weighted_size_text': formatSize(totalWeightedSize),
    chains,
    'chain_count': chains.length,
    '_alias_representative_size': candidateIsRepresentative
      ? candidateSize
      : previousRepresentativeSize,
    '_alias_representative_rank': candidateIsRepresentative
      ? candidateRank
      : previousRepresentativeRank,
  };
}

function combineSnapshotObjectCandidates(snapshot, category) {
  const combined = new Map();
  for (const candidate of getObjectCandidateList(snapshot.clusterJson, category)) {
    const normalizedName = normalizeComparisonObjectName(
      candidate.object_name || candidate.normalized_object_name || '',
    );
    combined.set(
      normalizedName,
      mergeSnapshotObjectCandidateAliases(combined.get(normalizedName), candidate, normalizedName),
    );
  }
  return combined;
}

function collectObjectOccurrencesByName(successfulSnapshots, category) {
  const occurrencesByName = new Map();
  for (const snapshot of successfulSnapshots) {
    const combined = combineSnapshotObjectCandidates(snapshot, category);
    for (const [normalizedName, candidate] of combined.entries()) {
      const occurrences = occurrencesByName.get(normalizedName) || [];
      occurrences.push({ snapshot, candidate });
      occurrencesByName.set(normalizedName, occurrences);
    }
  }
  return occurrencesByName;
}

function compareObjectRepresentativeOccurrence(a, b) {
  const sizeDiff = (b.candidate.total_retained_size || 0) -
    (a.candidate.total_retained_size || 0);
  if (sizeDiff !== 0) {
    return sizeDiff;
  }
  const rankDiff = (a.candidate.rank || Number.MAX_SAFE_INTEGER) -
    (b.candidate.rank || Number.MAX_SAFE_INTEGER);
  return rankDiff !== 0
    ? rankDiff
    : String(a.candidate.object_name || '').localeCompare(String(b.candidate.object_name || ''));
}

function serializeObjectOccurrence(occurrence, normalizedName) {
  const { snapshot, candidate } = occurrence;
  return {
    snapshot: snapshot.snapshotPath,
    'snapshot_name': path.basename(snapshot.snapshotPath),
    'cluster_json': snapshot.clusterJsonPath,
    'object_name': candidate.object_name || normalizedName,
    'normalized_object_name': normalizedName,
    rank: candidate.rank || 0,
    count: candidate.count || 0,
    'total_retained_size': candidate.total_retained_size || 0,
    'total_retained_size_text': candidate.total_retained_size_text ||
      formatSize(candidate.total_retained_size || 0),
  };
}

function summarizeObjectOccurrences(occurrenceDetails) {
  return occurrenceDetails.reduce((summary, detail) => ({
    totalRetainedSize: summary.totalRetainedSize + detail.total_retained_size,
    totalCount: summary.totalCount + detail.count,
    maxRetainedSize: Math.max(summary.maxRetainedSize, detail.total_retained_size),
    rankSum: summary.rankSum + detail.rank,
  }), { totalRetainedSize: 0, totalCount: 0, maxRetainedSize: 0, rankSum: 0 });
}

function serializeMultiSnapshotObjectAggregate(context) {
  const {
    category, normalizedName, objectName, objectNameVariants, occurrenceDetails,
    snapshotCount, representativeChains, summary,
  } = context;
  const occurrenceCount = occurrenceDetails.length;
  const snapshotAverage = snapshotCount > 0 ? summary.totalRetainedSize / snapshotCount : 0;
  const presentAverage = occurrenceCount > 0 ? summary.totalRetainedSize / occurrenceCount : 0;
  return {
    category,
    'object_key': JSON.stringify({ category, 'object_name': normalizedName }),
    'object_name': objectName,
    'normalized_object_name': normalizedName,
    'object_name_variants': objectNameVariants,
    'occurrence_count': occurrenceCount,
    'occurrence_ratio': snapshotCount > 0 ? occurrenceCount / snapshotCount : 0,
    'total_count': summary.totalCount,
    'average_count': occurrenceCount > 0 ? summary.totalCount / occurrenceCount : 0,
    'average_rank': occurrenceCount > 0 ? summary.rankSum / occurrenceCount : 0,
    'total_retained_size': summary.totalRetainedSize,
    'total_retained_size_text': formatSize(summary.totalRetainedSize),
    'snapshot_average_retained_size': snapshotAverage,
    'snapshot_average_retained_size_text': formatSize(snapshotAverage),
    'present_average_retained_size': presentAverage,
    'present_average_retained_size_text': formatSize(presentAverage),
    'max_retained_size': summary.maxRetainedSize,
    'max_retained_size_text': formatSize(summary.maxRetainedSize),
    'representative_chains': representativeChains,
    'top_representative_chains': representativeChains.slice(0, 3),
    occurrenceDetails: occurrenceDetails.sort((a, b) =>
      String(a.snapshot_name).localeCompare(String(b.snapshot_name))),
  };
}

function buildMultiSnapshotObjectAggregate(entry, snapshotCount, category) {
  const [normalizedName, occurrences] = entry;
  const representative = [...occurrences].sort(compareObjectRepresentativeOccurrence)[0];
  const objectName = representative?.candidate?.object_name || normalizedName;
  const objectNameVariants = [...new Set(occurrences.flatMap(item => [
    ...(item.candidate.object_name_variants || []),
    item.candidate.object_name || normalizedName,
  ]))].sort();
  const occurrenceDetails = occurrences.map(item => serializeObjectOccurrence(item, normalizedName));
  const representativeChains = collectObjectRepresentativeChains(occurrences, snapshotCount);
  return serializeMultiSnapshotObjectAggregate({
    category, normalizedName, objectName, objectNameVariants, occurrenceDetails,
    snapshotCount, representativeChains, summary: summarizeObjectOccurrences(occurrenceDetails),
  });
}

function collectMultiSnapshotObjectAggregates(successfulSnapshots, category) {
  const snapshotCount = successfulSnapshots.length;
  const occurrencesByName = collectObjectOccurrencesByName(successfulSnapshots, category);
  return [...occurrencesByName.entries()]
    .map(entry => buildMultiSnapshotObjectAggregate(entry, snapshotCount, category))
    .sort(compareMultiSnapshotObjectAggregate)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function appendSerializedPathEntries(lines, pathEntries, rootType = '') {
  if (!Array.isArray(pathEntries) || pathEntries.length === 0) {
    lines.push('       (无引用链)');
    return;
  }

  const lastIdx = pathEntries.length - 1;
  pathEntries.forEach((entry, idx) => {
    const isLast = idx === lastIdx;
    const prefix = idx === 0 ? '       ⬤ ' : (isLast ? '       └▶ ' : '       ├▶ ');
    const sizeText = entry.retained_size_text || formatSize(entry.retained_size || 0);
    const distance = entry.distance ?? (lastIdx - idx);
    const suffix = isLast && rootType ? ' (GC Root)' : '';
    lines.push(`${prefix}${entry.name || ''} [${sizeText}] Distance ${distance}${suffix}`);
  });
}

function appendMultiSnapshotAggregateSection(lines, title, items, topN, snapshotCount) {
  lines.push(`## ${title} Top${topN}`);
  lines.push('');

  if (!items || items.length === 0) {
    lines.push('(无结果)');
    lines.push('');
    return;
  }

  for (const item of items.slice(0, topN)) {
    const displayName = item.path_names[item.path_names.length - 1] || item.path_names[0] || '(未知引用链)';
    lines.push(`### #${item.rank} ${displayName}`);
    lines.push('');
    appendMarkdownKeyValueTable(lines, [
      ['累计大小', item.total_retained_size_text],
      ['平均大小', item.average_retained_size_text],
      ['出现次数', `${item.occurrence_count}/${snapshotCount} (${formatPercentRatio(item.occurrence_ratio)})`],
      ['平均排名', formatFixed(item.average_rank, 2)],
      ['最大大小', item.max_retained_size_text],
      ['合并相似链数', item.similar_chain_count],
      ['根节点类型', item.root_type || '-'],
      ['来源目录', item.group_names.join(', ')],
    ]);

    lines.push('引用链:');
    appendSerializedPathEntries(lines, item.representative_path_entries, item.root_type);
    lines.push('');

    lines.push('出现明细:');
    lines.push('| 快照 | 单快照排名 | 大小 | 数量 | 堆占比 |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const detail of item.occurrenceDetails) {
      const heapPercent = detail.heap_percent === '' ? '-' : `${detail.heap_percent}%`;
      lines.push(
        `| ${markdownCell(detail.snapshot_name)} | ${markdownCell(detail.rank)} | ` +
        `${markdownCell(detail.total_retained_size_text)} | ${markdownCell(detail.count)} | ${markdownCell(heapPercent)} |`,
      );
    }
    lines.push('');
  }
}

function buildMultiSnapshotReport(inputDir, outputDir, successfulSnapshots, failedSnapshots, multiTop) {
  const businessAggregates = collectMultiSnapshotAggregates(successfulSnapshots, 'business');
  const commonAggregates = collectMultiSnapshotAggregates(successfulSnapshots, 'common');
  const businessObjectAggregates = collectMultiSnapshotObjectAggregates(
    successfulSnapshots,
    'business',
  );
  const commonObjectAggregates = collectMultiSnapshotObjectAggregates(
    successfulSnapshots,
    'common',
  );

  return {
    metadata: {
      mode: 'multi_snapshot',
      'generated_at': new Date().toISOString(),
      'input_dir': path.resolve(inputDir),
      'output_dir': path.resolve(outputDir || inputDir),
      'total_snapshot_count': successfulSnapshots.length + failedSnapshots.length,
      'successful_snapshot_count': successfulSnapshots.length,
      'failed_snapshot_count': failedSnapshots.length,
      'markdown_top': multiTop,
      'chain_key_rule': '所有公共对象名先将 js_xxx、jsxxx 和 JSXxx 统一为 JSXxx 规范名（Proxy 额外兼容裸名），' +
        '再归一化依赖包版本和 #字母数字 混淆函数；同分类、同 root_type，' +
        '且一条 path_entries.name 序列连续完整包含于另一条时合并',
      'object_key_rule': '公共对象规范名、依赖包版本和混淆函数归一化后，保留包名、文件路径和行号，按分类和 object_name 精确匹配',
      'object_alias_same_snapshot_rule': '同一快照在支配树分组前就按公共对象规范名合并；count 累加所有变体节点，retained size 只累加未被同规范名父节点包含的最上层保留闭包，再作为一次对象出现参与跨快照统计',
      'object_chain_rule': '公共对象规范名、依赖包版本和混淆函数名归一化后，同对象、同 root_type，且一条路径名称序列是另一条的非连续有序子序列时合并',
      'sorting_rule': 'total_retained_size DESC, average_retained_size DESC',
    },
    snapshots: {
      successful: successfulSnapshots.map(item => ({
        snapshot: item.snapshotPath,
        report: item.reportPath,
        'html_report': item.htmlReportPath,
        'cluster_json': item.clusterJsonPath,
      })),
      failed: failedSnapshots,
    },
    'business_aggregates': businessAggregates,
    'common_aggregates': commonAggregates,
    'business_object_aggregates': businessObjectAggregates,
    'common_object_aggregates': commonObjectAggregates,
  };
}

function appendMultiSnapshotInputMarkdown(lines, successfulSnapshots) {
  lines.push('## 输入快照');
  lines.push('');
  if (successfulSnapshots.length === 0) {
    lines.push('(无成功快照)');
  } else {
    successfulSnapshots.forEach((item, index) => {
      lines.push(`${index + 1}. ${path.basename(item.snapshot)}`);
    });
  }
  lines.push('');
}

function appendFailedSnapshotMarkdown(lines, failedSnapshots) {
  if (failedSnapshots.length === 0) {
    return;
  }
  lines.push('## 失败快照');
  lines.push('');
  failedSnapshots.forEach((item, index) => {
    lines.push(`${index + 1}. ${path.basename(item.snapshot)}: ${item.error || 'unknown_error'}`);
  });
  lines.push('');
}

function renderMultiSnapshotMarkdown(report) {
  const lines = ['# 多快照 Heap 聚类总榜报告', '', '## 总览', ''];
  const metadata = report.metadata;
  appendMarkdownKeyValueTable(lines, [
    ['输入目录', metadata.input_dir],
    ['输出目录', metadata.output_dir],
    ['生成时间', metadata.generated_at],
    ['快照总数', metadata.total_snapshot_count],
    ['成功快照数', metadata.successful_snapshot_count],
    ['失败快照数', metadata.failed_snapshot_count],
    ['引用链归一化规则', metadata.chain_key_rule],
    ['同快照公共对象合并', metadata.object_alias_same_snapshot_rule],
    ['总榜排序规则', '累计大小降序，其次平均大小降序'],
  ]);
  appendMultiSnapshotInputMarkdown(lines, report.snapshots.successful);
  appendFailedSnapshotMarkdown(lines, report.snapshots.failed);
  appendMultiSnapshotAggregateSection(
    lines,
    categoryText('business'),
    report.business_aggregates,
    metadata.markdown_top,
    metadata.successful_snapshot_count,
  );
  appendMultiSnapshotAggregateSection(
    lines,
    categoryText('common'),
    report.common_aggregates,
    metadata.markdown_top,
    metadata.successful_snapshot_count,
  );

  return `${lines.join('\n')}\n`;
}

function formatHtmlReportTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value || '-')
    : date.toLocaleString('zh-CN', { hour12: false });
}

function encodeLocalReportHref(filePath) {
  return encodeURIComponent(path.basename(String(filePath || '')));
}

function renderHeapMetricGridHtml(rows) {
  return `<dl class="metric-grid">${rows.map(([label, value, tone]) => `
    <div><dt>${escapeHtml(label)}</dt><dd${tone ? ` class="${escapeHtml(tone)}"` : ''}>${escapeHtml(value)}</dd></div>`).join('')}
  </dl>`;
}

function renderHeapReferencePathHtml(pathEntries, rootType = '') {
  const entries = Array.isArray(pathEntries) ? pathEntries : [];
  if (entries.length === 0) {
    return '<div class="empty compact">无可用引用链</div>';
  }

  const lastIndex = entries.length - 1;
  return `<ol class="chain-path">${entries.map((entry, index) => {
    const sizeText = entry.retained_size_text || formatSize(entry.retained_size || 0);
    const distance = entry.distance ?? (lastIndex - index);
    const rootText = index === lastIndex && rootType ? ' · GC Root' : '';
    return `
      <li>
        <span class="chain-name">${escapeHtml(entry.name || '(未知节点)')}</span>
        <span class="chain-meta">${escapeHtml(sizeText)} · Distance ${escapeHtml(distance)}${rootText}</span>
      </li>`;
  }).join('')}
  </ol>`;
}

const heapReportStyles = `
    :root {
      color-scheme:light; --bg:#f4f6f5; --surface:#fff; --text:#202624; --muted:#65716d; --line:#d6ddda;
      --green:#087f73; --green-dark:#173b37; --green-soft:#e4f4f1; --coral:#b5471b; --gray-soft:#edf1ef;
    }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.65 "Segoe UI","Microsoft YaHei",sans-serif; letter-spacing:0; }
    header { padding:28px max(24px,calc((100vw - 1180px)/2)); background:var(--green-dark); color:#fff; }
    header h1 { margin:0 0 6px; font-size:27px; }
    header p { margin:0; color:#cfe1dd; overflow-wrap:anywhere; }
    .report-links { margin-top:12px; }
    .report-links a { margin-right:15px; color:#fff; font-weight:650; }
    nav {
      position:sticky; top:0; z-index:5; display:flex; gap:8px;
      padding:10px max(24px,calc((100vw - 1180px)/2)); overflow-x:auto;
      background:rgba(255,255,255,.97); border-bottom:1px solid var(--line);
    }
    nav a { flex:0 0 auto; padding:5px 8px; color:var(--green); font-weight:650; text-decoration:none; }
    main { width:min(1180px,calc(100% - 32px)); margin:24px auto 56px; }
    section { margin:28px 0; scroll-margin-top:68px; }
    h2 { margin:0 0 13px; font-size:20px; }
    h3,h4 { margin:0; }
    .summary-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); margin:0; border:1px solid var(--line); background:var(--surface); }
    .summary-grid div { min-width:0; padding:13px 15px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
    .summary-grid div:nth-child(3n) { border-right:0; }
    .summary-grid div:nth-last-child(-n+3) { border-bottom:0; }
    .summary-grid dt,.metric-grid dt { color:var(--muted); font-size:12px; }
    .summary-grid dd,.metric-grid dd { margin:3px 0 0; font-weight:700; overflow-wrap:anywhere; word-break:break-word; }
    .section-heading,.category-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .section-heading span,.category-heading span { color:var(--muted); }
    .report-item { margin:10px 0; overflow:hidden; border:1px solid var(--line); border-radius:6px; background:var(--surface); }
    .report-item > summary {
      display:grid; grid-template-columns:52px minmax(0,1fr) auto; gap:10px; align-items:start;
      padding:13px 15px; cursor:pointer; list-style:none;
    }
    .report-item > summary::-webkit-details-marker { display:none; }
    .report-item[open] > summary { border-bottom:1px solid var(--line); background:#fbfcfb; }
    .rank { color:var(--green); font-weight:800; }
    .item-name { min-width:0; font-weight:650; overflow-wrap:anywhere; }
    .item-size { color:var(--coral); font-weight:800; white-space:nowrap; }
    .item-body { padding:16px; }
    .metric-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); margin:0 0 15px; border:1px solid var(--line); }
    .metric-grid div { min-width:0; padding:10px 12px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
    .metric-grid div:nth-child(3n) { border-right:0; }
    .metric-grid div:nth-last-child(-n+3) { border-bottom:0; }
    .positive { color:var(--coral); }
    .source-line { display:grid; grid-template-columns:110px minmax(0,1fr); gap:10px; margin:0 0 14px; color:var(--muted); }
    .source-line span { overflow-wrap:anywhere; }
    .chain-title { margin:17px 0 7px; font-size:15px; }
    .chain-path { margin:0; padding:0; list-style:none; }
    .chain-path li { position:relative; display:flex; justify-content:space-between; gap:16px; padding:8px 10px 8px 28px; border-left:2px solid #9fc9c2; }
    .chain-path li::before { content:""; position:absolute; left:-5px; top:15px; width:8px; height:8px; border-radius:50%; background:var(--green); }
    .chain-name { min-width:0; overflow-wrap:anywhere; }
    .chain-meta { flex:0 0 auto; color:var(--muted); white-space:nowrap; }
    .table-wrap { max-width:100%; overflow:auto; border:1px solid var(--line); background:var(--surface); }
    table { width:100%; min-width:720px; border-collapse:collapse; }
    th,td { padding:9px 11px; text-align:left; vertical-align:top; border-bottom:1px solid var(--line); }
    th { background:var(--gray-soft); color:#46514d; font-size:12px; white-space:nowrap; }
    tbody tr:last-child td { border-bottom:0; }
    td { overflow-wrap:anywhere; }
    .snapshot-link { color:var(--green); font-weight:650; text-underline-offset:3px; }
    .badge { display:inline-block; padding:2px 7px; border-radius:4px; background:var(--green-soft); color:var(--green); font-size:12px; font-weight:700; }
    .badge.failed { background:#fff0e8; color:var(--coral); }
    .empty { padding:18px; border:1px dashed #b9c2be; background:var(--surface); color:var(--muted); }
    .empty.compact { padding:12px; }
    @media (max-width:760px) {
      header{padding:23px 16px} header h1{font-size:22px} nav{padding:8px 12px}
      main{width:calc(100% - 24px)} .summary-grid{grid-template-columns:1fr 1fr}
      .summary-grid div,.summary-grid div:nth-child(3n),.summary-grid div:nth-last-child(-n+3){
        border-right:1px solid var(--line); border-bottom:1px solid var(--line);
      }
      .summary-grid div:nth-child(2n){border-right:0} .summary-grid div:last-child{border-bottom:0}
      .metric-grid{grid-template-columns:1fr}
      .metric-grid div,.metric-grid div:nth-child(3n),.metric-grid div:nth-last-child(-n+3){
        border-right:0; border-bottom:1px solid var(--line);
      }
      .metric-grid div:last-child{border-bottom:0}
      .report-item>summary{grid-template-columns:42px minmax(0,1fr)} .item-size{grid-column:2}
      .source-line{grid-template-columns:1fr} .chain-path li{display:block}
      .chain-meta{display:block;margin-top:3px;white-space:normal}
    }
    @media print {
      nav{display:none} body{background:#fff} .report-item{break-inside:avoid}
      .report-item:not([open])>.item-body{display:block} main{width:100%;margin:0}
    }
`;

function renderHeapReportShell({ title, subtitle, links, navItems, content }) {
  const linkHtml = (links || []).map(link =>
    `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
  ).join('');
  const navHtml = (navItems || []).map(item =>
    `<a href="#${escapeHtml(item.id)}">${escapeHtml(item.label)}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${heapReportStyles}</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subtitle)}</p>
    <div class="report-links">${linkHtml}</div>
  </header>
  <nav>${navHtml}</nav>
  <main>${content}</main>
</body>
</html>
`;
}

function renderSingleSnapshotCategoryHtml(category, items, totalHeapSize, topCount = 5) {
  const title = categoryText(category);
  const sectionId = category === 'business' ? 'business-objects' : 'common-objects';
  const list = Array.isArray(items) ? items : [];
  const itemHtml = list.length > 0
    ? list.map((item, index) => {
      const sourceNames = Array.isArray(item.group_names) ? item.group_names : [];
      const pathEntries = Array.isArray(item.path_entries) ? item.path_entries : [];
      const displayName = sourceNames[0] ||
        pathEntries[pathEntries.length - 1]?.name ||
        '(未知对象)';
      const count = Number(item.count || 0).toLocaleString('zh-CN');
      const heapPercent = item.heap_percent === '' || item.heap_percent == null
        ? percentOf(item.total_retained_size || 0, totalHeapSize || 1)
        : item.heap_percent;
      return `<details class="report-item" ${index < 3 ? 'open' : ''}>
        <summary>
          <span class="rank">#${escapeHtml(item.rank || index + 1)}</span>
          <span class="item-name">${escapeHtml(displayName)}</span>
          <span class="item-size">${escapeHtml(item.total_retained_size_text || formatSize(item.total_retained_size || 0))}</span>
        </summary>
        <div class="item-body">
          ${renderHeapMetricGridHtml([
            ['Retained Size', item.total_retained_size_text || formatSize(item.total_retained_size || 0), 'positive'],
            ['堆占比', `${heapPercent}%`],
            ['对象数量', count],
            ['Distance', item.distance ?? '-'],
            ['根节点类型', item.root_type || '-'],
            ['合并来源数', sourceNames.length],
          ])}
          <div class="source-line"><strong>来源目录</strong><span>${escapeHtml(sourceNames.join(' · ') || '-')}</span></div>
          <h4 class="chain-title">引用链</h4>
          ${renderHeapReferencePathHtml(pathEntries, item.root_type)}
        </div>
      </details>`;
    }).join('')
    : '<div class="empty">无结果</div>';

  return `<section id="${sectionId}">
    <div class="category-heading"><h2>${escapeHtml(title)} Top${escapeHtml(topCount)}</h2><span>${escapeHtml(list.length)} 项</span></div>
    ${itemHtml}
  </section>`;
}

function renderSingleSnapshotHtml(clusterJson) {
  const metadata = clusterJson?.metadata || {};
  const topCount = metadata.top_count || 5;
  const businessItems = Array.isArray(clusterJson?.business_top5) ? clusterJson.business_top5 : [];
  const commonItems = Array.isArray(clusterJson?.common_top5) ? clusterJson.common_top5 : [];
  const snapshotName = path.basename(metadata.snapshot || 'snapshot.heapsnapshot');
  const baseName = path.parse(snapshotName).name;
  const totalHeapSize = metadata.total_heap_size || 0;
  const content = `
    <section id="overview">
      <h2>总览</h2>
      <dl class="summary-grid">
        <div><dt>快照文件</dt><dd>${escapeHtml(snapshotName)}</dd></div>
        <div><dt>堆总大小</dt><dd>${escapeHtml(metadata.total_heap_size_text || formatSize(totalHeapSize))}</dd></div>
        <div><dt>筛选阈值</dt><dd>${escapeHtml(metadata.threshold_size_text || formatSize(metadata.threshold_size || 0))}</dd></div>
        <div><dt>候选对象组</dt><dd>${escapeHtml(metadata.filtered_group_count || 0)}</dd></div>
        <div><dt>聚类对象组</dt><dd>${escapeHtml(metadata.cluster_group_count || 0)}</dd></div>
        <div><dt>生成时间</dt><dd>${escapeHtml(formatHtmlReportTime(metadata.generated_at))}</dd></div>
      </dl>
    </section>
    ${renderSingleSnapshotCategoryHtml('business', businessItems, totalHeapSize, topCount)}
    ${renderSingleSnapshotCategoryHtml('common', commonItems, totalHeapSize, topCount)}`;

  return renderHeapReportShell({
    title: '单快照 Heap 聚类报告',
    subtitle: snapshotName,
    links: [
      { label: 'Markdown', href: encodeURIComponent(`${baseName}.md`) },
      { label: 'JSON', href: encodeURIComponent(`${baseName}.clusters.json`) },
    ],
    navItems: [
      { id: 'overview', label: '总览' },
      { id: 'business-objects', label: '业务对象' },
      { id: 'common-objects', label: '公共对象' },
    ],
    content,
  });
}

function findSnapshotHtmlReport(report, snapshotName) {
  const successful = Array.isArray(report?.snapshots?.successful)
    ? report.snapshots.successful
    : [];
  return successful.find(item => path.basename(item.snapshot || '') === snapshotName)?.html_report || '';
}

function renderMultiSnapshotOccurrenceRow(detail, report) {
  const snapshotName = detail.snapshot_name || path.basename(detail.snapshot || '') || '-';
  const htmlReport = findSnapshotHtmlReport(report, snapshotName);
  const snapshotCell = htmlReport
    ? `<a class="snapshot-link" href="${encodeLocalReportHref(htmlReport)}">${escapeHtml(snapshotName)}</a>`
    : escapeHtml(snapshotName);
  const heapPercent = detail.heap_percent === '' || detail.heap_percent == null
    ? '-'
    : `${detail.heap_percent}%`;
  return `<tr>
    <td>${snapshotCell}</td>
    <td>${escapeHtml(detail.rank || '-')}</td>
    <td>${escapeHtml(detail.total_retained_size_text || formatSize(detail.total_retained_size || 0))}</td>
    <td>${escapeHtml(Number(detail.count || 0).toLocaleString('zh-CN'))}</td>
    <td>${escapeHtml(heapPercent)}</td>
  </tr>`;
}

function renderMultiSnapshotOccurrenceRows(item, report) {
  const details = Array.isArray(item.occurrenceDetails) ? item.occurrenceDetails : [];
  return details.length > 0
    ? details.map(detail => renderMultiSnapshotOccurrenceRow(detail, report)).join('')
    : '<tr><td colspan="5">无出现明细</td></tr>';
}

function renderMultiSnapshotAggregateItemHtml(item, index, report) {
  const metadata = report.metadata;
  const pathNames = Array.isArray(item.path_names) ? item.path_names : [];
  const displayName = pathNames[pathNames.length - 1] || pathNames[0] || '(未知引用链)';
  const detailRows = renderMultiSnapshotOccurrenceRows(item, report);
  return `<details class="report-item" ${index < 3 ? 'open' : ''}>
        <summary>
          <span class="rank">#${escapeHtml(item.rank || index + 1)}</span>
          <span class="item-name">${escapeHtml(displayName)}</span>
          <span class="item-size">${escapeHtml(item.total_retained_size_text || formatSize(item.total_retained_size || 0))}</span>
        </summary>
        <div class="item-body">
          ${renderHeapMetricGridHtml([
            ['累计大小', item.total_retained_size_text || formatSize(item.total_retained_size || 0), 'positive'],
            ['出现时平均大小', item.average_retained_size_text || formatSize(item.average_retained_size || 0)],
            ['出现次数', `${item.occurrence_count || 0}/${metadata.successful_snapshot_count} (${formatPercentRatio(item.occurrence_ratio || 0)})`],
            ['平均排名', formatFixed(item.average_rank || 0, 2)],
            ['单次最大大小', item.max_retained_size_text || formatSize(item.max_retained_size || 0)],
            ['合并相似链数', item.similar_chain_count || 1],
            ['根节点类型', item.root_type || '-'],
            ['代表链深度', Array.isArray(item.representative_path_entries) ? item.representative_path_entries.length : 0],
            ['来源目录数', Array.isArray(item.group_names) ? item.group_names.length : 0],
          ])}
          <div class="source-line"><strong>来源目录</strong><span>${escapeHtml((item.group_names || []).join(' · ') || '-')}</span></div>
          <h4 class="chain-title">代表引用链</h4>
          ${renderHeapReferencePathHtml(item.representative_path_entries, item.root_type)}
          <h4 class="chain-title">出现明细</h4>
          <div class="table-wrap"><table>
            <thead><tr><th>快照</th><th>单快照排名</th><th>大小</th><th>数量</th><th>堆占比</th></tr></thead>
            <tbody>${detailRows}</tbody>
          </table></div>
        </div>
      </details>`;
}

function renderMultiSnapshotAggregateHtml(report, category, items) {
  const metadata = report.metadata;
  const title = categoryText(category);
  const sectionId = category === 'business' ? 'business-ranking' : 'common-ranking';
  const list = (Array.isArray(items) ? items : []).slice(0, metadata.markdown_top);
  const itemHtml = list.length > 0
    ? list.map((item, index) => renderMultiSnapshotAggregateItemHtml(item, index, report)).join('')
    : '<div class="empty">无结果</div>';
  return `<section id="${sectionId}">
    <div class="category-heading"><h2>${escapeHtml(title)} Top${escapeHtml(metadata.markdown_top)}</h2><span>${escapeHtml(list.length)} 项</span></div>
    ${itemHtml}
  </section>`;
}

function renderMultiSnapshotListHtml(report) {
  const successful = Array.isArray(report?.snapshots?.successful) ? report.snapshots.successful : [];
  const failed = Array.isArray(report?.snapshots?.failed) ? report.snapshots.failed : [];
  const rows = [
    ...successful.map(item => {
      const snapshotName = path.basename(item.snapshot || '');
      const nameHtml = item.html_report
        ? `<a class="snapshot-link" href="${encodeLocalReportHref(item.html_report)}">${escapeHtml(snapshotName)}</a>`
        : escapeHtml(snapshotName);
      return `<tr><td>${nameHtml}</td><td><span class="badge">成功</span></td><td>${item.html_report ? '单快照 HTML' : '-'}</td></tr>`;
    }),
    ...failed.map(item => `<tr>
      <td>${escapeHtml(path.basename(item.snapshot || ''))}</td>
      <td><span class="badge failed">失败</span></td>
      <td>${escapeHtml(item.error || 'unknown_error')}</td>
    </tr>`),
  ].join('');
  return `<section id="snapshots">
    <h2>输入快照</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>快照</th><th>状态</th><th>报告或错误</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">无快照</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

function renderMultiSnapshotHtml(report) {
  const metadata = report.metadata;
  const content = `
    <section id="overview">
      <h2>总览</h2>
      <dl class="summary-grid">
        <div><dt>输入目录</dt><dd>${escapeHtml(metadata.input_dir)}</dd></div>
        <div><dt>输出目录</dt><dd>${escapeHtml(metadata.output_dir)}</dd></div>
        <div><dt>生成时间</dt><dd>${escapeHtml(formatHtmlReportTime(metadata.generated_at))}</dd></div>
        <div><dt>快照总数</dt><dd>${escapeHtml(metadata.total_snapshot_count)}</dd></div>
        <div><dt>成功快照</dt><dd>${escapeHtml(metadata.successful_snapshot_count)}</dd></div>
        <div><dt>失败快照</dt><dd>${escapeHtml(metadata.failed_snapshot_count)}</dd></div>
      </dl>
    </section>
    ${renderMultiSnapshotListHtml(report)}
    ${renderMultiSnapshotAggregateHtml(report, 'business', report.business_aggregates)}
    ${renderMultiSnapshotAggregateHtml(report, 'common', report.common_aggregates)}`;

  return renderHeapReportShell({
    title: '多快照 Heap 聚类总榜报告',
    subtitle: '按累计 Retained Size 排序，并展示出现时平均大小与快照明细',
    links: [
      { label: 'Markdown', href: 'multi-snapshot-clusters.md' },
      { label: 'JSON', href: 'multi-snapshot-clusters.json' },
    ],
    navItems: [
      { id: 'overview', label: '总览' },
      { id: 'snapshots', label: '输入快照' },
      { id: 'business-ranking', label: '业务对象' },
      { id: 'common-ranking', label: '公共对象' },
    ],
    content,
  });
}

export {
  appendFailedSnapshotMarkdown,
  appendMarkdownKeyValueTable,
  appendMultiSnapshotAggregateSection,
  appendMultiSnapshotInputMarkdown,
  appendSerializedPathEntries,
  areMultiSnapshotChainsSimilar,
  areObjectRepresentativeChainsSimilar,
  buildLegacyObjectCandidateList,
  buildMultiSnapshotChainAggregate,
  buildMultiSnapshotChainKey,
  buildMultiSnapshotObjectAggregate,
  buildMultiSnapshotOccurrenceDetail,
  buildMultiSnapshotReport,
  buildObjectRepresentativeChainAggregate,
  categoryText,
  collectMultiSnapshotAggregates,
  collectMultiSnapshotChainVariants,
  collectMultiSnapshotObjectAggregates,
  collectObjectChainVariants,
  collectObjectOccurrencesByName,
  collectObjectRepresentativeChains,
  collectSnapshotAliasVariants,
  combineSnapshotObjectCandidates,
  compareLegacyObjectCandidates,
  compareMultiSnapshotAggregate,
  compareMultiSnapshotObjectAggregate,
  compareObjectChainCandidate,
  compareObjectRepresentativeChainAggregate,
  compareObjectRepresentativeOccurrence,
  compareObjectRepresentativeVariant,
  compareRepresentativeChainOccurrence,
  compareSnapshotCandidate,
  createSnapshotObjectAlias,
  encodeLocalReportHref,
  findSnapshotHtmlReport,
  formatFixed,
  formatHtmlReportTime,
  formatPercentRatio,
  getCandidateList,
  getLegacyCandidateChains,
  getNormalizedPathNamesFromCandidate,
  getNormalizedPathNamesFromSerializedChain,
  getObjectCandidateList,
  getPathNamesFromCandidate,
  getPathNamesFromSerializedChain,
  groupLegacyChainsByObjectName,
  groupSimilarChainVariants,
  groupVariantsBySimilarity,
  heapReportStyles,
  isLegacyGroupInCategory,
  isPathNameOrderedSubsequence,
  isPathNameSequenceContained,
  isSnapshotAliasRepresentative,
  markdownCell,
  mergeSnapshotObjectCandidateAliases,
  rankMultiSnapshotAggregates,
  renderHeapMetricGridHtml,
  renderHeapReferencePathHtml,
  renderHeapReportShell,
  renderMultiSnapshotAggregateHtml,
  renderMultiSnapshotAggregateItemHtml,
  renderMultiSnapshotHtml,
  renderMultiSnapshotListHtml,
  renderMultiSnapshotMarkdown,
  renderMultiSnapshotOccurrenceRow,
  renderMultiSnapshotOccurrenceRows,
  renderSingleSnapshotCategoryHtml,
  renderSingleSnapshotHtml,
  selectBestSnapshotOccurrences,
  serializeLegacyObjectCandidate,
  serializeMultiSnapshotAggregate,
  serializeMultiSnapshotObjectAggregate,
  serializeObjectChainOccurrence,
  serializeObjectOccurrence,
  serializeObjectRepresentativeAggregate,
  serializeSimilarChainVariant,
  summarizeObjectOccurrences,
};
