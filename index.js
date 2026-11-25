import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import * as WI from '../../../world-info.js';

const MODULE = 'lorebook_editor';
const TAG = '[Lorebook Editor]';

const defaults = {
    selected: [],
    scope: 'all',
    scopeText: '',
    tab: 'flags',
    profileId: '',
    kwMode: 'empty',
    kwCount: 8,
    kwSkipConstant: true,
    kwExtra: '',
};

/* Entry flags that can be mass-edited. `invert` means the stored field is the opposite of the label. */
const FLAGS = [
    {
        group: 'Activation',
        items: [
            { key: 'enabled', label: 'Enabled', field: 'disable', invert: true },
            { key: 'constant', label: 'Constant', field: 'constant' },
            { key: 'vectorized', label: 'Vectorized', field: 'vectorized' },
            { key: 'ignoreBudget', label: 'Ignore budget', field: 'ignoreBudget' },
        ],
    },
    {
        group: 'Recursion',
        items: [
            { key: 'nonrec', label: 'Non-recursable', field: 'excludeRecursion' },
            { key: 'prevrec', label: 'Prevent further recursion', field: 'preventRecursion' },
            { key: 'delayrec', label: 'Delay until recursion', field: 'delayUntilRecursion' },
        ],
    },
    {
        group: 'Matching',
        items: [
            { key: 'case', label: 'Case-sensitive', field: 'caseSensitive', tri: true },
            { key: 'whole', label: 'Match whole words', field: 'matchWholeWords', tri: true },
            { key: 'groupscore', label: 'Group scoring', field: 'useGroupScoring', tri: true },
        ],
    },
];

/* Numeric / select values. Empty = leave unchanged. */
const VALUES = [
    {
        key: 'position', label: 'Position', type: 'select',
        options: [
            ['0', 'Before character defs'], ['1', 'After character defs'],
            ['2', 'Author\u2019s note top'], ['3', 'Author\u2019s note bottom'],
            ['4', '@ Depth'], ['5', 'Example messages top'],
            ['6', 'Example messages bottom'], ['7', 'Outlet'],
        ],
    },
    { key: 'depth', label: 'Depth', type: 'number', min: 0 },
    { key: 'role', label: 'Depth role', type: 'select', options: [['0', 'System'], ['1', 'User'], ['2', 'Assistant']] },
    { key: 'order', label: 'Order', type: 'number' },
    { key: 'probability', label: 'Trigger %', type: 'number', min: 0, max: 100 },
    { key: 'scanDepth', label: 'Scan depth', type: 'number', min: 0 },
    { key: 'sticky', label: 'Sticky', type: 'number', min: 0 },
    { key: 'cooldown', label: 'Cooldown', type: 'number', min: 0 },
    { key: 'delay', label: 'Delay', type: 'number', min: 0 },
];

const SCOPES = [
    ['all', 'All entries'],
    ['nokeys', 'Only entries without keywords'],
    ['enabled', 'Only enabled entries'],
    ['disabled', 'Only disabled entries'],
    ['constant', 'Only constant entries'],
    ['nonconstant', 'Only non-constant entries'],
    ['text', 'Title or keywords contain\u2026'],
];

let settings;
let allNames = [];
let busy = false;
let abortCtl = null;
const flagState = {};

/* ---------------- helpers ---------------- */

const ctx = () => SillyTavern.getContext();

function loadSettings() {
    const old = extension_settings.bulk_non_recursable; // from v1
    extension_settings[MODULE] = Object.assign({}, defaults, extension_settings[MODULE] ?? {});
    settings = extension_settings[MODULE];
    if (old?.selected?.length && !settings.selected.length) settings.selected = [...old.selected];
    for (const g of FLAGS) for (const f of g.items) flagState[f.key] = 'keep';
}

function save() {
    saveSettingsDebounced();
}

async function getWorldNames() {
    let names = Array.isArray(WI.world_names) ? [...WI.world_names] : [];
    if (!names.length) {
        try {
            const r = await fetch('/api/settings/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({}),
            });
            const d = await r.json();
            names = Array.isArray(d.world_names) ? d.world_names : [];
        } catch (e) {
            console.warn(TAG, 'could not fetch lorebook list', e);
        }
    }
    return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function saveBook(name, data) {
    await WI.saveWorldInfo(name, data, true);
    try { if (typeof WI.reloadEditor === 'function') WI.reloadEditor(name); } catch { /* optional */ }
}

function selectedNames() {
    return settings.selected.filter(n => allNames.includes(n));
}

function hasKeys(entry) {
    return Array.isArray(entry.key) && entry.key.some(k => String(k).trim());
}

function entryTitle(entry) {
    return String(entry.comment || '').trim() || (Array.isArray(entry.key) && entry.key[0]) || `#${entry.uid}`;
}

function getScope() {
    return { kind: settings.scope, text: String(settings.scopeText || '').trim().toLowerCase() };
}

function entryMatches(entry, scope) {
    switch (scope.kind) {
        case 'nokeys': return !hasKeys(entry);
        case 'enabled': return !entry.disable;
        case 'disabled': return !!entry.disable;
        case 'constant': return !!entry.constant;
        case 'nonconstant': return !entry.constant;
        case 'text': {
            if (!scope.text) return true;
            const hay = `${entry.comment || ''} ${(entry.key || []).join(' ')} ${(entry.keysecondary || []).join(' ')}`.toLowerCase();
            return hay.includes(scope.text);
        }
        default: return true;
    }
}

/* ---------------- mass edit ---------------- */

function collectPatch() {
    const flags = [];
    for (const g of FLAGS) {
        for (const f of g.items) {
            const s = flagState[f.key];
            if (s === 'keep') continue;
            let v = s === 'on';
            if (f.invert) v = !v;
            flags.push({ field: f.field, value: v, tri: !!f.tri });
        }
    }
    const values = {};
    for (const v of VALUES) {
        const raw = $(`#le_val_${v.key}`).val();
        if (raw === '' || raw == null) continue;
        const num = Number(raw);
        if (!Number.isNaN(num)) values[v.key] = num;
    }
    return { flags, values };
}

function applyPatch(entry, patch, dry) {
    let changed = false;
    const set = (k, v, strict) => {
        const differs = strict ? entry[k] !== v : (typeof v === 'boolean' ? !!entry[k] !== v : entry[k] !== v);
        if (differs) {
            changed = true;
            if (!dry) entry[k] = v;
        }
    };
    for (const f of patch.flags) set(f.field, f.value, f.tri);
    for (const [k, v] of Object.entries(patch.values)) {
        set(k, v, true);
        if (k === 'probability') set('useProbability', true, false);
    }
    return changed;
}

async function runFlags(dry) {
    const names = selectedNames();
    if (!names.length) return toastr.warning('Select at least one lorebook first.', 'Lorebook Editor');
    const patch = collectPatch();
    if (!patch.flags.length && !Object.keys(patch.values).length) {
        return toastr.info('Nothing to change yet. Set at least one option to On/Off or fill in a value.', 'Lorebook Editor');
    }

    const scope = getScope();
    setBusy(true);
    setStatus(dry ? 'Checking\u2026' : 'Applying\u2026');
    let books = 0, scanned = 0, matched = 0, changed = 0;
    try {
        for (const name of names) {
            const data = await WI.loadWorldInfo(name);
            if (!data?.entries) continue;
            books++;
            let bookChanged = 0;
            for (const entry of Object.values(data.entries)) {
                scanned++;
                if (!entryMatches(entry, scope)) continue;
                matched++;
                if (applyPatch(entry, patch, dry)) { changed++; bookChanged++; }
            }
            if (!dry && bookChanged) await saveBook(name, data);
        }
        const msg = `${dry ? 'Would change' : 'Changed'} ${changed} of ${matched} matching entries (${scanned} total) in ${books} lorebook(s).`;
        setStatus(msg, 'ok');
        if (!dry) toastr.success(msg, 'Lorebook Editor');
    } catch (e) {
        console.error(TAG, e);
        setStatus(`Error: ${e?.message ?? e}`, 'err');
        toastr.error(String(e?.message ?? e), 'Lorebook Editor');
    } finally {
        setBusy(false);
    }
}

/* ---------------- keyword generation ---------------- */

function getProfiles() {
    let cm;
    try { cm = ctx().extensionSettings?.connectionManager; } catch { /* old version */ }
    cm = cm ?? extension_settings.connectionManager;
    return Array.isArray(cm?.profiles) ? cm.profiles : [];
}

function renderProfiles() {
    const profiles = getProfiles();
    const $sel = $('#le_profile').empty();
    $sel.append($('<option value=""></option>').text('Current connection (no profile)'));
    for (const p of profiles) {
        $sel.append($('<option></option>').val(p.id).text(p.name || p.id));
    }
    if (settings.profileId && !profiles.some(p => p.id === settings.profileId)) {
        settings.profileId = '';
        save();
    }
    $sel.val(settings.profileId);
    $('#le_profile_hint').text(profiles.length
        ? `${profiles.length} profile(s) available.`
        : 'No API profiles found. Enable the Connection Manager extension and create a profile, or use the current connection.');
    return profiles.length;
}

async function llm(system, user, signal) {
    const c = ctx();
    if (settings.profileId) {
        let svc = c.ConnectionManagerRequestService;
        if (!svc) svc = (await import('../../shared.js')).ConnectionManagerRequestService;
        if (!svc) throw new Error('Connection Manager is not available in this SillyTavern version.');
        const res = await svc.sendRequest(
            settings.profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            1024,
            { stream: false, signal, extractData: true, includePreset: true, includeInstruct: false },
            {},
        );
        return String(res?.content ?? '');
    }
    if (typeof c.generateRaw !== 'function') throw new Error('generateRaw is not available. Pick an API profile instead.');
    let out;
    try {
        out = await c.generateRaw({ prompt: user, systemPrompt: system, responseLength: 1024 });
    } catch {
        out = await c.generateRaw(user, null, false, false, system, 1024);
    }
    return String(out ?? '');
}

function parseKeywords(text) {
    text = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    let arr = null;
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
        try {
            const j = JSON.parse(m[0]);
            if (Array.isArray(j)) arr = j.map(String);
        } catch { /* fall through */ }
    }
    if (!arr) {
        arr = text.replace(/```[a-z]*/gi, '').split(/[\n,;]+/).map(s => s.replace(/^[\s\-*\d.)"'\[]+|["'\]\s]+$/g, ''));
    }
    const seen = new Set();
    const out = [];
    for (const k of arr.map(s => s.trim())) {
        const low = k.toLowerCase();
        if (!k || k.length > 60 || seen.has(low)) continue;
        seen.add(low);
        out.push(k);
    }
    return out;
}

function mergeKeys(existing, extra) {
    const out = Array.isArray(existing) ? existing.filter(k => String(k).trim()) : [];
    const seen = new Set(out.map(k => String(k).toLowerCase()));
    for (const k of extra) {
        if (!seen.has(k.toLowerCase())) { out.push(k); seen.add(k.toLowerCase()); }
    }
    return out;
}

async function requestKeywords(entry, count, extra, signal) {
    const system = 'You write trigger keywords for lorebook entries used in roleplay. '
        + 'Given an entry, list the words and short phrases that should activate it when they appear in the chat: '
        + 'names, nicknames, distinctive terms, places, objects. Avoid generic words. '
        + 'Reply with ONLY a JSON array of strings and nothing else.';
    const existing = Array.isArray(entry.key) ? entry.key.filter(Boolean).join(', ') : '';
    let user = `Entry title: ${entry.comment || '(none)'}\n`
        + (existing ? `Existing keywords: ${existing}\n` : '')
        + `Entry content:\n${String(entry.content || '').slice(0, 3000)}\n\n`
        + `Give up to ${count} keywords.`;
    if (extra) user += `\nExtra instructions: ${extra}`;
    return llm(system, user, signal);
}

async function generateKeywords() {
    const names = selectedNames();
    if (!names.length) return toastr.warning('Select at least one lorebook first.', 'Lorebook Editor');

    const scope = getScope();
    const count = Math.min(30, Math.max(1, parseInt(settings.kwCount, 10) || 8));
    const mode = settings.kwMode;
    const skipConst = settings.kwSkipConstant;
    const extra = String(settings.kwExtra || '').trim();

    abortCtl = new AbortController();
    setBusy(true, 'kw');
    $('#le_log').empty();
    setProgress(0);
    setStatus('Collecting entries\u2026');

    let ok = 0, fail = 0;
    try {
        const books = [];
        let total = 0;
        for (const name of names) {
            const data = await WI.loadWorldInfo(name);
            if (!data?.entries) continue;
            const list = Object.values(data.entries).filter(e =>
                entryMatches(e, scope)
                && String(e.content || '').trim()
                && !(skipConst && e.constant)
                && (mode !== 'empty' || !hasKeys(e)));
            if (list.length) { books.push({ name, data, list }); total += list.length; }
        }
        if (!total) {
            setStatus('No matching entries to process.', 'ok');
            return;
        }

        let done = 0, consecutive = 0, stopped = false;
        for (const b of books) {
            let touched = false;
            for (const e of b.list) {
                if (abortCtl.signal.aborted) { stopped = true; break; }
                const title = entryTitle(e);
                setStatus(`Generating ${done + 1} / ${total}: ${title}`);
                try {
                    const kws = parseKeywords(await requestKeywords(e, count, extra, abortCtl.signal)).slice(0, count);
                    if (!kws.length) throw new Error('the model returned no keywords');
                    e.key = mode === 'merge' ? mergeKeys(e.key, kws) : kws;
                    touched = true; ok++; consecutive = 0;
                    log(`${b.name} \u2192 ${title}: ${kws.join(', ')}`, 'ok');
                } catch (err) {
                    if (abortCtl.signal.aborted) { stopped = true; break; }
                    fail++; consecutive++;
                    log(`${b.name} \u2192 ${title}: ${err?.message ?? err}`, 'err');
                    if (consecutive >= 3) {
                        log('Stopped after 3 failures in a row. Check your API profile.', 'err');
                        stopped = true;
                        break;
                    }
                }
                done++;
                setProgress(done / total);
            }
            if (touched) {
                try { await saveBook(b.name, b.data); } catch (err) { log(`Could not save ${b.name}: ${err?.message ?? err}`, 'err'); }
            }
            if (stopped) break;
        }
        const msg = `${stopped ? 'Stopped.' : 'Done.'} Keywords added to ${ok} entries${fail ? `, ${fail} failed` : ''}.`;
        setStatus(msg, fail ? 'err' : 'ok');
        if (ok) toastr.success(msg, 'Lorebook Editor');
    } catch (e) {
        console.error(TAG, e);
        setStatus(`Error: ${e?.message ?? e}`, 'err');
        toastr.error(String(e?.message ?? e), 'Lorebook Editor');
    } finally {
        abortCtl = null;
        setBusy(false);
    }
}

/* ---------------- UI helpers ---------------- */

function setStatus(text, kind) {
    $('#le_status').text(text || '').attr('data-kind', kind || '');
}

function setProgress(frac) {
    $('#le_progress').toggle(frac > 0 || busy).find('i').css('width', `${Math.round(frac * 100)}%`);
}

function log(text, kind) {
    const $log = $('#le_log');
    $log.append($('<div class="le-log-line"></div>').addClass(kind || '').text(text));
    while ($log.children().length > 300) $log.children().first().remove();
    $log.scrollTop($log[0].scrollHeight);
}

function setBusy(on, kind) {
    busy = on;
    $('#le_overlay').toggleClass('le-busy', on);
    $('.le-run').prop('disabled', on);
    $('#le_kw_stop').toggle(on && kind === 'kw');
    if (!on) setProgress(0);
}

function updateCount() {
    $('#le_count').text(`${selectedNames().length} selected`);
}

function renderList() {
    const filter = String($('#le_filter').val() || '').toLowerCase();
    const $list = $('#le_list').empty();
    const visible = allNames.filter(n => n.toLowerCase().includes(filter));
    if (!visible.length) {
        $list.append($('<div class="le-empty"></div>').text(allNames.length ? 'No lorebooks match.' : 'No lorebooks found.'));
    }
    for (const name of visible) {
        const $cb = $('<input type="checkbox">').prop('checked', settings.selected.includes(name));
        $cb.on('change', function () {
            const set = new Set(settings.selected);
            if (this.checked) set.add(name); else set.delete(name);
            settings.selected = [...set];
            save();
            updateCount();
        });
        $list.append($('<label class="le-item"></label>').append($cb, $('<span class="le-item-name"></span>').text(name)));
    }
    updateCount();
}

async function refreshList() {
    allNames = await getWorldNames();
    renderList();
}

function renderFlags() {
    const $c = $('#le_flags').empty();
    for (const g of FLAGS) {
        const $group = $('<div class="le-group"></div>').append($('<div class="le-group-title"></div>').text(g.group));
        for (const f of g.items) {
            const $seg = $('<div class="le-seg" role="group"></div>');
            [['keep', '\u2014', 'Leave unchanged'], ['on', 'On', 'Turn on'], ['off', 'Off', 'Turn off']].forEach(([v, t, title]) => {
                const $b = $('<button type="button" class="le-seg-btn"></button>')
                    .text(t).attr('title', title).addClass(`v-${v}`)
                    .toggleClass('active', flagState[f.key] === v);
                $b.on('click', () => {
                    flagState[f.key] = v;
                    $seg.find('.le-seg-btn').removeClass('active');
                    $b.addClass('active');
                });
                $seg.append($b);
            });
            $group.append($('<div class="le-flag"></div>').append($('<span class="le-flag-label"></span>').text(f.label), $seg));
        }
        $c.append($group);
    }
}

function renderValues() {
    const $c = $('#le_values').empty();
    for (const v of VALUES) {
        let $input;
        if (v.type === 'select') {
            $input = $(`<select id="le_val_${v.key}" class="text_pole"></select>`).append($('<option value="">unchanged</option>'));
            for (const [val, label] of v.options) $input.append($('<option></option>').val(val).text(label));
        } else {
            $input = $(`<input id="le_val_${v.key}" class="text_pole" type="number" inputmode="numeric" placeholder="unchanged">`);
            if (v.min != null) $input.attr('min', v.min);
            if (v.max != null) $input.attr('max', v.max);
        }
        $c.append($('<label class="le-field"></label>').append($('<span></span>').text(v.label), $input));
    }
}

function resetFlags() {
    for (const k of Object.keys(flagState)) flagState[k] = 'keep';
    renderFlags();
    renderValues();
    setStatus('');
}

function showTab(tab) {
    settings.tab = tab;
    save();
    $('.le-tab').each(function () { $(this).toggleClass('active', $(this).data('tab') === tab); });
    $('.le-tabpane').hide();
    $(`#le_tab_${tab}`).show();
}

function updateScopeUI() {
    $('#le_scope_text').toggle(settings.scope === 'text');
}

function openEditor(safe) {
    try {
        let $o = $('#le_overlay');
        if (!$o.length) {
            diagLog('overlay missing, rebuilding');
            buildModal();
            $o = $('#le_overlay');
        }
        // make sure it is the last child of <body> and not hidden by other CSS
        if ($o.parent()[0] !== document.body || document.body.lastElementChild !== $o[0]) document.body.appendChild($o[0]);
        const el = $o[0];
        el.style.setProperty('display', 'flex', 'important');
        if (safe) {
            el.classList.add('le-safe');
            el.style.setProperty('position', 'fixed', 'important');
            el.style.setProperty('inset', '0', 'important');
            el.style.setProperty('z-index', '2147483647', 'important');
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('transform', 'none', 'important');
        } else {
            el.classList.remove('le-safe');
            ['position', 'inset', 'z-index', 'visibility', 'opacity', 'transform'].forEach(p => el.style.removeProperty(p));
        }
        $('body').addClass('le-lock');
        diagLog(`opened (safe=${!!safe})`);
    } catch (e) {
        diagLog(`open failed: ${e?.stack || e}`);
        toastr.error(`Could not open: ${e?.message ?? e}. Use Diagnostics in the extension settings.`, 'Lorebook Editor');
        return;
    }
    try { refreshList(); } catch (e) { diagLog(`refreshList failed: ${e?.stack || e}`); }
    try { renderProfiles(); } catch (e) { diagLog(`renderProfiles failed: ${e?.stack || e}`); }
}

function closeEditor() {
    try { if (busy && abortCtl) abortCtl.abort(); } catch (_) { /* ignore */ }
    $('#le_overlay').css('display', 'none');
    $('#le_overlay')[0]?.style.setProperty('display', 'none', 'important');
    $('body').removeClass('le-lock');
    diagLog('closed');
}

/* ---------------- diagnostics ---------------- */

const diagEvents = [];

function diagLog(text) {
    diagEvents.push(`${new Date().toISOString().slice(11, 23)} ${text}`);
    while (diagEvents.length > 60) diagEvents.shift();
    console.debug(TAG, text);
}

window.addEventListener('error', (e) => {
    const where = `${e.filename || ''}:${e.lineno || ''}`;
    if (/lorebook|le_/i.test(`${where} ${e.message}`)) diagLog(`JS error: ${e.message} @ ${where}`);
});
window.addEventListener('unhandledrejection', (e) => {
    const m = String(e.reason?.stack || e.reason || '');
    if (/lorebook|le_/i.test(m)) diagLog(`Unhandled rejection: ${m.slice(0, 400)}`);
});

function describe(el) {
    if (!el) return 'none';
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
}

function collectDiagnostics() {
    const L = [];
    const add = (s) => L.push(s);
    const rect = (el) => { if (!el) return 'n/a'; const r = el.getBoundingClientRect(); return `x${Math.round(r.left)} y${Math.round(r.top)} w${Math.round(r.width)} h${Math.round(r.height)}`; };
    const safe = (fn) => { try { return fn(); } catch (e) { return `error: ${e?.message}`; } };

    add(`=== Lorebook Editor diagnostics ===`);
    add(`version: 2.0.0 (mobile-fix build)`);
    add(`time: ${new Date().toISOString()}`);
    add(`UA: ${navigator.userAgent}`);
    add(`viewport: inner ${innerWidth}x${innerHeight}, visual ${safe(() => `${Math.round(visualViewport.width)}x${Math.round(visualViewport.height)} scale ${visualViewport.scale}`)}, dpr ${devicePixelRatio}`);
    add(`scroll: window ${Math.round(scrollX)},${Math.round(scrollY)}; body class="${document.body.className}"`);
    add(`jQuery: ${typeof jQuery === 'function' ? jQuery.fn?.jquery : 'missing'}; toastr: ${typeof toastr}`);

    const o = document.getElementById('le_overlay');
    add(`\n-- overlay (#le_overlay) --`);
    add(`exists: ${!!o}; parent: ${describe(o?.parentElement)}; last child of body: ${o ? document.body.lastElementChild === o : 'n/a'}`);
    if (o) {
        const cs = getComputedStyle(o);
        add(`display: ${cs.display}; visibility: ${cs.visibility}; opacity: ${cs.opacity}; position: ${cs.position}; z-index: ${cs.zIndex}`);
        add(`transform: ${cs.transform}; inline style: "${o.getAttribute('style') || ''}"`);
        add(`rect: ${rect(o)}`);
        const p = o.querySelector('.le-panel');
        add(`panel rect: ${rect(p)}; header: ${rect(o.querySelector('.le-header'))}; body: ${rect(o.querySelector('.le-body'))}; footer: ${rect(o.querySelector('.le-footer'))}`);
        if (p) { const pc = getComputedStyle(p); add(`panel height: ${pc.height}; max-height: ${pc.maxHeight}; overflow: ${pc.overflow}`); }
        const bad = [];
        for (let a = o.parentElement; a; a = a.parentElement) {
            const c = getComputedStyle(a);
            if (c.transform !== 'none' || c.filter !== 'none' || c.perspective !== 'none' || c.contain !== 'none' || c.overflow !== 'visible' || c.display === 'none') {
                bad.push(`${describe(a)} {transform:${c.transform !== 'none'}, filter:${c.filter !== 'none'}, contain:${c.contain}, overflow:${c.overflow}, display:${c.display}}`);
            }
        }
        add(`ancestors with transform/filter/contain/overflow: ${bad.length ? '\n  ' + bad.join('\n  ') : 'none'}`);
        if (cs.display !== 'none') {
            const pts = [['center', innerWidth / 2, innerHeight / 2], ['top-left', 8, 8], ['bottom-center', innerWidth / 2, innerHeight - 8]];
            add(`element on top at: ` + pts.map(([n, x, y]) => `${n}=${describe(document.elementFromPoint(x, y))}`).join('; '));
            const zs = [];
            document.querySelectorAll('body *').forEach(el => {
                if (el.closest('#le_overlay')) return;
                const c = getComputedStyle(el);
                const z = parseInt(c.zIndex, 10);
                if ((c.position === 'fixed' || c.position === 'absolute') && z >= 999990 && c.display !== 'none') zs.push(`${describe(el)} z=${z}`);
            });
            add(`other elements with z-index >= 999990: ${zs.length ? zs.slice(0, 8).join('; ') : 'none'}`);
        }
    }
    add(`\n-- other mounts --`);
    add(`settings drawer: ${!!document.querySelector('.le-settings')}; wand button: ${!!document.getElementById('le_wand_button')}; #extensionsMenu: ${!!document.getElementById('extensionsMenu')}`);
    add(`lorebooks loaded in list: ${allNames?.length ?? 'n/a'}; selected: ${settings?.selected?.length ?? 'n/a'}`);
    add(`\n-- recent events --`);
    add(diagEvents.length ? diagEvents.join('\n') : '(none)');
    return L.join('\n');
}

/* Self-contained report window: inline styles only, so it works even if style.css is broken. */
function showDiagnostics() {
    document.getElementById('le_diag')?.remove();
    const text = collectDiagnostics();
    const box = document.createElement('div');
    box.id = 'le_diag';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;gap:8px;padding:12px;background:#111;color:#eee;box-sizing:border-box;');
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    ta.setAttribute('style', 'flex:1;min-height:0;width:100%;box-sizing:border-box;background:#000;color:#9f9;font:12px/1.4 monospace;border:1px solid #555;border-radius:8px;padding:8px;');
    const row = document.createElement('div');
    row.setAttribute('style', 'display:flex;gap:8px;');
    const mk = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.setAttribute('style', 'flex:1;min-height:44px;border-radius:10px;border:1px solid #666;background:#333;color:#fff;font-size:16px;');
        b.addEventListener('click', fn);
        row.appendChild(b);
    };
    mk('Copy', async () => {
        try { await navigator.clipboard.writeText(ta.value); } catch (_) { ta.select(); document.execCommand('copy'); }
        toastr?.success('Copied', 'Lorebook Editor');
    });
    mk('Refresh', () => { ta.value = collectDiagnostics(); });
    mk('Close', () => box.remove());
    box.append(ta, row);
    document.body.appendChild(box);
}

function buildModal() {
    const scopeOptions = SCOPES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    const html = `
    <div id="le_overlay" class="le-overlay" style="display:none">
        <div class="le-panel" role="dialog" aria-modal="true" aria-label="Lorebook Editor">
            <div class="le-header">
                <div class="le-title"><i class="fa-solid fa-book-bookmark"></i><span>Lorebook Editor</span></div>
                <button id="le_close" class="le-close" type="button" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="le-body">
                <section class="le-card le-books">
                    <div class="le-card-title"><span><i class="fa-solid fa-book"></i> Lorebooks</span><span id="le_count" class="le-pill">0 selected</span></div>
                    <div class="le-search"><i class="fa-solid fa-magnifying-glass"></i><input id="le_filter" type="search" placeholder="Search lorebooks\u2026" autocomplete="off"></div>
                    <div class="le-actions">
                        <button id="le_all" class="le-btn" type="button">Select shown</button>
                        <button id="le_none" class="le-btn" type="button">Clear</button>
                        <button id="le_refresh" class="le-btn le-icon" type="button" title="Reload lorebook list"><i class="fa-solid fa-rotate"></i></button>
                    </div>
                    <div id="le_list" class="le-list"></div>
                </section>

                <div class="le-main">
                    <section class="le-card">
                        <div class="le-card-title"><span><i class="fa-solid fa-filter"></i> Apply to</span></div>
                        <select id="le_scope" class="text_pole">${scopeOptions}</select>
                        <input id="le_scope_text" class="text_pole" type="text" placeholder="Text to look for in title or keywords" style="display:none">
                    </section>

                    <div class="le-tabs">
                        <button class="le-tab" data-tab="flags" type="button"><i class="fa-solid fa-sliders"></i> Entry settings</button>
                        <button class="le-tab" data-tab="kw" type="button"><i class="fa-solid fa-key"></i> Keywords</button>
                    </div>

                    <section id="le_tab_flags" class="le-card le-tabpane">
                        <div id="le_flags"></div>
                        <div class="le-group">
                            <div class="le-group-title">Values</div>
                            <div id="le_values" class="le-fields"></div>
                        </div>
                        <div class="le-actions le-end">
                            <button id="le_reset" class="le-btn" type="button">Reset</button>
                            <button id="le_preview" class="le-btn le-run" type="button"><i class="fa-regular fa-eye"></i> Preview</button>
                            <button id="le_apply" class="le-btn le-primary le-run" type="button"><i class="fa-solid fa-check"></i> Apply</button>
                        </div>
                    </section>

                    <section id="le_tab_kw" class="le-card le-tabpane">
                        <div class="le-group">
                            <div class="le-group-title">API profile</div>
                            <div class="le-inline">
                                <select id="le_profile" class="text_pole"></select>
                                <button id="le_profile_update" class="le-btn le-icon" type="button" title="Update profile list"><i class="fa-solid fa-rotate"></i> Update</button>
                            </div>
                            <small id="le_profile_hint" class="le-hint"></small>
                        </div>
                        <div class="le-fields">
                            <label class="le-field"><span>Mode</span>
                                <select id="le_kw_mode" class="text_pole">
                                    <option value="empty">Only fill entries without keywords</option>
                                    <option value="merge">Add to existing keywords</option>
                                    <option value="replace">Replace existing keywords</option>
                                </select>
                            </label>
                            <label class="le-field"><span>Max keywords</span><input id="le_kw_count" class="text_pole" type="number" min="1" max="30" inputmode="numeric"></label>
                        </div>
                        <label class="le-check"><input id="le_kw_skipconst" type="checkbox"><span>Skip constant entries (they don\u2019t need keywords)</span></label>
                        <label class="le-field"><span>Extra instructions (optional)</span>
                            <textarea id="le_kw_extra" class="text_pole" rows="2" placeholder="e.g. keywords in English, include character nicknames"></textarea>
                        </label>
                        <div class="le-actions le-end">
                            <button id="le_kw_stop" class="le-btn le-danger" type="button" style="display:none"><i class="fa-solid fa-stop"></i> Stop</button>
                            <button id="le_kw_go" class="le-btn le-primary le-run" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate keywords</button>
                        </div>
                        <div id="le_progress" class="le-progress" style="display:none"><i></i></div>
                        <div id="le_log" class="le-log"></div>
                    </section>
                </div>
            </div>

            <div class="le-footer"><div id="le_status" class="le-status"></div></div>
        </div>
    </div>`;
    $('body').append(html);

    $('#le_close').on('click', closeEditor);
    $('#le_overlay').on('mousedown', function (e) { if (e.target === this) closeEditor(); });
    $(document).on('keydown', (e) => {
        if (e.key === 'Escape' && $('#le_overlay').is(':visible')) closeEditor();
    });

    $('#le_filter').on('input', renderList);
    $('#le_refresh').on('click', refreshList);
    $('#le_all').on('click', () => {
        const filter = String($('#le_filter').val() || '').toLowerCase();
        const set = new Set(settings.selected);
        allNames.filter(n => n.toLowerCase().includes(filter)).forEach(n => set.add(n));
        settings.selected = [...set];
        save();
        renderList();
    });
    $('#le_none').on('click', () => { settings.selected = []; save(); renderList(); });

    $('#le_scope').val(settings.scope).on('change', function () {
        settings.scope = String($(this).val());
        save();
        updateScopeUI();
    });
    $('#le_scope_text').val(settings.scopeText).on('input', function () {
        settings.scopeText = String($(this).val());
        save();
    });
    updateScopeUI();

    $('.le-tab').on('click', function () { showTab($(this).data('tab')); });

    renderFlags();
    renderValues();
    $('#le_reset').on('click', resetFlags);
    $('#le_preview').on('click', () => runFlags(true));
    $('#le_apply').on('click', () => runFlags(false));

    $('#le_profile').on('change', function () { settings.profileId = String($(this).val() || ''); save(); });
    $('#le_profile_update').on('click', () => {
        const n = renderProfiles();
        toastr.info(`${n} API profile(s) found.`, 'Lorebook Editor');
    });
    $('#le_kw_mode').val(settings.kwMode).on('change', function () { settings.kwMode = String($(this).val()); save(); });
    $('#le_kw_count').val(settings.kwCount).on('input', function () { settings.kwCount = Number($(this).val()) || 8; save(); });
    $('#le_kw_skipconst').prop('checked', settings.kwSkipConstant).on('change', function () { settings.kwSkipConstant = this.checked; save(); });
    $('#le_kw_extra').val(settings.kwExtra).on('input', function () { settings.kwExtra = String($(this).val()); save(); });
    $('#le_kw_go').on('click', generateKeywords);
    $('#le_kw_stop').on('click', () => { if (abortCtl) { abortCtl.abort(); setStatus('Stopping\u2026'); } });

    showTab(settings.tab === 'kw' ? 'kw' : 'flags');
}

function buildSettingsEntry() {
    const html = `
    <div class="le-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Lorebook Editor</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small>Bulk-edit entry settings across lorebooks and generate keywords with AI.</small>
                <div id="le_open" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-book-bookmark"></i><span>Open Lorebook Editor</span>
                </div>
                <div id="le_open_safe" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-shield-halved"></i><span>Open (safe mode)</span>
                </div>
                <div id="le_diag_btn" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-stethoscope"></i><span>Diagnostics</span>
                </div>
            </div>
        </div>
    </div>`;
    const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $target.append(html);
    $('#le_open').on('click', () => openEditor(false));
    $('#le_open_safe').on('click', () => openEditor(true));
    $('#le_diag_btn').on('click', showDiagnostics);

    const $menu = $('#extensionsMenu');
    if ($menu.length) {
        const $item = $('<div id="le_wand_button" class="list-group-item flex-container flexGap5"></div>')
            .append('<div class="fa-solid fa-book-bookmark extensionsMenuExtensionButton"></div>', '<span>Lorebook Editor</span>');
        $item.on('click', () => { openEditor(false); try { $menu.hide(); } catch (_) { /* ignore */ } });
        $menu.append($item);
    }
}

/* ---------------- init ---------------- */

jQuery(() => {
    const step = (name, fn) => { try { fn(); diagLog(`${name}: ok`); } catch (e) { diagLog(`${name} FAILED: ${e?.stack || e}`); console.error(TAG, name, e); } };
    step('loadSettings', loadSettings);
    step('buildSettingsEntry', buildSettingsEntry); // first, so Diagnostics is always reachable
    step('buildModal', buildModal);
});
