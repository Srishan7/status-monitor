/**
 * Status Monitor — Cloudflare Worker
 * Storage: Cloudflare D1 (SQLite) — database binding: DB
 *
 * Endpoints:
 *  ?url=https://...        Ping proxy — HEAD + logs ping + tracks incidents
 *  GET  /ping-logs         Per-URL uptime/latency stats + recent 100 pings
 *  GET  /incidents         Open + recent resolved incidents
 *  POST /log-iframe-metric Save iframe load timing to D1
 *  GET  /iframe-metrics    Iframe timing stats + recent 100 sessions
 *  *                       HTMLRewriter — injects iframe timer into marici.org pages
 */

async function handlePing(env, url, result, now) {
  // 1. Log the ping
  await env.DB.prepare(
    'INSERT INTO ping_logs (url, status, ok, latency, ts) VALUES (?, ?, ?, ?, ?)'
  ).bind(url, result.status, result.ok ? 1 : 0, result.latency, now).run();

  // 2. Incident tracking — check for open incident on this URL
  const { results: [open] } = await env.DB.prepare(
    'SELECT id, started_at FROM incidents WHERE url = ? AND resolved_at IS NULL LIMIT 1'
  ).bind(url).all();

  if (!result.ok && !open) {
    // URL just went DOWN — open a new incident
    await env.DB.prepare(
      'INSERT INTO incidents (url, started_at, error_msg) VALUES (?, ?, ?)'
    ).bind(url, now, result.error || `HTTP ${result.status}`).run();
  } else if (result.ok && open) {
    // URL came back UP — resolve the incident
    await env.DB.prepare(
      'UPDATE incidents SET resolved_at = ?, duration_ms = ? WHERE id = ?'
    ).bind(now, now - open.started_at, open.id).run();
  }
}

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

    // ── CORS preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST' },
      });
    }

    // ── 1. Ping proxy (?url= param) ──
    const targetUrl = url.searchParams.get('url');
    if (targetUrl) {
      let parsed;
      try {
        parsed = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid URL' }), { status: 400, headers: CORS });
      }

      const t0 = Date.now();
      let result;
      try {
        const resp = await fetch(targetUrl, {
          method: 'HEAD', redirect: 'follow',
          headers: { 'User-Agent': 'StatusMonitor/1.0' },
        });
        const latency = Date.now() - t0;
        const ok = resp.status >= 200 && resp.status < 400;
        result = { status: resp.status, ok, latency, redirected: resp.redirected };
      } catch (e) {
        result = { status: 0, ok: false, latency: null, error: e.message };
      }

      if (env.DB) ctx.waitUntil(handlePing(env, targetUrl, result, Date.now()));

      return new Response(JSON.stringify(result), { headers: CORS });
    }

    // ── 2. Ping logs API — GET /ping-logs ──
    if (url.pathname === '/ping-logs' && request.method === 'GET') {
      if (!env.DB) return new Response(JSON.stringify({ error: 'DB not bound' }), { status: 500, headers: CORS });
      try {
        const { results: recent } = await env.DB.prepare(
          'SELECT url, status, ok, latency, ts AS timestamp FROM ping_logs ORDER BY ts DESC LIMIT 100'
        ).all();

        const { results: forStats } = await env.DB.prepare(
          'SELECT url, ok, latency FROM ping_logs ORDER BY ts DESC LIMIT 2000'
        ).all();

        const byUrl = {};
        for (const e of forStats) {
          if (!byUrl[e.url]) byUrl[e.url] = { lats: [], upCount: 0, total: 0 };
          byUrl[e.url].total++;
          if (e.ok) byUrl[e.url].upCount++;
          if (e.latency !== null) byUrl[e.url].lats.push(e.latency);
        }
        const stats = Object.entries(byUrl).map(([u, d]) => {
          const sorted = [...d.lats].sort((a, b) => a - b);
          return {
            url:    u,
            count:  d.total,
            uptime: Math.round(d.upCount / d.total * 100),
            avg:    d.lats.length ? Math.round(d.lats.reduce((a, b) => a + b, 0) / d.lats.length) : null,
            p95:    sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)]) : null,
          };
        });

        const { results: [{ n: total }] } = await env.DB.prepare('SELECT COUNT(*) AS n FROM ping_logs').all();

        return new Response(JSON.stringify({ total, stats, recent }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 3. Incidents API — GET /incidents ──
    if (url.pathname === '/incidents' && request.method === 'GET') {
      if (!env.DB) return new Response(JSON.stringify({ error: 'DB not bound' }), { status: 500, headers: CORS });
      try {
        const { results: open } = await env.DB.prepare(
          'SELECT id, url, started_at, error_msg FROM incidents WHERE resolved_at IS NULL ORDER BY started_at DESC'
        ).all();

        const { results: recent } = await env.DB.prepare(
          'SELECT id, url, started_at, resolved_at, duration_ms, error_msg FROM incidents WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 20'
        ).all();

        const { results: [{ n: total }] } = await env.DB.prepare('SELECT COUNT(*) AS n FROM incidents').all();

        return new Response(JSON.stringify({ open, recent, total }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 4. Iframe metric collection — POST /log-iframe-metric ──
    if (url.pathname === '/log-iframe-metric' && request.method === 'POST') {
      try {
        const data = await request.json();
        if (!env.DB) return new Response('DB not bound', { status: 500 });
        await env.DB.prepare(
          'INSERT INTO iframe_timings (duration, iframe, page, ts) VALUES (?, ?, ?, ?)'
        ).bind(data.duration, data.iframe, data.page, data.timestamp || Date.now()).run();
        console.log(`[IFRAME PERF] form="${data.iframe}" duration=${data.duration}ms page=${data.page}`);
        return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch (e) {
        return new Response('Invalid payload', { status: 400 });
      }
    }

    // ── 5. Iframe metrics read API — GET /iframe-metrics ──
    if (url.pathname === '/iframe-metrics' && request.method === 'GET') {
      if (!env.DB) return new Response(JSON.stringify({ error: 'DB not bound' }), { status: 500, headers: CORS });
      try {
        const { results: entries } = await env.DB.prepare(
          'SELECT duration, iframe, page, ts AS timestamp FROM iframe_timings ORDER BY ts DESC LIMIT 500'
        ).all();

        const durations = entries.map(e => e.duration);
        const avg  = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
        const min  = durations.length ? Math.round(Math.min(...durations)) : null;
        const max  = durations.length ? Math.round(Math.max(...durations)) : null;
        const sorted = [...durations].sort((a, b) => a - b);
        const p95  = sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)]) : null;

        const { results: [{ n: count }] } = await env.DB.prepare('SELECT COUNT(*) AS n FROM iframe_timings').all();

        return new Response(JSON.stringify({
          count, avg, min, max, p95,
          entries: entries.slice(0, 100),
        }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 6. HTMLRewriter — inject iframe timer + worker URL ──
    const response = await fetch(request);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return response;

    const workerOrigin = new URL(request.url).origin;
    return new HTMLRewriter()
      .on('head', new WorkerUrlInjector(workerOrigin))
      .on('iframe', new IframeTimerHandler())
      .transform(response);
  },
};

class WorkerUrlInjector {
  constructor(origin) { this.origin = origin; }
  element(element) {
    element.prepend(`<script>window.WORKER_URL='${this.origin}/';</script>`, { html: true });
  }
}

class IframeTimerHandler {
  element(element) {
    const iframeId = element.getAttribute('id') || `iframe_${Math.random().toString(36).substr(2, 9)}`;
    element.setAttribute('id', iframeId);

    element.before(`<script>
(function(){
  var id="${iframeId}", t0=performance.now(), hidden=false;
  document.addEventListener('visibilitychange',function(){ if(document.hidden) hidden=true; });
  var iv=setInterval(function(){
    var el=document.getElementById(id);
    if(el){
      clearInterval(iv);
      el.addEventListener('load',function(){
        if(hidden || document.hidden) return;
        var dur=(performance.now()-t0).toFixed(2);
        navigator.sendBeacon('/log-iframe-metric',JSON.stringify({
          duration:parseFloat(dur),
          iframe:id,
          page:window.location.pathname,
          timestamp:Date.now()
        }));
      });
    }
  },5);
})();
</script>`, { html: true });
  }
}
