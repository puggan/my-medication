import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { connectVerified } from '@med/db';
import { api } from './api.ts';
import { feed, feedUser } from './calendar.ts';
import { origin, port, publicDir } from './config.ts';

const db = await connectVerified();
const app = new Hono();

app.use(
    '*',
    secureHeaders({
        // Apache sets HSTS, as on the server's other vhosts
        strictTransportSecurity: false,
        contentSecurityPolicy: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            baseUri: ["'none'"],
        },
    }),
);
// Writes only from our own pages, on top of the SameSite=Strict cookies; hono's csrf() would only
// check form posts, and the API takes JSON
app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.header('origin') !== origin) return c.json({ error: 'Wrong origin' }, 403);
    await next();
});
app.route('/api', api(db));
app.get('/calendar/:file{[A-Za-z0-9_-]{43}\\.ics}', async (c) => {
    const owner = await feedUser(db, c.req.param('file').slice(0, -'.ics'.length));
    if (!owner) return c.text('No such calendar feed', 404);
    return c.body(await feed(db, owner), 200, {
        'content-type': 'text/calendar; charset=utf-8',
        'cache-control': 'private, max-age=900',
    });
});
app.use('*', serveStatic({ root: publicDir }));
app.get('*', serveStatic({ root: publicDir, path: 'index.html' }));

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.log(`med web listening on http://127.0.0.1:${port} for ${origin}`);
});
