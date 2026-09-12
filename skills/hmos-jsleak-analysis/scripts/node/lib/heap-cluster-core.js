import path from 'path';
import fs from 'fs/promises';

import { fieldKeys } from './heap-cluster-field-keys.js';

const { getFullHeapFromFile } = await import('@memlab/heap-analysis');
const memlabCoreModule = await import('@memlab/core');
const memlabCoreDefault = memlabCoreModule.default;
const TraceFinder = memlabCoreModule.TraceFinder ??
  memlabCoreDefault?.TraceFinder ?? memlabCoreDefault?.default?.TraceFinder;
const memlabUtils = memlabCoreModule.utils ??
  memlabCoreDefault?.utils ?? memlabCoreDefault?.default?.utils;

if (typeof TraceFinder !== 'function') {
  throw new TypeError(
    '@memlab/core 未导出可用的 TraceFinder，请在 scripts/node 目录重新安装锁定依赖。',
  );
}
if (typeof memlabUtils?.isRootNode !== 'function') {
  throw new TypeError(
    '@memlab/core 未导出可用的 utils.isRootNode，请在 scripts/node 目录重新安装锁定依赖。',
  );
}
// =================聚类策略常量=================
const clusterStrategy = {
  'SHORTEST_PATH': 'shortest_path',
  'NAME_ONLY': 'name_only',
  'NAME_AND_PATH': 'name_and_path',
  'PROPS_AND_PATH': 'props_and_path',
  'PROMISE_HANDLE': 'promise_handle',
  'NO_CLUSTER': 'no_cluster',
};

// =================对象权重=================
const appObjectWeight = 5;

const systemGroupNames = new Set([
  'String', 'Function', 'Framework',
  'JSObject', 'js_shared_object', 'jsobject',
  'Method', 'JSNativePointer',
  '(array)', 'tagged_array', 'lexical_env',
  'SourceTextModule', 'global_env', 'global_object',
  'Promise', 'PromiseRecord', 'PromiseCapability', 'PromiseReaction',
  'HiddenClass', 'HiddenClass(NonMovable)',
  'js_map', 'js_set', 'js_proxy', 'js_weak_ref',
  'js_array', 'jsarray',
  '(compiled code)', '(system)',
  'InternalAccessor', 'AccessorData',
  'CompletionRecord', 'PropertyBox',
  'MachineCode', 'ConstantPool',
  'ProfileTypeInfo', 'TransitionHandler', 'TransWithProtoHandler',
  'AOTLiteralInfo', 'VTable', 'ClassLiteral',
  'TaggedArray', 'MutantTaggedArray',
  'LinkedNode', 'RBTreeNode',
  'CellRecord', 'ModuleNamespace',
  'JSRegExp', 'JSDate', 'JSError',
  'ByteArray', 'LineString', 'TreeString', 'SlicedString',
]);

const weakReferenceNameMarkers = [
  'weaklinkedhash',
  'weakrefpool',
  'weakmap',
  'weakset',
  'weakref',
  'finalizationregistry',
];

function compactWeakReferenceName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isWeakReferenceContainerName(value) {
  const compactName = compactWeakReferenceName(value);
  return compactName.length > 0 &&
    weakReferenceNameMarkers.some(marker => compactName.includes(marker));
}

function shouldTraverseStrongReferenceEdge(edge, shouldTraverseByDefault = true) {
  if (!shouldTraverseByDefault || edge?.type === 'weak') {
    return false;
  }
  return !isWeakReferenceContainerName(edge?.fromNode?.name);
}

class StrongReferenceTraceFinder extends TraceFinder {
  shouldTraverseEdge(edge, snapshot, options = {}) {
    const shouldTraverseByDefault = super.shouldTraverseEdge(edge, snapshot, options);
    return shouldTraverseStrongReferenceEdge(edge, shouldTraverseByDefault);
  }
}

function annotateStrongReferencePaths(snapshot) {
  new StrongReferenceTraceFinder().annotateShortestPaths(snapshot);
}

function hasStrongReferencePath(node) {
  return Boolean(node?.hasPathEdge || memlabUtils.isRootNode(node));
}

function isBusinessObject(groupName) {
  if (systemGroupNames.has(groupName)) {
    return false;
  }
  if (groupName.startsWith('js_')) {
    return false;
  }
  if (groupName.startsWith('(') && groupName.endsWith(')')) {
    return false;
  }

  if (/[\\/]/.test(groupName)) {
    return true;
  }
  if (/\.(ts|ets|js|mjs)/.test(groupName)) {
    return true;
  }
  if (/:\d+/.test(groupName)) {
    return true;
  }

  return false;
}

function getGroupWeight(groupName) {
  return isBusinessObject(groupName) ? appObjectWeight : 1;
}

function isPromiseLikeName(name) {
  if (!name) {
    return false;
  }
  const n = String(name);
  return (
    n === 'Promise' ||
    n === 'JSPromise' ||
    n === 'js_promise' ||
    n === 'PromiseRecord' ||
    n === 'PromiseCapability' ||
    n === 'PromiseReaction' ||
    /^Promise(Record|Capability|Reaction)$/i.test(n) ||
    /^js_promise/i.test(n)
  );
}

// =================对象类型 -> 聚类策略映射=================
function getClusterStrategy(node) {
  const name = node.name;
  const type = node.type;

  const noClusterNames = ['SourceTextModule', 'global_env', 'global_object'];
  if (noClusterNames.includes(name)) {
    return clusterStrategy[fieldKeys.noCluster];
  }
  if (name.startsWith('HiddenClass')) {
    return clusterStrategy[fieldKeys.noCluster];
  }

  if (isPromiseLikeName(name)) {
    return clusterStrategy[fieldKeys.promiseHandle];
  }

  const shortestPathTypes = ['js_set', 'js_map', 'string', 'js_native_pointer'];
  const shortestPathNames = ['Method', 'JSNativePointer'];
  if (shortestPathTypes.includes(type) || shortestPathNames.includes(name)) {
    return clusterStrategy[fieldKeys.shortestPath];
  }
  if (type === 'string') {
    return clusterStrategy[fieldKeys.shortestPath];
  }
  if (type === 'js_array' || name === 'jsarray' || (type === 'array' && name !== '(array)')) {
    return clusterStrategy[fieldKeys.shortestPath];
  }

  if (type === 'closure' || name === 'Function' || name === '(closure)') {
    return clusterStrategy[fieldKeys.nameOnly];
  }

  if (name === 'JSObject' || name === 'js_shared_object' || name === 'jsobject') {
    return clusterStrategy[fieldKeys.propsAndPath];
  }

  if (type === 'framework' || name === '(array)') {
    return clusterStrategy[fieldKeys.nameAndPath];
  }
  if (type === 'object') {
    return clusterStrategy[fieldKeys.nameAndPath];
  }

  return clusterStrategy[fieldKeys.shortestPath];
}

// =================引用链工具函数=================
function isSyntheticRoot(name) {
  if (!name) {
    return true;
  }
  const n = String(name);
  return (
    n === 'syntheticRoot' ||
    n === 'SyntheticRoot' ||
    n === '(GC roots)' ||
    n === '(Synthetic)' ||
    n === '(synthetic)' ||
    n === '<synthetic>' ||
    n === '(Roots)' ||
    n === 'GC roots'
  );
}

function isHandleRootType(nodeOrType) {
  if (!nodeOrType) {
    return false;
  }

  // 兼容传 node.type 或整个 node
  if (typeof nodeOrType === 'string') {
    return (
      nodeOrType === 'GlobalHandleRoot' ||
      nodeOrType === 'LocalHandleRoot' ||
      nodeOrType === 'VMRoot' ||
      nodeOrType === 'FrameRoot'
    );
  }

  const type = String(nodeOrType.type || '');
  const name = String(nodeOrType.name || '');

  return (
    type === 'GlobalHandleRoot' ||
    type === 'LocalHandleRoot' ||
    type === 'VMRoot' ||
    type === 'FrameRoot' ||
    /^(?:GlobalHandleRoot|LocalHandleRoot|VMRoot|FrameRoot)(?:\[\d+\])?$/.test(name) ||
    name.startsWith('GlobalHandleRoot[') ||
    name.startsWith('LocalHandleRoot[') ||
    name.startsWith('VMRoot[') ||
    name.startsWith('FrameRoot[')
  );
}

function getHandleRootType(node) {
  const type = String(node.type || '');
  const name = String(node.name || '');
  const rootTypes = ['GlobalHandleRoot', 'LocalHandleRoot', 'VMRoot', 'FrameRoot'];
  return rootTypes.find(rootType => type === rootType || name.startsWith(rootType)) || '';
}

function buildHandleRootInfo(node) {
  if (!node || !isHandleRootType(node)) {
    return { rootType: '', rootId: null };
  }
  return {
    rootType: getHandleRootType(node),
    rootId: node.id ?? null,
  };
}

/**
 * 获取节点到 GC Root 的最短引用链
 * 返回:
 * [
 *   pathNodeIds[],
 *   pathNameStrings[],
 *   distance,
 *   rootInfo,
 *   pathEntries[]
 * ]
 *
 * pathEntries 形如:
 * [
 *   { nodeId, name, retainedSize }
 * ]
 *
 * 说明:
 * - 第 0 个 entry 是起始对象
 * - 后续 entry 是沿 pathEdge 向上的父节点
 * - GlobalHandleRoot / LocalHandleRoot 不进入 pathEntries，但会记到 rootInfo
 */
function getShortestPath(node) {
  const pathNodeIds = [];
  const pathStrings = [];
  const pathEntries = [];
  let distance = 0;
  let cur = node;

  let rootInfo = {
    rootType: '',
    rootId: null,
  };

  // 起始对象，distance = 0
  if (!isSyntheticRoot(cur.name) && !isHandleRootType(cur)) {
    pathStrings.push(cur.name);
    pathEntries.push({
      nodeId: cur.id,
      name: cur.name,
      retainedSize: cur.retainedSize || 0,
      distance: 0,
    });
  } else if (isHandleRootType(cur) && !rootInfo.rootType) {
    rootInfo = buildHandleRootInfo(cur);
  }

  while (cur && cur.hasPathEdge) {
    const edge = cur.pathEdge;
    if (!edge || !edge.fromNode) {
      break;
    }

    distance++;
    const parent = edge.fromNode;

    if (isHandleRootType(parent)) {
      if (!rootInfo.rootType) {
        rootInfo = buildHandleRootInfo(parent);
      }
    } else if (!isSyntheticRoot(parent.name)) {
      pathNodeIds.push(parent.id);
      pathStrings.push(parent.name);
      pathEntries.push({
        nodeId: parent.id,
        name: parent.name,
        retainedSize: parent.retainedSize || 0,
        distance, // 这里记录该节点在引用链中的距离
      });
    }

    cur = parent;
  }

  return [pathNodeIds, pathStrings, distance, rootInfo, pathEntries];
}

function getPropertySignature(node) {
  const props = [];
  node.forEachReference((edge) => {
    const edgeType = edge.type;
    if (edgeType === 'hidden' || edgeType === 'weak' || edgeType === 'internal') {
      return;
    }
    if (edge.toNode) {
      props.push(`${edge[fieldKeys.nameOrIndex]}:${edge.toNode.name}`);
    }
  });
  if (props.length === 0) {
    return 'Empty';
  }
  props.sort();
  return props.join(',');
}

const promiseHandlerFields = [
  'fulfilled_handler', 'rejected_handler', 'fulfill_handler', 'reject_handler',
  'onFulfilled', 'onRejected', 'on_fulfilled', 'on_rejected',
  'handler', 'handle', 'then_handler', 'catch_handler',
];
const promiseReactionFields = ['reactions', 'promise_reactions', 'promiseReactions'];
const promiseFields = ['promise', 'promise_', '[[Promise]]'];

function getPromiseHandlerScore(value) {
  if (/fulfill|then|handler/.test(value)) {
    return 0;
  }
  return /reject|catch/.test(value) ? 1 : 2;
}

function formatPromiseHandler(edge, rejectHole = false) {
  if (!promiseHandlerFields.includes(edge[fieldKeys.nameOrIndex]) || !edge.toNode) {
    return null;
  }
  const label = edge.toNode.name || `(${edge.toNode.type || '?'})`;
  if (!label || label === 'undefined' || (rejectHole && label === '(hole)')) {
    return null;
  }
  return `${edge[fieldKeys.nameOrIndex]}=${label}`;
}

function collectPromiseHandlers(node, rejectHole = false) {
  const handlers = [];
  try {
    node.forEachReference((edge) => {
      const handler = formatPromiseHandler(edge, rejectHole);
      if (handler) {
        handlers.push(handler);
      }
    });
  } catch {
    return handlers;
  }
  return handlers;
}

function extractPromiseHandlerFromReaction(reactionNode) {
  if (!reactionNode) {
    return null;
  }
  const handlers = collectPromiseHandlers(reactionNode, true);
  handlers.sort((a, b) => getPromiseHandlerScore(a) - getPromiseHandlerScore(b));
  return handlers[0] || null;
}

function findNestedPromiseReaction(node) {
  if (/Reaction/i.test(node.name)) {
    return node;
  }
  let reactionNode = null;
  try {
    node.forEachReference((edge) => {
      if (!reactionNode && edge.toNode && /Reaction/i.test(edge.toNode.name)) {
        reactionNode = edge.toNode;
      }
    });
  } catch {
    return reactionNode;
  }
  return reactionNode;
}

function findPromiseReaction(node) {
  if (!node) {
    return null;
  }
  let reactionNode = null;
  try {
    node.forEachReference((edge) => {
      const isReactionField = promiseReactionFields.includes(edge[fieldKeys.nameOrIndex]);
      if (!reactionNode && isReactionField && edge.toNode) {
        reactionNode = findNestedPromiseReaction(edge.toNode);
      }
    });
  } catch {
    return reactionNode;
  }
  return reactionNode;
}

function findReferencedNode(node, fields) {
  let referencedNode = null;
  try {
    node.forEachReference((edge) => {
      if (!referencedNode && fields.includes(edge[fieldKeys.nameOrIndex]) && edge.toNode) {
        referencedNode = edge.toNode;
      }
    });
  } catch {
    return referencedNode;
  }
  return referencedNode;
}

function getPromiseHandleInfo(node) {
  if (!node) {
    return 'unknown_handle';
  }
  const name = String(node.name || '');
  let handlerInfo = /PromiseReaction/i.test(name)
    ? extractPromiseHandlerFromReaction(node)
    : null;
  if (!handlerInfo && (/Promise(Record)?$/i.test(name) || name === 'JSPromise')) {
    handlerInfo = extractPromiseHandlerFromReaction(findPromiseReaction(node));
  }
  if (!handlerInfo && /PromiseCapability/i.test(name)) {
    const innerPromise = findReferencedNode(node, promiseFields);
    handlerInfo = extractPromiseHandlerFromReaction(findPromiseReaction(innerPromise));
  }
  const directHandler = collectPromiseHandlers(node)[0];
  return handlerInfo || directHandler || 'no_handler_info';
}

// =================聚类 Key 生成=================
function generateClusterKey(node, strategy, shortestPath = getShortestPath(node)) {
  const name = node.name;
  const [, pathStrs, distance] = shortestPath;
  const trace = pathStrs.join(' <- ');

  switch (strategy) {
    case clusterStrategy[fieldKeys.shortestPath]:
      return `PATH:${trace}`;

    case clusterStrategy[fieldKeys.nameOnly]:
      return `NAME:${name}`;

    case clusterStrategy[fieldKeys.nameAndPath]:
      return `NAMEPATH:${name}|${trace}`;

    case clusterStrategy[fieldKeys.propsAndPath]: {
      if (distance <= 1) {
        const propSig = getPropertySignature(node);
        return `PROPS:${propSig}`;
      }
      return `PROPPATH:${trace}`;
    }

    case clusterStrategy[fieldKeys.promiseHandle]: {
      const handleInfo = getPromiseHandleInfo(node);
      return `PROMISE:${handleInfo}|${trace}`;
    }

    case clusterStrategy[fieldKeys.noCluster]:
      return `SINGLE:${node.id}`;

    default:
      return `DEFAULT:${trace}`;
  }
}

// =================支配树构建=================
function buildDominatorTree(snapshot) {
  const childrenMap = new Map();
  const nodeCount = snapshot.nodes.length;
  for (let i = 0; i < nodeCount; i++) {
    const node = snapshot.nodes.get(i);
    const parent = node.dominatorNode;
    if (parent && parent.id !== node.id) {
      if (!childrenMap.has(parent.id)) {
        childrenMap.set(parent.id, []);
      }
      childrenMap.get(parent.id).push(node);
    }
  }
  return childrenMap;
}

// =================第一层分组（按目录/Name）=================
function getObjectGroupName(node) {
  let groupName = node?.name || '';
  if (node?.type === 'closure' || node?.type === 'code' || node?.name === '(closure)') {
    groupName = 'Function';
  } else if (node?.type === 'framework') {
    groupName = 'Framework';
  } else if (node?.type === 'string') {
    groupName = 'String';
  }
  return groupName;
}

function getOrCreateDirectoryGroup(groups, groupName) {
  if (!groups.has(groupName)) {
    groups.set(groupName, {
      groupName,
      objectNameVariants: new Set(),
      totalSize: 0,
      count: 0,
      nodes: [],
    });
  }
  return groups.get(groupName);
}

function appendNodeToDirectoryGroup(entry, node, groupName, hasChildren, stackLength, tracking) {
  entry.count++;
  if (tracking.seenClassKeys.has(groupName) || node[fieldKeys.selfSize] <= 0) {
    return;
  }
  entry.totalSize += node.retainedSize;
  entry.nodes.push(node);
  if (!hasChildren) {
    return;
  }
  tracking.seenClassKeys.add(groupName);
  tracking.sizes.push(stackLength);
  tracking.classKeys.push(groupName);
}

function buildDirectoryGroups(snapshot, dominatorChildrenMap) {
  const groups = new Map();
  const rootNode = snapshot.nodes.get(0);
  if (!rootNode) {
    throw new Error('Root node not found.');
  }

  const stack = [rootNode];
  const sizes = [-1];
  const classKeys = [];
  const seenClassKeys = new Set();
  const tracking = { sizes, classKeys, seenClassKeys };

  while (stack.length > 0) {
    const node = stack.pop();
    const children = dominatorChildrenMap.get(node.id) || [];
    if (hasStrongReferencePath(node)) {
      const rawGroupName = getObjectGroupName(node);
      const groupName = isBusinessObject(rawGroupName)
        ? rawGroupName
        : normalizeComparisonObjectName(rawGroupName);
      const entry = getOrCreateDirectoryGroup(groups, groupName);
      entry.objectNameVariants.add(rawGroupName);
      appendNodeToDirectoryGroup(
        entry, node, groupName, children.length > 0, stack.length, tracking,
      );
    }

    for (const child of children) {
      stack.push(child);
    }

    while (sizes.length > 0 && sizes[sizes.length - 1] === stack.length) {
      sizes.pop();
      seenClassKeys.delete(classKeys.pop());
    }
  }

  return groups;
}

function getOrCreateRetainedStats(categoryStats, category, objectName, normalizedObjectName) {
  if (!categoryStats.has(normalizedObjectName)) {
    categoryStats.set(normalizedObjectName, {
      category,
      'object_name': objectName,
      'normalized_object_name': normalizedObjectName,
      count: 0,
      'retained_root_count': 0,
      'total_self_size': 0,
      'total_retained_size': 0,
      'max_retained_size': 0,
      variants: new Map(),
    });
  }
  return categoryStats.get(normalizedObjectName);
}

function getOrCreateRetainedVariant(stats, objectName) {
  if (!stats.variants.has(objectName)) {
    stats.variants.set(objectName, {
      'object_name': objectName,
      count: 0,
      'retained_root_count': 0,
      'total_retained_size': 0,
    });
  }
  return stats.variants.get(objectName);
}

function createRetainedSizeFrame(node, statsByCategory, activeObjectKeys, childrenMap) {
  const children = childrenMap.get(node.id) || [];
  const calculatedRetainedSize = node[fieldKeys.selfSize] || 0;
  if (!hasStrongReferencePath(node)) {
    return {
      node, children, calculatedRetainedSize,
      objectKey: '', stats: null, variant: null,
      nextChildIndex: 0, isTopmostSameNameNode: false,
    };
  }
  const objectName = getObjectGroupName(node);
  const normalizedObjectName = normalizeComparisonObjectName(objectName);
  const category = isBusinessObject(objectName) ? 'business' : 'common';
  const objectKey = `${category}\u0000${normalizedObjectName}`;
  const stats = getOrCreateRetainedStats(
    statsByCategory[category], category, objectName, normalizedObjectName,
  );
  const variant = getOrCreateRetainedVariant(stats, objectName);
  stats.count++;
  stats[fieldKeys.totalSelfSize] += node[fieldKeys.selfSize] || 0;
  variant.count++;
  const isTopmostSameNameNode = !activeObjectKeys.has(objectKey);
  if (isTopmostSameNameNode) {
    activeObjectKeys.add(objectKey);
  }
  return {
    node, children, calculatedRetainedSize,
    objectKey, stats, variant, isTopmostSameNameNode, nextChildIndex: 0,
  };
}

function finishRetainedSizeFrame(frame, stack, activeObjectKeys) {
  if (frame.isTopmostSameNameNode) {
    activeObjectKeys.delete(frame.objectKey);
    if (frame.calculatedRetainedSize > 0) {
      frame.stats[fieldKeys.retainedRootCount]++;
      frame.stats[fieldKeys.totalRetainedSize] += frame.calculatedRetainedSize;
      frame.stats[fieldKeys.maxRetainedSize] = Math.max(
        frame.stats[fieldKeys.maxRetainedSize], frame.calculatedRetainedSize,
      );
      frame.variant[fieldKeys.retainedRootCount]++;
      frame.variant[fieldKeys.totalRetainedSize] += frame.calculatedRetainedSize;
    }
  }
  if (stack.length > 0) {
    stack[stack.length - 1].calculatedRetainedSize += frame.calculatedRetainedSize;
  }
}

function compareRetainedVariants(a, b) {
  const sizeDiff = b[fieldKeys.totalRetainedSize] - a[fieldKeys.totalRetainedSize];
  if (sizeDiff !== 0) {
    return sizeDiff;
  }
  const countDiff = b.count - a.count;
  return countDiff !== 0
    ? countDiff
    : String(a[fieldKeys.objectName]).localeCompare(String(b[fieldKeys.objectName]));
}

function serializeRetainedSizeStats(stats, category) {
  const variants = [...stats.variants.values()].sort(compareRetainedVariants);
  const representativeName = category === 'common'
    ? stats[fieldKeys.normalizedObjectName]
    : (variants[0]?.[fieldKeys.objectName] || stats[fieldKeys.objectName]);
  return {
    category,
    'object_name': representativeName,
    'normalized_object_name': stats[fieldKeys.normalizedObjectName],
    'object_name_variants': variants.map(item => item[fieldKeys.objectName]),
    count: stats.count,
    'retained_root_count': stats[fieldKeys.retainedRootCount],
    'total_self_size': stats[fieldKeys.totalSelfSize],
    'total_self_size_text': formatSize(stats[fieldKeys.totalSelfSize]),
    'total_retained_size': stats[fieldKeys.totalRetainedSize],
    'total_retained_size_text': formatSize(stats[fieldKeys.totalRetainedSize]),
    'max_retained_size': stats[fieldKeys.maxRetainedSize],
    'max_retained_size_text': formatSize(stats[fieldKeys.maxRetainedSize]),
  };
}

function compareSerializedRetainedStats(a, b) {
  const sizeDiff = b[fieldKeys.totalRetainedSize] - a[fieldKeys.totalRetainedSize];
  return sizeDiff !== 0
    ? sizeDiff
    : String(a[fieldKeys.objectName]).localeCompare(String(b[fieldKeys.objectName]));
}

function serializeRetainedSizeCategory(statsByCategory, category) {
  return [...statsByCategory[category].values()]
    .map(stats => serializeRetainedSizeStats(stats, category))
    .sort(compareSerializedRetainedStats)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function recalculateSnapshotObjectRetainedSizes(snapshot, dominatorChildrenMap) {
  const rootNode = snapshot.nodes.get(0);
  if (!rootNode) {
    throw new Error('Root node not found for retained size recalculation.');
  }
  const statsByCategory = { business: new Map(), common: new Map() };
  const activeObjectKeys = new Set();
  const createFrame = node => createRetainedSizeFrame(
    node, statsByCategory, activeObjectKeys, dominatorChildrenMap,
  );
  const stack = [createFrame(rootNode)];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.nextChildIndex < frame.children.length) {
      const child = frame.children[frame.nextChildIndex++];
      stack.push(createFrame(child));
      continue;
    }

    stack.pop();
    finishRetainedSizeFrame(frame, stack, activeObjectKeys);
  }
  return {
    'calculation_method': 'dominator_tree_self_size_postorder_same_name_union',
    business: serializeRetainedSizeCategory(statsByCategory, 'business'),
    common: serializeRetainedSizeCategory(statsByCategory, 'common'),
  };
}

// =================第二层聚类=================
function createUnclusteredResult(groupName, nodes, strategy) {
  const exampleNode = nodes[0];
  return [{
    key: `NO_CLUSTER:${groupName}`,
    strategy,
    count: nodes.length,
    totalRetainedSize: nodes.reduce((sum, node) => sum + (node.retainedSize || 0), 0),
    exampleNode,
    type: exampleNode.type,
    traceStr: '(无需聚类)',
    distance: 0,
    rootType: '',
    rootId: null,
    pathEntries: [{
      nodeId: exampleNode.id,
      name: exampleNode.name,
      retainedSize: exampleNode.retainedSize || 0,
    }],
  }];
}

function createNodeCluster(key, strategy, node, trace, pathInfo) {
  const [distance, rootInfo, pathEntries] = pathInfo;
  return {
    key, strategy, count: 0, totalRetainedSize: 0, exampleNode: node,
    type: node.type, traceStr: trace, distance,
    rootType: rootInfo.rootType, rootId: rootInfo.rootId, pathEntries,
  };
}

function updateNodeCluster(cluster, node, trace, pathInfo) {
  const [distance, rootInfo, pathEntries] = pathInfo;
  cluster.count++;
  cluster.totalRetainedSize += node.retainedSize || 0;
  if ((node.retainedSize || 0) <= (cluster.exampleNode.retainedSize || 0)) {
    return;
  }
  Object.assign(cluster, {
    exampleNode: node,
    traceStr: trace,
    distance,
    rootType: rootInfo.rootType,
    rootId: rootInfo.rootId,
    pathEntries,
  });
}

function clusterNodesInGroup(groupName, nodes) {
  if (nodes.length === 0) {
    return [];
  }
  const strategy = getClusterStrategy(nodes[0]);
  if (strategy === clusterStrategy[fieldKeys.noCluster]) {
    return createUnclusteredResult(groupName, nodes, strategy);
  }
  const clusterMap = new Map();
  for (const node of nodes) {
    const shortestPath = getShortestPath(node);
    const [, pathStrs, distance, rootInfo, pathEntries] = shortestPath;
    const key = generateClusterKey(node, strategy, shortestPath);
    const trace = pathStrs.join(' <- ');
    if (!clusterMap.has(key)) {
      clusterMap.set(
        key,
        createNodeCluster(key, strategy, node, trace, [distance, rootInfo, pathEntries]),
      );
    }
    const cluster = clusterMap.get(key);
    updateNodeCluster(cluster, node, trace, [distance, rootInfo, pathEntries]);
  }
  return Array.from(clusterMap.values());
}

// =================第一次目录内路径合并（保留原逻辑）=================
function useLargerSimilarPath(parent, child) {
  if (child.totalRetainedSize <= parent.totalRetainedSize) {
    return;
  }
  Object.assign(parent, {
    totalRetainedSize: child.totalRetainedSize,
    traceStr: child.traceStr,
    key: child.key,
    exampleNode: child.exampleNode,
    type: child.type,
    distance: child.distance,
    rootType: child.rootType,
    rootId: child.rootId,
    pathEntries: child.pathEntries,
  });
}

function mergeSimilarPathChildren(clusters, startIndex, parent, used) {
  let mergeCount = 0;
  for (let index = startIndex + 1; index < clusters.length; index++) {
    if (used.has(index)) {
      continue;
    }
    const child = clusters[index];
    if (!isTraceMergeable(parent.traceStr, child.traceStr)) {
      continue;
    }
    parent.count += child.count;
    useLargerSimilarPath(parent, child);
    used.add(index);
    mergeCount++;
  }
  return mergeCount;
}

function mergeSimilarPaths(clusters) {
  const merged = [];
  const used = new Set();
  for (let index = 0; index < clusters.length; index++) {
    if (used.has(index)) {
      continue;
    }
    const parent = { ...clusters[index] };
    parent.mergedCount = mergeSimilarPathChildren(clusters, index, parent, used);
    merged.push(parent);
    used.add(index);
  }
  return merged.sort((a, b) => b.totalRetainedSize - a.totalRetainedSize);
}

// =================第二次全局聚类辅助=================
function getTraceDepth(traceStr) {
  if (!traceStr || traceStr === '(无需聚类)') {
    return 0;
  }
  return traceStr.split(' <- ').length;
}

function isTraceMergeable(a, b) {
  if (!a || !b) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * 第二次全局合并:
 * - count 累加
 * - totalRetainedSize 保留最大
 * - traceStr / pathEntries 保留最长引用链对应的那条
 */
function compareClustersForPathMerge(a, b) {
  const sizeDiff = (b.totalRetainedSize || 0) - (a.totalRetainedSize || 0);
  return sizeDiff !== 0
    ? sizeDiff
    : getTraceDepth(b.traceStr) - getTraceDepth(a.traceStr);
}

function createLongestPathParent(base) {
  return {
    ...base,
    count: base.count || 0,
    totalRetainedSize: base.totalRetainedSize || 0,
    traceStr: base.traceStr || '',
    distance: base.distance || getTraceDepth(base.traceStr),
    exampleNode: base.exampleNode,
    mergedCount: 0,
    groupNames: new Set([base.groupName]),
    strategies: new Set([base.strategy]),
    rootType: base.rootType || '',
    rootId: base.rootId ?? null,
    pathEntries: Array.isArray(base.pathEntries) ? base.pathEntries : [],
  };
}

function shouldUseChildTrace(parent, child, childDepth) {
  const parentDepth = getTraceDepth(parent.traceStr);
  return childDepth > parentDepth || (
    childDepth === parentDepth &&
    (child.traceStr || '').length > (parent.traceStr || '').length
  );
}

function mergeLongestPathChild(parent, child) {
  parent.count += child.count || 0;
  if ((child.totalRetainedSize || 0) > (parent.totalRetainedSize || 0)) {
    Object.assign(parent, {
      totalRetainedSize: child.totalRetainedSize || 0,
      exampleNode: child.exampleNode,
      type: child.type,
      key: child.key,
    });
  }
  const childDepth = getTraceDepth(child.traceStr);
  if (shouldUseChildTrace(parent, child, childDepth)) {
    Object.assign(parent, {
      traceStr: child.traceStr,
      distance: child.distance || childDepth,
      rootType: child.rootType || '',
      rootId: child.rootId ?? null,
      pathEntries: Array.isArray(child.pathEntries) ? child.pathEntries : [],
    });
  }
  parent.groupNames.add(child.groupName);
  parent.strategies.add(child.strategy);
  parent.mergedCount++;
}

function mergeLongestPathChildren(sorted, startIndex, parent, used) {
  for (let index = startIndex + 1; index < sorted.length; index++) {
    if (used.has(index)) {
      continue;
    }
    const child = sorted[index];
    if (!isTraceMergeable(parent.traceStr, child.traceStr)) {
      continue;
    }
    mergeLongestPathChild(parent, child);
    used.add(index);
  }
}

function finalizeLongestPathParent(parent) {
  return {
    ...parent,
    groupNames: Array.from(parent.groupNames),
    strategies: Array.from(parent.strategies),
  };
}

function mergeSimilarPathsKeepLongestAndMax(clusters) {
  const merged = [];
  const used = new Set();
  const sorted = [...clusters].sort(compareClustersForPathMerge);
  for (let index = 0; index < sorted.length; index++) {
    if (used.has(index)) {
      continue;
    }
    const parent = createLongestPathParent(sorted[index]);
    mergeLongestPathChildren(sorted, index, parent, used);
    merged.push(finalizeLongestPathParent(parent));
    used.add(index);
  }
  return merged.sort((a, b) => (b.totalRetainedSize || 0) - (a.totalRetainedSize || 0));
}

// =================展示辅助=================
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function percentOf(part, total) {
  return ((part / total) * 100).toFixed(1);
}

/**
 * 第二次全局聚类只基于这批目录级筛选结果
 * 对应原先“第一次会展示的那部分”
 */
function getDisplayedSubsForGroup(group, mergedSubs) {
  return mergedSubs.filter(sub => {
    return parseFloat(percentOf(sub.totalRetainedSize, group.totalSize)) >= 2;
  });
}

function buildBizAndCommonCandidates(clusterResults) {
  const businessSubs = [];
  const commonSubs = [];

  for (const { group, strategy, mergedSubs } of clusterResults) {
    const isApp = group.isApp || isBusinessObject(group.groupName);
    const displayedSubs = getDisplayedSubsForGroup(group, mergedSubs);

    for (const sub of displayedSubs) {
      const item = {
        ...sub,
        groupName: group.groupName,
        strategy,
        isApp,
      };

      if (isApp) {
        businessSubs.push(item);
      } else {
        commonSubs.push(item);
      }
    }
  }

  const businessCandidates = mergeSimilarPathsKeepLongestAndMax(businessSubs);
  const commonCandidates = mergeSimilarPathsKeepLongestAndMax(commonSubs);

  return { businessCandidates, commonCandidates };
}

function buildBizAndCommonTop5(clusterResults, topCount = 5) {
  const { businessCandidates, commonCandidates } = buildBizAndCommonCandidates(clusterResults);

  return {
    businessCandidates,
    commonCandidates,
    businessTop5: businessCandidates.slice(0, topCount),
    commonTop5: commonCandidates.slice(0, topCount),
  };
}

function normalizeJsonNodeId(value) {
  if (value == null) {
    return null;
  }
  return String(value);
}

function serializePathEntry(entry, idx, lastIdx) {
  const retainedSize = entry?.retainedSize || 0;
  const displayedDistance = lastIdx - idx;
  return {
    'node_id': normalizeJsonNodeId(entry?.nodeId),
    name: entry?.name || '',
    'retained_size': retainedSize,
    'retained_size_text': formatSize(retainedSize),
    distance: displayedDistance,
    'raw_distance': Number.isFinite(entry?.distance) ? entry.distance : idx,
  };
}

function serializeClusterItem(item, category, rank, totalHeapSize) {
  const retainedSize = item?.totalRetainedSize || 0;
  const rawPathEntries = Array.isArray(item?.pathEntries) ? item.pathEntries : [];
  const lastIdx = rawPathEntries.length - 1;
  const pathEntries = rawPathEntries.map((entry, idx) =>
    serializePathEntry(entry, idx, lastIdx),
  );

  return {
    rank,
    category,
    key: item?.key || '',
    strategy: item?.strategy || '',
    strategies: Array.isArray(item?.strategies) ? item.strategies : [],
    'group_names': Array.isArray(item?.groupNames)
      ? item.groupNames
      : (item?.groupName ? [item.groupName] : []),
    count: item?.count || 0,
    'total_retained_size': retainedSize,
    'total_retained_size_text': formatSize(retainedSize),
    'heap_percent': percentOf(retainedSize, totalHeapSize),
    distance: item?.distance ?? null,
    'root_type': item?.rootType || '',
    'root_id': normalizeJsonNodeId(item?.rootId),
    'path_entries': pathEntries,
    'distance0_entries': pathEntries.filter(entry => entry.distance === 0 && entry[fieldKeys.nodeId] != null),
  };
}

function serializeObjectCandidateGroup(group, mergedSubs, totalHeapSize) {
  const isApp = Boolean(group.isApp) || isBusinessObject(group.groupName || '');
  const category = isApp ? 'business' : 'common';
  const retainedSize = group.totalSize || 0;
  const weight = group.weight || (isApp ? appObjectWeight : 1);
  const weightedSize = group.weightedSize || retainedSize * weight;
  const chains = (Array.isArray(mergedSubs) ? mergedSubs : []).map((item, index) =>
    serializeClusterItem(
      { ...item, groupName: group.groupName }, category, index + 1, totalHeapSize,
    ));
  return {
    'object_name': group.groupName || '',
    'normalized_object_name': normalizeComparisonObjectName(group.groupName || ''),
    'object_name_variants': [...(group.objectNameVariants || [group.groupName])]
      .filter(Boolean).sort(),
    category,
    count: group.count || 0,
    'total_retained_size': retainedSize,
    'total_retained_size_text': formatSize(retainedSize),
    'heap_percent': totalHeapSize > 0 ? percentOf(retainedSize, totalHeapSize) : '0.0',
    weight,
    'weighted_size': weightedSize,
    'weighted_size_text': formatSize(weightedSize),
    'chain_count': chains.length,
    chains,
  };
}

function compareSerializedObjectCandidate(a, b) {
  const sizeDiff = (b[fieldKeys.totalRetainedSize] || 0) - (a[fieldKeys.totalRetainedSize] || 0);
  return sizeDiff !== 0
    ? sizeDiff
    : String(a[fieldKeys.objectName]).localeCompare(String(b[fieldKeys.objectName]));
}

function rankSerializedObjectCandidates(items) {
  return items.sort(compareSerializedObjectCandidate)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function buildSerializedObjectCandidates(clusterResults, totalHeapSize) {
  const byCategory = { business: [], common: [] };
  for (const { group, mergedSubs } of clusterResults) {
    const candidate = serializeObjectCandidateGroup(group, mergedSubs, totalHeapSize);
    byCategory[candidate.category].push(candidate);
  }
  byCategory.business = rankSerializedObjectCandidates(byCategory.business);
  byCategory.common = rankSerializedObjectCandidates(byCategory.common);
  return byCategory;
}

function serializeFilteredGroup(group) {
  return {
    'group_name': group.groupName,
    'object_name_variants': [...(group.objectNameVariants || [group.groupName])]
      .filter(Boolean).sort(),
    count: group.count,
    'total_size': group.totalSize,
    'total_size_text': formatSize(group.totalSize || 0),
    weight: group.weight,
    'weighted_size': group.weightedSize,
    'weighted_size_text': formatSize(group.weightedSize || 0),
    'is_app': Boolean(group.isApp),
  };
}

function serializeCandidateList(items, category, totalHeapSize) {
  return items.map((item, index) =>
    serializeClusterItem(item, category, index + 1, totalHeapSize));
}

function buildClusterJson(
  filePath,
  totalHeapSize,
  thresholdSize,
  filteredGroups,
  clusterResults,
  businessTop5 = [],
  commonTop5 = [],
  businessCandidates = [],
  commonCandidates = [],
  topCount = 5,
) {
  const objectCandidates = buildSerializedObjectCandidates(clusterResults, totalHeapSize);
  return {
    metadata: {
      snapshot: path.resolve(filePath),
      'generated_at': new Date().toISOString(),
      'total_heap_size': totalHeapSize,
      'total_heap_size_text': formatSize(totalHeapSize),
      'threshold_size': thresholdSize,
      'threshold_size_text': formatSize(thresholdSize),
      'filtered_group_count': filteredGroups.length,
      'cluster_group_count': clusterResults.length,
      'top_count': topCount,
    },
    'filtered_groups': filteredGroups.map(serializeFilteredGroup),
    'business_top5': serializeCandidateList(businessTop5, 'business', totalHeapSize),
    'common_top5': serializeCandidateList(commonTop5, 'common', totalHeapSize),
    'business_candidates': serializeCandidateList(businessCandidates, 'business', totalHeapSize),
    'common_candidates': serializeCandidateList(commonCandidates, 'common', totalHeapSize),
    'business_object_candidates': objectCandidates.business,
    'common_object_candidates': objectCandidates.common,
  };
}

function wrapText(text, maxWidth = 78) {
  const s = String(text || '');
  if (s.length <= maxWidth) {
    return [s];
  }

  const parts = s.split(', ');
  const lines = [];
  let current = '';

  for (const part of parts) {
    const next = current ? `${current}, ${part}` : part;
    if (next.length <= maxWidth) {
      current = next;
    } else {
      if (current) {
        lines.push(current);
      }
      current = part;
    }
  }

  if (current) {
    lines.push(current);
  }
  return lines;
}

function appendWrappedField(outputLines, label, value, indent = '     ', maxWidth = 72) {
  const prefix = `${indent}${label}: `;
  const lines = wrapText(value, maxWidth);

  lines.forEach((line, idx) => {
    if (idx === 0) {
      outputLines.push(`${prefix}${line}`);
    } else {
      outputLines.push(`${' '.repeat(prefix.length)}${line}`);
    }
  });
}

function formatDistanceWithRoot(distance, rootType) {
  return rootType
    ? `${distance}  根节点类型: ${rootType}`
    : `${distance}`;
}

function appendPathEntries(lines, pathEntries, rootType = '') {
  if (!Array.isArray(pathEntries) || pathEntries.length === 0) {
    return;
  }

  const lastIdx = pathEntries.length - 1;

  pathEntries.forEach((entry, idx) => {
    const isLast = idx === lastIdx;
    const nodeDistance = lastIdx - idx;
    const suffix = isLast && rootType ? ' (GC Root)' : '';
    const line = `${entry.name} [${formatSize(entry.retainedSize || 0)}] Distance ${nodeDistance}${suffix}`;

    if (idx === 0) {
      lines.push(`       ⬤ ${line}`);
    } else if (isLast) {
      lines.push(`       └▶ ${line}`);
    } else {
      lines.push(`       ├▶ ${line}`);
    }
  });
}

function appendTopBucketSection(lines, title, items, totalHeapSize) {
  lines.push(`  ${title}`);
  lines.push('');

  if (!items || items.length === 0) {
    lines.push('    (无结果)');
    lines.push('');
    return;
  }

  items.forEach((item, idx) => {
    const rank = `#${idx + 1}`;
    const sizeText = formatSize(item.totalRetainedSize);
    const heapPct = percentOf(item.totalRetainedSize, totalHeapSize);
    const countText = item.count.toLocaleString();
    const distanceText = formatDistanceWithRoot(item.distance, item.rootType);
    const sourceText = item.groupNames.join(', ');

    lines.push(`    [${rank}] ${sizeText} (${heapPct}%)  数量: ${countText}  Distance: ${distanceText}`);
    appendWrappedField(lines, '来源目录', sourceText, '     ', 60);
    lines.push('     引用链:');
    appendPathEntries(lines, item.pathEntries, item.rootType);
    lines.push('');
  });
}

function generateReport(
  filePath,
  totalHeapSize,
  thresholdSize,
  filteredGroups,
  clusterResults,
  businessTop5 = [],
  commonTop5 = [],
  topCount = 5,
) {
  const lines = [];
  const fileName = path.basename(filePath);
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  lines.push('╔══════════════════════════════════════════════╗');
  lines.push('║                内存聚类分析报告              ║');
  lines.push('╚══════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`快照文件   : ${fileName}`);
  lines.push(`分析时间   : ${now}`);
  lines.push(`堆总大小   : ${formatSize(totalHeapSize)}`);


  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  一、全局聚类结果');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  appendTopBucketSection(lines, `业务对象 Top${topCount}`, businessTop5, totalHeapSize);
  appendTopBucketSection(lines, `公共对象 Top${topCount}`, commonTop5, totalHeapSize);

  lines.push('');

  return lines.join('\n');
}

// =================对象名称规范化=================

function normalizeObfuscatedFunctionName(value) {
  return String(value || '').replace(
    /#([A-Za-z_$]\d+)(?=\(line:\d+\))/g,
    '#<obfuscated>',
  );
}

function normalizeDependencyPackageVersion(value) {
  return String(value || '').replace(
    /\/([^/@]+)@\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?=\/)/g,
    '/$1@<version>',
  );
}

let publicObjectCanonicalNames = null;

const publicObjectIdentifierPatterns = [
  /^js_([A-Za-z0-9_]+)$/i,
  /^js([A-Z][A-Za-z0-9_]*)$/,
  /^js([a-z0-9]{3,})$/,
  /^JS([A-Z][a-z][A-Za-z0-9_]*)$/,
];

function findPublicObjectIdentifierBase(identifier) {
  for (const pattern of publicObjectIdentifierPatterns) {
    const match = identifier.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return '';
}

function parsePublicObjectIdentifier(value, allowBareProxy = false) {
  const identifier = String(value || '');
  const matchedBase = findPublicObjectIdentifierBase(identifier);
  const base = matchedBase || (allowBareProxy && /^proxy$/i.test(identifier) ? 'proxy' : '');
  const signature = base.replace(/_/g, '').toLowerCase();
  return signature ? { base, signature } : null;
}

function toPreferredPublicObjectName(base) {
  const words = String(base || '').split('_').filter(Boolean);
  if (words.length > 1) {
    return `JS${words.map(word =>
      `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`).join('')}`;
  }
  const compact = words[0] || '';
  return compact ? `JS${compact.charAt(0).toUpperCase()}${compact.slice(1)}` : '';
}

function getPublicObjectCanonicalNames() {
  if (publicObjectCanonicalNames) {
    return publicObjectCanonicalNames;
  }

  publicObjectCanonicalNames = new Map();
  for (const name of systemGroupNames) {
    const parsed = parsePublicObjectIdentifier(name) || (
      /^[A-Za-z][A-Za-z0-9_]*$/.test(name)
        ? { base: name, signature: name.replace(/_/g, '').toLowerCase() }
        : null
    );
    if (!parsed || publicObjectCanonicalNames.has(parsed.signature)) {
      continue;
    }
    publicObjectCanonicalNames.set(
      parsed.signature,
      toPreferredPublicObjectName(parsed.base),
    );
  }
  return publicObjectCanonicalNames;
}

function canonicalizePublicObjectIdentifier(value, allowBareProxy = false) {
  const parsed = parsePublicObjectIdentifier(value, allowBareProxy);
  if (!parsed) {
    return String(value || '');
  }

  const knownName = getPublicObjectCanonicalNames().get(parsed.signature);
  if (knownName) {
    return knownName;
  }
  return `JS${parsed.signature.charAt(0).toUpperCase()}${parsed.signature.slice(1)}`;
}

function normalizeHeapBaseObjectAliases(value) {
  const text = String(value || '');
  const simplePublicName = text.match(/^([A-Za-z][A-Za-z0-9_]*)(-.+)?$/);
  if (simplePublicName && !isBusinessObject(text)) {
    const head = simplePublicName[1];
    const normalizedHead = canonicalizePublicObjectIdentifier(head, /^proxy$/i.test(head));
    if (normalizedHead !== head) {
      return `${normalizedHead}${simplePublicName[2] || ''}`;
    }
  }

  return text
    .replace(
      /(^|[^A-Za-z0-9_$])(js_[A-Za-z0-9_]+|JS[A-Z][a-z][A-Za-z0-9_]*)(?=$|[^A-Za-z0-9_$])/g,
      (ignoredMatch, prefix, identifier) =>
        `${prefix}${canonicalizePublicObjectIdentifier(identifier)}`,
    )
    .replace(
      /#(js[A-Za-z0-9_]+)(?=\(line:\d+\)|\[entry\]|$)/g,
      (ignoredMatch, identifier) => `#${canonicalizePublicObjectIdentifier(identifier)}`,
    );
}

function normalizeComparisonObjectName(value) {
  const sourceNormalizedName = normalizeObfuscatedFunctionName(
    normalizeDependencyPackageVersion(value),
  );
  return normalizeHeapBaseObjectAliases(sourceNormalizedName);
}

// =================快照清洗=================
function parseSnapshotForSanitize(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn(`[Sanitize] 无法解析为 JSON，跳过清洗: ${e.message}`);
    return null;
  }
}

function getSnapshotSanitizeMetadata(data) {
  if (!data?.snapshot?.meta || !Array.isArray(data.edges) || !Array.isArray(data.nodes)) {
    console.warn('[Sanitize] 快照结构不符合预期，跳过清洗');
    return null;
  }
  const meta = data.snapshot.meta;
  const nodeFieldCount = meta[fieldKeys.nodeFields]?.length || 0;
  const edgeFieldCount = meta[fieldKeys.edgeFields]?.length || 0;
  if (nodeFieldCount === 0 || edgeFieldCount === 0) {
    console.warn('[Sanitize] meta 字段缺失，跳过清洗');
    return null;
  }
  const toNodeOffset = meta[fieldKeys.edgeFields].indexOf('to_node');
  if (toNodeOffset < 0) {
    console.warn('[Sanitize] 未找到 to_node 字段，跳过清洗');
    return null;
  }
  return {
    nodeFieldCount,
    edgeFieldCount,
    edgeCount: data.snapshot[fieldKeys.edgeCount] || (data.edges.length / edgeFieldCount),
    nodeArrayLength: data.nodes.length,
    toNodeOffset,
  };
}

function repairInvalidSnapshotEdges(data, metadata) {
  let fixedCount = 0;
  let nullToNode = 0;
  for (let index = 0; index < metadata.edgeCount; index++) {
    const base = index * metadata.edgeFieldCount;
    const toNode = data.edges[base + metadata.toNodeOffset];
    if (
      typeof toNode !== 'number' ||
      toNode < 0 ||
      toNode >= metadata.nodeArrayLength ||
      toNode % metadata.nodeFieldCount !== 0
    ) {
      data.edges[base + metadata.toNodeOffset] = 0;
      if (toNode == null) {
        nullToNode++;
      }
      fixedCount++;
    }
  }
  return { fixedCount, nullToNode };
}

async function sanitizeSnapshot(filePath) {
  console.log('[Sanitize] 开始扫描快照文件以修复无效 edges...');
  const text = await fs.readFile(filePath, 'utf-8');
  const data = parseSnapshotForSanitize(text);
  const metadata = data ? getSnapshotSanitizeMetadata(data) : null;
  if (!data || !metadata) {
    return filePath;
  }
  const { fixedCount, nullToNode } = repairInvalidSnapshotEdges(data, metadata);
  if (fixedCount === 0) {
    console.log('[Sanitize] 未发现非法 edge，使用原文件');
    return filePath;
  }

  console.log(`[Sanitize] 发现 ${fixedCount} 条非法 edge (其中 null=${nullToNode})，已修复`);

  const parsed = path.parse(filePath);
  const fixedPath = path.join(parsed.dir, `${parsed.name}.fixed${parsed.ext}`);
  await fs.writeFile(fixedPath, JSON.stringify(data), 'utf-8');
  console.log(`[Sanitize] 修复后的文件已保存: ${fixedPath}`);
  return fixedPath;
}

// =================核心分析流程=================
function isRecoverableHeapLoadError(error) {
  const message = String(error?.message || error);
  return message.includes('Cannot read properties of null') ||
    message.includes('Cannot read property') ||
    message.includes('TraceFinder');
}

async function recoverHeapGraph(absPath, error) {
  const message = String(error?.message || error);
  if (!isRecoverableHeapLoadError(error)) {
    throw error;
  }
  console.warn(`\n[Recovery] memlab 加载失败: ${message}`);
  console.warn('[Recovery] 检测到典型的非法 edge 错误，开始尝试清洗快照后重试...\n');
  const fixedPath = await sanitizeSnapshot(absPath);
  if (fixedPath === absPath) {
    throw error;
  }
  const graph = await getFullHeapFromFile(fixedPath);
  console.log(`[Recovery] 清洗后加载成功，使用文件: ${fixedPath}\n`);
  return { graph, absPath: fixedPath };
}

async function loadHeapGraphWithRecovery(snapshotFilePath) {
  const absPath = path.resolve(snapshotFilePath);
  try {
    return { graph: await getFullHeapFromFile(absPath), absPath };
  } catch (error) {
    return recoverHeapGraph(absPath, error);
  }
}

function calculateTotalHeapSize(graph) {
  let totalHeapSize = 0;
  graph.nodes.forEach(node => {
    totalHeapSize += node[fieldKeys.selfSize] || 0;
  });
  return totalHeapSize;
}

function selectWeightedHeapGroups(directoryGroups, thresholdSize) {
  const groups = Array.from(directoryGroups.values()).map(group => {
    const weight = getGroupWeight(group.groupName);
    return { ...group, weight, weightedSize: group.totalSize * weight, isApp: weight > 1 };
  });
  const skipDirectories = new Set(['tagged_array', 'lexical_env']);
  return groups.sort((a, b) => b.weightedSize - a.weightedSize)
    .slice(0, 20)
    .filter(group => group.weightedSize > thresholdSize)
    .filter(group => !skipDirectories.has(group.groupName));
}

function buildHeapClusterResults(filteredGroups) {
  return filteredGroups.map(group => {
    const strategy = group.nodes.length > 0
      ? getClusterStrategy(group.nodes[0])
      : clusterStrategy[fieldKeys.shortestPath];
    const topClusters = clusterNodesInGroup(group.groupName, group.nodes)
      .sort((a, b) => b.totalRetainedSize - a.totalRetainedSize)
      .slice(0, 20);
    return { group, strategy, mergedSubs: mergeSimilarPaths(topClusters).slice(0, 5) };
  });
}

function buildEmptyClusteringResult(context) {
  const {
    snapshotFilePath, totalHeapSize, thresholdSize, filteredGroups, topCount,
  } = context;
  return {
    report: '',
    recalculatedObjectStats: context.recalculatedObjectStats,
    clusterJson: buildClusterJson(
      snapshotFilePath, totalHeapSize, thresholdSize, filteredGroups,
      [], [], [], [], [], topCount,
    ),
  };
}

function buildSuccessfulClusteringResult(context, clusterResults) {
  const {
    businessCandidates, commonCandidates, businessTop5, commonTop5,
  } = buildBizAndCommonTop5(clusterResults, context.topCount);
  const args = [
    context.snapshotFilePath, context.totalHeapSize, context.thresholdSize,
    context.filteredGroups, clusterResults, businessTop5, commonTop5,
  ];
  const report = generateReport(...args, context.topCount);
  const clusterJson = buildClusterJson(
    ...args, businessCandidates, commonCandidates, context.topCount,
  );
  console.log(report);
  return { report, clusterJson, recalculatedObjectStats: context.recalculatedObjectStats };
}

async function runClustering(snapshotFilePath, options = {}) {
  try {
    const { graph } = await loadHeapGraphWithRecovery(snapshotFilePath);
    annotateStrongReferencePaths(graph);
    const totalHeapSize = calculateTotalHeapSize(graph);
    const thresholdSize = totalHeapSize * 0.05;
    console.log(`[Stats] Total: ${(totalHeapSize / 1024 / 1024).toFixed(2)} MB, Threshold (5%): ${(thresholdSize / 1024 / 1024).toFixed(2)} MB`);
    const dominatorChildrenMap = buildDominatorTree(graph);
    const recalculatedObjectStats = options.recalculateObjectRetainedSizes
      ? recalculateSnapshotObjectRetainedSizes(graph, dominatorChildrenMap)
      : null;
    const directoryGroups = buildDirectoryGroups(graph, dominatorChildrenMap);
    const filteredGroups = selectWeightedHeapGroups(directoryGroups, thresholdSize);
    const context = {
      snapshotFilePath,
      totalHeapSize,
      thresholdSize,
      filteredGroups,
      recalculatedObjectStats,
      topCount: options.topCount || 5,
    };
    if (filteredGroups.length === 0) {
      return buildEmptyClusteringResult(context);
    }
    console.log('');
    return buildSuccessfulClusteringResult(context, buildHeapClusterResults(filteredGroups));
  } catch (error) {
    console.error('Fatal Error:', error);
    return { report: '', clusterJson: null, recalculatedObjectStats: null };
  }
}

export {
  annotateStrongReferencePaths, appObjectWeight, appendPathEntries, appendTopBucketSection, appendWrappedField,
  buildBizAndCommonCandidates,
  buildBizAndCommonTop5, buildClusterJson, buildDirectoryGroups, buildDominatorTree, buildEmptyClusteringResult,
  buildHandleRootInfo, buildHeapClusterResults, buildSerializedObjectCandidates, buildSuccessfulClusteringResult, calculateTotalHeapSize,
  canonicalizePublicObjectIdentifier, clusterNodesInGroup, clusterStrategy, collectPromiseHandlers, compareClustersForPathMerge,
  compareRetainedVariants, compareSerializedObjectCandidate, compareSerializedRetainedStats, createLongestPathParent, createNodeCluster,
  createRetainedSizeFrame, createUnclusteredResult, escapeHtml, extractPromiseHandlerFromReaction, finalizeLongestPathParent, findNestedPromiseReaction,
  findPromiseReaction, findPublicObjectIdentifierBase, findReferencedNode, finishRetainedSizeFrame, formatDistanceWithRoot,
  formatPromiseHandler, formatSize, generateClusterKey, generateReport, getClusterStrategy,
  getDisplayedSubsForGroup, getFullHeapFromFile, getGroupWeight, getHandleRootType, getObjectGroupName,
  getOrCreateRetainedStats, getOrCreateRetainedVariant, getPromiseHandleInfo, getPromiseHandlerScore, getPropertySignature,
  getPublicObjectCanonicalNames, getShortestPath, getSnapshotSanitizeMetadata, getTraceDepth, hasStrongReferencePath,
  isBusinessObject, isHandleRootType, isPromiseLikeName, isRecoverableHeapLoadError,
  isSyntheticRoot, isTraceMergeable, isWeakReferenceContainerName,
  loadHeapGraphWithRecovery, mergeLongestPathChild, mergeLongestPathChildren, mergeSimilarPathChildren, mergeSimilarPaths,
  mergeSimilarPathsKeepLongestAndMax, normalizeComparisonObjectName, normalizeDependencyPackageVersion, normalizeHeapBaseObjectAliases, normalizeJsonNodeId,
  normalizeObfuscatedFunctionName, parsePublicObjectIdentifier, parseSnapshotForSanitize, percentOf, promiseFields,
  promiseHandlerFields, promiseReactionFields, publicObjectCanonicalNames, publicObjectIdentifierPatterns, rankSerializedObjectCandidates,
  recalculateSnapshotObjectRetainedSizes, recoverHeapGraph, repairInvalidSnapshotEdges, runClustering, sanitizeSnapshot,
  selectWeightedHeapGroups, serializeCandidateList, serializeClusterItem, serializeFilteredGroup,
  serializeObjectCandidateGroup, shouldTraverseStrongReferenceEdge,
  serializePathEntry, serializeRetainedSizeCategory, serializeRetainedSizeStats, shouldUseChildTrace, systemGroupNames,
  toPreferredPublicObjectName, updateNodeCluster, useLargerSimilarPath, wrapText,
};
