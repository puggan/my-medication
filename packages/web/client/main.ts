import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { Overview, OverviewEvent, OverviewMedication } from '../src/types.ts';

const app = document.getElementById('app')!;
const dialog = document.getElementById('dialog') as HTMLDialogElement;

type Me = { state: 'anonymous' } | { state: 'pending'; username: string; pairingCode: string } | { state: 'approved'; username: string };

class Unauthorized extends Error {}
/** The request never reached the server. */
class NetworkError extends Error {}

// ---- Helpers ----

type Child = Node | string | null | undefined | false;

/** Build an element; text is always set as text, never parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<Record<string, string | number | boolean | EventListener>> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === false) continue;
        if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (key === 'className') el.className = String(value);
        else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
    return el;
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
    }).catch(() => {
        throw new NetworkError('No connection to the server');
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (response.status === 401) throw new Unauthorized(data.error ?? 'Not logged in');
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);

/** 7, 1.5 or 0.25 */
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function whenBadge(today: string, date: string): HTMLElement {
    const days = daysBetween(today, date);
    if (days < 0) return h('span', { className: 'badge late' }, `${plural(-days, 'day')} late`);
    if (days === 0) return h('span', { className: 'badge soon' }, 'today');
    return h('span', { className: `badge ${days <= 7 ? 'soon' : 'later'}` }, `in ${plural(days, 'day')}`);
}

function savedUsername(): string {
    try {
        return localStorage.getItem('med-username') ?? '';
    } catch {
        return '';
    }
}

function saveUsername(name: string): void {
    try {
        localStorage.setItem('med-username', name);
    } catch {
        // Private mode: the field just starts empty next time
    }
}

// ---- Unsent actions ----

/**
 * A write kept in localStorage until the server has answered it, so one interrupted by an ended
 * session or a lost connection can be sent again after logging in.
 */
interface PendingAction {
    path: string;
    body: unknown;
    /** What it does, for the question whether to send it again. */
    label: string;
    username: string;
    /** When it was first tried, as an ISO timestamp. */
    savedAt: string;
}

const PENDING_KEY = 'med-pending-action';
/** Older unsent actions are dropped without asking. */
const PENDING_DAYS = 7;

function savePending(action: PendingAction): void {
    try {
        localStorage.setItem(PENDING_KEY, JSON.stringify(action));
    } catch {
        // Private mode or storage blocked: it just can't be offered again
    }
}

function loadPending(): PendingAction | undefined {
    try {
        const raw = localStorage.getItem(PENDING_KEY);
        return raw === null ? undefined : (JSON.parse(raw) as PendingAction);
    } catch {
        return undefined;
    }
}

function clearPending(): void {
    try {
        localStorage.removeItem(PENDING_KEY);
    } catch {
        // Nothing to clear when storage is unavailable
    }
}

/** Ask whether to send an action that didn't get through, for the user now logged in. */
function offerPending(username: string, today: string): void {
    const pending = loadPending();
    if (!pending || pending.username !== username) return;
    const saved = new Date(pending.savedAt);
    if (Number.isNaN(saved.getTime()) || Date.now() - saved.getTime() > PENDING_DAYS * 86_400_000) {
        clearPending();
        return;
    }
    const savedDay = saved.toLocaleDateString('sv-SE');
    const status = h('p', {});
    const send = h('button', { className: 'primary' }, 'Send it now');
    const discard = h('button', {}, 'Discard');
    discard.addEventListener('click', () => {
        clearPending();
        closeDialog();
    });
    send.addEventListener('click', async () => {
        if (await submit(status, [send, discard], pending)) closeDialog();
    });
    openDialog(
        'Unsent action',
        h('p', {}, 'This was not saved, as the session ended or the connection was lost:'),
        h('p', {}, h('strong', {}, pending.label)),
        h('p', { className: 'muted' }, `Tried ${savedDay} ${saved.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}.`),
        savedDay !== today &&
            h('p', { className: 'error' }, `Sent now, it is recorded as done today, ${today}, not ${savedDay}.`),
        status,
        h('div', { className: 'actions' }, discard, send),
    );
}

// ---- Login ----

let pollTimer: number | undefined;

async function refresh(): Promise<void> {
    window.clearTimeout(pollTimer);
    try {
        const me = await get<Me>('/api/me');
        if (me.state === 'anonymous') renderLogin();
        else if (me.state === 'pending') renderPending(me.username, me.pairingCode);
        else {
            await renderOverview();
            offerPending(me.username, current!.today);
        }
    } catch (error) {
        if (error instanceof Unauthorized) renderLogin();
        else renderLogin((error as Error).message);
    }
}

function renderLogin(message?: string, offerRegister = false): void {
    const input = h('input', {
        id: 'username',
        name: 'username',
        autocomplete: 'username webauthn',
        autocapitalize: 'none',
        spellcheck: 'false',
        value: savedUsername(),
        required: true,
    });
    const status = h('p', { className: message ? 'error' : 'muted' }, message ?? '');
    const busy = (text: string) => {
        status.className = 'muted';
        status.textContent = text;
    };
    const fail = (text: string, register = false) => renderLogin(text, register);

    const login = async (event?: Event) => {
        event?.preventDefault();
        const username = input.value.trim().toLowerCase();
        if (!username) return;
        saveUsername(username);
        busy('Waiting for your passkey…');
        try {
            const start = await post<{ mode: 'login' | 'register'; options: never }>('/api/login/options', { username });
            if (start.mode === 'register') return await register(username, start.options);
            const response = await startAuthentication({ optionsJSON: start.options });
            await post('/api/login/verify', response);
            await refresh();
        } catch (error) {
            const name = (error as Error).name;
            if (name === 'NotAllowedError' || name === 'AbortError') {
                fail('No passkey was used. If this device has none for that username yet, register it.', true);
            } else {
                fail((error as Error).message, true);
            }
        }
    };

    const register = async (username: string, options?: never) => {
        busy('Creating a passkey for this device…');
        try {
            const optionsJSON = options ?? (await post<{ options: never }>('/api/register/options', { username })).options;
            const response = await startRegistration({ optionsJSON });
            await post('/api/register/verify', response);
            await refresh();
        } catch (error) {
            const name = (error as Error).name;
            if (name === 'InvalidStateError') fail('This device already has a passkey for that username: log in instead.');
            else if (name === 'NotAllowedError' || name === 'AbortError') fail('No passkey was created.', true);
            else fail((error as Error).message, true);
        }
    };

    app.replaceChildren(
        h(
            'form',
            { className: 'card login', onsubmit: login as EventListener },
            h('h1', {}, 'Medication stock'),
            h('label', { for: 'username' }, 'Username'),
            input,
            h(
                'div',
                { className: 'row' },
                h('button', { type: 'submit', className: 'primary' }, 'Log in'),
                offerRegister &&
                    h(
                        'button',
                        {
                            type: 'button',
                            onclick: (() => {
                                const username = input.value.trim().toLowerCase();
                                if (username) void register(username);
                            }) as EventListener,
                        },
                        'Register this device',
                    ),
            ),
            status,
        ),
    );
    input.focus();
}

function renderPending(username: string, code: string): void {
    const shown = `${code.slice(0, 3)}-${code.slice(3)}`;
    app.replaceChildren(
        h(
            'div',
            { className: 'card login' },
            h('h1', {}, 'Device not yet verified'),
            h('p', {}, `This passkey for ${username} is waiting for approval. Its pairing code is:`),
            h('div', { className: 'code' }, shown),
            h('p', { className: 'muted' }, 'Approve it from the command line:'),
            h('pre', {}, `pnpm med passkey approve ${shown}`),
            h('p', { className: 'muted' }, 'This page continues by itself once it is approved.'),
            h('button', { onclick: logout as EventListener }, 'Log out'),
        ),
    );
    pollTimer = window.setTimeout(() => void refresh(), 5000);
}

async function logout(): Promise<void> {
    await post('/api/logout').catch(() => undefined);
    renderLogin();
}

// ---- Overview ----

let current: Overview | undefined;

async function renderOverview(): Promise<void> {
    current = await get<Overview>('/api/overview');
    const data = current;
    app.replaceChildren(
        h(
            'header',
            {},
            h('h1', {}, 'Medication stock'),
            h(
                'div',
                { className: 'choices' },
                h('span', { className: 'muted' }, `${data.user} · ${data.today}`),
                h('button', { onclick: feedDialog as EventListener }, 'Calendar feed'),
                h('button', { onclick: logout as EventListener }, 'Log out'),
            ),
        ),
        h('h2', {}, 'Stock'),
        stockTable(data),
        h('p', { className: 'detail' }, 'Tap a medication to count it, pick up packages or add a new prescription.'),
        h('h2', {}, 'Actions'),
        eventTable(data),
    );
}

/** 7/11: day and month only, to keep the table narrow; the full date is in the tooltip. */
function shortDate(today: string, date: string | undefined): HTMLElement | string {
    if (date === undefined) return '–';
    const [, month, day] = date.split('-').map(Number);
    const days = daysBetween(today, date);
    const className = days < 0 ? 'badge late' : days <= 7 ? 'badge soon' : '';
    return h('span', { className, title: date }, `${day}/${month}`);
}

function stockTable(data: Overview): HTMLElement {
    // One column each for dose and tier 1, the organizers joined with +: Metformin 2+2, the rest 1
    const perOrganizer = (med: OverviewMedication, values: Record<number, number>) => {
        const boxes = data.organizers.filter((box) => med.doses[box.id] || med.tier1[box.id]);
        return boxes.length === 0 ? '–' : boxes.map((box) => fmt(values[box.id] ?? 0)).join('+');
    };
    const names = data.organizers.map((box) => box.name).join('+');
    return h(
        'div',
        { className: 'scroll' },
        h(
            'table',
            {},
            h(
                'thead',
                {},
                h(
                    'tr',
                    {},
                    h('th', {}, 'Medication'),
                    h('th', { className: 'num', title: `Tablets per day, ${names}` }, 'Per day'),
                    h('th', { className: 'num', title: `Tier 1, ${names}` }, 'Organizer'),
                    h('th', { className: 'num', title: 'Tier 2' }, 'Cupboard'),
                    h('th', { className: 'num', title: 'Tier 3' }, 'Pharmacy'),
                    h('th', { className: 'num' }, 'Pickup'),
                    h('th', { className: 'num', title: 'Contact the doctor for a new prescription' }, 'Re-order'),
                ),
            ),
            h(
                'tbody',
                {},
                ...data.medications.map((med) =>
                    h(
                        'tr',
                        {},
                        h('td', {}, h('button', { className: 'link', onclick: (() => medicationMenu(med)) as EventListener }, med.name)),
                        h('td', { className: 'num' }, perOrganizer(med, med.doses)),
                        h('td', { className: 'num' }, perOrganizer(med, med.tier1)),
                        h('td', { className: 'num' }, fmt(med.tier2)),
                        h(
                            'td',
                            { className: 'num', title: `${(med.tier3 / med.packageSize).toFixed(2)} packages` },
                            fmt(med.tier3),
                        ),
                        h('td', { className: 'num' }, shortDate(data.today, med.nextPickup)),
                        h('td', { className: 'num' }, shortDate(data.today, med.nextReorder)),
                    ),
                ),
            ),
        ),
    );
}

const medication = (id: number) => current!.medications.find((med) => med.id === id)!;

function describe(event: OverviewEvent): (Node | string)[] {
    switch (event.action) {
        case 'refill':
            return [
                `Refill the ${event.organizerName} organizer`,
                h('div', { className: 'detail' }, event.items.map((item) => `${item.name} ${fmt(item.tablets)}`).join(', ')),
            ];
        case 'pickup':
            return [
                `Pick up ${plural(event.packages ?? 1, 'package')} of ${event.medicationName}`,
                ...(event.needsRenewal
                    ? [h('div', { className: 'detail' }, 'From the new prescription, once the doctor has renewed it')]
                    : []),
            ];
        case 'pickup-before-expiry':
            return [
                `Pick up ${plural(event.packages ?? 1, 'package')} of ${event.medicationName}`,
                h('div', { className: 'detail' }, `The prescription expires ${event.expiresOn}`),
            ];
        case 'contact-doctor':
            return [
                `Contact the doctor about ${event.medicationName}`,
                h(
                    'div',
                    { className: 'detail' },
                    event.expiresOn ? `The prescription expired ${event.expiresOn}` : 'Nothing left to pick up on the prescription',
                ),
            ];
    }
}

function eventButton(event: OverviewEvent, today: string): HTMLElement {
    switch (event.action) {
        case 'refill':
            // Possible once a container is free, which can be well before it is due
            return h('button', { disabled: event.availableFrom > today, onclick: (() => refillDialog(event)) as EventListener }, 'Refill');
        case 'pickup':
        case 'pickup-before-expiry':
            return h('button', { onclick: (() => pickupDialog(medication(event.medicationId))) as EventListener }, 'Pick up');
        case 'contact-doctor':
            return h('button', { onclick: (() => renewDialog(medication(event.medicationId))) as EventListener }, 'New prescription');
    }
}

function eventTable(data: Overview): HTMLElement {
    if (data.events.length === 0) return h('p', { className: 'muted' }, 'Nothing to do.');
    return h(
        'div',
        { className: 'scroll' },
        h(
            'table',
            {},
            h(
                'thead',
                {},
                // The button right after the date, so it isn't read as belonging to the runs-out date
                h('tr', {}, h('th', {}, 'Action date'), h('th', {}, ''), h('th', {}, 'Action'), h('th', {}, 'Runs out')),
            ),
            h(
                'tbody',
                {},
                ...data.events.map((event) =>
                    h(
                        'tr',
                        {},
                        h('td', {}, event.actionDate, h('div', {}, whenBadge(data.today, event.actionDate))),
                        h('td', {}, eventButton(event, data.today)),
                        h('td', { className: 'wrap' }, ...describe(event)),
                        h('td', {}, event.runsOut),
                    ),
                ),
            ),
        ),
    );
}

// ---- Dialogs ----

function openDialog(title: string, ...content: Child[]): void {
    dialog.replaceChildren(h('h3', {}, title), ...content.filter((c): c is Node | string => !!c));
    if (!dialog.open) dialog.showModal();
}

function closeDialog(): void {
    dialog.close();
}

/**
 * Send a write, then reload the overview; errors stay in the dialog. It is kept in localStorage
 * until the server has answered, and offered again after logging in if the session ended or the
 * connection was lost on the way.
 */
async function submit(
    status: HTMLElement,
    buttons: HTMLButtonElement[],
    action: { path: string; body: unknown; label: string; savedAt?: string },
): Promise<boolean> {
    for (const button of buttons) button.disabled = true;
    status.className = 'muted';
    status.textContent = 'Saving…';
    savePending({
        path: action.path,
        body: action.body,
        label: action.label,
        username: current!.user,
        savedAt: action.savedAt ?? new Date().toISOString(),
    });
    try {
        await post(action.path, action.body);
        clearPending();
        await renderOverview();
        return true;
    } catch (error) {
        if (error instanceof Unauthorized) {
            closeDialog();
            renderLogin('Your session ended. Log in again, and you are asked whether to send it again.');
            return false;
        }
        status.className = 'error';
        if (error instanceof NetworkError) {
            status.textContent = 'No connection to the server. It is saved, and offered again the next time the page loads.';
        } else {
            // The server answered and said no: sending it again would not help
            clearPending();
            status.textContent = (error as Error).message;
        }
        for (const button of buttons) button.disabled = false;
        return false;
    }
}

const cancelButton = () => h('button', { type: 'button', onclick: closeDialog as EventListener }, 'Cancel');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Fri 13/11: the weekday too, as the organizer's containers are marked by weekday. */
function weekdayDayMonth(date: string): string {
    const [, month, day] = date.split('-').map(Number);
    return `${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${day}/${month}`;
}

function refillDialog(event: Extract<OverviewEvent, { action: 'refill' }>): void {
    const status = h('p', {});
    const confirm = h('button', { className: 'primary' }, 'Confirm refill');
    const fill = event.fill;
    // Filled by days when it can be: a choice of 1 up to the days that fit, the amounts following it
    const until = (days: number) => {
        const date = new Date(`${fill!.filledUntil}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + days);
        return date.toISOString().slice(0, 10);
    };
    const select = fill
        ? h(
              'select',
              { id: 'refill-days' },
              ...Array.from({ length: fill.maxDays }, (_, i) =>
                  h('option', { value: String(i + 1), selected: i + 1 === fill.maxDays }, `${plural(i + 1, 'day')}, until ${weekdayDayMonth(until(i + 1))}`),
              ),
          )
        : undefined;
    const list = h('ul', {});
    const filled = h('p', { className: 'muted' });
    const render = () => {
        const days = select ? Number(select.value) : undefined;
        list.replaceChildren(
            ...event.items.map((item) =>
                h('li', {}, `${item.name}: ${fmt(days === undefined ? item.tablets : (item.byDays?.[days - 1] ?? 0))}`),
            ),
        );
        filled.textContent = days === undefined ? '' : `Filled until ${weekdayDayMonth(until(days))} (${until(days)}).`;
    };
    select?.addEventListener('change', render);
    render();

    confirm.addEventListener('click', async () => {
        const body = { organizerId: event.organizerId, days: select ? Number(select.value) : undefined };
        const label = `Refill the ${event.organizerName} organizer${body.days === undefined ? '' : `, ${plural(body.days, 'day')}`}`;
        if (await submit(status, [confirm], { path: '/api/refill', body, label })) closeDialog();
    });
    openDialog(
        `Refill the ${event.organizerName} organizer`,
        select && h('label', { for: 'refill-days' }, 'Days to fill'),
        select,
        h('p', {}, 'Moves these tablets from the cupboard (tier 2) into the organizer (tier 1):'),
        list,
        filled,
        status,
        h('div', { className: 'actions' }, cancelButton(), confirm),
    );
}

function numberInput(id: string, value: string, attrs: Record<string, string> = {}): HTMLInputElement {
    return h('input', { id, type: 'number', inputmode: 'numeric', min: '1', step: '1', value, ...attrs });
}

function pickupDialog(med: OverviewMedication): void {
    const size = numberInput('pickup-size', String(med.packageSize));
    const packages = numberInput('pickup-packages', '1');
    const price = h('input', {
        id: 'pickup-price',
        type: 'number',
        inputmode: 'decimal',
        min: '0',
        step: '0.01',
        placeholder: 'From the receipt, if you have it',
    });
    const total = h('p', { className: 'muted' });
    const update = () => {
        total.textContent = `${Number(packages.value) * Number(size.value) || 0} tablets move from the pharmacy (tier 3) to the cupboard (tier 2).`;
    };
    size.addEventListener('input', update);
    packages.addEventListener('input', update);
    update();
    const status = h('p', {});
    const confirm = h('button', { className: 'primary' }, 'Confirm pickup');
    confirm.addEventListener('click', async () => {
        const body = {
            medicationId: med.id,
            packages: Number(packages.value),
            packageSize: Number(size.value),
            pricePerPackage: price.value === '' ? undefined : Number(price.value),
        };
        const label = `Pick up ${plural(body.packages, 'package')} of ${body.packageSize} ${med.name}`;
        if (await submit(status, [confirm], { path: '/api/pickup', body, label })) closeDialog();
    });
    openDialog(
        `Pick up ${med.name}`,
        h('label', { for: 'pickup-size' }, 'Package size (tablets)'),
        size,
        h('label', { for: 'pickup-packages' }, 'Packages'),
        packages,
        h('label', { for: 'pickup-price' }, 'Price per package (SEK)'),
        price,
        total,
        status,
        h('div', { className: 'actions' }, cancelButton(), confirm),
    );
}

function renewDialog(med: OverviewMedication): void {
    const expires = h('input', { id: 'renew-expires', type: 'date', required: true });
    const size = numberInput('renew-size', String(med.packageSize));
    const packages = numberInput('renew-packages', '1');
    const tablets = numberInput('renew-tablets', String(med.packageSize), { step: 'any', inputmode: 'decimal' });
    // Package size or count give the tablets; typed tablets give the count when it comes out even
    const fromPackages = () => {
        const n = Number(size.value) * Number(packages.value);
        if (n > 0) tablets.value = String(n);
    };
    size.addEventListener('input', fromPackages);
    packages.addEventListener('input', fromPackages);
    tablets.addEventListener('input', () => {
        const count = Number(tablets.value) / Number(size.value);
        packages.value = Number.isInteger(count) && count > 0 ? String(count) : '';
    });
    const status = h('p', {});
    const confirm = h('button', { className: 'primary' }, 'Save prescription');
    confirm.addEventListener('click', async () => {
        if (!expires.value) {
            status.className = 'error';
            status.textContent = 'Enter the expiry date';
            return;
        }
        const body = {
            medicationId: med.id,
            expiresOn: expires.value,
            packageSize: Number(size.value),
            tablets: Number(tablets.value),
        };
        const label = `New prescription for ${med.name}: ${fmt(body.tablets)} tablets, expires ${body.expiresOn}`;
        if (await submit(status, [confirm], { path: '/api/renew', body, label })) closeDialog();
    });
    openDialog(
        `New prescription for ${med.name}`,
        h('label', { for: 'renew-expires' }, 'Expires'),
        expires,
        h('label', { for: 'renew-size' }, 'Package size (tablets, becomes the default)'),
        size,
        h('label', { for: 'renew-packages' }, 'Packages'),
        packages,
        h('label', { for: 'renew-tablets' }, 'Tablets'),
        tablets,
        status,
        h('div', { className: 'actions' }, cancelButton(), confirm),
    );
}

function countDialog(med: OverviewMedication): void {
    const data = current!;
    const places = [
        ...data.organizers
            .filter((box) => med.doses[box.id] || med.tier1[box.id])
            .map((box) => ({ label: `Organizer ${box.name}`, tier: 1, organizerId: box.id })),
        { label: 'Cupboard', tier: 2, organizerId: undefined },
        { label: 'Pharmacy', tier: 3, organizerId: undefined },
    ];
    // The cupboard is what gets counted most; organizers are easy to see at a glance
    let place = places.find((p) => p.tier === 2)!;
    const calculated = h('p', { className: 'muted' });
    const counted = numberInput('count-tablets', '', { min: '0', step: 'any', inputmode: 'decimal' });
    const status = h('p', {});
    const save = h('button', {}, 'Save count');
    const saveDrop = h('button', { className: 'primary' }, 'Save and drop the difference');
    let expected: number | undefined;

    const compare = () => {
        const value = counted.value === '' ? undefined : Number(counted.value);
        const differs = expected !== undefined && value !== undefined && Math.abs(value - expected) > 0.001;
        saveDrop.hidden = !differs;
        status.className = 'muted';
        status.textContent = differs ? `${fmt(Math.abs(expected! - value!))} ${expected! > value! ? 'missing' : 'extra'}` : '';
    };
    const loadExpected = async () => {
        expected = undefined;
        calculated.textContent = 'Calculating…';
        try {
            const result = await post<{ calculated: number }>('/api/count', {
                medicationId: med.id,
                tier: place.tier,
                organizerId: place.organizerId,
                preview: true,
            });
            expected = result.calculated;
            calculated.textContent = `Calculated: ${fmt(expected)} tablets`;
        } catch (error) {
            calculated.textContent = (error as Error).message;
        }
        compare();
    };
    counted.addEventListener('input', compare);

    const send = async (drop: boolean) => {
        if (counted.value === '') return;
        const body = { medicationId: med.id, tier: place.tier, organizerId: place.organizerId, tablets: Number(counted.value), drop };
        const label = `Count ${med.name} in ${place.label.toLowerCase()}: ${fmt(body.tablets)}${drop ? ', dropping the difference' : ''}`;
        if (await submit(status, [save, saveDrop], { path: '/api/count', body, label })) closeDialog();
    };
    save.addEventListener('click', () => void send(false));
    saveDrop.addEventListener('click', () => void send(true));

    openDialog(
        `Count ${med.name}`,
        h(
            'div',
            { className: 'choices' },
            ...places.map((p) =>
                h(
                    'label',
                    {},
                    h('input', {
                        type: 'radio',
                        name: 'count-place',
                        checked: p === place,
                        onchange: (() => {
                            place = p;
                            void loadExpected();
                        }) as EventListener,
                    }),
                    p.label,
                ),
            ),
        ),
        calculated,
        h('label', { for: 'count-tablets' }, 'Counted tablets'),
        counted,
        status,
        h('div', { className: 'actions' }, cancelButton(), save, saveDrop),
    );
    void loadExpected();
}

function feedDialog(): void {
    const name = h('input', { id: 'feed-name', value: 'Calendar', maxlength: '64' });
    const status = h('p', {});
    const create = h('button', { className: 'primary' }, 'Create feed');
    create.addEventListener('click', async () => {
        create.disabled = true;
        try {
            const { url } = await post<{ url: string }>('/api/feeds', { name: name.value });
            showFeed(url);
        } catch (error) {
            if (error instanceof Unauthorized) {
                closeDialog();
                renderLogin('Your session ended, log in again.');
                return;
            }
            status.className = 'error';
            status.textContent = (error as Error).message;
            create.disabled = false;
        }
    });
    openDialog(
        'Calendar feed',
        h('p', {}, 'A private address your calendar app can subscribe to, with the actions from this page as all-day events.'),
        h('label', { for: 'feed-name' }, 'Name, to recognise it in the command line'),
        name,
        status,
        h('div', { className: 'actions' }, cancelButton(), create),
    );
}

function showFeed(url: string): void {
    const field = h('input', { value: url, readonly: true });
    const copied = h('p', { className: 'muted' });
    const copy = h('button', {}, 'Copy');
    copy.addEventListener('click', async () => {
        field.select();
        try {
            await navigator.clipboard.writeText(url);
            copied.textContent = 'Copied.';
        } catch {
            copied.textContent = 'Select the address and copy it by hand.';
        }
    });
    openDialog(
        'Calendar feed created',
        h('p', {}, 'Subscribe to this address in your calendar. It is shown only now; anyone with it can read your actions.'),
        field,
        copied,
        h(
            'p',
            { className: 'detail' },
            'Google Calendar: Other calendars → From URL, with https:// instead of webcal://. Revoke it with pnpm med feed revoke.',
        ),
        h(
            'div',
            { className: 'actions' },
            copy,
            h('a', { href: url, className: 'button primary' }, 'Open in calendar app'),
            h('button', { type: 'button', onclick: closeDialog as EventListener }, 'Done'),
        ),
    );
}

function medicationMenu(med: OverviewMedication): void {
    const action = (label: string, open: (m: OverviewMedication) => void) =>
        h('button', { onclick: (() => open(med)) as EventListener }, label);
    openDialog(
        med.name,
        h(
            'p',
            { className: 'muted' },
            `Cupboard ${fmt(med.tier2)}, pharmacy ${fmt(med.tier3)}, default package ${med.packageSize}.`,
        ),
        h(
            'div',
            { className: 'actions' },
            action('Count', countDialog),
            action('Pick up', pickupDialog),
            action('New prescription', renewDialog),
            cancelButton(),
        ),
    );
}

void refresh();
