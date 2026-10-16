import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  ShieldAlert,
  TimerReset
} from 'lucide-react';
import { ageLabel, dataWarnings, evidenceByRole, formatTime, minutesLabel, pct, priceText, signedPoints } from '../presentation';
import type { MarketCard, Verdict } from '../types';

function verdictIcon(verdict: Verdict) {
  if (verdict === 'BULLISH') return ArrowUpRight;
  if (verdict === 'BEARISH') return ArrowDownRight;
  return Activity;
}

/** Renders one desk. Every verdict and decision comes from the API; nothing is recomputed here. */
export function MarketCardView({ card, refreshMinutes }: { card: MarketCard; refreshMinutes: number }) {
  const DirectionIcon = verdictIcon(card.verdict);
  const { direction, risk, context } = evidenceByRole(card);
  const warnings = dataWarnings(card);
  const record = card.trackRecord;
  const calibration = card.calibration;
  const quality = card.signalQuality;
  const isUnavailable = card.verdict === 'UNAVAILABLE';

  return (
    <article className={`signal-card ${card.slug} ${card.decision.tone}`}>
      <div className="signal-card-head">
        <div>
          <span className="market-kicker">{card.slug === 'nifty' ? 'INDIA · NIFTY 50' : 'GLOBAL · BITCOIN'}</span>
          <h2>{card.slug === 'nifty' ? 'Nifty 50' : 'Bitcoin'}</h2>
        </div>
        <span className={`feed-state ${card.availability}`}>{card.availability === 'live' ? 'LIVE DATA' : card.availability.toUpperCase()}</span>
      </div>

      <div className="price-line">
        <strong>{priceText(card)}</strong>
        <span className={card.priceChangePct == null ? 'muted' : card.priceChangePct >= 0 ? 'positive' : 'negative'}>
          {card.priceChangePct == null ? '--' : `${card.priceChangePct >= 0 ? '+' : ''}${card.priceChangePct.toFixed(2)}%`}
        </span>
      </div>

      {warnings.length > 0 && (
        <div className="data-warning" role="alert">
          <AlertTriangle />
          <div>
            <strong>Data warning</strong>
            {warnings.map((source) => (
              <span key={source.name}>{source.name}: {source.status === 'stale' ? `stale (${ageLabel(source)}), excluded from scoring` : source.message}</span>
            ))}
          </div>
        </div>
      )}

      <div className="direction-read">
        <p>{refreshMinutes}-minute research read</p>
        <div className={`direction-title ${card.verdict.toLowerCase()}`}>
          <DirectionIcon />
          <strong>{card.verdict}</strong>
        </div>
        <span>{isUnavailable ? 'No directional call without grounded price data.' : `Signal quality ${quality.score}/100 · uncalibrated, not a win probability`}</span>
      </div>

      <div className={`action-box ${card.decision.tone}`}>
        <small>RESEARCH POSTURE</small>
        <strong>{card.decision.action}</strong>
        <p>{card.decision.copy}</p>
      </div>

      <div className={`validity ${card.session.open ? '' : 'expired'}`}>
        <TimerReset />
        <div><strong>{card.session.label}</strong><span>{card.session.detail}</span></div>
      </div>

      <div className="score-readout">
        <span>DIRECTIONAL SCORE</span>
        <strong>{card.score >= 0 ? '+' : ''}{card.score} / 100</strong>
      </div>

      <div className="probability-panel">
        <div>
          <small>CALIBRATED PROBABILITY</small>
          {calibration.status === 'calibrated' && calibration.calibratedProbabilities ? (
            <p className="calibrated">
              ↑ {calibration.calibratedProbabilities.bullish}% · – {calibration.calibratedProbabilities.neutral}% · ↓ {calibration.calibratedProbabilities.bearish}%
              <em>Held-out Brier {calibration.brier} vs class-frequency {calibration.empiricalBrier} (lower is better; uniform 0.667)</em>
            </p>
          ) : calibration.status === 'no_skill' ? (
            <p className="unavailable-copy">Not shown · no skill vs class frequencies (Brier {calibration.brier} vs {calibration.empiricalBrier})</p>
          ) : (
            <p className="unavailable-copy">Unavailable · {calibration.sampleSize}/{calibration.required} independent outcomes</p>
          )}
        </div>
        {!isUnavailable && (
          <p className="heuristic-split">
            Heuristic split (uncalibrated): ↑ {card.probabilities.bullish} · – {card.probabilities.neutral} · ↓ {card.probabilities.bearish}
          </p>
        )}
      </div>

      <div className="reason-list">
        <small>WHAT MOVES THE SCORE</small>
        {direction.length ? direction.slice(0, 4).map((reason) => (
          <div key={reason.key}><span className={reason.contribution >= 0 ? 'up' : 'down'} /> <b>{reason.label}</b><em>{reason.value} · {signedPoints(reason.contribution)}</em></div>
        )) : <p>Grounded reasons are not available yet.</p>}
      </div>

      <details className="detail-panel">
        <summary>Analyst contributions</summary>
        <table className="mini-table">
          <thead><tr><th>Analyst</th><th>Score</th><th>Weight</th><th>Adds</th></tr></thead>
          <tbody>
            {card.analysts.map((analyst) => (
              <tr key={analyst.key} title={analyst.summary}>
                <td>{analyst.name}</td>
                <td>{analyst.inputs ? analyst.score : '—'}</td>
                <td>{analyst.key === 'risk' ? 'quality only' : `${analyst.effectiveWeightPct}%`}</td>
                <td>{analyst.key === 'risk' ? '—' : signedPoints(analyst.contribution)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {direction.length > 4 && (
          <ul className="plain-list">
            {direction.slice(4).map((item) => <li key={item.key}>{item.label}: {item.value} ({signedPoints(item.contribution)})</li>)}
          </ul>
        )}
      </details>

      <details className="detail-panel">
        <summary>Risk & signal quality</summary>
        <p className="panel-note">Coverage {pct(quality.coverage * 100)} · agreement {pct(quality.agreement * 100)} · risk adjustment {quality.riskAdjustment >= 0 ? '+' : ''}{quality.riskAdjustment}. Risk changes signal quality, never direction.</p>
        <ul className="plain-list">
          {risk.map((item) => <li key={item.key}><b>{item.label}</b> {item.value}</li>)}
          {card.risks.map((line) => <li key={line} className="risk-item">{line}</li>)}
        </ul>
      </details>

      {(context.length > 0 || card.breadth || card.options || card.derivatives) && (
        <details className="detail-panel">
          <summary>Market context (not scored)</summary>
          <ul className="plain-list">
            {context.map((item) => <li key={item.key} title={item.reason}><b>{item.label}</b> {item.value}</li>)}
          </ul>
          {card.breadth && card.breadth.sectors.length > 0 && (
            <p className="panel-note">Sectors: {card.breadth.sectors.map((sector) => `${sector.name} ${sector.changePct >= 0 ? '+' : ''}${sector.changePct}%`).join(' · ')}</p>
          )}
          {card.options && card.options.flowBreakdown.length > 0 && (
            <p className="panel-note">OI flow ({card.options.flowAdjusted ? 'delta/theta-adjusted' : 'raw premiums'}): {card.options.flowBreakdown.slice(0, 4).map((flow) => `${flow.label} ${flow.contracts.toLocaleString('en-IN')}`).join(' · ')}</p>
          )}
          {card.derivatives && <p className="panel-note">Derivatives source: {card.derivatives.source}</p>}
        </details>
      )}

      {card.events.length > 0 && (
        <div className="event-list">
          <small><CalendarClock /> SCHEDULED EVENTS</small>
          {card.events.slice(0, 3).map((event) => (
            <a key={`${event.name}-${event.scheduledAt}`} href={event.sourceUrl} target="_blank" rel="noreferrer">
              <b>{event.name}</b><span>{formatTime(event.scheduledAt)} IST · {minutesLabel(event.minutesUntil)} · {event.source}</span>
            </a>
          ))}
        </div>
      )}

      <div className="track-record">
        <small>FORWARD TRACK RECORD · {card.modelVersion}</small>
        <p>
          {record.nonOverlapping.n} independent outcomes
          {record.nonOverlapping.hitRate != null && ` · hit rate ${record.nonOverlapping.hitRate}%`}
          {record.nonOverlapping.ci95 && ` (95% CI ${Math.round(record.nonOverlapping.ci95.low * 100)}–${Math.round(record.nonOverlapping.ci95.high * 100)}%)`}
          {record.nonOverlapping.alwaysNeutralHitRate != null && ` · always-neutral ${record.nonOverlapping.alwaysNeutralHitRate}%`}
        </p>
        <span>{record.resolved} resolved · {record.pending} pending · {record.unresolvable} unresolvable. {record.note}</span>
      </div>

      <details className="detail-panel">
        <summary>Data sources ({card.sources.filter((source) => source.status === 'live').length}/{card.sources.length} live)</summary>
        <ul className="source-list">
          {card.sources.map((source) => (
            <li key={source.name} className={source.status}>
              <b>{source.name}</b> <em>{source.status}{source.optional ? ' · optional' : ''}{ageLabel(source) ? ` · ${ageLabel(source)}` : ''}</em>
              <span>{source.message}</span>
            </li>
          ))}
        </ul>
      </details>

      <div className="risk-line"><ShieldAlert /> <span>{card.risks[0]}</span></div>
    </article>
  );
}
