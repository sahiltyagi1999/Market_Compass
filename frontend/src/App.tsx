import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Clock3,
  ExternalLink,
  Newspaper,
  RefreshCw,
  ShieldAlert,
  Signal,
  TimerReset
} from 'lucide-react';
import type { DashboardResponse, HeadlineSignal, MarketCard, Verdict } from './types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function formatTime(value: string | null) {
  if (!value) return 'No live timestamp';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function priceText(card: MarketCard) {
  if (card.price == null) return 'Not available';
  return card.slug === 'crypto'
    ? `$${card.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : card.price.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function verdictIcon(verdict: Verdict) {
  if (verdict === 'BULLISH') return ArrowUpRight;
  if (verdict === 'BEARISH') return ArrowDownRight;
  return Activity;
}

function indiaClock(value: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
  return {
    weekday: read('weekday'),
    minutes: Number(read('hour')) * 60 + Number(read('minute'))
  };
}

function niftyMarketOpen(value: string) {
  const { weekday, minutes } = indiaClock(value);
  return !['Sat', 'Sun'].includes(weekday) && minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30;
}

function signalValidity(card: MarketCard, generatedAt: string) {
  if (card.slug === 'nifty' && !niftyMarketOpen(generatedAt)) {
    return {
      label: 'Market closed',
      detail: 'Recheck after the next 9:15 AM IST open',
      expired: true
    };
  }

  const generated = new Date(generatedAt);
  if (card.slug === 'crypto') {
    return {
      label: 'Live snapshot, not a locked forecast',
      detail: `Generated ${formatTime(generatedAt)} IST; confirm again after the next hourly close`,
      expired: false
    };
  }

  const minutesToClose = 15 * 60 + 30 - indiaClock(generatedAt).minutes;
  const recheckMinutes = Math.max(0, Math.min(120, minutesToClose));
  return {
    label: `Recheck by ${formatTime(new Date(generated.getTime() + recheckMinutes * 60 * 1000).toISOString())} IST`,
    detail: 'Next 2-4 hours, never beyond market close',
    expired: false
  };
}

type Decision = {
  action: string;
  copy: string;
  tone: 'bullish' | 'bearish' | 'neutral';
};

function researchDecision(card: MarketCard, generatedAt: string): Decision {
  if (card.availability === 'unavailable' || card.verdict === 'UNAVAILABLE') {
    return { action: 'WAIT FOR DATA', copy: 'No position until grounded price data returns.', tone: 'neutral' };
  }
  if (card.slug === 'nifty' && !niftyMarketOpen(generatedAt)) {
    return { action: 'WAIT', copy: 'Cash market is closed. Re-evaluate after the next open.', tone: 'neutral' };
  }

  if (card.trackRecord.resolved < 30 || card.trackRecord.hitRate == null || card.trackRecord.hitRate < 55) {
    return {
      action: 'PAPER TRADE ONLY',
      copy: `This model is not calibrated for entries (${card.trackRecord.resolved}/30 resolved outcomes).`,
      tone: 'neutral'
    };
  }

  if (card.verdict === 'NEUTRAL' || card.confidence < 55) {
    return { action: 'WAIT / NO TRADE', copy: 'The directional edge is not strong enough yet.', tone: 'neutral' };
  }
  if (card.slug === 'nifty') {
    return card.verdict === 'BULLISH'
      ? { action: 'BULLISH SETUP', copy: 'Research direction only; confirm entry and risk independently.', tone: 'bullish' }
      : { action: 'BEARISH SETUP', copy: 'Research direction only; confirm entry and risk independently.', tone: 'bearish' };
  }
  return card.verdict === 'BULLISH'
    ? { action: 'BULLISH SETUP', copy: 'Research direction only; this is not a buy instruction.', tone: 'bullish' }
    : { action: 'BEARISH SETUP', copy: 'Research direction only; this is not a sell instruction.', tone: 'bearish' };
}

function fallbackMeaning(tone: HeadlineSignal['tone'], market: MarketCard['slug']) {
  const marketName = market === 'nifty' ? 'Nifty' : 'crypto';
  if (tone === 'positive') return `Positive wording may support ${marketName}.`;
  if (tone === 'negative') return `Negative wording may pressure ${marketName}.`;
  return `No clear directional effect on ${marketName}.`;
}

function importantHeadlines(headlines: HeadlineSignal[]) {
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
  return [...headlines]
    .sort((left, right) => {
      const importance = rank[right.aiImportance || 'LOW'] - rank[left.aiImportance || 'LOW'];
      return importance || new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime();
    })
    .slice(0, 4);
}

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/dashboard`);
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      setDashboard(await response.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load dashboard');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!dashboard && loading) {
    return <main className="loading-screen"><Signal className="pulse" /><p>Building the latest market read...</p></main>;
  }

  if (!dashboard) {
    return (
      <main className="loading-screen">
        <AlertTriangle />
        <p>{error || 'Dashboard unavailable'}</p>
        <button onClick={() => void refresh()}>Try again</button>
      </main>
    );
  }

  const visibleNewsCount = dashboard.cards.reduce((sum, card) => sum + Math.min(card.headlines.length, 4), 0);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#signals" aria-label="Market Compass home">
          <span className="brand-mark"><Signal /></span>
          <span><small>MARKET COMPASS</small><strong>Clear Signal</strong></span>
        </a>
        <nav className="topnav" aria-label="Primary navigation">
          <a href="#signals">Signals</a>
          <a href="#news"><Newspaper /> News <span>{visibleNewsCount}</span></a>
        </nav>
        <div className="topbar-actions">
          <span className="timestamp"><Clock3 /> {formatTime(dashboard.generatedAt)} IST</span>
          <button className="refresh" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? 'spin' : ''} /> <span>Refresh</span>
          </button>
        </div>
      </header>

      <main className="page">
        <section className="intro" id="signals">
          <div>
            <p className="eyebrow">LIVE DECISION DESK</p>
            <h1>Read the market<br />in ten seconds.</h1>
          </div>
          <p>Direction, signal validity and a cautious research posture. Everything else stays out of your way.</p>
        </section>

        {error && <div className="error-banner">Last refresh failed: {error}</div>}

        <div className="calibration-warning" role="note">
          <ShieldAlert />
          <div><strong>Experimental research model</strong><span>Paper-trade until at least 30 forward outcomes are resolved. Scores can change and are not win probabilities.</span></div>
        </div>

        <section className="signal-grid" aria-label="Market signals">
          {dashboard.cards.map((card) => {
            const DirectionIcon = verdictIcon(card.verdict);
            const decision = researchDecision(card, dashboard.generatedAt);
            const validity = signalValidity(card, dashboard.generatedAt);
            const reasons = card.evidence.slice(0, 3);
            return (
              <article className={`signal-card ${card.slug} ${decision.tone}`} key={card.slug}>
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

                <div className="direction-read">
                  <p>Live market snapshot</p>
                  <div className={`direction-title ${card.verdict.toLowerCase()}`}>
                    <DirectionIcon />
                    <strong>{card.verdict}</strong>
                  </div>
                  <span>{card.confidence}% input coverage and agreement</span>
                </div>

                <div className={`action-box ${decision.tone}`}>
                  <small>RESEARCH POSTURE</small>
                  <strong>{decision.action}</strong>
                  <p>{decision.copy}</p>
                </div>

                <div className={`validity ${validity.expired ? 'expired' : ''}`}>
                  <TimerReset />
                  <div><strong>{validity.label}</strong><span>{validity.detail}</span></div>
                </div>

                <div className="score-readout">
                  <span>DIRECTIONAL SCORE</span>
                  <strong>{card.score >= 0 ? '+' : ''}{card.score} / 100</strong>
                </div>
                <p className="score-disclaimer">Live composite strength, not a statistically calibrated probability.</p>

                <div className="reason-list">
                  <small>WHY THIS READ</small>
                  {reasons.length ? reasons.map((reason) => (
                    <div key={reason.key}><span className={reason.contribution >= 0 ? 'up' : 'down'} /> <b>{reason.label}</b><em>{reason.value}</em></div>
                  )) : <p>Grounded reasons are not available yet.</p>}
                </div>

                <div className="risk-line"><ShieldAlert /> <span>{card.risks[0]}</span></div>
              </article>
            );
          })}
        </section>

        <section className="news-section" id="news">
          <div className="news-heading">
            <div><p className="eyebrow">MARKET-MOVING NEWS</p><h2>What changed the direction?</h2></div>
            <p>Only the most important stories, translated into likely market impact.</p>
          </div>

          <div className="news-grid">
            {dashboard.cards.map((card) => {
              const stories = importantHeadlines(card.headlines);
              return (
                <article className="news-column" key={`news-${card.slug}`}>
                  <div className="news-column-head">
                    <div><span>{card.slug === 'nifty' ? 'NIFTY' : 'CRYPTO'}</span><h3>{card.slug === 'nifty' ? 'India market' : 'Digital assets'}</h3></div>
                    <b className={(card.aiAnalysis?.overallImpact || 'NEUTRAL').toLowerCase()}>{card.aiAnalysis?.overallImpact || 'NEUTRAL'}</b>
                  </div>

                  <div className="news-summary">
                    <small>{card.aiAnalysis ? `${card.aiAnalysis.model} · ${card.aiAnalysis.confidence}% confidence` : 'RULES-BASED READ'}</small>
                    <p>{card.aiAnalysis?.summary || 'AI meaning is unavailable; headline wording is used as a fallback.'}</p>
                  </div>

                  <div className="story-list">
                    {stories.length ? stories.map((story) => {
                      const impact = story.aiImpact || (story.tone === 'positive' ? 'BULLISH' : story.tone === 'negative' ? 'BEARISH' : 'NEUTRAL');
                      return (
                        <a className="story" href={story.url} target="_blank" rel="noreferrer" key={`${story.url}-${story.title}`}>
                          <div className="story-meta"><span>{story.source}</span><time>{formatTime(story.publishedAt)} IST</time></div>
                          <h4>{story.title}</h4>
                          <p>{story.aiExplanation || fallbackMeaning(story.tone, card.slug)}</p>
                          <div className="story-foot"><b className={impact.toLowerCase()}>{impact}</b><span>{story.aiImportance || 'NEWS'} IMPACT</span><ExternalLink /></div>
                        </a>
                      );
                    }) : <p className="empty-copy">No recent market-moving stories loaded.</p>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <footer className="footer-note">
          <ShieldAlert />
          <p><strong>Research signal, not an order instruction.</strong> Options can multiply losses; confirm price action and define maximum risk before acting. <a href="https://investor.sebi.gov.in/understanding_derivatives.html" target="_blank" rel="noreferrer">SEBI derivatives guidance</a>.</p>
        </footer>
      </main>
    </div>
  );
}
