"""Preserved from douyin.collect.Collector.FETCH_JS."""
FETCH_JS = """async (u) => {
        const r = await fetch(u, {credentials: 'include'});
        const t = await r.text();
        let body = null; try { body = JSON.parse(t); } catch (e) {}
        return {status: r.status, body: body, length: t.length, head: body ? '' : t.slice(0, 4000), url: r.url};
    }"""
