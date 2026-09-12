import path from 'path';
import fs from 'fs/promises';

const defaultInput = '';

// 用法:
//   node heap_cluster.js                           → 扫描当前目录下所有 .heapsnapshot
//   node heap_cluster.js ./snapshot.heapsnapshot   → 分析单个文件
//   node heap_cluster.js --top 20 ./snapshot.heapsnapshot ./out
//   node heap_cluster.js ./snapshots/              → 扫描目录下所有 .heapsnapshot
//   node heap_cluster.js --multi ./snapshots/ ./out
//   node heap_cluster.js --compare ./old-version/ ./new-version/ ./compare-out
//   node heap_cluster.js --compare-experimental ./old-version/ ./new-version/ ./compare-out
import { runClustering } from './lib/heap-cluster-core.js';
import { buildMultiSnapshotReport, renderMultiSnapshotHtml, renderMultiSnapshotMarkdown, renderSingleSnapshotHtml } from './lib/heap-cluster-multi.js';
import { renderExperimentalVersionComparisonMarkdown, renderVersionComparisonHtml, renderVersionComparisonMarkdown } from './lib/heap-cluster-render.js';
import { buildExperimentalVersionComparisonReport, buildVersionComparisonReport } from './lib/heap-cluster-version.js';

// =================文件处理=================
async function processOneFile(inputFilePath, outputDir, options = {}) {
  try {
    console.log(`\n================ 开始处理: ${inputFilePath} ================`);

    const snapshotPath = inputFilePath;

    const clustering = await runClustering(snapshotPath, options);
    const report = typeof clustering === 'string' ? clustering : (clustering?.report ?? '');
    const clusterJson = typeof clustering === 'object' ? clustering.clusterJson : null;

    const outDir = outputDir || path.dirname(inputFilePath);
    const baseName = path.parse(inputFilePath).name;
    const outputPath = path.join(outDir, `${baseName}.md`);
    const htmlPath = path.join(outDir, `${baseName}.html`);
    const clusterJsonPath = path.join(outDir, `${baseName}.clusters.json`);

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(outputPath, `\uFEFF${report ?? ''}`, 'utf-8');
    if (clusterJson) {
      await fs.writeFile(htmlPath, renderSingleSnapshotHtml(clusterJson), 'utf-8');
      await fs.writeFile(clusterJsonPath, `${JSON.stringify(clusterJson, null, 2)}\n`, 'utf-8');
    }

    console.log(`✅ 处理完成: ${inputFilePath}`);
    console.log(`📄 报告已保存: ${outputPath}`);
    if (clusterJson) {
      console.log(`HTML report saved: ${htmlPath}`);
      console.log(`Cluster JSON saved: ${clusterJsonPath}`);
    }
    return {
      snapshotPath: path.resolve(snapshotPath),
      reportPath: outputPath,
      htmlReportPath: clusterJson ? htmlPath : null,
      clusterJsonPath: clusterJson ? clusterJsonPath : null,
      clusterJson,
      recalculatedObjectStats: typeof clustering === 'object'
        ? clustering.recalculatedObjectStats
        : null,
    };
  } catch (err) {
    console.error(`❌ 处理失败: ${inputFilePath}`, err);
    return null;
  }
}

async function listSnapshotFiles(dirPath) {
  const files = await fs.readdir(dirPath);
  return files
    .filter(file => file.endsWith('.heapsnapshot'))
    .sort((a, b) => a.localeCompare(b))
    .map(file => path.join(dirPath, file));
}

async function processDirectory(dirPath, outputDir, options = {}) {
  const targetFiles = await listSnapshotFiles(dirPath);

  if (targetFiles.length === 0) {
    console.log('⚠️ 当前文件夹下没有找到 .heapsnapshot 文件');
    return;
  }

  console.log(`共找到 ${targetFiles.length} 个文件，开始串行处理...\n`);

  for (const filePath of targetFiles) {
    await processOneFile(filePath, outputDir, options);
  }

  console.log('\n🎉 所有文件处理完成');
}

async function processDirectoryMulti(dirPath, outputDir, options = {}) {
  const outDir = outputDir || dirPath;
  const multiTop = options.multiTop || 20;
  const targetFiles = await listSnapshotFiles(dirPath);

  if (targetFiles.length === 0) {
    console.log('⚠️ 当前文件夹下没有找到 .heapsnapshot 文件');
    return null;
  }

  console.log(`共找到 ${targetFiles.length} 个文件，开始多快照串行处理...\n`);

  const successfulSnapshots = [];
  const failedSnapshots = [];

  for (const filePath of targetFiles) {
    const result = await processOneFile(filePath, outDir, {
      recalculateObjectRetainedSizes: Boolean(options.recalculateObjectRetainedSizes),
      topCount: options.topCount,
    });
    if (result?.clusterJson) {
      successfulSnapshots.push(result);
    } else {
      failedSnapshots.push({
        snapshot: path.resolve(filePath),
        error: result ? 'cluster_json_missing' : 'process_failed',
      });
    }
  }

  if (successfulSnapshots.length === 0) {
    console.log('\n⚠️ 没有成功生成 cluster JSON 的快照，跳过多快照总榜');
    return null;
  }

  const multiReport = buildMultiSnapshotReport(dirPath, outDir, successfulSnapshots, failedSnapshots, multiTop);
  const markdown = renderMultiSnapshotMarkdown(multiReport);
  const html = renderMultiSnapshotHtml(multiReport);
  const markdownPath = path.join(outDir, 'multi-snapshot-clusters.md');
  const htmlPath = path.join(outDir, 'multi-snapshot-clusters.html');
  const jsonPath = path.join(outDir, 'multi-snapshot-clusters.json');

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(markdownPath, `\uFEFF${markdown}`, 'utf-8');
  await fs.writeFile(htmlPath, html, 'utf-8');
  await fs.writeFile(jsonPath, `${JSON.stringify(multiReport, null, 2)}\n`, 'utf-8');

  console.log('\n🎉 多快照处理完成');
  console.log(`📄 多快照总报告已保存: ${markdownPath}`);
  console.log(`HTML report saved: ${htmlPath}`);
  console.log(`Cluster JSON saved: ${jsonPath}`);

  return {
    reportPath: markdownPath,
    htmlReportPath: htmlPath,
    clusterJsonPath: jsonPath,
    report: multiReport,
    successfulSnapshots,
  };
}

function safeOutputSegment(value, fallback) {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '');
  return normalized || fallback;
}

function createComparisonProcessResult(paths, baselineResult, currentResult, report) {
  return { ...paths, baselineResult, currentResult, report };
}

function logComparisonOutputs(title, outputs) {
  console.log(`\n🎉 ${title}`);
  for (const [label, outputPath] of outputs) {
    console.log(`${label}: ${outputPath}`);
  }
}

async function processVersionComparison(
  baselineDir,
  currentDir,
  outputDir,
  options = {},
) {
  const outDir = outputDir || path.join(process.cwd(), 'version_compare_out');
  const multiTop = options.multiTop || 20;
  const compareTop = options.compareTop || 20;
  const baselineLabel = safeOutputSegment(path.basename(path.resolve(baselineDir)), 'baseline');
  const currentLabel = safeOutputSegment(path.basename(path.resolve(currentDir)), 'current');
  const baselineOutDir = path.join(outDir, `baseline-${baselineLabel}`);
  const currentOutDir = path.join(outDir, `current-${currentLabel}`);

  await fs.mkdir(outDir, { recursive: true });

  console.log(`\n========== 基线版本: ${baselineDir} ==========`);
  const baselineResult = await processDirectoryMulti(baselineDir, baselineOutDir, { multiTop });
  if (!baselineResult?.report) {
    throw new Error(`基线版本没有可用于比较的聚类结果: ${baselineDir}`);
  }

  console.log(`\n========== 新版本: ${currentDir} ==========`);
  const currentResult = await processDirectoryMulti(currentDir, currentOutDir, { multiTop });
  if (!currentResult?.report) {
    throw new Error(`新版本没有可用于比较的聚类结果: ${currentDir}`);
  }

  const comparisonReport = buildVersionComparisonReport(
    baselineDir,
    currentDir,
    outDir,
    baselineResult,
    currentResult,
    compareTop,
  );
  const markdown = renderVersionComparisonMarkdown(comparisonReport);
  const html = renderVersionComparisonHtml(comparisonReport);
  const markdownPath = path.join(outDir, 'version-comparison.md');
  const jsonPath = path.join(outDir, 'version-comparison.json');
  const htmlPath = path.join(outDir, 'version-comparison.html');

  await fs.writeFile(markdownPath, `\uFEFF${markdown}`, 'utf-8');
  await fs.writeFile(jsonPath, `${JSON.stringify(comparisonReport, null, 2)}\n`, 'utf-8');
  await fs.writeFile(htmlPath, html, 'utf-8');

  logComparisonOutputs('不同版本快照对比完成', [['📄 版本增长报告已保存', markdownPath], ['HTML report saved', htmlPath], ['Comparison JSON saved', jsonPath]]);

  return createComparisonProcessResult(
    { reportPath: markdownPath, htmlReportPath: htmlPath, comparisonJsonPath: jsonPath },
    baselineResult, currentResult, comparisonReport,
  );
}

async function processExperimentalVersionComparison(
  baselineDir,
  currentDir,
  outputDir,
  options = {},
) {
  const outDir = outputDir || path.join(process.cwd(), 'experimental_version_compare_out');
  const multiTop = options.multiTop || 20;
  const compareTop = options.compareTop || 20;
  const baselineLabel = safeOutputSegment(path.basename(path.resolve(baselineDir)), 'baseline');
  const currentLabel = safeOutputSegment(path.basename(path.resolve(currentDir)), 'current');
  const baselineOutDir = path.join(outDir, `experimental-baseline-${baselineLabel}`);
  const currentOutDir = path.join(outDir, `experimental-current-${currentLabel}`);

  await fs.mkdir(outDir, { recursive: true });

  console.log(`\n========== 测试版基线版本: ${baselineDir} ==========`);
  const baselineResult = await processDirectoryMulti(baselineDir, baselineOutDir, {
    multiTop,
    recalculateObjectRetainedSizes: true,
  });
  if (!baselineResult?.report) {
    throw new Error(`测试版基线版本没有可用于比较的聚类结果: ${baselineDir}`);
  }

  console.log(`\n========== 测试版新版本: ${currentDir} ==========`);
  const currentResult = await processDirectoryMulti(currentDir, currentOutDir, {
    multiTop,
    recalculateObjectRetainedSizes: true,
  });
  if (!currentResult?.report) {
    throw new Error(`测试版新版本没有可用于比较的聚类结果: ${currentDir}`);
  }

  const comparisonReport = buildExperimentalVersionComparisonReport(
    baselineDir,
    currentDir,
    outDir,
    baselineResult,
    currentResult,
    compareTop,
  );
  const markdown = renderExperimentalVersionComparisonMarkdown(comparisonReport);
  const markdownPath = path.join(outDir, 'experimental-version-comparison.md');
  const jsonPath = path.join(outDir, 'experimental-version-comparison.json');

  await fs.writeFile(markdownPath, `\uFEFF${markdown}`, 'utf-8');
  await fs.writeFile(jsonPath, `${JSON.stringify(comparisonReport, null, 2)}\n`, 'utf-8');

  logComparisonOutputs('测试版不同版本快照对比完成', [['📄 测试版版本增长报告已保存', markdownPath], ['Experimental comparison JSON saved', jsonPath]]);

  return createComparisonProcessResult(
    { reportPath: markdownPath, comparisonJsonPath: jsonPath },
    baselineResult, currentResult, comparisonReport,
  );
}

function parsePositiveCliInteger(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} 需要正整数，当前值: ${value}`);
  }
  return parsed;
}

function applyInlineCliLimit(arg, options) {
  if (arg.startsWith('--top=')) {
    options.top = parsePositiveCliInteger(arg.slice('--top='.length), '--top');
    return true;
  }
  if (arg.startsWith('--multi-top=')) {
    options.multiTop = parsePositiveCliInteger(arg.slice('--multi-top='.length), '--multi-top');
    return true;
  }
  if (arg.startsWith('--compare-top=')) {
    options.compareTop = parsePositiveCliInteger(
      arg.slice('--compare-top='.length), '--compare-top',
    );
    return true;
  }
  return false;
}

function parseCliArgs(argv) {
  const positionals = [];
  const options = {
    multi: false, compare: false, compareExperimental: false, top: 5, multiTop: 20, compareTop: 20,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--multi':
        options.multi = true;
        break;
      case '--compare':
        options.compare = true;
        break;
      case '--compare-experimental':
        options.compareExperimental = true;
        break;
      case '--top':
        options.top = parsePositiveCliInteger(argv[++index], '--top');
        break;
      case '--multi-top':
        options.multiTop = parsePositiveCliInteger(argv[++index], '--multi-top');
        break;
      case '--compare-top':
        options.compareTop = parsePositiveCliInteger(argv[++index], '--compare-top');
        break;
      default:
        if (!applyInlineCliLimit(arg, options)) {
          positionals.push(arg);
        }
    }
  }
  return {
    inputArg: positionals[0] || defaultInput,
    outputArg: positionals[1] || null,
    baselineArg: positionals[0] || null,
    currentArg: positionals[1] || null,
    compareOutputArg: positionals[2] || null,
    ...options,
  };
}

// =================主入口=================
async function resolveComparisonDirectories(args, experimental) {
  const baselinePath = path.resolve(args.baselineArg);
  const currentPath = path.resolve(args.currentArg);
  const [baselineStat, currentStat] = await Promise.all([
    fs.stat(baselinePath), fs.stat(currentPath),
  ]);
  const prefix = experimental ? '测试版' : '';
  if (!baselineStat.isDirectory()) {
    throw new Error(`${prefix}基线版本不是目录: ${baselinePath}`);
  }
  if (!currentStat.isDirectory()) {
    throw new Error(`${prefix}新版本不是目录: ${currentPath}`);
  }
  return { baselinePath, currentPath };
}

async function runComparisonMode(args, experimental) {
  const optionName = experimental ? '--compare-experimental' : '--compare';
  if (args.multi || (experimental && args.compare)) {
    const conflicts = experimental ? '--compare、--multi' : '--multi';
    throw new Error(`${optionName} 与 ${conflicts} 不能同时使用`);
  }
  if (!args.baselineArg || !args.currentArg) {
    throw new Error(`${optionName} 需要两个版本目录: ${optionName} <基线目录> <新版本目录> [输出目录]`);
  }
  const { baselinePath, currentPath } = await resolveComparisonDirectories(args, experimental);
  const defaultOutput = experimental ? 'experimental_version_compare_out' : 'version_compare_out';
  const comparisonOutput = args.compareOutputArg
    ? path.resolve(args.compareOutputArg)
    : path.join(process.cwd(), defaultOutput);
  console.log(experimental ? '📊 测试版对象差值优先的不同版本快照对比模式' : '📊 不同版本快照对比模式');
  console.log(`   基线版本: ${baselinePath}`);
  console.log(`   新版本: ${currentPath}`);
  console.log(`   输出目录: ${comparisonOutput}`);
  const processComparison = experimental
    ? processExperimentalVersionComparison
    : processVersionComparison;
  await processComparison(
    baselinePath, currentPath, comparisonOutput,
    { multiTop: args.multiTop, compareTop: args.compareTop },
  );
}

async function runInputMode(args) {
  const inputPath = path.resolve(args.inputArg);
  const outputPath = args.outputArg ? path.resolve(args.outputArg) : null;
  const stat = await fs.stat(inputPath);
  if (args.multi) {
    if (!stat.isDirectory()) {
      console.log(`⚠️ --multi 只支持目录输入: ${inputPath}`);
      return;
    }
    console.log(`📂 多快照目录模式: ${inputPath}`);
    await processDirectoryMulti(inputPath, outputPath, {
      multiTop: args.multiTop,
      topCount: args.top,
    });
    return;
  }
  if (stat.isFile()) {
    if (!inputPath.endsWith('.heapsnapshot')) {
      console.log(`⚠️ 文件不是 .heapsnapshot 格式: ${inputPath}`);
      return;
    }
    console.log(`📎 单文件模式: ${inputPath}`);
    await processOneFile(inputPath, outputPath, { topCount: args.top });
    return;
  }
  if (stat.isDirectory()) {
    console.log(`📂 目录扫描模式: ${inputPath}`);
    await processDirectory(inputPath, outputPath, { topCount: args.top });
    return;
  }
  console.log(`❌ 无法识别的路径: ${inputPath}`);
}

function reportMainError(error) {
  if (error.code === 'ENOENT') {
    console.error(`❌ 路径不存在: ${error.path || process.argv[2]}`);
    return;
  }
  console.error('❌ Fatal Error:', error);
}

async function main() {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.compareExperimental) {
      await runComparisonMode(args, true);
      return;
    }
    if (args.compare) {
      await runComparisonMode(args, false);
      return;
    }
    await runInputMode(args);
  } catch (error) {
    reportMainError(error);
  }
}

main();
