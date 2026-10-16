import type { ReliabilityBin } from '../evaluation.js';
import { OUTCOME_CLASSES, type OutcomeClass } from '../outcomes.js';
import type { BacktestReport, EvaluationBlock } from './engine.js';

export interface RunMetadata {
  command: string;
  generatedAt: string;
  gitCommit: string | null;
  gitDirty: boolean | null;
  requestedRange: { start: string; end: string };
  dataSources: string[];
  /** sha256 of the exact candle/series data used, per series. */
  fingerprints: Record<string, { count: number; first: string | null; last: string | null; sha256: string }>;
  artifacts: string[];
}

const pct = (value: number | null | undefined, digits = 1) => value == null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
const num = (value: number | null | undefined, digits = 3) => value == null ? 'n/a' : value.toFixed(digits);
const signed = (value: number | null | undefined, digits = 3) => value == null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
const interval = (low: number | null | undefined, high: number | null | undefined, digits = 3) => low == null || high == null ? '' : ` [${low.toFixed(digits)}, ${high.toFixed(digits)}]`;
const distribution = (value: Record<OutcomeClass, number>) => {
  const total = OUTCOME_CLASSES.reduce((sum, cls) => sum + value[cls], 0) || 1;
  return OUTCOME_CLASSES.map((cls) => `${cls[0]} ${((value[cls] / total) * 100).toFixed(0)}%`).join(' / ');
};

function classificationTable(block: EvaluationBlock) {
  const rows = Object.entries(block.classification).map(([name, report]) => {
    const f1 = block.intervals?.macroF1[name as keyof typeof block.intervals.macroF1];
    const ba = block.intervals?.balancedAccuracy[name as keyof typeof block.intervals.balancedAccuracy];
    return `| ${name} | ${report.n} | ${pct(report.accuracy)}${interval(report.accuracyCi95?.low, report.accuracyCi95?.high, 2)} | ${num(report.balancedAccuracy)}${interval(ba?.low, ba?.high)} | ${num(report.macroF1)}${interval(f1?.low, f1?.high)} | ${distribution(report.predictedDistribution)} | ${pct(block.abstentionRate[name as keyof typeof block.abstentionRate], 0)} |`;
  });
  return ['| Classifier | n | Accuracy [Wilson 95%] | Balanced acc [boot 95%] | Macro-F1 [boot 95%] | Predicted mix U/N/D | Abstain |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

function perClassTable(block: EvaluationBlock, name: 'handSet' | 'logistic' | 'momentum' | 'majority') {
  const report = block.classification[name];
  return [`| ${name} class | Precision | Recall | F1 | Support | Predicted |`, '|---|---|---|---|---|---|',
    ...OUTCOME_CLASSES.map((cls) => `| ${cls} | ${num(report.perClass[cls].precision)} | ${num(report.perClass[cls].recall)} | ${num(report.perClass[cls].f1)} | ${report.perClass[cls].support} | ${report.perClass[cls].predicted} |`)].join('\n');
}

function confusionTable(block: EvaluationBlock, name: 'handSet' | 'logistic') {
  const confusion = block.classification[name].confusion;
  return [`| ${name}: actual \\ predicted | UP | NEUTRAL | DOWN |`, '|---|---|---|---|',
    ...OUTCOME_CLASSES.map((actual) => `| ${actual} | ${OUTCOME_CLASSES.map((predicted) => confusion[actual][predicted]).join(' | ')} |`)].join('\n');
}

function probabilityTable(block: EvaluationBlock) {
  const rows = Object.entries(block.probability).map(([name, report]) => {
    const diff = block.intervals?.brierDifferenceVsEmpirical[name];
    return `| ${name} | ${num(report.brier)} | ${diff ? `${signed(diff.estimate)}${interval(diff.low, diff.high)}` : '—'} | ${signed(block.brierSkillVsEmpirical[name as keyof typeof block.brierSkillVsEmpirical])} | ${num(report.logLoss)} | ${signed(block.logLossSkillVsEmpirical[name as keyof typeof block.logLossSkillVsEmpirical])} | ${num(report.reliability, 4)} | ${num(report.resolution, 4)} | ${num(report.uncertainty, 4)} |`;
  });
  return ['| Forecast | Brier (0–2, lower better) | Brier − empirical [boot 95%] | Brier skill vs empirical | Log loss | Log-loss skill | Reliability (lower better) | Resolution (higher better) | Uncertainty |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

function tradingTable(block: EvaluationBlock) {
  if (!block.trading) return '';
  const { strategies, benchmarks } = block.trading;
  const row = (name: string, stats: typeof strategies.handSet) => `| ${name} | ${stats.trades} (${stats.longs}L/${stats.shorts}S) | ${pct(stats.winRate)} | ${signed(stats.averageWinPct)} / ${signed(stats.averageLossPct)} | ${num(stats.profitFactor, 2)} | ${signed(stats.grossCompoundedReturnPct, 2)}% | **${signed(stats.compoundedReturnPct, 2)}%** | ${signed(stats.additiveReturnPct, 2)} | ${num(stats.maxDrawdownPct, 2)}% | ${pct(stats.exposure, 0)} | ${num(stats.totalCostsPct, 1)}% |`;
  return [
    `Rules: ${block.trading.rules} Round-trip cost ${strategies.handSet.costPerRoundTripPct}%.`,
    '',
    '| Strategy | Trades | Win rate | Avg win / loss (net %) | Profit factor | Gross compounded | Net compounded | Net additive (sum of %) | Max drawdown | Exposure | Costs paid |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    row('handSet', strategies.handSet),
    row('logistic', strategies.logistic),
    row('momentum', strategies.momentum),
    row('always long (same windows)', benchmarks.alwaysLongSameWindows),
    row('no trade', benchmarks.noTrade),
    `| buy & hold (whole period) | 1 | — | — | — | — | **${signed(benchmarks.buyAndHoldPct, 2)}%** | — | — | 100% | — |`,
    '',
    'Cost sensitivity (net compounded %):',
    '',
    '| Round-trip cost | hand-set net | hand-set max DD | momentum net |',
    '|---|---|---|---|',
    ...block.trading.costSensitivity.map((row) => `| ${row.costPct}% | ${signed(row.handSetNetPct, 2)}% | ${num(row.handSetMaxDrawdownPct, 2)}% | ${signed(row.momentumNetPct, 2)}% |`)
  ].join('\n');
}

export function renderMarkdown(report: BacktestReport, meta: RunMetadata) {
  const lines: string[] = [];
  lines.push(`# ${report.market.toUpperCase()} backtest — ${report.modelVersion}`, '');
  lines.push(`Generated ${meta.generatedAt} by \`${meta.command}\` at commit ${meta.gitCommit ?? 'unknown'}${meta.gitDirty ? ' (uncommitted changes present)' : ''}.`, '');
  lines.push('## Data and splits', '');
  lines.push(`- Requested range: ${meta.requestedRange.start} → ${meta.requestedRange.end} (UTC). Sources: ${meta.dataSources.join('; ')}.`);
  for (const [name, print] of Object.entries(meta.fingerprints)) lines.push(`- \`${name}\`: ${print.count} rows, ${print.first} → ${print.last}, sha256 \`${print.sha256.slice(0, 16)}…\``);
  lines.push(`- Decision points: ${report.dataset.observations}; excluded UNAVAILABLE: ${report.dataset.excludedUnavailable}; usable: ${report.dataset.usable}.`);
  lines.push(`- Development: ${report.dataset.development.n} (${report.dataset.development.from} → ${report.dataset.development.to}); untouched test: ${report.dataset.test.n} (${report.dataset.test.from} → ${report.dataset.test.to}); purged at boundary: ${report.dataset.purgedAtTestBoundary}.`);
  lines.push(`- Settings: horizon ${report.settings.horizonMinutes} min; ${report.settings.developmentBlocks - 1} walk-forward folds; outcome thresholds ${report.settings.outcomeThresholds.join(', ')}%; verdict grid ±${report.settings.verdictThresholds.join(', ±')}; L2 grid ${report.settings.lambdas.join(', ')}; ${report.settings.bootstrapIterations} bootstrap resamples; round-trip cost ${report.settings.roundTripCostPct}%.`, '');

  lines.push('## Threshold sensitivity (development folds only)', '');
  lines.push('Each row relabels outcomes with ±t% and refits everything inside each fold. Lift = model macro-F1 minus the best of majority / always-neutral / momentum in the same fold.', '');
  lines.push('| t | Dev label mix U/N/D | Fold n | hand-set F1 | logistic F1 | majority F1 | momentum F1 | neutral F1 | hand-set lift (folds > 0) | logistic lift (folds > 0) | hand-set abstain | Brier skill: calibrated / logistic |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of report.thresholdSensitivity) {
    const s = row.summary;
    const abstain = row.folds.length ? row.folds.reduce((sum, fold) => sum + (fold.abstentionRate.handSet ?? 0), 0) / row.folds.length : null;
    lines.push(`| ${row.outcomeThreshold}% | ${distribution(row.developmentDistribution)} | ${row.folds.map((fold) => fold.n).join('/')} | ${num(s.meanMacroF1.handSet)} | ${num(s.meanMacroF1.logistic)} | ${num(s.meanMacroF1.majority)} | ${num(s.meanMacroF1.momentum)} | ${num(s.meanMacroF1.alwaysNeutral)} | ${signed(s.meanLiftOverBestBaseline.handSet)} (${s.foldsWithPositiveLift.handSet}/${row.folds.length}) | ${signed(s.meanLiftOverBestBaseline.logistic)} (${s.foldsWithPositiveLift.logistic}/${row.folds.length}) | ${pct(abstain, 0)} | ${signed(s.meanBrierSkillVsEmpirical.scoreCalibrated)} / ${signed(s.meanBrierSkillVsEmpirical.logistic)} |`);
  }
  lines.push('', 'Hand-set strategy per development fold (gross → net compounded %, trades):', '');
  for (const row of report.thresholdSensitivity) {
    lines.push(`- ±${row.outcomeThreshold}%: ${row.folds.map((fold) => `${signed(fold.handSetTrading.grossPct, 1)} → ${signed(fold.handSetTrading.netPct, 1)} (${fold.handSetTrading.trades}, ±${fold.verdictThreshold})`).join(' | ')}`);
  }
  lines.push('', `Selection rule: ${report.selection.rule}`, `Selected threshold: **±${report.selection.selectedOutcomeThreshold}%** (development only). Persistent improvement — hand-set: ${report.selection.persistentImprovement.handSet ? 'yes' : 'no'}, logistic: ${report.selection.persistentImprovement.logistic ? 'yes' : 'no'}.`, '');

  for (const final of report.finalTest) {
    const block = final.result;
    lines.push(`## Untouched test — ±${final.outcomeThreshold}% (${final.label})`, '');
    lines.push(`Fitted on development (${final.fitted.trainRange.n} rows, ${final.fitted.trainRange.from} → ${final.fitted.trainRange.to}): verdict threshold ±${final.fitted.verdictThreshold}, majority class ${final.fitted.majorityClass}, logistic λ ${final.fitted.lambda}. Test windows: ${block.n} non-overlapping (${block.range.from} → ${block.range.to}). Actual mix: ${distribution(block.classification.handSet.actualDistribution)}.`, '');
    lines.push('### Classification (same windows, same labels)', '', classificationTable(block), '');
    lines.push(perClassTable(block, 'handSet'), '', perClassTable(block, 'logistic'), '', confusionTable(block, 'handSet'), '', confusionTable(block, 'logistic'), '');
    if (block.intervals) {
      lines.push('Paired macro-F1 lift (model − baseline) [bootstrap 95%]:', '');
      for (const [pair, value] of Object.entries(block.intervals.macroF1Lift)) lines.push(`- ${pair}: ${signed(value.estimate)}${interval(value.low, value.high)}`);
      lines.push('');
    }
    lines.push('### Probability quality', '', probabilityTable(block), '');
    lines.push(`Discrimination (one-vs-rest ROC AUC, 0.5 = none): hand-set score UP ${num(block.discrimination.handSetScore.up)}, DOWN ${num(block.discrimination.handSetScore.down)}; logistic UP ${num(block.discrimination.logistic.up)}, DOWN ${num(block.discrimination.logistic.down)}.`, '');
    const coefficients = final.fitted.logisticCoefficients;
    const strongest = (cls: OutcomeClass) => Object.entries(coefficients[cls]).sort((left, right) => Math.abs(right[1]) - Math.abs(left[1])).slice(0, 4).map(([name, value]) => `${name} ${signed(value, 2)}`).join(', ');
    lines.push(`Largest standardised logistic coefficients — UP: ${strongest('UP')}; NEUTRAL: ${strongest('NEUTRAL')}; DOWN: ${strongest('DOWN')}.`, '');
    lines.push('### Trading simulation', '', tradingTable(block), '');
  }

  if (report.ablation.length) {
    lines.push('## Ablation (last development fold, hand-set macro-F1)', '', '| Removed | Macro-F1 | Δ vs full |', '|---|---|---|');
    for (const row of report.ablation) lines.push(`| ${row.removed} | ${num(row.macroF1)} | ${signed(row.deltaVsFull)} |`);
    lines.push('');
  }
  lines.push('## Limitations', '', ...report.limitations.map((line) => `- ${line}`), '');
  lines.push('## Definitions', '', ...Object.entries(report.definitions).map(([key, value]) => `- **${key}**: ${value}`), '');
  lines.push('## Artifacts', '', ...meta.artifacts.map((path) => `- \`${path}\``), '');
  return lines.join('\n');
}

/** Class-wise reliability diagram (forecast vs observed frequency) as a standalone SVG. */
export function reliabilitySvg(title: string, series: Record<string, Record<OutcomeClass, ReliabilityBin[]>>) {
  const panel = 220;
  const pad = 36;
  const width = OUTCOME_CLASSES.length * (panel + pad) + pad;
  const height = panel + pad * 2 + 40;
  const colors = ['#2a6f97', '#c05621', '#2f855a', '#6b46c1'];
  const names = Object.keys(series);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="11">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/><text x="${pad}" y="20" font-size="13" font-weight="bold">${title}</text>`);
  OUTCOME_CLASSES.forEach((cls, index) => {
    const x0 = pad + index * (panel + pad);
    const y0 = pad + 10;
    const px = (value: number) => x0 + value * panel;
    const py = (value: number) => y0 + panel - value * panel;
    parts.push(`<rect x="${x0}" y="${y0}" width="${panel}" height="${panel}" fill="none" stroke="#999"/>`);
    parts.push(`<line x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}" stroke="#bbb" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${x0}" y="${y0 - 6}" font-weight="bold">${cls}</text>`);
    parts.push(`<text x="${x0 + panel / 2}" y="${y0 + panel + 16}" text-anchor="middle">forecast probability</text>`);
    if (index === 0) parts.push(`<text x="${x0 - 24}" y="${y0 + panel / 2}" transform="rotate(-90 ${x0 - 24} ${y0 + panel / 2})" text-anchor="middle">observed frequency</text>`);
    names.forEach((name, seriesIndex) => {
      const bins = series[name][cls];
      if (!bins.length) return;
      const points = bins.map((bin) => `${px(bin.meanForecast).toFixed(1)},${py(bin.observedFrequency).toFixed(1)}`).join(' ');
      parts.push(`<polyline points="${points}" fill="none" stroke="${colors[seriesIndex % colors.length]}" stroke-width="1.5"/>`);
      for (const bin of bins) parts.push(`<circle cx="${px(bin.meanForecast).toFixed(1)}" cy="${py(bin.observedFrequency).toFixed(1)}" r="${Math.min(6, 1.5 + Math.sqrt(bin.n) / 3).toFixed(1)}" fill="${colors[seriesIndex % colors.length]}" fill-opacity="0.6"/>`);
    });
  });
  names.forEach((name, index) => {
    parts.push(`<rect x="${pad + index * 140}" y="${height - 18}" width="10" height="10" fill="${colors[index % colors.length]}"/><text x="${pad + index * 140 + 14}" y="${height - 9}">${name}</text>`);
  });
  parts.push('</svg>');
  return parts.join('\n');
}
