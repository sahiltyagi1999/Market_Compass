import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock3, ExternalLink, Newspaper, RefreshCw, ShieldAlert, Signal } from 'lucide-react';
import { MarketCardView } from './components/MarketCardView';
import { formatClock, formatTime } from './presentation';
import type { DashboardResponse, HeadlineSignal, MarketCard } from './types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const RETRY_MS = 60_000;

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
  const [nextRefreshAt, setNextRefreshAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const nextRefreshRef = useRef(0);

  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/dashboard`);
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const next: DashboardResponse = await response.json();
      setDashboard(next);
      // The server locks a new prediction every 15 minutes; fetch right after it lands.
      const due = new Date(next.nextUpdateAt).getTime();
      nextRefreshRef.current = Number.isFinite(due) && due > Date.now() ? due + 3_000 : Date.now() + RETRY_MS;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load dashboard');
      nextRefreshRef.current = Date.now() + RETRY_MS;
    } finally {
      inFlight.current = false;
      setNextRefreshAt(nextRefreshRef.current);
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    // Background tabs get throttled or frozen, so catch up as soon as the user returns.
    const catchUp = () => {
      if (document.visibilityState === 'visible' && Date.now() >= nextRefreshRef.current) void refresh();
    };
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('online', catchUp);
    return () => {
      window.clearInterval(clock);
      document.removeEventListener('visibilitychange', catchUp);
      window.removeEventListener('online', catchUp);
    };
  }, []);

  useEffect(() => {
    if (nextRefreshAt && now >= nextRefreshAt) void refresh();
  }, [now, nextRefreshAt]);

  const secondsToRefresh = Math.max(0, Math.ceil((nextRefreshAt - now) / 1000));
  const countdown = `${Math.floor(secondsToRefresh / 60)}:${String(secondsToRefresh % 60).padStart(2, '0')}`;

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
          <span className="timestamp"><Clock3 /> {formatTime(dashboard.generatedAt)} IST · next {formatClock(dashboard.nextUpdateAt)}</span>
          <button className="refresh" onClick={() => void refresh()} disabled={loading} title="A fresh prediction is built every 15 minutes">
            <RefreshCw className={loading ? 'spin' : ''} /> <span>Refresh</span>
            <em className="countdown">{loading ? '…' : countdown}</em>
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
          <div><strong>Experimental, uncalibrated research model</strong><span>Directional score and signal quality are heuristics, not win probabilities. Historical backtests have not shown a reliable edge yet; setups unlock only when the independent forward track record beats its baselines.</span></div>
        </div>

        <section className="signal-grid" aria-label="Market signals">
          {dashboard.cards.map((card) => <MarketCardView card={card} refreshMinutes={dashboard.refreshMinutes} key={card.slug} />)}
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
          <p><strong>Research signal, not an order instruction.</strong> Prediction history: {dashboard.storage.durable ? 'durable storage' : 'not durable on this host (set DATABASE_URL)'}. Options can multiply losses; confirm price action and define maximum risk before acting. <a href="https://investor.sebi.gov.in/understanding_derivatives.html" target="_blank" rel="noreferrer">SEBI derivatives guidance</a>.</p>
        </footer>
      </main>
    </div>
  );
}
