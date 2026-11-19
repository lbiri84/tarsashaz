// Társasházi elszámoló (tarsashaz.laszlobiri.com).
//
// Négy lakás osztozik a közös költségeken; nevek nincsenek, mindenki lakásként szerepel.
// Az adat a közös Supabase-projekt th_* tábláiban van (laszlobiri-com/supabase/migrations/
// …_tarsashaz.sql). Olvasni a társasház oldal jogával lehet, írni csak a kezelő tud, a th_*
// függvényeken át; a felosztást és az utalásokat ez a kliens számolja, a szerver az
// összegek egyezését ellenőrzi.

import { ready } from 'https://laszlobiri.com/lib/v1/gate.js';
import { supabase as sb } from 'https://laszlobiri.com/lib/v1/client.js';

// ---------------------------------------------------------------------------
// Állandók és segédfüggvények
// ---------------------------------------------------------------------------
export const FLATS = ['fsz-1', 'fsz-2', 'em-3', 'em-4'];
const CATS = { viz: 'Víz', csatorna: 'Csatorna', szemet: 'Szemét', villany: 'Villany', egyeb: 'Egyéb' };
const METHODS = { hanyad: 'Tulajdoni hányad', letszam: 'Lakók száma', viz: 'Vízfogyasztás', egyenlo: 'Egyenlő', kezi: 'Kézi', atvett: 'Átvett' };
const METHOD_TEXT = { hanyad: 'tulajdoni hányad szerint', letszam: 'lakók száma szerint', viz: 'vízfogyasztás szerint', egyenlo: 'egyenlő részben', kezi: 'kézi felosztás', atvett: 'a régi elszámolásból' };
// A kimutatás négy csoportja (a víz és a csatorna együtt) és a színük.
const GROUPS = [['vizcs', 'Víz-csatorna', 'var(--s-viz)'], ['szemet', 'Szemét', 'var(--s-szemet)'], ['villany', 'Villany', 'var(--s-villany)'], ['egyeb', 'Egyéb', 'var(--s-egyeb)']];
const groupOf = c => (c === 'viz' || c === 'csatorna' ? 'vizcs' : c);
const COLOR = { viz: 'var(--s-viz)', csatorna: 'var(--s-viz)', szemet: 'var(--s-szemet)', villany: 'var(--s-villany)', egyeb: 'var(--s-egyeb)' };
const MCOL = { 'fsz-1': 'fsz1', 'fsz-2': 'fsz2', 'em-3': 'em3', 'em-4': 'em4' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0, useGrouping: 'always' });
const ft = n => nf.format(Math.round(n)) + ' Ft';
const sft = n => (n > 0 ? '+' : n < 0 ? '−' : '') + nf.format(Math.abs(Math.round(n)));
const m3 = n => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 1 }).format(n) + ' m³';
const pct = n => new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 1 }).format(n * 100) + '%';
const day = d => d ? new Date(d + (String(d).length === 10 ? 'T12:00:00' : '')).toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
const today = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();
/** Beírt szám: a szóközök kimaradnak, a tizedesvessző is jó. Üres vagy hibás: NaN. */
/** Szám ezres tagolással a beviteli mezőkbe ("48 620"; tizedesmezőben "1 284,5"). */
function groupStr(v, dec = false) {
  if (v == null || v === '') return '';
  let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v).replace(/[\s\u00a0]/g, '');
  const neg = s.startsWith('-');
  s = s.replace(/[^\d.,]/g, '');
  const sep = dec ? s.search(/[.,]/) : -1;
  let i = (sep >= 0 ? s.slice(0, sep) : s).replace(/[.,]/g, ''), d = sep >= 0 ? s.slice(sep + 1).replace(/[.,]/g, '') : null;
  if (dec && typeof v !== 'number' && /^\d+\.\d+$/.test(String(v))) { [i, d] = String(v).split('.'); d = d.replace(/0+$/, '') || null; }
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + i + (d != null ? ',' + d : '');
}
/** Gépelés közben tagol, a kurzor a beírt számjegyek között a helyén marad. */
function groupInput(el) {
  const dec = el.inputMode === 'decimal', sig = c => (dec ? /[\d.,-]/ : /[\d-]/).test(c);
  const v = el.value, pos = el.selectionStart ?? v.length;
  const before = [...v.slice(0, pos)].filter(sig).length;
  const out = groupStr(v, dec);
  let k = 0, p = 0;
  while (p < out.length && k < before) { if (sig(out[p])) k++; p++; }
  if (out !== v) { el.value = out; el.setSelectionRange(p, p); }
}
const num = v => { const t = String(v ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.'); return t === '' || t === '-' ? NaN : Number(t); };

/** Egész forintos felosztás súlyok szerint; a kerekítés után is pontosan kiadja az összeget. */
export function split(amount, weights) {
  const keys = FLATS.filter(f => (weights[f] || 0) > 0);
  const W = keys.reduce((a, f) => a + weights[f], 0);
  const out = Object.fromEntries(FLATS.map(f => [f, 0]));
  if (!keys.length || !W) return out;
  const sign = amount < 0 ? -1 : 1, abs = Math.abs(Math.round(amount));
  const raw = keys.map(f => [f, abs * weights[f] / W]);
  let rest = abs;
  for (const [f, v] of raw) { out[f] = Math.floor(v); rest -= out[f]; }
  raw.sort((a, b) => (b[1] - Math.floor(b[1])) - (a[1] - Math.floor(a[1])) || FLATS.indexOf(a[0]) - FLATS.indexOf(b[0]));
  for (let i = 0; i < rest; i++) out[raw[i % raw.length][0]] += 1;
  if (sign < 0) for (const f of FLATS) out[f] = -out[f] || 0;
  return out;
}

/** A legkevesebb utalás: a tartozók a követelőknek, a legnagyobbakkal kezdve. */
export function transfers(bal) {
  const cred = FLATS.filter(f => bal[f] > 0).map(f => [f, bal[f]]).sort((a, b) => b[1] - a[1]);
  const debt = FLATS.filter(f => bal[f] < 0).map(f => [f, -bal[f]]).sort((a, b) => b[1] - a[1]);
  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const a = Math.min(debt[i][1], cred[j][1]);
    if (a > 0) out.push({ from: debt[i][0], to: cred[j][0], amount: a });
    debt[i][1] -= a; cred[j][1] -= a;
    if (!debt[i][1]) i++;
    if (!cred[j][1]) j++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Adat
// ---------------------------------------------------------------------------
let D = { flats: [], residents: [], periods: [], readings: [], items: [], shares: [], transfers: [] };
let ME = { flat: null, manager: false };

async function load() {
  const q = (t, o) => sb.from(t).select('*').order(o[0], { ascending: o[1] !== false });
  const [me, flats, residents, periods, readings, items, shares, trs] = await Promise.all([
    sb.rpc('th_me'), q('th_flats', ['sort']), q('th_residents', ['valid_from']), q('th_periods', ['starts_on', false]),
    q('th_readings', ['read_on']), q('th_items', ['created_at']), sb.from('th_item_shares').select('*'), q('th_transfers', ['amount', false]),
  ]);
  for (const r of [me, flats, residents, periods, readings, items, shares, trs]) if (r.error) throw r.error;
  ME = me.data || { flat: null, manager: false };
  D = { flats: flats.data, residents: residents.data, periods: periods.data, readings: readings.data, items: items.data, shares: shares.data, transfers: trs.data };
}

const share = f => D.flats.find(x => x.code === f)?.share || 0;
const openPeriod = () => D.periods.find(p => p.status === 'open');
const itemsOf = pid => D.items.filter(i => i.period_id === pid);
const sharesOf = iid => Object.fromEntries(FLATS.map(f => [f, D.shares.find(s => s.item_id === iid && s.flat === f)?.amount || 0]));
const transfersOf = pid => D.transfers.filter(t => t.period_id === pid);

/** A létszám egy adott napon (lakásonként a legutóbbi érvényes beállítás). */
function residentsAt(date) {
  const out = {};
  for (const f of FLATS) {
    const rows = D.residents.filter(r => r.flat === f).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
    const r = rows.filter(x => x.valid_from <= date).pop() || rows[0];
    out[f] = r ? r.count : 0;
  }
  return out;
}

/** Az almérők fogyasztása két leolvasás között. */
function waterUse(fromId, toId) {
  const a = D.readings.find(r => r.id === fromId), b = D.readings.find(r => r.id === toId);
  if (!a || !b) return null;
  const use = Object.fromEntries(FLATS.map(f => [f, Number(b[MCOL[f]]) - Number(a[MCOL[f]])]));
  const main = a.main != null && b.main != null ? Number(b.main) - Number(a.main) : null;
  return { use, main, from: a, to: b };
}

function balances(pid) {
  const bal = Object.fromEntries(FLATS.map(f => [f, 0]));
  for (const it of itemsOf(pid)) {
    bal[it.paid_by] += it.amount;
    const sh = sharesOf(it.id);
    for (const f of FLATS) bal[f] -= sh[f];
  }
  return bal;
}

function periodState(p) {
  if (p.status === 'open') return ['nyitott', 'open'];
  const trs = transfersOf(p.id), wait = trs.filter(t => !t.paid_at).length;
  return wait ? [`lezárva, ${wait} utalás vár`, ''] : ['rendezve', 'ok'];
}

/** A tétel lakásrészei a választott mód szerint (a „kézi” a megadott számokkal). */
function computeShares(f) {
  const parts = FLATS.filter(x => f.participants.includes(x));
  const amount = Math.round(num(f.amount) || 0);
  if (f.method === 'kezi') return { shares: Object.fromEntries(FLATS.map(x => [x, parts.includes(x) ? Math.round(num(f.manual[x]) || 0) : 0])) };
  let w = {}, info = '';
  if (f.method === 'hanyad') { for (const x of parts) w[x] = share(x); info = parts.map(x => share(x)).join(' / ') + ' tízezred'; }
  if (f.method === 'letszam') { const r = residentsAt(f.date || today()); for (const x of parts) w[x] = r[x]; info = parts.map(x => r[x] + ' fő').join(' / '); }
  if (f.method === 'egyenlo') { for (const x of parts) w[x] = 1; info = `${parts.length} egyenlő részben`; }
  if (f.method === 'viz') {
    const u = waterUse(f.reading_from, f.reading_to);
    if (!u) return { shares: split(amount, {}), error: 'Válassz két leolvasást.' };
    for (const x of parts) w[x] = Math.max(0, u.use[x]);
    const tot = parts.reduce((a, x) => a + w[x], 0);
    info = parts.map(x => tot ? pct(w[x] / tot) : '–').join(' · ') + ` (${day(u.from.read_on)} – ${day(u.to.read_on)})`;
    if (!tot) return { shares: split(amount, {}), error: 'A két leolvasás között nincs fogyasztás.' };
  }
  return { shares: split(amount, w), info };
}

// ---------------------------------------------------------------------------
// Nézetek
// ---------------------------------------------------------------------------
const $app = document.getElementById('app');
let msg = '', msgErr = false;
const say = (t, err = false) => { msg = t; msgErr = err; const m = document.getElementById('msg'); if (m) { m.textContent = t; m.className = 'msg' + (err ? ' err' : ''); } };
const msgEl = () => `<p class="msg${msgErr ? ' err' : ''}" id="msg" role="status" aria-live="polite">${esc(msg)}</p>`;
const errText = e => {
  const s = String(e?.message || e || '');
  if (/fetch|network/i.test(s)) return 'Nincs kapcsolat. Próbáld újra.';
  return s.length < 160 ? s : 'Nem sikerült. Próbáld újra.';
};

function itemRow(it, link) {
  const tag = link ? 'a' : 'div';
  return `<${tag} class="item"${link ? ` href="#/tetel/${it.id}"` : ''}><i class="dot" style="background:${COLOR[it.category]}"></i><span class="n">${esc(it.name)}</span><b class="num">${ft(it.amount)}</b>
    <span class="m">fizette: ${esc(it.paid_by)} · ${METHOD_TEXT[it.method]}${it.participants.length < 4 ? ' (' + it.participants.join(', ') + ')' : ''}${it.note ? ' · ' + esc(it.note) : ''}</span></${tag}>`;
}

function splitTable(pid) {
  const its = itemsOf(pid);
  if (!its.length) return '<p class="muted small">Még nincs tétel.</p>';
  const tot = Object.fromEntries(FLATS.map(f => [f, 0]));
  const rows = its.map(it => { const sh = sharesOf(it.id); FLATS.forEach(f => tot[f] += sh[f]);
    return `<tr><td>${esc(it.name)}</td>${FLATS.map(f => `<td class="num">${sh[f] ? nf.format(sh[f]) : '–'}</td>`).join('')}</tr>`; }).join('');
  return `<div class="scroll"><table><tr><th></th>${FLATS.map(f => `<th>${f}</th>`).join('')}</tr>${rows}
    <tr class="tot"><td>Összesen</td>${FLATS.map(f => `<td class="num">${nf.format(tot[f])}</td>`).join('')}</tr></table></div>`;
}

function balanceTable(pid) {
  const bal = balances(pid);
  const paid = Object.fromEntries(FLATS.map(f => [f, itemsOf(pid).filter(i => i.paid_by === f).reduce((a, i) => a + i.amount, 0)]));
  return `<table><tr><th>Lakás</th><th>Fizetett</th><th>Része</th><th>Egyenleg</th></tr>
    ${FLATS.map(f => `<tr><td><b>${f}</b></td><td class="num">${nf.format(paid[f])}</td><td class="num">${nf.format(paid[f] - bal[f])}</td><td class="num">${sft(bal[f])}</td></tr>`).join('')}</table>`;
}

function homeView() {
  const op = openPeriod();
  let hero = '';
  // Függő utalások a lezárt időszakokból, amelyek a saját lakást érintik.
  const mine = ME.flat ? D.transfers.filter(t => !t.paid_at && (t.from_flat === ME.flat || t.to_flat === ME.flat)) : [];
  if (ME.flat && mine.length) {
    const out = mine.filter(t => t.from_flat === ME.flat), inn = mine.filter(t => t.to_flat === ME.flat);
    hero = out.map(t => `<a class="card hero" href="#/idoszak/${t.period_id}"><div class="small">${esc(D.periods.find(p => p.id === t.period_id)?.name)} · ${ME.flat}</div><div class="big num">${ft(t.amount)}</div><div>utalandó <b>${t.to_flat}</b> részére</div></a>`).join('')
      + inn.map(t => `<a class="card hero even" href="#/idoszak/${t.period_id}"><div class="small">${esc(D.periods.find(p => p.id === t.period_id)?.name)}</div><div><b>${t.from_flat}</b> utalása várható: <b class="num">${ft(t.amount)}</b></div></a>`).join('');
  } else if (ME.flat && op) {
    const b = balances(op.id)[ME.flat];
    hero = `<div class="card hero even"><div class="small">${esc(op.name)} · ${ME.flat} · eddig</div><div class="big num">${b < 0 ? ft(-b) : b > 0 ? ft(b) : '0 Ft'}</div><div>${b < 0 ? 'a részed (még nyitott időszak)' : b > 0 ? 'neked jár (még nyitott időszak)' : 'nincs teendőd'}</div></div>`;
  }
  const last = D.readings[D.readings.length - 1], prev = D.readings[D.readings.length - 2];
  const u = last && prev ? waterUse(prev.id, last.id) : null;
  const subs = u ? FLATS.reduce((a, f) => a + u.use[f], 0) : 0;
  return `${!ME.flat && !ME.manager ? '<div class="warn">A fiókod még nincs lakáshoz rendelve. Szólj a kezelőnek.</div>' : ''}
  ${hero}
  ${ME.manager ? `<div class="btns">${op ? `<a class="btn p" href="#/tetel/uj">+ Új tétel</a>` : `<a class="btn p" href="#/idoszakok">Új időszak</a>`}<a class="btn" href="#/viz/uj">Vízóra-leolvasás</a></div>` : ''}
  ${ME.manager && !D.periods.length ? '<div class="warn">Az elszámoló még üres. A régi adatokat a <a href="#/beallitasok">Beállítások</a> oldalon töltheted be, vagy indíts egy új időszakot.</div>' : ''}
  <h2>Nyitott elszámolás</h2>
  ${op ? `<a class="card" href="#/idoszak/${op.id}"><div class="row"><b>${esc(op.name)}</b><span class="pill open sp">nyitott</span></div>
    <div class="small muted">${itemsOf(op.id).length} tétel · összesen <span class="num">${ft(itemsOf(op.id).reduce((a, i) => a + i.amount, 0))}</span></div>
    <div style="margin-top:8px">${balanceTable(op.id)}</div></a>` : '<p class="muted">Nincs nyitott időszak.</p>'}
  <h2>Vízóra</h2>
  ${last ? `<a class="card small" href="#/viz"><div class="row"><span>Utolsó leolvasás</span><b class="sp">${day(last.read_on)}</b></div>
    ${u ? `<div class="row"><span>Lakások összesen</span><b class="sp num">${m3(subs)}</b></div>
    ${u.main != null ? `<div class="row"><span>Főmérő</span><b class="sp num">${m3(u.main)}</b></div><div class="row"><span>Kerti csap (különbség)</span><b class="sp num">${m3(u.main - subs)}</b></div>` : ''}` : ''}</a>` : '<p class="muted">Még nincs leolvasás.</p>'}`;
}

function periodsView() {
  const op = openPeriod();
  const byYear = {};
  for (const p of D.periods) (byYear[p.starts_on.slice(0, 4)] ||= []).push(p);
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const MON = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
  const defName = `${y}. ${MON[m]}–${MON[(m + 1) % 12]}`;
  return `<h1>Elszámolások</h1>
  <p class="small muted">A lezárt időszakok megmaradnak, bármikor visszanézhetők.</p>
  ${ME.manager && !op ? `<form class="card" id="newPeriod"><label class="field"><span class="l">Az új időszak neve</span><input type="text" name="name" maxlength="60" value="${esc(defName)}" required></label>
    <label class="field"><span class="l">Kezdete</span><input type="date" name="starts_on" value="${today().slice(0, 8)}01" required></label><button class="p" type="submit">Új időszak indítása</button></form>` : ''}
  ${msgEl()}
  ${Object.keys(byYear).sort().reverse().map(yr => `<h2>${yr}</h2>` + byYear[yr].map(p => { const [st, cls] = periodState(p); const its = itemsOf(p.id);
    const wait = transfersOf(p.id).filter(t => !t.paid_at);
    return `<a class="card" href="#/idoszak/${p.id}"><div class="row"><b>${esc(p.name)}</b><span class="pill ${cls} sp">${st}</span></div>
      <div class="small muted">${its.length} tétel · <span class="num">${ft(its.reduce((a, i) => a + i.amount, 0))}</span>${p.closed_at ? ' · lezárva ' + day(p.closed_at.slice(0, 10)) : ''}</div>
      ${wait.map(t => `<div class="small">Vár: <b>${t.from_flat} → ${t.to_flat}</b> <span class="num">${ft(t.amount)}</span></div>`).join('')}</a>`; }).join('')).join('')}
  ${!D.periods.length ? '<p class="muted">Még nincs időszak.</p>' : ''}`;
}

function chatText(p) {
  const its = itemsOf(p.id), trs = transfersOf(p.id);
  const lines = [`Közös költség, ${p.name} (${ft(its.reduce((a, i) => a + i.amount, 0))})`, its.map(i => `${i.name} ${nf.format(i.amount)}`).join(', '), ''];
  if (trs.length) { lines.push('Utalások:'); for (const t of trs) lines.push(`${t.from_flat} → ${t.to_flat}: ${ft(t.amount)}`); }
  lines.push('Részletek: https://tarsashaz.laszlobiri.com');
  return lines.join('\n');
}

let closing = null;   // a lezárás előnézete: [{from, to, amount}]
function periodView(id) {
  const p = D.periods.find(x => x.id === id);
  if (!p) return '<p class="muted">Nincs ilyen időszak.</p>';
  const [st, cls] = periodState(p), its = itemsOf(p.id), trs = transfersOf(p.id), open = p.status === 'open';
  const canMark = t => ME.manager || (ME.flat && (t.from_flat === ME.flat || t.to_flat === ME.flat));
  return `<a class="back" href="#/idoszakok">‹ Elszámolások</a>
  <h1>${esc(p.name)}</h1>
  <div class="row small"><span class="pill ${cls}">${st}</span>${p.note ? `<span class="muted">${esc(p.note)}</span>` : ''}</div>
  ${msgEl()}
  <h2>Tételek</h2>
  <div class="card" style="padding-top:2px;padding-bottom:2px">${its.length ? its.map(it => itemRow(it, ME.manager && open)).join('') : '<p class="muted small">Még nincs tétel.</p>'}</div>
  ${ME.manager && open ? `<div class="btns"><a class="btn" href="#/tetel/uj">+ Új tétel</a><button class="p" data-act="preclose"${its.length ? '' : ' disabled'}>Lezárás, utalások</button></div>` : ''}
  ${closing ? `<div class="card"><b>Lezárás előtt</b><p class="small muted">Ezek az utalások rendezik az időszakot. Lezárás után a tételek nem módosíthatók.</p>
    ${closing.length ? closing.map(t => `<div class="tr"><span class="tag">${t.from}</span><span class="muted">→</span><span class="tag" style="justify-self:start">${t.to}</span><b class="num">${ft(t.amount)}</b></div>`).join('') : '<p class="small">Nincs szükség utalásra.</p>'}
    <div class="btns"><button data-act="cancelclose">Mégse</button><button class="p" data-act="close">Lezárás</button></div></div>` : ''}
  <h2>Felosztás</h2><div class="card">${splitTable(p.id)}</div>
  <h2>Egyenlegek</h2><div class="card">${balanceTable(p.id)}</div>
  ${!open ? `<h2>Utalások</h2><div class="card" style="padding-top:2px;padding-bottom:2px">${trs.length ? trs.map(t => `<label class="tr"><span class="tag">${t.from_flat}</span><span class="muted">→</span><span class="tag" style="justify-self:start">${t.to_flat}</span>
      <span class="row"><b class="num">${ft(t.amount)}</b><input type="checkbox" data-paid="${t.id}"${t.paid_at ? ' checked' : ''}${canMark(t) ? '' : ' disabled'} aria-label="${t.from_flat} → ${t.to_flat}: megérkezett"></span></label>`).join('') : '<p class="small muted">Nem volt szükség utalásra.</p>'}</div>
    <p class="small muted">A pipát az utaló vagy a fogadó lakás teheti be, amikor az utalás megérkezett.</p>` : ''}
  <h2>Üzenet a közös chatbe</h2><div class="card"><pre class="chat" id="chat">${esc(chatText(p))}</pre></div>
  <div class="btns${ME.manager && !open ? '' : ' one'}"><button data-act="copy">Szöveg másolása</button>${ME.manager && !open ? '<button data-act="reopen">Újranyitás</button>' : ''}</div>`;
}

// Az új vagy szerkesztett tétel űrlapjának állapota.
let F = null;
function newForm(it) {
  const op = openPeriod();
  if (it) {
    return { id: it.id, period_id: it.period_id, name: it.name, category: it.category, amount: it.amount, paid_by: it.paid_by, method: it.method,
      participants: [...it.participants], reading_from: it.reading_from, reading_to: it.reading_to, note: it.note || '', manual: sharesOf(it.id),
      date: D.periods.find(p => p.id === it.period_id)?.starts_on };
  }
  // vízhez alapból: az előző víz tétel záró leolvasásától a legutolsóig
  const lastViz = [...D.items].reverse().find(i => i.method === 'viz' && i.reading_to);
  const lastR = D.readings[D.readings.length - 1];
  const fromR = lastViz ? lastViz.reading_to : D.readings[D.readings.length - 2]?.id;
  return { id: null, period_id: op?.id, name: '', category: 'egyeb', amount: '', paid_by: ME.flat || 'fsz-1', method: 'hanyad', participants: [...FLATS],
    reading_from: fromR || null, reading_to: lastR?.id || null, note: '', manual: Object.fromEntries(FLATS.map(f => [f, 0])), date: op?.starts_on };
}

function itemView() {
  if (!F || !F.period_id) return '<p class="muted">Nincs nyitott időszak.</p>';
  const seg = (name, opts, val, multi = false) => `<div class="seg" role="${multi ? 'group' : 'radiogroup'}">${Object.entries(opts).map(([k, l]) =>
    `<label><input type="${multi ? 'checkbox' : 'radio'}" name="${name}" value="${k}"${(multi ? val.includes(k) : val === k) ? ' checked' : ''}>${esc(l)}</label>`).join('')}</div>`;
  const { shares, info, error } = computeShares(F);
  const total = FLATS.reduce((a, f) => a + shares[f], 0), amt = Math.round(num(F.amount) || 0);
  const max = Math.max(1, ...FLATS.map(f => Math.abs(shares[f])));
  const rOpts = D.readings.map(r => `<option value="${r.id}">${day(r.read_on)}</option>`).join('');
  const wu = F.method === 'viz' ? waterUse(F.reading_from, F.reading_to) : null;
  const gaps = F.method === 'viz' ? overlapWarn(F) : '';
  return `<a class="back" href="#/idoszak/${F.period_id}">‹ ${esc(D.periods.find(p => p.id === F.period_id)?.name)}</a>
  <h1>${F.id ? 'Tétel szerkesztése' : 'Új tétel'}</h1>
  <form id="itemForm" novalidate>
  <label class="field"><span class="l">Megnevezés</span><input type="text" name="name" maxlength="80" value="${esc(F.name)}" required></label>
  <div class="field"><span class="l">Kategória</span>${seg('category', CATS, F.category)}</div>
  <label class="field"><span class="l">Összeg (Ft; visszatérítés: negatív)</span><input type="text" name="amount" inputmode="numeric" autocomplete="off" value="${esc(groupStr(F.amount))}" required></label>
  <div class="field"><span class="l">Ki fizette?</span>${seg('paid_by', Object.fromEntries(FLATS.map(f => [f, f])), F.paid_by)}</div>
  <div class="field"><span class="l">Ki száll be?</span>${seg('participants', Object.fromEntries(FLATS.map(f => [f, f])), F.participants, true)}</div>
  <div class="field"><span class="l">Felosztás</span>${seg('method', Object.fromEntries(Object.entries(METHODS).filter(([k]) => k !== 'atvett' || F.method === 'atvett')), F.method)}</div>
  ${F.method === 'viz' ? `<div class="field grid2"><label class="field"><span class="l">Leolvasás: ettől</span><select name="reading_from">${rOpts}</select></label>
    <label class="field"><span class="l">eddig</span><select name="reading_to">${rOpts}</select></label></div>
    ${wu && wu.main != null ? `<p class="small muted">Főmérő: ${m3(wu.main)}, lakások: ${m3(FLATS.reduce((a, f) => a + wu.use[f], 0))}, kerti csap: ${m3(wu.main - FLATS.reduce((a, f) => a + wu.use[f], 0))}. A kerti rész a lakások fogyasztásának arányában oszlik.</p>` : ''}${gaps}` : ''}
  ${F.method === 'kezi' ? `<div class="field"><span class="l">Lakásonként (Ft)</span><div class="grid4">${FLATS.filter(f => F.participants.includes(f)).map(f => `<b>${f}</b><input type="text" inputmode="numeric" autocomplete="off" name="m_${f}" value="${esc(groupStr(F.manual[f]))}" style="grid-column: span 3">`).join('')}</div></div>` : ''}
  <div class="card"><div class="small muted" style="margin-bottom:8px">${error ? `<span class="msg err">${esc(error)}</span>` : 'Így oszlik meg' + (info ? ` (${esc(info)})` : '')}</div>
    <div class="split">${FLATS.map(f => `<b>${f}</b><div class="bar" style="width:${Math.round(Math.abs(shares[f]) / max * 100)}%${shares[f] ? '' : ';opacity:.2'}"></div><span class="num r">${ft(shares[f])}</span>`).join('')}</div>
    <div class="small ${total === amt ? 'muted' : 'msg err'}" style="margin-top:8px">${total === amt ? `Pontosan ${ft(amt)}.` : `A részek összege ${ft(total)}, a tétel ${ft(amt)}.`}</div></div>
  <label class="field"><span class="l">Megjegyzés (nem kötelező)</span><input type="text" name="note" maxlength="200" value="${esc(F.note)}"></label>
  ${msgEl()}
  <div class="btns${F.id ? '' : ' one'}">${F.id ? '<button type="button" class="danger" data-act="delitem">Törlés</button>' : ''}<button class="p" type="submit"${error || total !== amt || !amt ? ' disabled' : ''}>Mentés</button></div>
  </form>`;
}

// Figyelmeztet, ha a víz tétel leolvasási szakasza átfed egy másik víz tétellel, vagy hézag van.
function overlapWarn(f) {
  const a = D.readings.find(r => r.id === f.reading_from), b = D.readings.find(r => r.id === f.reading_to);
  if (!a || !b) return '';
  if (a.read_on >= b.read_on) return '<div class="warn">A „ettől” leolvasás legyen korábbi, mint az „eddig”.</div>';
  const others = D.items.filter(i => i.method === 'viz' && i.id !== f.id && i.category === f.category && i.reading_from && i.reading_to)
    .map(i => [D.readings.find(r => r.id === i.reading_from)?.read_on, D.readings.find(r => r.id === i.reading_to)?.read_on, i.name]);
  const over = others.find(([x, y]) => x < b.read_on && a.read_on < y);
  if (over) return `<div class="warn">Átfed a(z) „${esc(over[2])}” tétel szakaszával: ugyanaz a fogyasztás kétszer számítana.</div>`;
  const prevEnd = others.map(o => o[1]).filter(x => x <= a.read_on).sort().pop();
  if (prevEnd && prevEnd < a.read_on) return `<div class="warn">Hézag: az előző ${esc(CATS[f.category].toLowerCase())} tétel ${day(prevEnd)}-ig tartott.</div>`;
  return '';
}

let R = null;   // új leolvasás űrlapja
function waterView() {
  const rows = D.readings.map((r, i) => {
    const p = D.readings[i - 1], u = p ? waterUse(p.id, r.id) : null, subs = u ? FLATS.reduce((a, f) => a + u.use[f], 0) : null;
    return `<tr><td>${day(r.read_on)}</td><td class="num">${r.main != null ? nf.format(r.main) : '–'}</td>${FLATS.map(f => `<td class="num">${new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 3 }).format(r[MCOL[f]])}${u ? `<div class="small muted">+${new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 1 }).format(u.use[f])}</div>` : ''}</td>`).join('')}
      <td class="num">${u && u.main != null ? m3(u.main - subs) : '–'}</td>${ME.manager ? `<td><button class="danger" data-delreading="${r.id}" aria-label="Törlés">✕</button></td>` : ''}</tr>`;
  }).reverse().join('');
  return `<h1>Vízóra</h1>
  <p class="small muted">A vízdíjat a lakások almérőinek arányában osztjuk szét. A főmérő nem kötelező: ellenőrzésre és a kerti csap fogyasztásához kell.</p>
  ${ME.manager ? '<div class="btns one"><a class="btn p" href="#/viz/uj">+ Új leolvasás</a></div>' : ''}
  ${msgEl()}
  <div class="card scroll"><table><tr><th>Dátum</th><th>Főmérő</th>${FLATS.map(f => `<th>${f}</th>`).join('')}<th>Kert</th>${ME.manager ? '<th></th>' : ''}</tr>${rows || '<tr><td colspan="7" class="muted">Még nincs leolvasás.</td></tr>'}</table></div>`;
}

function readingView() {
  const last = D.readings[D.readings.length - 1];
  const v = R || { read_on: today(), main: '', fsz1: '', fsz2: '', em3: '', em4: '' };
  const d = k => (last && last[k] != null ? num(v[k]) - Number(last[k]) : NaN);
  const subs = FLATS.reduce((a, f) => a + (isNaN(d(MCOL[f])) ? 0 : d(MCOL[f])), 0);
  const warns = [];
  for (const f of FLATS) if (!isNaN(d(MCOL[f])) && d(MCOL[f]) < 0) warns.push(`A(z) ${f} állása kisebb, mint az előző: elírás lehet.`);
  if (!isNaN(d('main')) && subs > d('main') + 0.001) warns.push('A lakások összesen többet fogyasztottak, mint a főmérő: valamelyik szám elírás lehet.');
  const line = (k, label) => `<b>${label}</b><span class="r muted num">${last && last[k] != null ? nf.format(last[k]) : '–'}</span><input type="text" inputmode="decimal" autocomplete="off" name="${k}" value="${esc(groupStr(v[k], true))}" aria-label="${label}"><span class="r num"><b>${isNaN(d(k)) ? '' : m3(d(k))}</b></span>`;
  return `<a class="back" href="#/viz">‹ Vízóra</a><h1>Leolvasás</h1>
  <form id="readingForm" novalidate>
  <label class="field"><span class="l">A leolvasás napja</span><input type="date" name="read_on" value="${esc(v.read_on)}" required></label>
  <div class="grid4"><span class="h">Mérő</span><span class="h r">Előző${last ? ' (' + day(last.read_on) + ')' : ''}</span><span class="h">Most</span><span class="h r">Fogyás</span>
    ${line('main', 'Főmérő')}${FLATS.map(f => line(MCOL[f], f)).join('')}</div>
  <p class="small muted">A főmérő nem kötelező.</p>
  ${warns.map(w => `<div class="warn">${esc(w)}</div>`).join('')}
  ${msgEl()}
  <div class="btns one"><button class="p" type="submit">Mentés</button></div></form>`;
}

function statsView(year) {
  const years = [...new Set(D.periods.map(p => p.starts_on.slice(0, 4)))].sort().reverse();
  const y = year || years[0];
  const setLink = ME.manager ? '<h2>Beállítások</h2><div class="btns one"><a class="btn" href="#/beallitasok">Tulajdoni hányad, lakók száma, régi adatok</a></div>' : '';
  if (!y) return `<h1>Kimutatás</h1><p class="muted">Még nincs adat.</p>${setLink}`;
  const pids = new Set(D.periods.filter(p => p.starts_on.startsWith(y)).map(p => p.id));
  const its = D.items.filter(i => pids.has(i.period_id));
  const t = Object.fromEntries(FLATS.map(f => [f, Object.fromEntries(GROUPS.map(g => [g[0], 0]))]));
  for (const it of its) { const sh = sharesOf(it.id); for (const f of FLATS) t[f][groupOf(it.category)] += sh[f]; }
  const tot = f => GROUPS.reduce((a, g) => a + t[f][g[0]], 0);
  const max = Math.max(1, ...FLATS.map(tot));
  // kerti csap leolvasásonként
  const garden = [];
  for (let i = 1; i < D.readings.length; i++) {
    const u = waterUse(D.readings[i - 1].id, D.readings[i].id);
    if (u && u.main != null && D.readings[i].read_on.startsWith(y)) garden.push([D.readings[i].read_on, Math.max(0, u.main - FLATS.reduce((a, f) => a + u.use[f], 0))]);
  }
  const gmax = Math.max(1, ...garden.map(g => g[1]));
  return `<h1>Kimutatás</h1>
  <div class="seg" role="radiogroup" style="margin:6px 0 4px">${years.map(x => `<label><input type="radio" name="year" value="${x}"${x === y ? ' checked' : ''}>${x}</label>`).join('')}</div>
  <h2>Lakásonként, kategóriánként</h2>
  <div class="card">
    <div class="legend">${GROUPS.map(g => `<span><i style="background:${g[2]}"></i>${g[1]}</span>`).join('')}</div>
    ${FLATS.map(f => `<div class="hbar"><b>${f}</b><div class="stack" style="width:${(tot(f) / max * 100).toFixed(1)}%">${GROUPS.filter(g => t[f][g[0]] > 0).map(g => `<b style="flex:${t[f][g[0]]};background:${g[2]}" title="${g[1]}: ${ft(t[f][g[0]])}"></b>`).join('')}</div><span class="num r">${nf.format(tot(f))}</span></div>`).join('')}
    <div class="scroll" style="margin-top:10px"><table><tr><th>Ft</th>${FLATS.map(f => `<th>${f}</th>`).join('')}</tr>
      ${GROUPS.map(g => `<tr><td>${g[1]}</td>${FLATS.map(f => `<td class="num">${nf.format(t[f][g[0]])}</td>`).join('')}</tr>`).join('')}
      <tr class="tot"><td>Összesen</td>${FLATS.map(f => `<td class="num">${nf.format(tot(f))}</td>`).join('')}</tr></table></div>
  </div>
  <div class="card small"><div class="row"><span>Összes közös költség ${y}-ben</span><b class="sp num">${ft(its.reduce((a, i) => a + i.amount, 0))}</b></div></div>
  ${garden.length ? `<h2>Kerti csap (a főmérő és a lakások különbsége)</h2><div class="card"><div class="vbars">${garden.map(g => `<div><span class="num">${m3(g[1])}</span><b style="height:${(g[1] / gmax * 100).toFixed(0)}%"></b></div>`).join('')}</div>
    <div class="vlab">${garden.map(g => `<span>${new Date(g[0] + 'T12:00:00').toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })}</span>`).join('')}</div></div>` : ''}
  ${setLink}`;
}

function settingsView() {
  const r = residentsAt(today());
  const hist = [...new Set(D.residents.map(x => x.valid_from))].sort().reverse();
  return `<a class="back" href="#/kimutatas">‹ Kimutatás</a><h1>Beállítások</h1>
  ${msgEl()}
  <h2>Tulajdoni hányad (tízezred, összesen 10 000)</h2>
  <form class="card" id="flatsForm"><div class="grid4">${FLATS.map(f => `<b>${f}</b><input type="text" inputmode="numeric" autocomplete="off" name="${f}" value="${share(f) ? groupStr(share(f)) : ''}" style="grid-column: span 3" aria-label="${f} tulajdoni hányad">`).join('')}</div>
    <div class="btns one"><button class="p" type="submit">Mentés</button></div></form>
  <h2>Lakók száma (a szemétdíjhoz)</h2>
  <form class="card" id="resForm"><label class="field"><span class="l">Ettől a naptól</span><input type="date" name="valid_from" value="${today()}" required></label>
    <div class="grid4">${FLATS.map(f => `<b>${f}</b><input type="text" inputmode="numeric" autocomplete="off" name="${f}" value="${r[f]}" style="grid-column: span 3" aria-label="${f} lakók száma">`).join('')}</div>
    <div class="btns one"><button class="p" type="submit">Mentés</button></div></form>
  ${!D.periods.length ? `<h2>Régi adatok betöltése (egyszeri)</h2>
  <form class="card" id="importForm"><p class="small muted">Csak üres elszámolóba: a hányad, a létszám, a leolvasások és a lezárt időszakok egy JSON fájlból. A régi utalások kiegyenlítettként kerülnek be.</p>
    <label class="field"><span class="l">Fájl</span><input type="file" name="file" accept="application/json,.json" required></label>
    <div class="btns one"><button class="p" type="submit">Betöltés</button></div></form>` : ''}
  ${hist.length ? `<div class="card small">${hist.map(d => `<div class="row"><span>${day(d)}-tól</span><span class="sp num">${FLATS.map(f => D.residents.find(x => x.valid_from === d && x.flat === f)?.count ?? '–').join(' : ')}</span></div>`).join('')}</div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Útvonalak és események
// ---------------------------------------------------------------------------
let route = '';
function render() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (h !== route) { if (!h.startsWith('/tetel')) F = null; if (h !== '/viz/uj') R = null; closing = null; msg = ''; route = h; }
  const [, a, b] = h.split('/');
  let html, tab = 'home';
  if (a === 'idoszakok') { html = periodsView(); tab = 'periods'; }
  else if (a === 'idoszak') { html = periodView(b); tab = 'periods'; }
  else if (a === 'tetel' && ME.manager) {
    if (!F) { const it = D.items.find(i => i.id === b); F = newForm(b === 'uj' ? null : it); }
    html = itemView(); tab = 'periods';
  }
  else if (a === 'viz' && b === 'uj' && ME.manager) { html = readingView(); tab = 'water'; }
  else if (a === 'viz') { html = waterView(); tab = 'water'; }
  else if (a === 'kimutatas') { html = statsView(b); tab = 'stats'; }
  else if (a === 'beallitasok' && ME.manager) { html = settingsView(); tab = 'stats'; }
  else html = homeView();
  $app.innerHTML = html;
  for (const t of document.querySelectorAll('#tabs a')) t.classList.toggle('on', t.dataset.tab === tab);
  // a select-ek értéke (az innerHTML nem állítja)
  const rf = $app.querySelector('select[name=reading_from]'), rt = $app.querySelector('select[name=reading_to]');
  if (rf && F) rf.value = F.reading_from || ''; if (rt && F) rt.value = F.reading_to || '';
}

// Újratöltés, üzenettel; ha `hash` meg van adva, oda navigál (az üzenet megmarad).
async function refresh(t, hash) {
  let err = false;
  try { await load(); } catch (e) { t = errText(e); err = true; }
  if (t !== undefined) { msg = t; msgErr = err; }
  if (hash && location.hash !== hash) { route = hash.slice(1); closing = null; location.hash = hash; }
  else render();
}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}

function readItemForm(form) {
  const fd = new FormData(form);
  F.name = fd.get('name') ?? F.name; F.category = fd.get('category') || F.category; F.amount = fd.get('amount') ?? F.amount;
  F.paid_by = fd.get('paid_by') || F.paid_by; F.method = fd.get('method') || F.method; F.note = fd.get('note') ?? F.note;
  F.participants = fd.getAll('participants');
  if (fd.has('reading_from')) { F.reading_from = fd.get('reading_from'); F.reading_to = fd.get('reading_to'); }
  for (const f of FLATS) if (fd.has('m_' + f)) F.manual[f] = fd.get('m_' + f);
}

// Űrlapmezők változása: az előnézet frissül (a fókusz és a kurzor megmarad).
$app.addEventListener('input', e => {
  if (e.target.inputMode === 'numeric' || e.target.inputMode === 'decimal') groupInput(e.target);
  const form = e.target.closest('form');
  if (form?.id === 'itemForm') {
    readItemForm(form);
    const name = e.target.name, pos = e.target.selectionStart;
    render();
    const el = $app.querySelector(`[name="${name}"]${e.target.type === 'radio' || e.target.type === 'checkbox' ? `[value="${e.target.value}"]` : ''}`);
    if (el) { el.focus(); if (pos != null && el.type === 'text') el.setSelectionRange(pos, pos); }
  }
  if (form?.id === 'readingForm') {
    const fd = new FormData(form); R = Object.fromEntries(['read_on', 'main', 'fsz1', 'fsz2', 'em3', 'em4'].map(k => [k, fd.get(k) ?? '']));
    const name = e.target.name, pos = e.target.selectionStart; render();
    const el = $app.querySelector(`[name="${name}"]`);
    if (el) { el.focus(); if (pos != null && el.type === 'text') el.setSelectionRange(pos, pos); }
  }
});
$app.addEventListener('change', async e => {
  if (e.target.matches('select') && e.target.closest('#itemForm')) { readItemForm(e.target.form); render(); }
  if (e.target.name === 'year') location.hash = '#/kimutatas/' + e.target.value;
  const pid = e.target.dataset.paid;
  if (pid) {
    e.target.disabled = true;
    try { await rpc('th_mark_transfer', { p_id: pid, p_paid: e.target.checked }); await refresh(e.target.checked ? 'Megérkezettnek jelölve.' : 'A jelölés visszavonva.'); }
    catch (err) { say(errText(err), true); e.target.checked = !e.target.checked; e.target.disabled = false; }
  }
});

$app.addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target, btn = form.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  try {
    if (form.id === 'newPeriod') {
      const fd = new FormData(form);
      const id = await rpc('th_open_period', { p_name: fd.get('name'), p_starts_on: fd.get('starts_on') });
      await refresh('Az időszak elindult.', '#/idoszak/' + id);
    }
    if (form.id === 'itemForm') {
      readItemForm(form);
      const { shares } = computeShares(F);
      const p = { id: F.id || uid(), period_id: F.period_id, name: F.name.trim(), category: F.category, amount: Math.round(num(F.amount)), paid_by: F.paid_by,
        method: F.method, participants: F.participants, reading_from: F.method === 'viz' ? F.reading_from : null, reading_to: F.method === 'viz' ? F.reading_to : null,
        note: F.note, shares };
      if (!p.name) throw new Error('Adj meg egy megnevezést.');
      if (!p.participants.length) throw new Error('Legalább egy lakás szálljon be.');
      await rpc('th_save_item', { p });
      const pid = F.period_id; F = null;
      await refresh('Mentve: ' + p.name + '.', '#/idoszak/' + pid);
    }
    if (form.id === 'readingForm') {
      const fd = new FormData(form), v = k => (isNaN(num(fd.get(k))) ? null : num(fd.get(k)));
      const p = { read_on: fd.get('read_on'), main: v('main'), fsz1: v('fsz1'), fsz2: v('fsz2'), em3: v('em3'), em4: v('em4') };
      if (FLATS.some(f => p[MCOL[f]] == null)) throw new Error('Mind a négy almérő állása kell.');
      await rpc('th_save_reading', { p });
      R = null; await refresh('Leolvasás mentve.', '#/viz');
    }
    if (form.id === 'flatsForm') {
      const fd = new FormData(form); await rpc('th_save_flats', { p: Object.fromEntries(FLATS.map(f => [f, num(fd.get(f))])) });
      await refresh('Tulajdoni hányad mentve.');
    }
    if (form.id === 'importForm') {
      const file = new FormData(form).get('file');
      if (!file || !file.size) throw new Error('Válassz egy fájlt.');
      let p; try { p = JSON.parse(await file.text()); } catch { throw new Error('A fájl nem érvényes JSON.'); }
      const n = await rpc('th_import', { p });
      await refresh(`Betöltve: ${n} tétel.`, '#/idoszakok');
    }
    if (form.id === 'resForm') {
      const fd = new FormData(form); await rpc('th_save_residents', { p_valid_from: fd.get('valid_from'), p_counts: Object.fromEntries(FLATS.map(f => [f, num(fd.get(f))])) });
      await refresh('Lakók száma mentve.');
    }
  } catch (err) { say(errText(err), true); if (btn) btn.disabled = false; return; }
  msgErr = false;
});

$app.addEventListener('click', async e => {
  const b = e.target.closest('[data-act], [data-delreading]');
  if (!b) return;
  const act = b.dataset.act, p = D.periods.find(x => location.hash.includes(x.id));
  try {
    if (act === 'preclose' && p) { closing = transfers(balances(p.id)); render(); }
    if (act === 'cancelclose') { closing = null; render(); }
    if (act === 'close' && p) { b.disabled = true; await rpc('th_close_period', { p_id: p.id, p_transfers: closing }); closing = null; await refresh('Lezárva. Az utalások lent láthatók.'); }
    if (act === 'reopen' && p) {
      if (!confirm('Újranyitod az időszakot? Az utalások törlődnek, és lezáráskor újraszámolódnak.')) return;
      const paid = transfersOf(p.id).filter(t => t.paid_at).length;
      if (paid && !confirm(`Ebben az időszakban már ${paid} utalás megérkezett. Biztosan újranyitod?`)) return;
      await rpc('th_reopen_period', { p_id: p.id, p_force: paid > 0 }); await refresh('Újranyitva.');
    }
    if (act === 'copy') {
      const t = document.getElementById('chat').textContent;
      try { await navigator.clipboard.writeText(t); say('Kimásolva.'); } catch { say('A másolás nem sikerült; jelöld ki a szöveget kézzel.', true); }
    }
    if (act === 'delitem' && F?.id) {
      if (!confirm(`Törlöd: ${F.name}?`)) return;
      const pid = F.period_id; await rpc('th_delete_item', { p_id: F.id }); F = null; await refresh('Törölve.', '#/idoszak/' + pid);
    }
    if (b.dataset.delreading) {
      if (!confirm('Törlöd ezt a leolvasást?')) return;
      await rpc('th_delete_reading', { p_id: b.dataset.delreading }); await refresh('Leolvasás törölve.');
    }
  } catch (err) { say(errText(err), true); b.disabled = false; }
});

window.addEventListener('hashchange', render);

// ---------------------------------------------------------------------------
// Indulás
// ---------------------------------------------------------------------------
(async () => {
  const { user } = await ready;
  try { await load(); }
  catch (e) { $app.innerHTML = `<p class="msg err">${esc(errText(e))}</p>`; return; }
  const meEl = document.getElementById('me');
  if (ME.flat || ME.manager) { meEl.textContent = [ME.flat, ME.manager ? 'kezelő' : ''].filter(Boolean).join(' · '); meEl.hidden = false; }
  document.getElementById('tabs').hidden = false;
  if (!user) say('Offline: a legutóbb betöltött adatok.');
  render();
})();
