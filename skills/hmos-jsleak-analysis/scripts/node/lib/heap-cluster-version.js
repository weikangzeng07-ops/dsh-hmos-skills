import path from 'path';

import { formatSize, normalizeComparisonObjectName } from './heap-cluster-core.js';
import { fieldKeys } from './heap-cluster-field-keys.js';
import {
  compareMultiSnapshotObjectAggregate,
  compareObjectRepresentativeChainAggregate,
  formatFixed,
  groupSimilarChainVariants,
  groupVariantsBySimilarity,
  isPathNameSequenceContained,
} from './heap-cluster-multi.js';

// =================不同版本快照对比=================
function getVersionAggregates(report, category) {
  const key = category === 'business' ? 'business_aggregates' : 'common_aggregates';
  return Array.isArray(report?.[key]) ? report[key] : [];
}

function getVersionComparisonVariants(report, category, version) {
  const variants = [];

  for (const aggregate of getVersionAggregates(report, category)) {
    const similarChains = Array.isArray(aggregate[fieldKeys.similarChains]) && aggregate[fieldKeys.similarChains].length > 0
      ? aggregate[fieldKeys.similarChains]
      : [{
          'chain_key': aggregate[fieldKeys.chainKey],
          'path_names': aggregate[fieldKeys.pathNames],
          'normalized_path_names': aggregate[fieldKeys.normalizedPathNames],
        }];

    for (const chain of similarChains) {
      variants.push({
        category,
        version,
        aggregate,
        'chain_key': chain[fieldKeys.chainKey] || aggregate[fieldKeys.chainKey] || '',
        'root_type': aggregate[fieldKeys.rootType] || '',
        'path_names': Array.isArray(chain[fieldKeys.pathNames]) ? chain[fieldKeys.pathNames] : (aggregate[fieldKeys.pathNames] || []),
        'normalized_path_names': Array.isArray(chain[fieldKeys.normalizedPathNames])
          ? chain[fieldKeys.normalizedPathNames]
          : (Array.isArray(chain[fieldKeys.pathNames])
              ? chain[fieldKeys.pathNames].map(normalizeComparisonObjectName)
              : (aggregate[fieldKeys.pathNames] || []).map(normalizeComparisonObjectName)),
      });
    }
  }

  return variants;
}

function compareOccurrenceDetail(a, b) {
  const rankDiff = (a?.rank || Number[fieldKeys.maxSafeInteger]) - (b?.rank || Number[fieldKeys.maxSafeInteger]);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  return (b?.[fieldKeys.totalRetainedSize] || 0) - (a?.[fieldKeys.totalRetainedSize] || 0);
}

function summarizeVersionSide(aggregates, successfulSnapshotCount) {
  const uniqueAggregates = [...new Set(aggregates)];
  const bestBySnapshot = new Map();
  const groupNames = new Set();

  for (const aggregate of uniqueAggregates) {
    const names = Array.isArray(aggregate[fieldKeys.groupNames]) ? aggregate[fieldKeys.groupNames] : [];
    names.forEach(name => groupNames.add(name));

    for (const detail of aggregate.occurrenceDetails || []) {
      const snapshotKey = detail.snapshot
        ? path.resolve(detail.snapshot)
        : String(detail[fieldKeys.snapshotName] || '');
      const previous = bestBySnapshot.get(snapshotKey);
      if (!previous || compareOccurrenceDetail(detail, previous) < 0) {
        bestBySnapshot.set(snapshotKey, detail);
      }
    }
  }

  const occurrenceDetails = [...bestBySnapshot.values()].sort((a, b) =>
    String(a[fieldKeys.snapshotName] || '').localeCompare(String(b[fieldKeys.snapshotName] || '')),
  );
  const occurrenceCount = occurrenceDetails.length;
  const totalRetainedSize = occurrenceDetails.reduce(
    (sum, detail) => sum + (detail[fieldKeys.totalRetainedSize] || 0),
    0,
  );
  const rankSum = occurrenceDetails.reduce((sum, detail) => sum + (detail.rank || 0), 0);
  const maxRetainedSize = occurrenceDetails.reduce(
    (max, detail) => Math.max(max, detail[fieldKeys.totalRetainedSize] || 0),
    0,
  );
  const occurrenceAverageRetainedSize = occurrenceCount > 0
    ? totalRetainedSize / occurrenceCount
    : 0;

  return {
    'successful_snapshot_count': successfulSnapshotCount,
    'matched_aggregate_count': uniqueAggregates.length,
    'occurrence_count': occurrenceCount,
    'occurrence_ratio': successfulSnapshotCount > 0 ? occurrenceCount / successfulSnapshotCount : 0,
    'total_retained_size': totalRetainedSize,
    'total_retained_size_text': formatSize(totalRetainedSize),
    'occurrence_average_retained_size': occurrenceAverageRetainedSize,
    'occurrence_average_retained_size_text': formatSize(occurrenceAverageRetainedSize),
    'max_retained_size': maxRetainedSize,
    'max_retained_size_text': formatSize(maxRetainedSize),
    'average_rank': occurrenceCount > 0 ? rankSum / occurrenceCount : 0,
    'group_names': [...groupNames].sort(),
    occurrenceDetails,
  };
}

function compareVersionGrowth(a, b) {
  const growthDiff = (b[fieldKeys.occurrenceAverageGrowth] || 0) -
    (a[fieldKeys.occurrenceAverageGrowth] || 0);
  if (growthDiff !== 0) {
    return growthDiff;
  }

  const currentSizeDiff = (b.current?.[fieldKeys.occurrenceAverageRetainedSize] || 0) -
    (a.current?.[fieldKeys.occurrenceAverageRetainedSize] || 0);
  if (currentSizeDiff !== 0) {
    return currentSizeDiff;
  }

  const occurrenceDiff = (b.current?.[fieldKeys.occurrenceRatio] || 0) - (a.current?.[fieldKeys.occurrenceRatio] || 0);
  if (occurrenceDiff !== 0) {
    return occurrenceDiff;
  }

  return String(a[fieldKeys.chainKey] || '').localeCompare(String(b[fieldKeys.chainKey] || ''));
}

function getVersionGrowthStatus(baselineSize, currentSize) {
  if (baselineSize === 0 && currentSize > 0) {
    return 'new';
  }
  if (baselineSize > 0 && currentSize === 0) {
    return 'removed';
  }
  if (currentSize > baselineSize) {
    return 'increased';
  }
  if (currentSize < baselineSize) {
    return 'decreased';
  }
  return 'unchanged';
}

function versionGrowthStatusText(status) {
  const labels = {
    new: '新增',
    increased: '增长',
    decreased: '下降',
    removed: '消失',
    unchanged: '持平',
  };
  return labels[status] || status || '未知';
}

function formatSignedSize(value) {
  if (!Number.isFinite(value) || value === 0) {
    return formatSize(0);
  }
  return `${value > 0 ? '+' : '-'}${formatSize(Math.abs(value))}`;
}

function formatGrowthRatio(value, status) {
  if (status === 'new') {
    return '新增';
  }
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${value > 0 ? '+' : ''}${formatFixed(value * 100, 1)}%`;
}

function selectVersionComparisonRepresentative(component) {
  return [...component].sort((a, b) => {
    const depthDiff = (b[fieldKeys.pathNames]?.length || 0) - (a[fieldKeys.pathNames]?.length || 0);
    if (depthDiff !== 0) {
      return depthDiff;
    }

    const versionDiff = Number(b.version === 'current') - Number(a.version === 'current');
    if (versionDiff !== 0) {
      return versionDiff;
    }

    const sizeDiff = (b.aggregate?.[fieldKeys.totalRetainedSize] || 0) -
      (a.aggregate?.[fieldKeys.totalRetainedSize] || 0);
    if (sizeDiff !== 0) {
      return sizeDiff;
    }

    return String(a[fieldKeys.chainKey] || '').localeCompare(String(b[fieldKeys.chainKey] || ''));
  })[0];
}

function collectDistinctVersionChains(component) {
  const distinctChains = new Map();
  for (const item of component) {
    if (!distinctChains.has(item[fieldKeys.chainKey])) {
      distinctChains.set(item[fieldKeys.chainKey], {
        'chain_key': item[fieldKeys.chainKey],
        'root_type': item[fieldKeys.rootType],
        'path_names': item[fieldKeys.pathNames],
        versions: [],
      });
    }
    const chain = distinctChains.get(item[fieldKeys.chainKey]);
    if (!chain.versions.includes(item.version)) {
      chain.versions.push(item.version);
    }
  }
  return distinctChains;
}

function buildVersionCategoryComparison(component, context) {
  const { category, baselineSnapshotCount, currentSnapshotCount } = context;
  const representative = selectVersionComparisonRepresentative(component);
  const baselineAggregates = component.filter(item => item.version === 'baseline')
    .map(item => item.aggregate);
  const currentAggregates = component.filter(item => item.version === 'current')
    .map(item => item.aggregate);
  const baseline = summarizeVersionSide(baselineAggregates, baselineSnapshotCount);
  const current = summarizeVersionSide(currentAggregates, currentSnapshotCount);
  const growth = current[fieldKeys.occurrenceAverageRetainedSize] -
    baseline[fieldKeys.occurrenceAverageRetainedSize];
  const status = getVersionGrowthStatus(
    baseline[fieldKeys.occurrenceAverageRetainedSize], current[fieldKeys.occurrenceAverageRetainedSize],
  );
  const growthRatio = baseline[fieldKeys.occurrenceAverageRetainedSize] > 0
    ? growth / baseline[fieldKeys.occurrenceAverageRetainedSize]
    : null;
  const distinctChains = collectDistinctVersionChains(component);
  return {
    category,
    'chain_key': representative?.[fieldKeys.chainKey] || '',
    'root_type': representative?.[fieldKeys.rootType] || '',
    'path_names': representative?.[fieldKeys.pathNames] || [],
    'representative_path_entries': representative?.aggregate?.[fieldKeys.representativePathEntries] || [],
    'similar_chain_count': distinctChains.size,
    'similar_chains': [...distinctChains.values()].sort((a, b) =>
      String(a[fieldKeys.chainKey]).localeCompare(String(b[fieldKeys.chainKey]))),
    status,
    'status_text': versionGrowthStatusText(status),
    'occurrence_average_growth': growth,
    'occurrence_average_growth_text': formatSignedSize(growth),
    'growth_ratio': growthRatio,
    'growth_ratio_text': formatGrowthRatio(growthRatio, status),
    baseline,
    current,
  };
}

function rankPositiveGrowthComparisons(items, growthField) {
  let growthRank = 0;
  return items.map((item, index) => {
    const isPositiveGrowth = item[growthField] > 0;
    if (isPositiveGrowth) {
      growthRank++;
    }
    return {
      'comparison_rank': index + 1,
      'growth_rank': isPositiveGrowth ? growthRank : null,
      ...item,
    };
  });
}

function buildVersionCategoryComparisons(
  baselineReport,
  currentReport,
  category,
  baselineSnapshotCount,
  currentSnapshotCount,
) {
  const variants = [
    ...getVersionComparisonVariants(baselineReport, category, 'baseline'),
    ...getVersionComparisonVariants(currentReport, category, 'current'),
  ];
  const context = { category, baselineSnapshotCount, currentSnapshotCount };
  const comparisons = groupSimilarChainVariants(variants)
    .map(component => buildVersionCategoryComparison(component, context))
    .sort(compareVersionGrowth);
  return rankPositiveGrowthComparisons(comparisons, 'occurrence_average_growth');
}

function getVersionObjectAggregates(report, category) {
  const key = category === 'business'
    ? 'business_object_aggregates'
    : 'common_object_aggregates';
  return Array.isArray(report?.[key]) ? report[key] : [];
}

function normalizeVersionObjectSummary(aggregate, successfulSnapshotCount) {
  const source = aggregate || {};
  return {
    'object_name': source[fieldKeys.objectName] || '',
    'normalized_object_name': source[fieldKeys.normalizedObjectName] ||
      normalizeComparisonObjectName(source[fieldKeys.objectName] || ''),
    'object_name_variants': Array.isArray(source[fieldKeys.objectNameVariants])
      ? source[fieldKeys.objectNameVariants]
      : (source[fieldKeys.objectName] ? [source[fieldKeys.objectName]] : []),
    'successful_snapshot_count': successfulSnapshotCount,
    'occurrence_count': source[fieldKeys.occurrenceCount] || 0,
    'occurrence_ratio': source[fieldKeys.occurrenceRatio] || 0,
    'total_count': source[fieldKeys.totalCount] || 0,
    'average_count': source[fieldKeys.averageCount] || 0,
    'average_rank': source[fieldKeys.averageRank] || 0,
    'total_retained_size': source[fieldKeys.totalRetainedSize] || 0,
    'total_retained_size_text': source[fieldKeys.totalRetainedSizeText] || formatSize(0),
    'snapshot_average_retained_size': source[fieldKeys.snapshotAverageRetainedSize] || 0,
    'snapshot_average_retained_size_text': source[fieldKeys.snapshotAverageRetainedSizeText] ||
      formatSize(0),
    'present_average_retained_size': source[fieldKeys.presentAverageRetainedSize] || 0,
    'present_average_retained_size_text': source[fieldKeys.presentAverageRetainedSizeText] ||
      formatSize(0),
    'max_retained_size': source[fieldKeys.maxRetainedSize] || 0,
    'max_retained_size_text': source[fieldKeys.maxRetainedSizeText] || formatSize(0),
    'representative_chains': Array.isArray(source[fieldKeys.representativeChains])
      ? source[fieldKeys.representativeChains]
      : [],
    'top_representative_chains': Array.isArray(source[fieldKeys.topRepresentativeChains])
      ? source[fieldKeys.topRepresentativeChains].slice(0, 3)
      : [],
    occurrenceDetails: Array.isArray(source.occurrenceDetails)
      ? source.occurrenceDetails
      : [],
  };
}

function normalizeOccurrenceAverageVersionObjectSummary(
  aggregate,
  successfulSnapshotCount,
) {
  const source = aggregate || {};
  const occurrenceAverageRetainedSize = source[fieldKeys.occurrenceCount] > 0
    ? (source[fieldKeys.totalRetainedSize] || 0) / source[fieldKeys.occurrenceCount]
    : 0;
  return {
    'object_name': source[fieldKeys.objectName] || '',
    'normalized_object_name': source[fieldKeys.normalizedObjectName] ||
      normalizeComparisonObjectName(source[fieldKeys.objectName] || ''),
    'object_name_variants': Array.isArray(source[fieldKeys.objectNameVariants])
      ? source[fieldKeys.objectNameVariants]
      : (source[fieldKeys.objectName] ? [source[fieldKeys.objectName]] : []),
    'successful_snapshot_count': successfulSnapshotCount,
    'occurrence_count': source[fieldKeys.occurrenceCount] || 0,
    'occurrence_ratio': source[fieldKeys.occurrenceRatio] || 0,
    'total_count': source[fieldKeys.totalCount] || 0,
    'average_count': source[fieldKeys.averageCount] || 0,
    'average_rank': source[fieldKeys.averageRank] || 0,
    'total_retained_size': source[fieldKeys.totalRetainedSize] || 0,
    'total_retained_size_text': source[fieldKeys.totalRetainedSizeText] || formatSize(0),
    'occurrence_average_retained_size': occurrenceAverageRetainedSize,
    'occurrence_average_retained_size_text': formatSize(occurrenceAverageRetainedSize),
    'max_retained_size': source[fieldKeys.maxRetainedSize] || 0,
    'max_retained_size_text': source[fieldKeys.maxRetainedSizeText] || formatSize(0),
    'representative_chains': Array.isArray(source[fieldKeys.representativeChains])
      ? source[fieldKeys.representativeChains]
      : [],
    occurrenceDetails: Array.isArray(source.occurrenceDetails)
      ? source.occurrenceDetails
      : [],
  };
}

function getOccurrenceWeightFactor(occurrenceCount) {
  return 1 + Math.log(Math.max(1, occurrenceCount || 0));
}

function compareVersionObjectOccurrenceGrowth(a, b) {
  const weightedGrowthDiff = (b[fieldKeys.occurrenceWeightedGrowth] || 0) -
    (a[fieldKeys.occurrenceWeightedGrowth] || 0);
  if (weightedGrowthDiff !== 0) {
    return weightedGrowthDiff;
  }

  const growthDiff = (b[fieldKeys.occurrenceAverageGrowth] || 0) -
    (a[fieldKeys.occurrenceAverageGrowth] || 0);
  if (growthDiff !== 0) {
    return growthDiff;
  }

  const occurrenceDiff = (b.current?.[fieldKeys.occurrenceCount] || 0) -
    (a.current?.[fieldKeys.occurrenceCount] || 0);
  if (occurrenceDiff !== 0) {
    return occurrenceDiff;
  }

  const currentSizeDiff = (b.current?.[fieldKeys.occurrenceAverageRetainedSize] || 0) -
    (a.current?.[fieldKeys.occurrenceAverageRetainedSize] || 0);
  if (currentSizeDiff !== 0) {
    return currentSizeDiff;
  }

  return String(a[fieldKeys.normalizedObjectName] || a[fieldKeys.objectName] || '')
    .localeCompare(String(b[fieldKeys.normalizedObjectName] || b[fieldKeys.objectName] || ''));
}

function compareVersionObjectGrowth(a, b) {
  const growthDiff = (b[fieldKeys.snapshotAverageGrowth] || 0) - (a[fieldKeys.snapshotAverageGrowth] || 0);
  if (growthDiff !== 0) {
    return growthDiff;
  }

  const currentSizeDiff = (b.current?.[fieldKeys.snapshotAverageRetainedSize] || 0) -
    (a.current?.[fieldKeys.snapshotAverageRetainedSize] || 0);
  if (currentSizeDiff !== 0) {
    return currentSizeDiff;
  }

  return String(a[fieldKeys.objectName] || '').localeCompare(String(b[fieldKeys.objectName] || ''));
}

function indexVersionObjectsByName(report, category) {
  return new Map(getVersionObjectAggregates(report, category).map(item => [
    item[fieldKeys.normalizedObjectName] || normalizeComparisonObjectName(item[fieldKeys.objectName] || ''),
    item,
  ]));
}

function getVersionObjectNameVariants(baselineAggregate, currentAggregate) {
  return [...new Set([
    ...(baselineAggregate?.[fieldKeys.objectNameVariants] ||
      (baselineAggregate?.[fieldKeys.objectName] ? [baselineAggregate[fieldKeys.objectName]] : [])),
    ...(currentAggregate?.[fieldKeys.objectNameVariants] ||
      (currentAggregate?.[fieldKeys.objectName] ? [currentAggregate[fieldKeys.objectName]] : [])),
  ])].sort();
}

function buildVersionObjectComparison(normalizedName, context) {
  const {
    baselineByName, currentByName, baselineSnapshotCount,
    currentSnapshotCount, category,
  } = context;
  const baselineAggregate = baselineByName.get(normalizedName);
  const currentAggregate = currentByName.get(normalizedName);
  const objectName = currentAggregate?.[fieldKeys.objectName] || baselineAggregate?.[fieldKeys.objectName] || normalizedName;
  const baseline = normalizeOccurrenceAverageVersionObjectSummary(
    baselineAggregate, baselineSnapshotCount,
  );
  const current = normalizeOccurrenceAverageVersionObjectSummary(
    currentAggregate, currentSnapshotCount,
  );
  const growth = current[fieldKeys.occurrenceAverageRetainedSize] -
    baseline[fieldKeys.occurrenceAverageRetainedSize];
  const status = getVersionGrowthStatus(
    baseline[fieldKeys.occurrenceAverageRetainedSize], current[fieldKeys.occurrenceAverageRetainedSize],
  );
  const growthRatio = baseline[fieldKeys.occurrenceAverageRetainedSize] > 0
    ? growth / baseline[fieldKeys.occurrenceAverageRetainedSize]
    : null;
  const occurrenceWeightFactor = getOccurrenceWeightFactor(current[fieldKeys.occurrenceCount]);
  const comparison = {
    category,
    'object_key': JSON.stringify({ category, 'object_name': normalizedName }),
    'object_name': objectName,
    'normalized_object_name': normalizedName,
    'object_name_variants': getVersionObjectNameVariants(baselineAggregate, currentAggregate),
    status,
    'status_text': versionGrowthStatusText(status),
    'occurrence_average_growth': growth,
    'occurrence_average_growth_text': formatSignedSize(growth),
    'occurrence_weight_factor': occurrenceWeightFactor,
    'occurrence_weight_factor_text': `${formatFixed(occurrenceWeightFactor, 4)}x`,
    'occurrence_weighted_growth': growth * occurrenceWeightFactor,
    'occurrence_weighted_growth_text': formatSignedSize(growth * occurrenceWeightFactor),
    'growth_ratio': growthRatio,
    'growth_ratio_text': formatGrowthRatio(growthRatio, status),
    baseline,
    current,
  };
  const largestCurrentChains = selectLargestCurrentRepresentativeChains(comparison, 3);
  return {
    ...comparison,
    'largest_current_chains': largestCurrentChains,
    'largest_current_chain': largestCurrentChains[0] || null,
  };
}

function rankVersionObjectComparisons(comparisons) {
  let growthRank = 0;
  const statusRanks = new Map();
  return comparisons.map((item, index) => {
    const isPositiveGrowth = item[fieldKeys.occurrenceAverageGrowth] > 0;
    const isReportedStatus = item.status === 'new' || item.status === 'increased';
    if (isPositiveGrowth) {
      growthRank++;
    }
    if (isReportedStatus) {
      statusRanks.set(item.status, (statusRanks.get(item.status) || 0) + 1);
    }
    return {
      'comparison_rank': index + 1,
      'growth_rank': isPositiveGrowth ? growthRank : null,
      'status_rank': isReportedStatus ? statusRanks.get(item.status) : null,
      ...item,
    };
  });
}

function buildVersionObjectCategoryComparisons(
  baselineReport,
  currentReport,
  category,
  baselineSnapshotCount,
  currentSnapshotCount,
) {
  const baselineByName = indexVersionObjectsByName(baselineReport, category);
  const currentByName = indexVersionObjectsByName(currentReport, category);
  const normalizedNames = new Set([...baselineByName.keys(), ...currentByName.keys()]);
  const context = {
    baselineByName, currentByName, baselineSnapshotCount, currentSnapshotCount, category,
  };
  const comparisons = [...normalizedNames]
    .map(name => buildVersionObjectComparison(name, context))
    .sort(compareVersionObjectOccurrenceGrowth);
  return rankVersionObjectComparisons(comparisons);
}

function serializeObjectOverviewItem(item, rank) {
  return {
    rank,
    'status_rank': item[fieldKeys.statusRank],
    category: item.category,
    'object_name': item[fieldKeys.objectName],
    'normalized_object_name': item[fieldKeys.normalizedObjectName],
    'object_name_variants': item[fieldKeys.objectNameVariants],
    status: item.status,
    'status_text': item[fieldKeys.statusText],
    'occurrence_average_growth': item[fieldKeys.occurrenceAverageGrowth],
    'occurrence_average_growth_text': item[fieldKeys.occurrenceAverageGrowthText],
    'occurrence_weight_factor': item[fieldKeys.occurrenceWeightFactor],
    'occurrence_weight_factor_text': item[fieldKeys.occurrenceWeightFactorText],
    'occurrence_weighted_growth': item[fieldKeys.occurrenceWeightedGrowth],
    'occurrence_weighted_growth_text': item[fieldKeys.occurrenceWeightedGrowthText],
    'growth_ratio': item[fieldKeys.growthRatio],
    'growth_ratio_text': item[fieldKeys.growthRatioText],
    'similar_chain_family_ids': Array.isArray(item[fieldKeys.similarChainFamilyIds])
      ? item[fieldKeys.similarChainFamilyIds]
      : [],
    'similar_chain_families': Array.isArray(item[fieldKeys.similarChainFamilies])
      ? item[fieldKeys.similarChainFamilies]
      : [],
    baseline: {
      'occurrence_count': item.baseline[fieldKeys.occurrenceCount],
      'occurrence_ratio': item.baseline[fieldKeys.occurrenceRatio],
      'occurrence_average_retained_size':
        item.baseline[fieldKeys.occurrenceAverageRetainedSize],
      'occurrence_average_retained_size_text':
        item.baseline[fieldKeys.occurrenceAverageRetainedSizeText],
    },
    current: {
      'occurrence_count': item.current[fieldKeys.occurrenceCount],
      'occurrence_ratio': item.current[fieldKeys.occurrenceRatio],
      'occurrence_average_retained_size':
        item.current[fieldKeys.occurrenceAverageRetainedSize],
      'occurrence_average_retained_size_text':
        item.current[fieldKeys.occurrenceAverageRetainedSizeText],
    },
  };
}

function buildObjectOverview(comparisons, predicate, limit = 10) {
  return comparisons
    .filter(predicate)
    .sort(compareVersionObjectOccurrenceGrowth)
    .slice(0, limit)
    .map((item, index) => serializeObjectOverviewItem(item, index + 1));
}

function buildObjectGrowthOverview(businessComparisons, commonComparisons) {
  return buildObjectOverview(
    [...businessComparisons, ...commonComparisons],
    item => item[fieldKeys.occurrenceAverageGrowth] > 0,
  );
}

function buildObjectStatusOverview(businessComparisons, commonComparisons, status) {
  return buildObjectOverview(
    [...businessComparisons, ...commonComparisons],
    item => item.status === status,
  );
}

const similarChainFamilyColorCount = 10;

function formatAlphabeticSequence(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function getVersionObjectDetailAnchor(item) {
  const status = item?.status === 'new' ? 'new' : 'increased';
  const category = item?.category === 'business' ? 'business' : 'common';
  const rank = Number.isInteger(item?.[fieldKeys.statusRank]) && item[fieldKeys.statusRank] > 0
    ? item[fieldKeys.statusRank]
    : 0;
  return `object-${status}-${category}-${rank}`;
}

function getLargestCurrentChains(item) {
  if (Array.isArray(item?.[fieldKeys.largestCurrentChains])) {
    return item[fieldKeys.largestCurrentChains].slice(0, 3);
  }
  return item?.[fieldKeys.largestCurrentChain] ? [item[fieldKeys.largestCurrentChain]] : [];
}

function getVersionChainDetailAnchor(item, chainRank) {
  return `${getVersionObjectDetailAnchor(item)}-chain-${chainRank}`;
}

function getVisibleVersionObjectComparisons(
  businessComparisons,
  commonComparisons,
  compareTop,
) {
  const visible = [];
  for (const status of ['new', 'increased']) {
    for (const comparisons of [businessComparisons, commonComparisons]) {
      visible.push(
        ...comparisons
          .filter(item => item.status === status)
          .slice(0, compareTop),
      );
    }
  }
  return visible;
}

function initializeVersionSimilarChainFields(comparisons) {
  for (const item of comparisons) {
    const chains = getLargestCurrentChains(item).map(chain => ({
      ...chain,
      'similar_chain_family_id': null,
      'similar_chain_family_label': null,
      'similar_chain_family_display_label': null,
      'similar_chain_family_distance0_object_name': null,
      'similar_chain_family_color_index': null,
      'similar_chain_family_object_count': 0,
    }));
    item[fieldKeys.largestCurrentChains] = chains;
    item[fieldKeys.largestCurrentChain] = chains[0] || null;
    item[fieldKeys.similarChainFamilyIds] = [];
    item[fieldKeys.similarChainFamilies] = [];
  }
}

function getSimilarChainMemberKey(item, chainRank) {
  return `${item[fieldKeys.objectKey] || item[fieldKeys.normalizedObjectName] || item[fieldKeys.objectName]}\u0000${chainRank}`;
}

function getRepresentativeChainPathNames(chain) {
  if (Array.isArray(chain?.[fieldKeys.pathNames])) {
    return chain[fieldKeys.pathNames];
  }
  return (Array.isArray(chain?.[fieldKeys.representativePathEntries])
    ? chain[fieldKeys.representativePathEntries]
    : [])
    .map(entry => entry?.name || '');
}

function getRepresentativeChainNormalizedPathNames(chain) {
  if (Array.isArray(chain?.[fieldKeys.normalizedPathNames])) {
    return chain[fieldKeys.normalizedPathNames];
  }
  return getRepresentativeChainPathNames(chain).map(normalizeComparisonObjectName);
}

function areGlobalVersionChainsSimilar(a, b) {
  if (!a || !b) {
    return false;
  }
  if ((a[fieldKeys.rootType] || '') !== (b[fieldKeys.rootType] || '')) {
    return false;
  }

  const aNames = getRepresentativeChainNormalizedPathNames(a);
  const bNames = getRepresentativeChainNormalizedPathNames(b);
  return isPathNameSequenceContained(aNames, bNames) ||
    isPathNameSequenceContained(bNames, aNames);
}

function getRepresentativeChainDistance0ObjectName(chain) {
  const pathEntries = Array.isArray(chain?.[fieldKeys.representativePathEntries])
    ? chain[fieldKeys.representativePathEntries]
    : [];
  const distance0Entry = pathEntries.find(entry => Number(entry?.distance) === 0);
  if (distance0Entry?.name) {
    return distance0Entry.name;
  }

  const pathNames = getRepresentativeChainPathNames(chain)
    .filter(name => typeof name === 'string' && name.length > 0);
  return pathNames[pathNames.length - 1] || '未知 Distance 0 对象';
}

function compareSimilarChainFamilyDraft(a, b) {
  const objectCountDiff = b[fieldKeys.objectCount] - a[fieldKeys.objectCount];
  if (objectCountDiff !== 0) {
    return objectCountDiff;
  }

  const maxSizeDiff = b[fieldKeys.maxRetainedSize] - a[fieldKeys.maxRetainedSize];
  if (maxSizeDiff !== 0) {
    return maxSizeDiff;
  }

  return a[fieldKeys.familyKey].localeCompare(b[fieldKeys.familyKey]);
}

function compareSimilarChainFamilyMember(a, b) {
  const sizeDiff = (b.chain[fieldKeys.totalRetainedSize] || 0) -
    (a.chain[fieldKeys.totalRetainedSize] || 0);
  if (sizeDiff !== 0) {
    return sizeDiff;
  }

  const objectNameDiff = String(a.item[fieldKeys.objectName] || '')
    .localeCompare(String(b.item[fieldKeys.objectName] || ''));
  if (objectNameDiff !== 0) {
    return objectNameDiff;
  }

  return a[fieldKeys.chainRank] - b[fieldKeys.chainRank];
}

function selectSimilarChainFamilyRepresentative(members) {
  return [...members].sort((a, b) => {
    const depthDiff = getRepresentativeChainNormalizedPathNames(b.chain).length -
      getRepresentativeChainNormalizedPathNames(a.chain).length;
    if (depthDiff !== 0) {
      return depthDiff;
    }

    const sizeDiff = (b.chain[fieldKeys.totalRetainedSize] || 0) -
      (a.chain[fieldKeys.totalRetainedSize] || 0);
    if (sizeDiff !== 0) {
      return sizeDiff;
    }

    const chainKeyDiff = String(a.chain[fieldKeys.chainKey] || '')
      .localeCompare(String(b.chain[fieldKeys.chainKey] || ''));
    if (chainKeyDiff !== 0) {
      return chainKeyDiff;
    }

    return a[fieldKeys.memberKey].localeCompare(b[fieldKeys.memberKey]);
  })[0];
}

function collectVersionSimilarChainMembers(visibleComparisons) {
  const members = [];
  for (const item of visibleComparisons) {
    item[fieldKeys.largestCurrentChains].forEach((chain, index) => {
      const chainRank = index + 1;
      members.push({
        item,
        chain,
        'chain_rank': chainRank,
        'member_key': getSimilarChainMemberKey(item, chainRank),
      });
    });
  }
  return members;
}

function buildVersionSimilarChainDraft(component) {
  const objectKeys = new Set(component.map(member => member.item[fieldKeys.objectKey]));
  if (objectKeys.size < 2) {
    return null;
  }
  const maxRetainedSize = component.reduce(
    (max, member) => Math.max(max, member.chain[fieldKeys.totalRetainedSize] || 0), 0,
  );
  const familyKey = component.map(member => JSON.stringify({
    'object_key': member.item[fieldKeys.objectKey],
    'chain_key': member.chain[fieldKeys.chainKey] || '',
    'chain_rank': member[fieldKeys.chainRank],
  })).sort().join('\u0001');
  return {
    'family_key': familyKey,
    'root_type': component[0]?.chain?.[fieldKeys.rootType] || '',
    'object_count': objectKeys.size,
    'chain_count': component.length,
    'max_retained_size': maxRetainedSize,
    members: component,
    representative: selectSimilarChainFamilyRepresentative(component),
  };
}

function buildVersionSimilarChainDrafts(members) {
  return groupVariantsBySimilarity(
    members, (a, b) => areGlobalVersionChainsSimilar(a.chain, b.chain),
  ).map(buildVersionSimilarChainDraft)
    .filter(Boolean)
    .sort(compareSimilarChainFamilyDraft);
}

function serializeVersionSimilarChainMember(member) {
  return {
    'object_key': member.item[fieldKeys.objectKey],
    'object_name': member.item[fieldKeys.objectName],
    category: member.item.category,
    status: member.item.status,
    'status_text': member.item[fieldKeys.statusText],
    'status_rank': member.item[fieldKeys.statusRank],
    'object_detail_anchor': getVersionObjectDetailAnchor(member.item),
    'chain_rank': member[fieldKeys.chainRank],
    'chain_detail_anchor': getVersionChainDetailAnchor(member.item, member[fieldKeys.chainRank]),
    'chain_key': member.chain[fieldKeys.chainKey] || '',
    'total_retained_size': member.chain[fieldKeys.totalRetainedSize] || 0,
    'total_retained_size_text': member.chain[fieldKeys.totalRetainedSizeText] ||
      formatSize(member.chain[fieldKeys.totalRetainedSize] || 0),
    'root_type': member.chain[fieldKeys.rootType] || '',
    'path_names': getRepresentativeChainPathNames(member.chain),
    'normalized_path_names': getRepresentativeChainNormalizedPathNames(member.chain),
  };
}

function createVersionSimilarChainFamily(draft, index) {
  const sequence = formatAlphabeticSequence(index);
  const distance0ObjectName = getRepresentativeChainDistance0ObjectName(
    draft.representative.chain,
  );
  const familyLabel = `链组 ${sequence}`;
  return {
    rank: index + 1,
    'family_id': `chain-family-${sequence}`,
    'family_label': familyLabel,
    'distance0_object_name': distance0ObjectName,
    'display_label': `${familyLabel} · ${distance0ObjectName}`,
    'color_index': index % similarChainFamilyColorCount,
    'family_key': draft[fieldKeys.familyKey],
    'root_type': draft[fieldKeys.rootType],
    'object_count': draft[fieldKeys.objectCount],
    'chain_count': draft[fieldKeys.chainCount],
    'max_retained_size': draft[fieldKeys.maxRetainedSize],
    'max_retained_size_text': formatSize(draft[fieldKeys.maxRetainedSize]),
    'representative_path_names': getRepresentativeChainPathNames(draft.representative.chain),
    'representative_normalized_path_names': getRepresentativeChainNormalizedPathNames(
      draft.representative.chain,
    ),
    'member_chains': [...draft.members]
      .sort(compareSimilarChainFamilyMember)
      .map(serializeVersionSimilarChainMember),
  };
}

function compactVersionSimilarChainFamily(family) {
  return {
    rank: family.rank,
    'family_id': family[fieldKeys.familyId],
    'family_label': family[fieldKeys.familyLabel],
    'distance0_object_name': family[fieldKeys.distance0ObjectName],
    'display_label': family[fieldKeys.displayLabel],
    'color_index': family[fieldKeys.colorIndex],
    'object_count': family[fieldKeys.objectCount],
  };
}

function createVersionSimilarChainFamilyIndex(drafts) {
  const familyByMemberKey = new Map();
  const families = drafts.map((draft, index) => {
    const family = createVersionSimilarChainFamily(draft, index);
    const compact = compactVersionSimilarChainFamily(family);
    for (const member of draft.members) {
      familyByMemberKey.set(member[fieldKeys.memberKey], compact);
    }
    return family;
  });
  return { families, familyByMemberKey };
}

function annotateVersionComparisonsWithChainFamilies(allComparisons, familyByMemberKey) {
  for (const item of allComparisons) {
    const objectFamilies = new Map();
    item[fieldKeys.largestCurrentChains] = item[fieldKeys.largestCurrentChains].map((chain, index) => {
      const family = familyByMemberKey.get(getSimilarChainMemberKey(item, index + 1));
      if (!family) {
        return chain;
      }
      objectFamilies.set(family[fieldKeys.familyId], family);
      return {
        ...chain,
        'similar_chain_family_id': family[fieldKeys.familyId],
        'similar_chain_family_label': family[fieldKeys.familyLabel],
        'similar_chain_family_display_label': family[fieldKeys.displayLabel],
        'similar_chain_family_distance0_object_name': family[fieldKeys.distance0ObjectName],
        'similar_chain_family_color_index': family[fieldKeys.colorIndex],
        'similar_chain_family_object_count': family[fieldKeys.objectCount],
      };
    });
    item[fieldKeys.largestCurrentChain] = item[fieldKeys.largestCurrentChains][0] || null;
    item[fieldKeys.similarChainFamilies] = [...objectFamilies.values()]
      .sort((a, b) => a.rank - b.rank);
    item[fieldKeys.similarChainFamilyIds] = item[fieldKeys.similarChainFamilies]
      .map(family => family[fieldKeys.familyId]);
  }
}

function buildVersionSimilarChainFamilies(
  businessComparisons,
  commonComparisons,
  compareTop,
) {
  const allComparisons = [...businessComparisons, ...commonComparisons];
  initializeVersionSimilarChainFields(allComparisons);
  const visibleComparisons = getVisibleVersionObjectComparisons(
    businessComparisons, commonComparisons, compareTop,
  );
  const members = collectVersionSimilarChainMembers(visibleComparisons);
  const drafts = buildVersionSimilarChainDrafts(members);
  const { families, familyByMemberKey } = createVersionSimilarChainFamilyIndex(drafts);
  annotateVersionComparisonsWithChainFamilies(allComparisons, familyByMemberKey);
  return families;
}

function buildVersionCategoryData(baselineReport, currentReport, category, counts) {
  return {
    chainComparisons: buildVersionCategoryComparisons(
      baselineReport, currentReport, category, counts.baseline, counts.current,
    ),
    objectComparisons: buildVersionObjectCategoryComparisons(
      baselineReport, currentReport, category, counts.baseline, counts.current,
    ),
  };
}

function countVersionItems(items, predicate) {
  return items.filter(predicate).length;
}

function buildVersionComparisonMetadata(outputDir, compareTop, baselineReport, data) {
  const { business, common, similarChainFamilies } = data;
  const isGrowth = item => item[fieldKeys.occurrenceAverageGrowth] > 0;
  const isNew = item => item.status === 'new';
  const isIncreased = item => item.status === 'increased';
  return {
    mode: 'version_comparison',
    'generated_at': new Date().toISOString(),
    'output_dir': path.resolve(outputDir),
    'markdown_top': compareTop,
    'comparison_metric': '对象组累计 retained size / 对象出现次数；未出现该对象的快照不参与均值',
    'matching_rule': '所有公共对象名先将 js_xxx、jsxxx 和 JSXxx 统一为 JSXxx 规范名（Proxy 额外兼容裸名），再归一化依赖包版本和 #a21810 这类混淆函数；保留包名、文件路径和行号，root_type 和引用链不参与对象匹配',
    'representative_chain_rule': '公共对象规范名、依赖包版本和混淆函数名归一化后，同对象、同 root_type，且一条路径名称序列是另一条的非连续有序子序列时合并；报告展示新版本跨快照累计 retained size 最大的 Top3',
    'similar_chain_family_rule': '普通跨版本报告四个可见 TopN 榜单的新版本 Top3 链全局比较；root_type 相同且一条归一化路径连续完整包含于另一条路径时进入同一连通链组，中间不允许插层，空 root_type 可互相匹配，不过滤公共运行时尾链',
    'similar_chain_family_count': similarChainFamilies.length,
    'similar_chain_family_color_count': similarChainFamilyColorCount,
    'legacy_chain_matching_rule': baselineReport.metadata[fieldKeys.chainKeyRule],
    'occurrence_weight_rule': 'occurrence_average_growth * (1 + ln(max(1, current occurrence_count)))',
    'sorting_rule': 'occurrence_weighted_growth DESC, occurrence_average_growth DESC, ' +
      'current occurrence_count DESC, current occurrence average retained size DESC, normalized object name ASC',
    'business_growth_count': countVersionItems(business.objectComparisons, isGrowth),
    'common_growth_count': countVersionItems(common.objectComparisons, isGrowth),
    'business_new_count': countVersionItems(business.objectComparisons, isNew),
    'common_new_count': countVersionItems(common.objectComparisons, isNew),
    'business_increased_count': countVersionItems(business.objectComparisons, isIncreased),
    'common_increased_count': countVersionItems(common.objectComparisons, isIncreased),
    'legacy_chain_business_growth_count': countVersionItems(business.chainComparisons, isGrowth),
    'legacy_chain_common_growth_count': countVersionItems(common.chainComparisons, isGrowth),
  };
}

function buildVersionSideSummary(inputDir, result, report, successfulSnapshotCount) {
  return {
    label: path.basename(path.resolve(inputDir)),
    'input_dir': path.resolve(inputDir),
    'aggregate_report': result.reportPath,
    'aggregate_json': result.clusterJsonPath,
    'total_snapshot_count': report.metadata[fieldKeys.totalSnapshotCount],
    'successful_snapshot_count': successfulSnapshotCount,
    'failed_snapshot_count': report.metadata[fieldKeys.failedSnapshotCount],
  };
}

function buildVersionComparisonReport(
  baselineDir,
  currentDir,
  outputDir,
  baselineResult,
  currentResult,
  compareTop,
) {
  const baselineReport = baselineResult.report;
  const currentReport = currentResult.report;
  const counts = {
    baseline: baselineReport.metadata[fieldKeys.successfulSnapshotCount],
    current: currentReport.metadata[fieldKeys.successfulSnapshotCount],
  };
  const business = buildVersionCategoryData(baselineReport, currentReport, 'business', counts);
  const common = buildVersionCategoryData(baselineReport, currentReport, 'common', counts);
  const similarChainFamilies = buildVersionSimilarChainFamilies(
    business.objectComparisons, common.objectComparisons, compareTop,
  );
  const data = { business, common, similarChainFamilies };
  return {
    metadata: buildVersionComparisonMetadata(outputDir, compareTop, baselineReport, data),
    baseline: buildVersionSideSummary(baselineDir, baselineResult, baselineReport, counts.baseline),
    current: buildVersionSideSummary(currentDir, currentResult, currentReport, counts.current),
    'growth_overview': buildObjectGrowthOverview(
      business.objectComparisons, common.objectComparisons,
    ),
    'new_object_overview': buildObjectStatusOverview(
      business.objectComparisons, common.objectComparisons, 'new',
    ),
    'increased_object_overview': buildObjectStatusOverview(
      business.objectComparisons, common.objectComparisons, 'increased',
    ),
    'similar_chain_families': similarChainFamilies,
    'business_object_comparisons': business.objectComparisons,
    'common_object_comparisons': common.objectComparisons,
    'business_comparisons': business.chainComparisons,
    'common_comparisons': common.chainComparisons,
  };
}

function selectLargestCurrentRepresentativeChains(comparison, limit = 3) {
  const chains = Array.isArray(comparison?.current?.[fieldKeys.representativeChains])
    ? comparison.current[fieldKeys.representativeChains]
    : [];
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3;
  return [...chains]
    .sort(compareObjectRepresentativeChainAggregate)
    .slice(0, safeLimit);
}

function selectLargestCurrentRepresentativeChain(comparison) {
  return selectLargestCurrentRepresentativeChains(comparison, 1)[0] || null;
}

function collectRecalculatedOccurrences(successfulSnapshots, category) {
  const occurrencesByName = new Map();
  for (const snapshot of successfulSnapshots) {
    const recalculatedStats = snapshot.recalculatedObjectStats;
    if (!recalculatedStats || !Array.isArray(recalculatedStats[category])) {
      throw new Error(
        `快照缺少实验模式 retained size 重算结果: ${snapshot.snapshotPath}`,
      );
    }

    for (const stats of recalculatedStats[category]) {
      const normalizedObjectName = stats[fieldKeys.normalizedObjectName] ||
        normalizeComparisonObjectName(stats[fieldKeys.objectName] || '');
      const occurrences = occurrencesByName.get(normalizedObjectName) || [];
      occurrences.push({ snapshot, stats });
      occurrencesByName.set(normalizedObjectName, occurrences);
    }
  }
  return occurrencesByName;
}

function compareRecalculatedOccurrence(a, b) {
  const sizeDiff = (b.stats[fieldKeys.totalRetainedSize] || 0) -
    (a.stats[fieldKeys.totalRetainedSize] || 0);
  return sizeDiff !== 0
    ? sizeDiff
    : String(a.stats[fieldKeys.objectName] || '').localeCompare(String(b.stats[fieldKeys.objectName] || ''));
}

function serializeRecalculatedOccurrence(occurrence, normalizedName) {
  const { snapshot, stats } = occurrence;
  return {
    snapshot: snapshot.snapshotPath,
    'snapshot_name': path.basename(snapshot.snapshotPath),
    'cluster_json': snapshot.clusterJsonPath,
    'object_name': stats[fieldKeys.objectName] || normalizedName,
    'normalized_object_name': normalizedName,
    rank: stats.rank || 0,
    count: stats.count || 0,
    'retained_root_count': stats[fieldKeys.retainedRootCount] || 0,
    'total_self_size': stats[fieldKeys.totalSelfSize] || 0,
    'total_self_size_text': stats[fieldKeys.totalSelfSizeText] || formatSize(stats[fieldKeys.totalSelfSize] || 0),
    'total_retained_size': stats[fieldKeys.totalRetainedSize] || 0,
    'total_retained_size_text': stats[fieldKeys.totalRetainedSizeText] ||
      formatSize(stats[fieldKeys.totalRetainedSize] || 0),
  };
}

function summarizeRecalculatedOccurrences(details) {
  return details.reduce((summary, detail) => ({
    totalRetainedSize: summary.totalRetainedSize + detail[fieldKeys.totalRetainedSize],
    totalSelfSize: summary.totalSelfSize + detail[fieldKeys.totalSelfSize],
    totalCount: summary.totalCount + detail.count,
    retainedRootCount: summary.retainedRootCount + detail[fieldKeys.retainedRootCount],
    rankSum: summary.rankSum + detail.rank,
    maxRetainedSize: Math.max(summary.maxRetainedSize, detail[fieldKeys.totalRetainedSize]),
  }), {
    totalRetainedSize: 0, totalSelfSize: 0, totalCount: 0,
    retainedRootCount: 0, rankSum: 0, maxRetainedSize: 0,
  });
}

function serializeRecalculatedObjectAggregate(context) {
  const {
    category, normalizedName, objectName, objectNameVariants,
    snapshotCount, occurrenceDetails, summary, representativeChains,
  } = context;
  const occurrenceCount = occurrenceDetails.length;
  const snapshotRetainedAverage = snapshotCount > 0
    ? summary.totalRetainedSize / snapshotCount
    : 0;
  const snapshotSelfAverage = snapshotCount > 0 ? summary.totalSelfSize / snapshotCount : 0;
  const presentAverage = occurrenceCount > 0 ? summary.totalRetainedSize / occurrenceCount : 0;
  return {
    category,
    'object_key': JSON.stringify({ category, 'object_name': normalizedName }),
    'object_name': objectName,
    'normalized_object_name': normalizedName,
    'object_name_variants': objectNameVariants,
    'calculation_method': 'dominator_tree_self_size_postorder_same_name_union',
    'occurrence_count': occurrenceCount,
    'occurrence_ratio': snapshotCount > 0 ? occurrenceCount / snapshotCount : 0,
    'total_count': summary.totalCount,
    'average_count': snapshotCount > 0 ? summary.totalCount / snapshotCount : 0,
    'average_rank': occurrenceCount > 0 ? summary.rankSum / occurrenceCount : 0,
    'retained_root_count': summary.retainedRootCount,
    'average_retained_root_count': snapshotCount > 0 ? summary.retainedRootCount / snapshotCount : 0,
    'total_self_size': summary.totalSelfSize,
    'total_self_size_text': formatSize(summary.totalSelfSize),
    'snapshot_average_self_size': snapshotSelfAverage,
    'snapshot_average_self_size_text': formatSize(snapshotSelfAverage),
    'total_retained_size': summary.totalRetainedSize,
    'total_retained_size_text': formatSize(summary.totalRetainedSize),
    'snapshot_average_retained_size': snapshotRetainedAverage,
    'snapshot_average_retained_size_text': formatSize(snapshotRetainedAverage),
    'present_average_retained_size': presentAverage,
    'present_average_retained_size_text': formatSize(presentAverage),
    'max_retained_size': summary.maxRetainedSize,
    'max_retained_size_text': formatSize(summary.maxRetainedSize),
    'representative_chains': representativeChains,
    'top_representative_chains': representativeChains.slice(0, 3),
    occurrenceDetails: occurrenceDetails.sort((a, b) =>
      String(a[fieldKeys.snapshotName]).localeCompare(String(b[fieldKeys.snapshotName]))),
  };
}

function buildRecalculatedObjectAggregate(entry, context) {
  const [normalizedName, occurrences] = entry;
  const chainAggregate = context.chainAggregatesByName.get(normalizedName);
  const representative = [...occurrences].sort(compareRecalculatedOccurrence)[0];
  const objectName = representative?.stats?.[fieldKeys.objectName] || chainAggregate?.[fieldKeys.objectName] || normalizedName;
  const objectNameVariants = [...new Set([
    ...occurrences.flatMap(item => item.stats[fieldKeys.objectNameVariants] || [item.stats[fieldKeys.objectName]]),
    ...(chainAggregate?.[fieldKeys.objectNameVariants] || []),
  ].filter(Boolean))].sort();
  const occurrenceDetails = occurrences.map(item =>
    serializeRecalculatedOccurrence(item, normalizedName));
  const representativeChains = Array.isArray(chainAggregate?.[fieldKeys.representativeChains])
    ? chainAggregate[fieldKeys.representativeChains]
    : [];
  return serializeRecalculatedObjectAggregate({
    ...context, normalizedName, objectName, objectNameVariants,
    occurrenceDetails, representativeChains,
    summary: summarizeRecalculatedOccurrences(occurrenceDetails),
  });
}

function collectRecalculatedVersionObjectAggregates(
  successfulSnapshots,
  category,
  versionReport,
) {
  const occurrencesByName = collectRecalculatedOccurrences(successfulSnapshots, category);
  const context = {
    category,
    snapshotCount: successfulSnapshots.length,
    chainAggregatesByName: indexVersionObjectsByName(versionReport, category),
  };
  return [...occurrencesByName.entries()]
    .map(entry => buildRecalculatedObjectAggregate(entry, context))
    .sort(compareMultiSnapshotObjectAggregate)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function normalizeExperimentalVersionObjectSummary(aggregate, successfulSnapshotCount) {
  const summary = normalizeVersionObjectSummary(aggregate, successfulSnapshotCount);
  return {
    ...summary,
    'calculation_method': 'dominator_tree_self_size_postorder_same_name_union',
    'retained_root_count': aggregate?.[fieldKeys.retainedRootCount] || 0,
    'average_retained_root_count': aggregate?.[fieldKeys.averageRetainedRootCount] || 0,
    'total_self_size': aggregate?.[fieldKeys.totalSelfSize] || 0,
    'total_self_size_text': aggregate?.[fieldKeys.totalSelfSizeText] || formatSize(0),
    'snapshot_average_self_size': aggregate?.[fieldKeys.snapshotAverageSelfSize] || 0,
    'snapshot_average_self_size_text': aggregate?.[fieldKeys.snapshotAverageSelfSizeText] ||
      formatSize(0),
  };
}

function indexObjectAggregatesByName(aggregates) {
  return new Map(aggregates.map(item => [
    item[fieldKeys.normalizedObjectName] || normalizeComparisonObjectName(item[fieldKeys.objectName] || ''),
    item,
  ]));
}

function buildExperimentalObjectDelta(normalizedName, context) {
  const {
    baselineByName, currentByName, baselineSnapshotCount,
    currentSnapshotCount, category,
  } = context;
  const baselineAggregate = baselineByName.get(normalizedName);
  const currentAggregate = currentByName.get(normalizedName);
  const objectName = currentAggregate?.[fieldKeys.objectName] || baselineAggregate?.[fieldKeys.objectName] || normalizedName;
  const baseline = normalizeExperimentalVersionObjectSummary(
    baselineAggregate, baselineSnapshotCount,
  );
  const current = normalizeExperimentalVersionObjectSummary(
    currentAggregate, currentSnapshotCount,
  );
  const growth = current[fieldKeys.snapshotAverageRetainedSize] - baseline[fieldKeys.snapshotAverageRetainedSize];
  const status = getVersionGrowthStatus(
    baseline[fieldKeys.snapshotAverageRetainedSize], current[fieldKeys.snapshotAverageRetainedSize],
  );
  const growthRatio = baseline[fieldKeys.snapshotAverageRetainedSize] > 0
    ? growth / baseline[fieldKeys.snapshotAverageRetainedSize]
    : null;
  const comparison = {
    category,
    'object_key': JSON.stringify({ category, 'object_name': normalizedName }),
    'object_name': objectName,
    'normalized_object_name': normalizedName,
    'object_name_variants': [...new Set([
      ...(baselineAggregate?.[fieldKeys.objectNameVariants] || []),
      ...(currentAggregate?.[fieldKeys.objectNameVariants] || []),
    ])].sort(),
    'calculation_method': 'dominator_tree_self_size_postorder_same_name_union',
    status,
    'status_text': versionGrowthStatusText(status),
    'snapshot_average_growth': growth,
    'snapshot_average_growth_text': formatSignedSize(growth),
    'growth_ratio': growthRatio,
    'growth_ratio_text': formatGrowthRatio(growthRatio, status),
    baseline,
    current,
  };
  return {
    ...comparison,
    'largest_current_chain': selectLargestCurrentRepresentativeChain(comparison),
  };
}

function buildExperimentalObjectCategoryDeltas(
  baselineAggregates,
  currentAggregates,
  category,
  baselineSnapshotCount,
  currentSnapshotCount,
) {
  const baselineByName = indexObjectAggregatesByName(baselineAggregates);
  const currentByName = indexObjectAggregatesByName(currentAggregates);
  const normalizedNames = new Set([...baselineByName.keys(), ...currentByName.keys()]);
  const context = {
    baselineByName, currentByName, baselineSnapshotCount, currentSnapshotCount, category,
  };
  const comparisons = [...normalizedNames]
    .map(name => buildExperimentalObjectDelta(name, context))
    .sort(compareVersionObjectGrowth);
  return rankPositiveGrowthComparisons(comparisons, 'snapshot_average_growth');
}

function buildExperimentalCategoryData(
  baselineResult,
  currentResult,
  category,
  counts,
) {
  const baselineAggregates = collectRecalculatedVersionObjectAggregates(
    baselineResult.successfulSnapshots || [], category, baselineResult.report,
  );
  const currentAggregates = collectRecalculatedVersionObjectAggregates(
    currentResult.successfulSnapshots || [], category, currentResult.report,
  );
  return buildExperimentalObjectCategoryDeltas(
    baselineAggregates, currentAggregates, category, counts.baseline, counts.current,
  );
}

function buildTopExperimentalGrowth(comparisons, compareTop) {
  return comparisons.filter(item => item[fieldKeys.snapshotAverageGrowth] > 0)
    .slice(0, compareTop)
    .map((item, index) => ({ 'experimental_rank': index + 1, ...item }));
}

function buildExperimentalComparisonMetadata(outputDir, compareTop, business, common) {
  const isGrowth = item => item[fieldKeys.snapshotAverageGrowth] > 0;
  return {
    mode: 'experimental_version_comparison',
    'generated_at': new Date().toISOString(),
    'output_dir': path.resolve(outputDir),
    'markdown_top': compareTop,
    'comparison_metric': '逐份 heapsnapshot 重算同名对象 retained size 并累计，再除以版本成功快照数；对象未出现的快照按 0 计入',
    'retained_size_recalculation_rule': '仅使用快照节点 self_size 在完整支配树上后序累加，重新计算支配子树 retained size；同一归一化对象名只累计未被同名对象支配的最上层节点，避免同一保留闭包重复计数',
    'object_scope': '快照中的全部对象，不使用原版聚类候选大小',
    'matching_rule': '所有公共对象名先将 js_xxx、jsxxx 和 JSXxx 统一为 JSXxx 规范名（Proxy 额外兼容裸名），再归一化依赖包版本和 #a21810 这类混淆函数；保留包名、文件路径和行号，root_type 和引用链不参与对象匹配',
    'object_sorting_rule': '只保留正增长对象；snapshot_average_growth DESC, current snapshot average retained size DESC, object_name ASC',
    'largest_chain_rule': '只使用新版本引用链；按跨快照累计 retained size、出现时平均大小、出现次数、单次最大大小、chain key 依次排序并取 Top1',
    'representative_chain_rule': '公共对象规范名、依赖包版本和混淆函数名归一化后，同对象、同 root_type，且一条路径名称序列是另一条的非连续有序子序列时合并',
    'business_growth_count': countVersionItems(business, isGrowth),
    'common_growth_count': countVersionItems(common, isGrowth),
  };
}

function buildExperimentalVersionComparisonReport(
  baselineDir,
  currentDir,
  outputDir,
  baselineResult,
  currentResult,
  compareTop,
) {
  const baselineReport = baselineResult.report;
  const currentReport = currentResult.report;
  const counts = {
    baseline: baselineReport.metadata[fieldKeys.successfulSnapshotCount],
    current: currentReport.metadata[fieldKeys.successfulSnapshotCount],
  };
  const business = buildExperimentalCategoryData(
    baselineResult, currentResult, 'business', counts,
  );
  const common = buildExperimentalCategoryData(
    baselineResult, currentResult, 'common', counts,
  );
  return {
    metadata: buildExperimentalComparisonMetadata(outputDir, compareTop, business, common),
    baseline: buildVersionSideSummary(baselineDir, baselineResult, baselineReport, counts.baseline),
    current: buildVersionSideSummary(currentDir, currentResult, currentReport, counts.current),
    'business_object_deltas': business,
    'common_object_deltas': common,
    'business_top_growth': buildTopExperimentalGrowth(business, compareTop),
    'common_top_growth': buildTopExperimentalGrowth(common, compareTop),
  };
}

export {
  annotateVersionComparisonsWithChainFamilies,
  areGlobalVersionChainsSimilar,
  buildExperimentalCategoryData,
  buildExperimentalComparisonMetadata,
  buildExperimentalObjectCategoryDeltas,
  buildExperimentalObjectDelta,
  buildExperimentalVersionComparisonReport,
  buildObjectGrowthOverview,
  buildObjectOverview,
  buildObjectStatusOverview,
  buildRecalculatedObjectAggregate,
  buildTopExperimentalGrowth,
  buildVersionCategoryComparison,
  buildVersionCategoryComparisons,
  buildVersionCategoryData,
  buildVersionComparisonMetadata,
  buildVersionComparisonReport,
  buildVersionObjectCategoryComparisons,
  buildVersionObjectComparison,
  buildVersionSideSummary,
  buildVersionSimilarChainDraft,
  buildVersionSimilarChainDrafts,
  buildVersionSimilarChainFamilies,
  collectDistinctVersionChains,
  collectRecalculatedOccurrences,
  collectRecalculatedVersionObjectAggregates,
  collectVersionSimilarChainMembers,
  compactVersionSimilarChainFamily,
  compareOccurrenceDetail,
  compareRecalculatedOccurrence,
  compareSimilarChainFamilyDraft,
  compareSimilarChainFamilyMember,
  compareVersionGrowth,
  compareVersionObjectGrowth,
  compareVersionObjectOccurrenceGrowth,
  countVersionItems,
  createVersionSimilarChainFamily,
  createVersionSimilarChainFamilyIndex,
  formatAlphabeticSequence,
  formatGrowthRatio,
  formatSignedSize,
  getOccurrenceWeightFactor,
  getRepresentativeChainDistance0ObjectName,
  getRepresentativeChainNormalizedPathNames,
  getRepresentativeChainPathNames,
  getLargestCurrentChains,
  getSimilarChainMemberKey,
  getVersionAggregates,
  getVersionChainDetailAnchor,
  getVersionComparisonVariants,
  getVersionGrowthStatus,
  getVersionObjectAggregates,
  getVersionObjectNameVariants,
  getVisibleVersionObjectComparisons,
  indexObjectAggregatesByName,
  indexVersionObjectsByName,
  getVersionObjectDetailAnchor,
  initializeVersionSimilarChainFields,
  normalizeExperimentalVersionObjectSummary,
  normalizeOccurrenceAverageVersionObjectSummary,
  normalizeVersionObjectSummary,
  rankPositiveGrowthComparisons,
  rankVersionObjectComparisons,
  selectLargestCurrentRepresentativeChain,
  selectLargestCurrentRepresentativeChains,
  selectSimilarChainFamilyRepresentative,
  selectVersionComparisonRepresentative,
  serializeObjectOverviewItem,
  serializeRecalculatedObjectAggregate,
  serializeRecalculatedOccurrence,
  serializeVersionSimilarChainMember,
  similarChainFamilyColorCount,
  summarizeRecalculatedOccurrences,
  summarizeVersionSide,
  versionGrowthStatusText,
};
