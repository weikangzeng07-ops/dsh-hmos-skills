import { escapeHtml, formatSize } from './heap-cluster-core.js';
import {
  appendMarkdownKeyValueTable,
  appendSerializedPathEntries,
  categoryText,
  formatFixed,
  formatPercentRatio,
  markdownCell,
} from './heap-cluster-multi.js';
import {
  getLargestCurrentChains,
  getVersionChainDetailAnchor,
  getVersionObjectDetailAnchor,
  similarChainFamilyColorCount,
  versionGrowthStatusText,
} from './heap-cluster-version.js';

function appendVersionGrowthSection(lines, title, comparisons, topN, report) {
  const growthItems = comparisons
    .filter(item => item.occurrence_average_growth > 0)
    .slice(0, topN);
  lines.push(`## ${title}增长 Top${topN}`);
  lines.push('');

  if (growthItems.length === 0) {
    lines.push('(未发现增长的引用链)');
    lines.push('');
    return;
  }

  for (const item of growthItems) {
    const displayName = item.path_names[0] || item.path_names[item.path_names.length - 1] || '(未知引用链)';
    lines.push(`### #${item.growth_rank} ${displayName}`);
    lines.push('');
    appendMarkdownKeyValueTable(lines, [
      ['变化状态', item.status_text],
      ['出现时平均增长', item.occurrence_average_growth_text],
      ['增长率', item.growth_ratio_text],
      ['根节点类型', item.root_type || '-'],
      ['匹配相似链数', item.similar_chain_count],
    ]);

    lines.push('| 版本 | 成功快照 | 出现次数 | 出现率 | 出现时均值 | 平均排名 |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const [version, summary] of [
      [report.baseline.label, item.baseline],
      [report.current.label, item.current],
    ]) {
      lines.push(
        `| ${markdownCell(version)} | ${summary.successful_snapshot_count} | ${summary.occurrence_count} | ` +
        `${formatPercentRatio(summary.occurrence_ratio)} | ` +
        `${summary.occurrence_average_retained_size_text} | ` +
        `${summary.occurrence_count > 0 ? formatFixed(summary.average_rank, 2) : '-'} |`,
      );
    }
    lines.push('');

    lines.push('代表引用链:');
    appendSerializedPathEntries(lines, item.representative_path_entries, item.root_type);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
}

function appendObjectStatusOverview(lines, report, status) {
  const key = status === 'new' ? 'new_object_overview' : 'increased_object_overview';
  const items = Array.isArray(report[key]) ? report[key] : [];
  const title = status === 'new' ? '新增对象' : '增长对象';
  lines.push(`## ${title}总览 Top 10`);
  lines.push('');

  if (items.length === 0) {
    lines.push(`(未发现${title})`);
    lines.push('');
    return;
  }

  lines.push(
    `| 排名 | 分类 | 对象及源码位置 | 相似引用链组 | ${markdownCell(report.baseline.label)} 出现时均值 | ` +
    `${markdownCell(report.current.label)} 出现时均值 | 出现时平均增长 | ` +
    `新版本出现次数 | 增长率 |`,
  );
  lines.push('| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const item of items) {
    lines.push(
      `| ${item.rank} | ${markdownCell(categoryText(item.category))} | ` +
      `${renderVersionOverviewObjectMarkdown(item, report)} | ` +
      `${renderSimilarChainFamilyLinksMarkdown(item)} | ` +
      `${item.baseline.occurrence_average_retained_size_text} | ` +
      `${item.current.occurrence_average_retained_size_text} | ` +
      `${item.occurrence_average_growth_text} | ` +
      `${item.current.occurrence_count}/${report.current.successful_snapshot_count} ` +
      `(${formatPercentRatio(item.current.occurrence_ratio)}) | ` +
      `${item.growth_ratio_text} |`,
    );
  }
  lines.push('');
}

function hasRenderedVersionObjectDetail(item, report) {
  const topN = report?.metadata?.markdown_top || 0;
  return Number.isInteger(item?.status_rank) &&
    item.status_rank > 0 &&
    item.status_rank <= topN;
}

function renderVersionOverviewObjectMarkdown(item, report) {
  if (!hasRenderedVersionObjectDetail(item, report)) {
    return markdownCell(item.object_name);
  }
  const label = escapeHtml(item.object_name || '(未知对象)')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '&#124;');
  return `<a href="#${getVersionObjectDetailAnchor(item)}">${label}</a>`;
}

function getItemSimilarChainFamilies(item) {
  return Array.isArray(item?.similar_chain_families)
    ? item.similar_chain_families
    : [];
}

function renderSimilarChainFamilyLinksMarkdown(item) {
  const families = getItemSimilarChainFamilies(item);
  if (families.length === 0) {
    return '-';
  }
  return families
    .map(family => `[${family.family_label || family.family_id}](#${family.family_id})`)
    .join(' / ');
}

function appendSimilarChainFamiliesMarkdown(lines, report) {
  const families = Array.isArray(report.similar_chain_families)
    ? report.similar_chain_families
    : [];
  lines.push('## 相似引用链组');
  lines.push('');
  lines.push(
    '链组在本报告四个可见对象榜单的新版本 Top 3 引用链之间全局计算。' +
    '只有路径连续完整包含且根节点类型相同的链才会直接匹配，中间插层不算相似。' +
    '同一链组使用相同编号；Markdown 不依赖颜色。',
  );
  lines.push('');

  if (families.length === 0) {
    lines.push('(未发现跨对象的相似引用链组)');
    lines.push('');
    return;
  }

  for (const family of families) {
    lines.push(`<a id="${family.family_id}"></a>`);
    lines.push('');
    lines.push(`### ${family.display_label || family.family_label}`);
    lines.push('');
    appendMarkdownKeyValueTable(lines, [
      ['Distance 0 对象', family.distance0_object_name || '未知 Distance 0 对象'],
      ['根节点类型', family.root_type || '-'],
      ['关联对象数', family.object_count],
      ['成员引用链数', family.chain_count],
      ['成员链最大 Retained Size', family.max_retained_size_text],
    ]);
    lines.push('代表路径（选择链组内层级最完整的一条）:');
    lines.push('');
    for (const name of family.representative_path_names || []) {
      lines.push(`- ${markdownCell(name)}`);
    }
    if (!Array.isArray(family.representative_path_names) ||
        family.representative_path_names.length === 0) {
      lines.push('- (无代表路径)');
    }
    lines.push('');
  }
}

function appendVersionCurrentLargestChains(lines, item, report) {
  const chains = getLargestCurrentChains(item);
  lines.push(`##### ${report.current.label} Retained Size 最大引用链 Top 3`);
  lines.push('');

  if (chains.length === 0) {
    lines.push('(新版本无可用引用链)');
    lines.push('');
    return;
  }

  chains.forEach((chain, index) => {
    lines.push(`<a id="${getVersionChainDetailAnchor(item, index + 1)}"></a>`);
    lines.push('');
    const familyLabel = chain.similar_chain_family_id
      ? ` [${chain.similar_chain_family_label || chain.similar_chain_family_id}](#${chain.similar_chain_family_id})`
      : '';
    lines.push(`###### #${index + 1}${familyLabel} ${chain.total_retained_size_text || formatSize(chain.total_retained_size || 0)}`);
    lines.push('');
    appendMarkdownKeyValueTable(lines, [
      ['累计大小', chain.total_retained_size_text],
      ['出现次数', `${chain.occurrence_count}/${report.current.successful_snapshot_count} (${formatPercentRatio(chain.occurrence_ratio)})`],
      ['出现时平均大小', chain.average_retained_size_text],
      ['单次最大大小', chain.max_retained_size_text],
      ['根节点类型', chain.root_type || '-'],
      ['合并相似链数', chain.similar_chain_count],
    ]);
    lines.push('代表引用链:');
    appendSerializedPathEntries(
      lines,
      chain.representative_path_entries,
      chain.root_type,
    );
    lines.push('');

    const details = Array.isArray(chain.occurrenceDetails) ? chain.occurrenceDetails : [];
    if (details.length > 0) {
      lines.push('命中快照明细:');
      lines.push('');
      lines.push('| 快照 | 单快照排名 | 对象数 | 该链大小 |');
      lines.push('| --- | ---: | ---: | ---: |');
      for (const detail of details) {
        lines.push(
          `| ${markdownCell(detail.snapshot_name || detail.snapshot || '-')} | ` +
          `${detail.rank > 0 ? detail.rank : '-'} | ${detail.count || 0} | ` +
          `${detail.total_retained_size_text || formatSize(detail.total_retained_size || 0)} |`,
        );
      }
      lines.push('');
    }
  });
}

function buildVersionObjectMarkdownRows(item, report) {
  const rows = [
    ['变化状态', item.status_text],
    ['出现时平均增长', item.occurrence_average_growth_text],
    ['新版本出现次数', `${item.current.occurrence_count}/${report.current.successful_snapshot_count}`],
    ['增长率', item.growth_ratio_text],
    ['对象匹配方式', '公共对象名统一为 JS... 规范名，并归一化依赖包版本和混淆函数名'],
  ];
  if (getItemSimilarChainFamilies(item).length > 0) {
    rows.push(['相似引用链组', renderSimilarChainFamilyLinksMarkdown(item)]);
  }
  if (Array.isArray(item.object_name_variants) && item.object_name_variants.length > 1) {
    rows.push(['归并名称变体', item.object_name_variants.join(', ')]);
  }
  return rows;
}

function appendVersionObjectSummaryTable(lines, item, report) {
  lines.push('| 版本 | 成功快照 | 出现次数 | 出现率 | 出现时均值 | 平均对象数量 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [version, summary] of [
    [report.baseline.label, item.baseline],
    [report.current.label, item.current],
  ]) {
    lines.push(
      `| ${markdownCell(version)} | ${summary.successful_snapshot_count} | ` +
      `${summary.occurrence_count} | ${formatPercentRatio(summary.occurrence_ratio)} | ` +
      `${summary.occurrence_average_retained_size_text} | ` +
      `${summary.occurrence_count > 0 ? formatFixed(summary.average_count, 2) : '-'} |`,
    );
  }
  lines.push('');
}

function appendVersionObjectStatusItem(lines, item, report) {
  lines.push(`<a id="${getVersionObjectDetailAnchor(item)}"></a>`, '');
  const familyLabels = renderSimilarChainFamilyLinksMarkdown(item);
  const familySuffix = familyLabels === '-' ? '' : ` · ${familyLabels}`;
  lines.push(`#### #${item.status_rank} ${item.object_name || '(未知对象)'}${familySuffix}`, '');
  appendMarkdownKeyValueTable(lines, buildVersionObjectMarkdownRows(item, report));
  appendVersionObjectSummaryTable(lines, item, report);
  appendVersionCurrentLargestChains(lines, item, report);
  lines.push('---', '');
}

function appendVersionObjectStatusCategorySection(
  lines,
  status,
  category,
  comparisons,
  topN,
  report,
) {
  const items = comparisons.filter(item => item.status === status).slice(0, topN);
  lines.push(`### ${categoryText(category)} Top${topN}`, '');
  if (items.length === 0) {
    const statusText = status === 'new' ? '新增' : '增长';
    lines.push(`(未发现${statusText}的${categoryText(category)})`, '');
    return;
  }
  for (const item of items) {
    appendVersionObjectStatusItem(lines, item, report);
  }
}

function appendVersionSnapshotStatsMarkdown(lines, report) {
  lines.push('## 快照统计');
  lines.push('');
  lines.push('| 版本 | 快照总数 | 成功 | 失败 | 多快照报告 |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const version of [report.baseline, report.current]) {
    lines.push(
      `| ${markdownCell(version.label)} | ${version.total_snapshot_count} | ` +
      `${version.successful_snapshot_count} | ${version.failed_snapshot_count} | ` +
      `${markdownCell(version.aggregate_report)} |`,
    );
  }
  lines.push('');
}

function appendVersionComparisonOverviewMarkdown(lines, report) {
  const metadata = report.metadata;
  lines.push('## 总览');
  lines.push('');
  appendMarkdownKeyValueTable(lines, [
    ['基线版本', `${report.baseline.label} (${report.baseline.input_dir})`],
    ['新版本', `${report.current.label} (${report.current.input_dir})`],
    ['输出目录', metadata.output_dir],
    ['生成时间', metadata.generated_at],
    ['比较指标', metadata.comparison_metric],
    ['对象匹配规则', metadata.matching_rule],
    ['代表链合并规则', metadata.representative_chain_rule],
    ['跨对象相似链组规则', metadata.similar_chain_family_rule],
    ['排序规则', '综合出现时平均增长和新版本出现次数；仅影响顺序，报告展示值均为真实内存'],
  ]);
}

function appendVersionStatusMarkdown(lines, report, status) {
  const title = status === 'new' ? '新增对象' : '增长对象';
  lines.push(`## ${title}`, '');
  appendVersionObjectStatusCategorySection(
    lines, status, 'business', report.business_object_comparisons,
    report.metadata.markdown_top, report,
  );
  appendVersionObjectStatusCategorySection(
    lines, status, 'common', report.common_object_comparisons,
    report.metadata.markdown_top, report,
  );
}

function renderVersionComparisonMarkdown(report) {
  const lines = ['# 不同版本 Heap 对象增长对比报告', ''];
  appendObjectStatusOverview(lines, report, 'new');
  appendObjectStatusOverview(lines, report, 'increased');
  appendVersionSnapshotStatsMarkdown(lines, report);
  appendSimilarChainFamiliesMarkdown(lines, report);
  appendVersionComparisonOverviewMarkdown(lines, report);
  appendVersionStatusMarkdown(lines, report, 'new');
  appendVersionStatusMarkdown(lines, report, 'increased');
  return `${lines.join('\n')}\n`;
}

function getSimilarChainFamilyColorClass(colorIndex) {
  if (!Number.isInteger(colorIndex) || colorIndex < 0) {
    return '';
  }
  return `family-color-${colorIndex % similarChainFamilyColorCount}`;
}

function renderSimilarChainFamilyChipHtml(family, options = {}) {
  if (!family?.family_id) {
    return '';
  }
  const colorClass = getSimilarChainFamilyColorClass(family.color_index);
  const className = `family-chip ${colorClass}`;
  const labelValue = options.showDisplayLabel
    ? (family.display_label || family.family_label || family.family_id)
    : (family.family_label || family.family_id);
  const label = escapeHtml(labelValue);
  if (options.link === false) {
    return `<span class="${className}">${label}</span>`;
  }
  return `<a class="${className}" href="#${escapeHtml(family.family_id)}" title="查看相似引用链组">${label}</a>`;
}

function renderSimilarChainFamilyChipsHtml(item, options = {}) {
  const families = getItemSimilarChainFamilies(item);
  if (families.length === 0) {
    return '';
  }
  return `<span class="family-chip-list">${families
    .map(family => renderSimilarChainFamilyChipHtml(family, options))
    .join('')}</span>`;
}

function getVersionChainFamily(chain) {
  return chain.similar_chain_family_id
    ? {
      'family_id': chain.similar_chain_family_id,
      'family_label': chain.similar_chain_family_label,
      'display_label': chain.similar_chain_family_display_label,
      'distance0_object_name': chain.similar_chain_family_distance0_object_name,
      'color_index': chain.similar_chain_family_color_index,
    }
    : null;
}

function renderVersionChainPathHtml(chain) {
  const pathEntries = Array.isArray(chain.representative_path_entries)
    ? chain.representative_path_entries
    : [];
  return pathEntries.length > 0
    ? `<ol class="chain-path">${pathEntries.map(entry => `
        <li>
          <span class="chain-name">${escapeHtml(entry.name || '')}</span>
          <span class="chain-meta">${escapeHtml(
            entry.retained_size_text || formatSize(entry.retained_size || 0),
          )} · Distance ${escapeHtml(entry.distance ?? '-')}</span>
        </li>`).join('')}
      </ol>`
    : '<div class="empty">无代表路径</div>';
}

function renderVersionChainDetailsHtml(chain) {
  const occurrenceDetails = Array.isArray(chain.occurrenceDetails)
    ? chain.occurrenceDetails
    : [];
  return occurrenceDetails.length > 0
    ? `<details class="snapshot-details">
        <summary>命中快照明细 (${occurrenceDetails.length})</summary>
        <div class="table-wrap">
          <table>
            <thead><tr><th>快照</th><th>单快照排名</th><th>对象数</th><th>该链大小</th></tr></thead>
            <tbody>${occurrenceDetails.map(detail => `
              <tr>
                <td>${escapeHtml(detail.snapshot_name || detail.snapshot || '-')}</td>
                <td>${escapeHtml(detail.rank > 0 ? detail.rank : '-')}</td>
                <td>${escapeHtml(detail.count || 0)}</td>
                <td>${escapeHtml(detail.total_retained_size_text || formatSize(detail.total_retained_size || 0))}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </details>`
    : '';
}

function renderVersionChainHtml(chain, report, chainRank, item) {
  if (!chain) {
    return '<div class="empty">新版本无可用引用链</div>';
  }
  const family = getVersionChainFamily(chain);
  const colorClass = getSimilarChainFamilyColorClass(chain.similar_chain_family_color_index);
  const familyClass = family ? ` has-family ${colorClass}` : '';
  const familyChip = family ? renderSimilarChainFamilyChipHtml(family) : '';
  const chainAnchor = getVersionChainDetailAnchor(item, chainRank);
  return `<section id="${escapeHtml(chainAnchor)}" class="chain-section${familyClass}">
    <h5><span>#${escapeHtml(chainRank)} 累计 ${escapeHtml(chain.total_retained_size_text)}</span>${familyChip}</h5>
    <dl class="metric-grid">
      <div><dt>累计大小</dt><dd>${escapeHtml(chain.total_retained_size_text)}</dd></div>
      <div><dt>出现次数</dt><dd>${escapeHtml(chain.occurrence_count)}/${escapeHtml(
        report.current.successful_snapshot_count,
      )} (${escapeHtml(formatPercentRatio(chain.occurrence_ratio))})</dd></div>
      <div><dt>出现时均值</dt><dd>${escapeHtml(chain.average_retained_size_text)}</dd></div>
      <div><dt>单次最大</dt><dd>${escapeHtml(chain.max_retained_size_text)}</dd></div>
      <div><dt>根节点类型</dt><dd>${escapeHtml(chain.root_type || '-')}</dd></div>
      <div><dt>合并相似链</dt><dd>${escapeHtml(chain.similar_chain_count)}</dd></div>
    </dl>
    ${renderVersionChainPathHtml(chain)}
    ${renderVersionChainDetailsHtml(chain)}
  </section>`;
}

function renderVersionChainsHtml(item, report) {
  const chains = getLargestCurrentChains(item);
  if (chains.length === 0) {
    return '<div class="chain-group"><h4>新版本 Retained Size 最大引用链 Top 3</h4><div class="empty">新版本无可用引用链</div></div>';
  }
  return `<div class="chain-group">
    <h4>${escapeHtml(report.current.label)} Retained Size 最大引用链 Top 3</h4>
    ${chains.map((chain, index) => renderVersionChainHtml(chain, report, index + 1, item)).join('\n')}
  </div>`;
}

function renderVersionObjectSummaryRow([label, summary]) {
  return `
      <tr>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(summary.successful_snapshot_count)}</td>
        <td>${escapeHtml(summary.occurrence_count)}</td>
        <td>${escapeHtml(formatPercentRatio(summary.occurrence_ratio))}</td>
        <td>${escapeHtml(summary.occurrence_average_retained_size_text)}</td>
        <td>${escapeHtml(summary.occurrence_count > 0 ? formatFixed(summary.average_count, 2) : '-')}</td>
      </tr>`;
}

function renderVersionObjectItemHtml(item, index, report) {
  const detailAnchor = getVersionObjectDetailAnchor(item);
  const familyChips = renderSimilarChainFamilyChipsHtml(item);
  const variants = Array.isArray(item.object_name_variants) ? item.object_name_variants : [];
  const variantsHtml = variants.length > 1
    ? `<div class="variants"><strong>归并名称变体</strong><span>${escapeHtml(variants.join(' · '))}</span></div>`
    : '';
  const versionRows = [
    [report.baseline.label, item.baseline],
    [report.current.label, item.current],
  ].map(renderVersionObjectSummaryRow).join('');
  return `<details id="${escapeHtml(detailAnchor)}" class="object-panel" ${index < 3 ? 'open' : ''}>
      <summary>
        <span class="rank">#${escapeHtml(item.status_rank)}</span>
        <span class="object-title"><span class="object-name">${escapeHtml(item.object_name || '(未知对象)')}</span>${familyChips}</span>
        <span class="growth"><small>出现时平均增长</small>${escapeHtml(item.occurrence_average_growth_text)}</span>
      </summary>
      <div class="object-body">
        <dl class="metric-grid object-metrics">
          <div><dt>变化状态</dt><dd>${escapeHtml(item.status_text)}</dd></div>
          <div><dt>出现时平均增长</dt><dd class="positive">${escapeHtml(item.occurrence_average_growth_text)}</dd></div>
          <div><dt>新版本出现次数</dt><dd>${escapeHtml(item.current.occurrence_count)}/${escapeHtml(report.current.successful_snapshot_count)}</dd></div>
          <div><dt>${escapeHtml(report.baseline.label)} 出现时均值</dt><dd>${escapeHtml(item.baseline.occurrence_average_retained_size_text)}</dd></div>
          <div><dt>${escapeHtml(report.current.label)} 出现时均值</dt><dd>${escapeHtml(item.current.occurrence_average_retained_size_text)}</dd></div>
          <div><dt>增长率</dt><dd>${escapeHtml(item.growth_ratio_text)}</dd></div>
        </dl>
        ${variantsHtml}
        <div class="table-wrap">
          <table>
            <thead><tr><th>版本</th><th>成功快照</th><th>出现次数</th><th>出现率</th><th>出现时均值</th><th>平均对象数</th></tr></thead>
            <tbody>${versionRows}</tbody>
          </table>
        </div>
        ${renderVersionChainsHtml(item, report)}
      </div>
    </details>`;
}

function renderVersionObjectHtmlCategory(report, status, category, comparisons) {
  const title = categoryText(category);
  const items = comparisons.filter(item => item.status === status)
    .slice(0, report.metadata.markdown_top);
  if (items.length === 0) {
    return `<div id="${escapeHtml(status)}-${escapeHtml(category)}" class="category-section">
      <div class="category-heading"><h3>${escapeHtml(title)} Top${escapeHtml(report.metadata.markdown_top)}</h3><span>0 项</span></div>
      <div class="empty">未发现${escapeHtml(versionGrowthStatusText(status))}的${escapeHtml(title)}</div>
    </div>`;
  }
  const objectHtml = items.map((item, index) =>
    renderVersionObjectItemHtml(item, index, report)).join('\n');
  return `<div id="${escapeHtml(status)}-${escapeHtml(category)}" class="category-section">
    <div class="category-heading"><h3>${escapeHtml(title)} Top${escapeHtml(report.metadata.markdown_top)}</h3><span>${escapeHtml(items.length)} 项</span></div>
    ${objectHtml}
  </div>`;
}

function renderVersionStatusHtmlSection(report, status) {
  const title = status === 'new' ? '新增对象' : '增长对象';
  const sectionId = status === 'new' ? 'new-objects' : 'increased-objects';
  const businessHtml = renderVersionObjectHtmlCategory(
    report,
    status,
    'business',
    report.business_object_comparisons,
  );
  const commonHtml = renderVersionObjectHtmlCategory(
    report,
    status,
    'common',
    report.common_object_comparisons,
  );
  return `<section id="${sectionId}" class="status-section">
    <div class="section-heading"><h2>${title}</h2></div>
    ${businessHtml}
    ${commonHtml}
  </section>`;
}

function renderVersionStatusOverviewHtml(report, status) {
  const key = status === 'new' ? 'new_object_overview' : 'increased_object_overview';
  const title = status === 'new' ? '新增对象' : '增长对象';
  const items = Array.isArray(report[key]) ? report[key] : [];
  const rows = items.length > 0
    ? items.map(item => {
      const objectName = escapeHtml(item.object_name);
      const objectCell = hasRenderedVersionObjectDetail(item, report)
        ? `<a class="object-link" href="#${getVersionObjectDetailAnchor(item)}" title="跳转到对象详情">${objectName}</a>`
        : objectName;
      const familyChips = renderSimilarChainFamilyChipsHtml(item);
      return `
        <tr>
          <td>${escapeHtml(item.rank)}</td>
          <td><span class="category ${escapeHtml(item.category)}">${escapeHtml(categoryText(item.category))}</span></td>
          <td class="object-cell">${objectCell}</td>
          <td class="family-cell">${familyChips || '<span class="muted">-</span>'}</td>
          <td>${escapeHtml(item.baseline.occurrence_average_retained_size_text)}</td>
          <td>${escapeHtml(item.current.occurrence_average_retained_size_text)}</td>
          <td class="positive">${escapeHtml(item.occurrence_average_growth_text)}</td>
          <td>${escapeHtml(item.current.occurrence_count)}/${escapeHtml(
            report.current.successful_snapshot_count,
          )} (${escapeHtml(formatPercentRatio(item.current.occurrence_ratio))})</td>
          <td>${escapeHtml(item.growth_ratio_text)}</td>
        </tr>`;
    }).join('')
    : `<tr><td colspan="9" class="empty-cell">未发现${title}</td></tr>`;
  return `<div class="overview-block">
    <h3>${title}总览 Top 10</h3>
    <div class="table-wrap overview-table"><table>
      <thead><tr>
        <th>排名</th><th>分类</th><th>对象及源码位置</th><th>相似引用链组</th>
        <th>${escapeHtml(report.baseline.label)} 出现时均值</th>
        <th>${escapeHtml(report.current.label)} 出现时均值</th>
        <th>出现时平均增长</th><th>新版本出现次数</th><th>增长率</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function renderSimilarChainFamilyOverviewHtml(report) {
  const families = Array.isArray(report.similar_chain_families)
    ? report.similar_chain_families
    : [];
  const content = families.length > 0
    ? families.map((family, index) => {
      const colorClass = getSimilarChainFamilyColorClass(family.color_index);
      const familyChip = renderSimilarChainFamilyChipHtml(family, {
        link: false,
        showDisplayLabel: true,
      });
      const pathNames = Array.isArray(family.representative_path_names)
        ? family.representative_path_names
        : [];
      const pathHtml = pathNames.length > 0
        ? `<ol class="family-path">${pathNames
          .map(name => `<li>${escapeHtml(name)}</li>`)
          .join('')}</ol>`
        : '<div class="empty">无代表路径</div>';

      return `<details id="${escapeHtml(family.family_id)}" class="family-panel ${colorClass}" ${index < 3 ? 'open' : ''}>
        <summary>
          <span class="family-summary-title">${familyChip}</span>
          <span class="family-summary-stats">${escapeHtml(family.object_count)} 个对象 · ${escapeHtml(family.chain_count)} 条链</span>
        </summary>
        <div class="family-body">
          <dl class="metric-grid family-metrics">
            <div><dt>根节点类型</dt><dd>${escapeHtml(family.root_type || '-')}</dd></div>
            <div><dt>关联对象数</dt><dd>${escapeHtml(family.object_count)}</dd></div>
            <div><dt>成员引用链数</dt><dd>${escapeHtml(family.chain_count)}</dd></div>
            <div><dt>成员链最大 Retained Size</dt><dd>${escapeHtml(family.max_retained_size_text)}</dd></div>
          </dl>
          <h4>代表路径</h4>
          ${pathHtml}
        </div>
      </details>`;
    }).join('\n')
    : '<div class="empty">未发现跨对象的相似引用链组</div>';

  return `<section id="similar-chain-families" class="family-overview-section">
    <div class="section-heading"><h2>相似引用链组</h2><span>${escapeHtml(families.length)} 组</span></div>
    <p class="section-note">在四个可见对象榜单的新版本 Top 3 链之间全局匹配。根节点类型相同且一条路径连续完整包含于另一条路径时才直接匹配，中间插层不算相似。相同编号和颜色表示同一链组；颜色循环使用时以编号为准。</p>
    ${content}
  </section>`;
}

const versionComparisonStyles = `
    :root {
      color-scheme:light; --bg:#f4f6f5; --surface:#fff; --text:#202624; --muted:#64706c; --line:#d7ddda;
      --teal:#087f73; --teal-soft:#e4f4f1; --coral:#b5471b; --coral-soft:#fff0e8; --common:#51606b;
    }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.65 "Segoe UI","Microsoft YaHei",sans-serif; letter-spacing:0; }
    header { background:#173b37; color:#fff; padding:30px max(24px,calc((100vw - 1180px)/2)); }
    header h1 { margin:0 0 8px; font-size:28px; font-weight:700; }
    header p { margin:0; max-width:100%; color:#cfe1dd; overflow-wrap:anywhere; }
    nav {
      position:sticky; top:0; z-index:5; display:flex; gap:8px;
      padding:10px max(24px,calc((100vw - 1180px)/2));
      background:rgba(255,255,255,.96); border-bottom:1px solid var(--line);
    }
    nav a { color:var(--teal); text-decoration:none; font-weight:600; padding:5px 8px; }
    main { width:min(1180px,calc(100% - 32px)); margin:24px auto 56px; }
    section { margin:28px 0; }
    h2 { margin:0 0 14px; font-size:20px; }
    h3,h4,h5 { margin:0; }
    .summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); min-width:0; border:1px solid var(--line); background:var(--surface); }
    .summary-grid div { min-width:0; padding:14px 16px; border-right:1px solid var(--line); }
    .summary-grid div:last-child { border-right:0; }
    .summary-grid dt,.metric-grid dt { color:var(--muted); font-size:12px; }
    .summary-grid dd,.metric-grid dd { margin:3px 0 0; font-weight:650; overflow-wrap:anywhere; word-break:break-word; }
    .table-wrap { max-width:100%; overflow:auto; border:1px solid var(--line); background:var(--surface); }
    table { width:100%; border-collapse:collapse; min-width:720px; }
    .overview-block + .overview-block { margin-top:24px; }
    .overview-block h3 { margin-bottom:10px; font-size:16px; }
    .overview-table table { min-width:960px; }
    th,td { padding:10px 12px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
    th { background:#edf1ef; color:#45504c; font-size:12px; white-space:nowrap; }
    tbody tr:last-child td { border-bottom:0; }
    .object-cell,.object-name,.variants span { overflow-wrap:anywhere; }
    .object-link { color:var(--teal); font-weight:650; text-decoration-thickness:1px; text-underline-offset:3px; }
    .object-link:hover { color:#055f57; }
    .positive { color:var(--coral); font-weight:700; }
    .category { display:inline-block; padding:2px 7px; border-radius:4px; font-size:12px; font-weight:650; }
    .category.business { background:var(--teal-soft); color:var(--teal); }
    .category.common { background:#edf0f2; color:var(--common); }
    .muted,.section-note { color:var(--muted); }
    .section-note { margin:-4px 0 14px; }
    .family-color-0 { --family-color:#2563eb; --family-soft:#eff6ff; --family-text:#1e3a8a; }
    .family-color-1 { --family-color:#7c3aed; --family-soft:#f5f3ff; --family-text:#5b21b6; }
    .family-color-2 { --family-color:#c2410c; --family-soft:#fff7ed; --family-text:#9a3412; }
    .family-color-3 { --family-color:#0e7490; --family-soft:#ecfeff; --family-text:#155e75; }
    .family-color-4 { --family-color:#be185d; --family-soft:#fdf2f8; --family-text:#9d174d; }
    .family-color-5 { --family-color:#4d7c0f; --family-soft:#f7fee7; --family-text:#3f6212; }
    .family-color-6 { --family-color:#4338ca; --family-soft:#eef2ff; --family-text:#3730a3; }
    .family-color-7 { --family-color:#a16207; --family-soft:#fffbeb; --family-text:#854d0e; }
    .family-color-8 { --family-color:#0f766e; --family-soft:#f0fdfa; --family-text:#115e59; }
    .family-color-9 { --family-color:#475569; --family-soft:#f1f5f9; --family-text:#334155; }
    .family-chip-list { display:inline-flex; flex-wrap:wrap; align-items:center; gap:5px; max-width:100%; }
    .family-chip {
      display:inline-flex; align-items:flex-start; gap:5px; max-width:100%; min-height:24px; padding:2px 7px;
      border:1px solid var(--family-color); border-radius:4px; background:var(--family-soft); color:var(--family-text);
      font-size:12px; font-weight:700; line-height:1.35; text-decoration:none; white-space:normal;
      overflow-wrap:anywhere; word-break:break-word;
    }
    .family-chip::before { content:""; flex:0 0 auto; width:7px; height:7px; border-radius:50%; background:var(--family-color); }
    a.family-chip:hover { box-shadow:0 0 0 2px color-mix(in srgb,var(--family-color) 20%,transparent); }
    .family-cell { min-width:130px; }
    .section-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .section-heading span { color:var(--muted); }
    .status-section { scroll-margin-top:64px; }
    .family-overview-section { scroll-margin-top:64px; }
    .family-panel {
      margin:10px 0; border:1px solid var(--line); border-left:4px solid var(--family-color);
      border-radius:6px; background:var(--surface); overflow:hidden; scroll-margin-top:70px;
    }
    .family-panel:target { box-shadow:0 0 0 2px color-mix(in srgb,var(--family-color) 24%,transparent); }
    .family-panel > summary { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:12px 14px; cursor:pointer; list-style:none; }
    .family-panel > summary::-webkit-details-marker { display:none; }
    .family-panel[open] > summary { border-bottom:1px solid var(--line); background:var(--family-soft); }
    .family-summary-title { display:flex; flex-wrap:wrap; align-items:center; gap:10px; min-width:0; }
    .family-summary-stats { flex:0 0 auto; color:var(--muted); white-space:nowrap; }
    .family-body { padding:16px; }
    .family-body h4 { margin:14px 0 8px; font-size:14px; }
    .family-metrics { grid-template-columns:repeat(4,minmax(0,1fr)); margin-bottom:14px; }
    .family-metrics div:nth-child(3n) { border-right:1px solid var(--line); }
    .family-metrics div:nth-child(4n) { border-right:0; }
    .family-path { margin:0; padding:0; list-style:none; }
    .family-path li { position:relative; padding:7px 10px 7px 26px; border-left:2px solid var(--family-color); overflow-wrap:anywhere; }
    .family-path li::before { content:""; position:absolute; left:-5px; top:14px; width:8px; height:8px; border-radius:50%; background:var(--family-color); }
    .category-section { margin:18px 0 34px; }
    .category-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .category-heading h3 { font-size:17px; }
    .category-heading span { color:var(--muted); }
    .object-panel { margin:10px 0; border:1px solid var(--line); border-radius:6px; background:var(--surface); overflow:hidden; scroll-margin-top:70px; }
    .object-panel:target { border-color:var(--teal); box-shadow:0 0 0 2px rgba(8,127,115,.14); }
    .object-panel > summary {
      display:grid; grid-template-columns:52px minmax(0,1fr) auto; gap:10px; align-items:start;
      cursor:pointer; padding:13px 15px; list-style:none;
    }
    .object-panel > summary::-webkit-details-marker { display:none; }
    .object-panel[open] > summary { border-bottom:1px solid var(--line); background:#fbfcfb; }
    .rank { color:var(--teal); font-weight:750; }
    .object-title { display:flex; flex-direction:column; align-items:flex-start; gap:7px; min-width:0; }
    .growth { display:flex; flex-direction:column; align-items:flex-end; color:var(--coral); font-weight:750; white-space:nowrap; }
    .growth small { color:var(--muted); font-size:11px; font-weight:500; }
    .object-body { padding:16px; }
    .metric-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); margin:0 0 16px; border:1px solid var(--line); }
    .metric-grid div { padding:10px 12px; border-right:1px solid var(--line); }
    .metric-grid div:nth-child(3n) { border-right:0; }
    .variants { display:grid; grid-template-columns:140px minmax(0,1fr); gap:10px; margin:0 0 14px; color:var(--muted); }
    .chain-group { margin-top:20px; }
    .chain-group > h4 { margin-bottom:8px; font-size:16px; }
    .chain-section { margin:0; padding:16px 0; border-top:2px solid var(--teal); scroll-margin-top:70px; }
    .chain-section:target { background:#fbfcfb; box-shadow:inset 3px 0 0 var(--teal); }
    .chain-section.has-family { border-top-color:var(--family-color); }
    .chain-section.has-family:target { box-shadow:inset 3px 0 0 var(--family-color); }
    .chain-section h5 { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; font-size:15px; }
    .chain-path { margin:12px 0 0; padding:0; list-style:none; }
    .chain-path li { position:relative; display:flex; justify-content:space-between; gap:16px; padding:8px 10px 8px 28px; border-left:2px solid #9fc9c2; }
    .chain-path li::before { content:""; position:absolute; left:-5px; top:15px; width:8px; height:8px; border-radius:50%; background:var(--teal); }
    .chain-section.has-family .chain-path li { border-left-color:var(--family-color); }
    .chain-section.has-family .chain-path li::before { background:var(--family-color); }
    .chain-name { overflow-wrap:anywhere; }
    .chain-meta { flex:0 0 auto; color:var(--muted); white-space:nowrap; }
    .snapshot-details { margin-top:12px; }
    .snapshot-details summary { cursor:pointer; color:var(--teal); font-weight:650; margin-bottom:8px; }
    .empty { padding:18px; border:1px dashed #b9c2be; color:var(--muted); background:var(--surface); }
    .empty-cell { color:var(--muted); text-align:center; }
    .report-links { margin-top:12px; }
    .report-links a { color:#fff; margin-right:14px; }
    @media (max-width:760px) {
      header{padding:24px 16px} header h1{font-size:22px} header p{word-break:break-word}
      nav{padding:8px 12px;overflow-x:auto} main{width:calc(100% - 24px)}
      .summary-grid{grid-template-columns:1fr 1fr} .summary-grid div:nth-child(2){border-right:0}
      .summary-grid dd{word-break:break-all} .metric-grid{grid-template-columns:1fr}
      .metric-grid div,.metric-grid div:nth-child(3n){border-right:0;border-bottom:1px solid var(--line)}
      .object-panel>summary{grid-template-columns:42px minmax(0,1fr)} .growth{grid-column:2}
      .chain-path li{display:block} .chain-meta{display:block;margin-top:3px;white-space:normal}
      .variants{grid-template-columns:1fr} .family-panel>summary{align-items:flex-start}
      .family-summary-stats{white-space:normal;text-align:right} .family-chip-list{width:100%}
    }
    @media print {
      nav{display:none} body{background:#fff} .object-panel,.family-panel{break-inside:avoid}
      .object-panel:not([open])>.object-body,.family-panel:not([open])>.family-body{display:block}
      .family-chip{-webkit-print-color-adjust:exact;print-color-adjust:exact} main{width:100%;margin:0}
    }
`;

const versionComparisonClientScript = `
    (() => {
      const revealReportTarget = () => {
        const id = decodeURIComponent(window.location.hash.slice(1));
        if (!id) return;
        const target = document.getElementById(id);
        if (!target) return;
        if (target.tagName === 'DETAILS') target.open = true;
        const parentDetails = target.closest('details.object-panel,details.family-panel');
        if (parentDetails) parentDetails.open = true;
        window.requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
      };
      document.querySelectorAll('summary a.family-chip').forEach(link => {
        link.addEventListener('click', event => event.stopPropagation());
      });
      window.addEventListener('hashchange', revealReportTarget);
      revealReportTarget();
    })();
`;

function renderVersionSummaryHtml(report, generatedAtText) {
  return `<section>
      <dl class="summary-grid">
        <div><dt>基线版本</dt><dd>${escapeHtml(report.baseline.label)}</dd></div>
        <div><dt>新版本</dt><dd>${escapeHtml(report.current.label)}</dd></div>
        <div><dt>比较指标</dt><dd>出现时平均 Retained Size</dd></div>
        <div><dt>生成时间</dt><dd>${escapeHtml(generatedAtText)}</dd></div>
      </dl>
    </section>`;
}

function renderVersionSnapshotStatsHtml(report) {
  const renderRow = version => `<tr>
    <td>${escapeHtml(version.label)}</td>
    <td>${escapeHtml(version.total_snapshot_count)}</td>
    <td>${escapeHtml(version.successful_snapshot_count)}</td>
    <td>${escapeHtml(version.failed_snapshot_count)}</td>
    <td class="object-cell">${escapeHtml(version.input_dir)}</td>
  </tr>`;
  return `<section>
      <h2>快照统计</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>版本</th><th>快照总数</th><th>成功</th><th>失败</th><th>输入目录</th></tr></thead>
        <tbody>${[report.baseline, report.current].map(renderRow).join('')}</tbody>
      </table></div>
    </section>`;
}

function renderVersionComparisonMainHtml(report, generatedAtText) {
  return `${renderVersionSummaryHtml(report, generatedAtText)}
    <section id="overview">
      <h2>对象变化总览</h2>
      ${renderVersionStatusOverviewHtml(report, 'new')}
      ${renderVersionStatusOverviewHtml(report, 'increased')}
    </section>
    ${renderVersionSnapshotStatsHtml(report)}
    ${renderSimilarChainFamilyOverviewHtml(report)}
    ${renderVersionStatusHtmlSection(report, 'new')}
    ${renderVersionStatusHtmlSection(report, 'increased')}`;
}

function renderVersionComparisonHtml(report) {
  const generatedAtDate = new Date(report.metadata.generated_at);
  const generatedAtText = Number.isNaN(generatedAtDate.getTime())
    ? report.metadata.generated_at
    : generatedAtDate.toLocaleString('zh-CN', { hour12: false });
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>不同版本 Heap 对象增长对比报告</title>
  <style>${versionComparisonStyles}</style>
</head>
<body>
  <header>
    <h1>不同版本 Heap 对象增长对比报告</h1>
    <p>新增与增长分开排名，排序综合平均增长与出现次数；相似引用链使用相同链组编号和颜色，展示值均为真实 Retained Size</p>
    <div class="report-links"><a href="version-comparison.md">Markdown</a><a href="version-comparison.json">JSON</a></div>
  </header>
  <nav><a href="#overview">总览</a><a href="#similar-chain-families">相似链组</a><a href="#new-objects">新增对象</a><a href="#increased-objects">增长对象</a></nav>
  <main>${renderVersionComparisonMainHtml(report, generatedAtText)}</main>
  <script>${versionComparisonClientScript}</script>
</body>
</html>
`;
}

function appendExperimentalGrowthTable(lines, title, items, report) {
  const topN = report.metadata.markdown_top;
  lines.push(`## ${title}增长 Top${topN}`);
  lines.push('');

  if (!Array.isArray(items) || items.length === 0) {
    lines.push('(未发现增长的对象)');
    lines.push('');
    return;
  }

  lines.push(
    `| 排名 | 对象及源码位置 | ${markdownCell(report.baseline.label)} 每快照均值 | ` +
    `${markdownCell(report.current.label)} 每快照均值 | 每快照平均增长 | 增长率 | 新版本最大累计链 |`,
  );
  lines.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const item of items) {
    lines.push(
      `| ${item.experimental_rank} | ${markdownCell(item.object_name || '(未知对象)')} | ` +
      `${item.baseline.snapshot_average_retained_size_text} | ` +
      `${item.current.snapshot_average_retained_size_text} | ` +
      `${item.snapshot_average_growth_text} | ${item.growth_ratio_text} | ` +
      `${item.largest_current_chain?.total_retained_size_text || '-'} |`,
    );
  }
  lines.push('');
}

function appendExperimentalLargestCurrentChain(lines, item, report) {
  const chain = item.largest_current_chain;
  lines.push(`#### ${report.current.label} 最大累计引用链`);
  lines.push('');

  if (!chain) {
    lines.push('(无可用引用链)');
    lines.push('');
    return;
  }

  appendMarkdownKeyValueTable(lines, [
    ['累计大小', chain.total_retained_size_text],
    ['出现次数', `${chain.occurrence_count}/${report.current.successful_snapshot_count} (${formatPercentRatio(chain.occurrence_ratio)})`],
    ['出现时平均大小', chain.average_retained_size_text],
    ['单次最大大小', chain.max_retained_size_text],
    ['根节点类型', chain.root_type || '-'],
    ['合并相似链数', chain.similar_chain_count],
  ]);
  lines.push('代表路径:');
  appendSerializedPathEntries(lines, chain.representative_path_entries, chain.root_type);
  lines.push('');

  const details = Array.isArray(chain.occurrenceDetails) ? chain.occurrenceDetails : [];
  if (details.length === 0) {
    return;
  }

  lines.push('命中快照明细:');
  lines.push('');
  lines.push('| 快照 | 单快照排名 | 对象数 | 该链大小 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const detail of details) {
    lines.push(
      `| ${markdownCell(detail.snapshot_name || detail.snapshot || '-')} | ` +
      `${detail.rank > 0 ? detail.rank : '-'} | ${detail.count || 0} | ` +
      `${detail.total_retained_size_text || formatSize(detail.total_retained_size || 0)} |`,
    );
  }
  lines.push('');
}

function appendExperimentalObjectDetailSection(lines, title, items, report) {
  const topN = report.metadata.markdown_top;
  lines.push(`## ${title}增长详情 Top${topN}`);
  lines.push('');

  if (!Array.isArray(items) || items.length === 0) {
    lines.push('(未发现增长的对象)');
    lines.push('');
    return;
  }

  for (const item of items) {
    lines.push(`### #${item.experimental_rank} ${item.object_name || '(未知对象)'}`);
    lines.push('');
    const objectRows = [
      ['每快照平均增长', item.snapshot_average_growth_text],
      ['增长率', item.growth_ratio_text],
      ['Retained Size 来源', '从每份 heapsnapshot 的完整支配树独立重算'],
      ['对象匹配方式', '公共对象名统一为 JS... 规范名，并归一化依赖包版本和混淆函数名'],
    ];
    if (Array.isArray(item.object_name_variants) && item.object_name_variants.length > 1) {
      objectRows.push(['归并名称变体', item.object_name_variants.join(', ')]);
    }
    appendMarkdownKeyValueTable(lines, objectRows);

    lines.push('| 版本 | 成功快照 | 出现次数 | 出现率 | 对象节点数 | 计入 Retained 根对象数 | 对象累计大小 | 每快照均值 |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const [version, summary] of [
      [report.baseline.label, item.baseline],
      [report.current.label, item.current],
    ]) {
      lines.push(
        `| ${markdownCell(version)} | ${summary.successful_snapshot_count} | ` +
        `${summary.occurrence_count} | ${formatPercentRatio(summary.occurrence_ratio)} | ` +
        `${summary.total_count} | ${summary.retained_root_count} | ` +
        `${summary.total_retained_size_text} | ${summary.snapshot_average_retained_size_text} |`,
      );
    }
    lines.push('');

    appendExperimentalLargestCurrentChain(lines, item, report);
    lines.push('---');
    lines.push('');
  }
}

function appendExperimentalComparisonNotes(lines, report) {
  const metadata = report.metadata;
  lines.push('## 比较说明');
  lines.push('');
  appendMarkdownKeyValueTable(lines, [
    ['基线版本', `${report.baseline.label} (${report.baseline.input_dir})`],
    ['新版本', `${report.current.label} (${report.current.input_dir})`],
    ['输出目录', metadata.output_dir],
    ['生成时间', metadata.generated_at],
    ['对象差值口径', metadata.comparison_metric],
    ['Retained Size 重算规则', metadata.retained_size_recalculation_rule],
    ['对象统计范围', metadata.object_scope],
    ['对象匹配规则', metadata.matching_rule],
    ['对象排序规则', '只保留正增长；先按每快照平均增长降序，再按新版本每快照均值降序'],
    ['最大链规则', '仅从新版本选择跨快照累计 Retained Size 最大的相似引用链组'],
  ]);
}

function renderExperimentalVersionComparisonMarkdown(report) {
  const lines = ['# 测试版不同版本 Heap 对象增长对比报告', ''];
  appendExperimentalGrowthTable(
    lines, categoryText('business'), report.business_top_growth, report,
  );
  appendExperimentalGrowthTable(
    lines, categoryText('common'), report.common_top_growth, report,
  );
  appendExperimentalComparisonNotes(lines, report);
  appendVersionSnapshotStatsMarkdown(lines, report);
  appendExperimentalObjectDetailSection(
    lines, categoryText('business'), report.business_top_growth, report,
  );
  appendExperimentalObjectDetailSection(
    lines, categoryText('common'), report.common_top_growth, report,
  );
  return `${lines.join('\n')}\n`;
}

export {
  appendExperimentalComparisonNotes,
  appendExperimentalGrowthTable,
  appendExperimentalLargestCurrentChain,
  appendExperimentalObjectDetailSection,
  appendObjectStatusOverview,
  appendSimilarChainFamiliesMarkdown,
  appendVersionComparisonOverviewMarkdown,
  appendVersionCurrentLargestChains,
  appendVersionGrowthSection,
  appendVersionObjectStatusCategorySection,
  appendVersionObjectStatusItem,
  appendVersionObjectSummaryTable,
  appendVersionSnapshotStatsMarkdown,
  appendVersionStatusMarkdown,
  buildVersionObjectMarkdownRows,
  getItemSimilarChainFamilies,
  getSimilarChainFamilyColorClass,
  getVersionChainFamily,
  hasRenderedVersionObjectDetail,
  renderExperimentalVersionComparisonMarkdown,
  renderSimilarChainFamilyChipHtml,
  renderSimilarChainFamilyChipsHtml,
  renderSimilarChainFamilyLinksMarkdown,
  renderSimilarChainFamilyOverviewHtml,
  renderVersionChainDetailsHtml,
  renderVersionChainHtml,
  renderVersionChainPathHtml,
  renderVersionChainsHtml,
  renderVersionComparisonHtml,
  renderVersionComparisonMainHtml,
  renderVersionComparisonMarkdown,
  renderVersionObjectHtmlCategory,
  renderVersionObjectItemHtml,
  renderVersionObjectSummaryRow,
  renderVersionOverviewObjectMarkdown,
  renderVersionSnapshotStatsHtml,
  renderVersionStatusHtmlSection,
  renderVersionStatusOverviewHtml,
  renderVersionSummaryHtml,
  versionComparisonClientScript,
  versionComparisonStyles,
};
