import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { connectVerified } from '@med/db';
import { api } from './api.ts';
import { origin, port, publicDir } from './config.ts';

const db = await connectVerified();
const app = new Hono();

app.use(
    '*',
    secureHeaders({
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
app.use('*', serveStatic({ root: publicDir }));
app.get('*', serveStatic({ root: publicDir, path: 'index.html' }));

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.log(`med web listening on http://127.0.0.1:${port} for ${origin}`);
});
