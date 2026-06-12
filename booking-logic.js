// booking-logic.js — Slot-filling decision logic for the WhatsApp bot.
// Pure/deterministic: no DB or Groq imports. Availability is injected via
// getSlots(barberId, date) so this file is unit-testable offline.

// ── Date / time helpers (mirror index.js, PR = UTC-4) ─────────────────────────
function todayPR() {
  return new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function formatDate(dateStr) {
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto',
                  'septiembre','octubre','noviembre','diciembre'];
  const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const d = new Date(dateStr + 'T12:00:00');
  return `${days[d.getDay()]} ${d.getDate()} de ${months[d.getMonth()]}`;
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

const WEEKDAYS = {
  'domingo': 0, 'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3,
  'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6,
};

// Resolve "today" | "tomorrow" | weekday(es) | YYYY-MM-DD → YYYY-MM-DD (PR)
function resolveDateToken(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const todayStr = todayPR();
  const base = new Date(todayStr + 'T12:00:00');
  if (t === 'today' || t === 'hoy') return todayStr;
  if (t === 'tomorrow' || t === 'mañana' || t === 'manana') {
    base.setDate(base.getDate() + 1);
    return base.toISOString().split('T')[0];
  }
  if (t in WEEKDAYS) {
    const target = WEEKDAYS[t];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(todayStr + 'T12:00:00');
      d.setDate(base.getDate() + i);
      if (d.getDay() === target) return d.toISOString().split('T')[0];
    }
  }
  return null;
}

function normalizeTime(t) {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
  if (!m) return null;
  const h = Math.min(23, parseInt(m[1], 10));
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const hm = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function matchService(name, services) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  return services.find(s => s.name.toLowerCase() === n)
      || services.find(s => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()))
      || null;
}

function matchBarber(name, barbers) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  return barbers.find(b => b.name.toLowerCase() === n)
      || barbers.find(b => b.name.toLowerCase().includes(n) || n.includes(b.name.toLowerCase()))
      || null;
}

// 2-3 free slots closest to the requested time (returned sorted by time)
function nearestSlots(slots, time, n = 3) {
  const target = hm(time);
  return slots
    .map(s => ({ s, d: Math.abs(hm(s) - target) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(x => x.s)
    .sort((a, b) => hm(a) - hm(b));
}

// Up to n slots spread evenly across the day (only when explicitly requested)
function spreadSlots(slots, n = 5) {
  if (slots.length <= n) return slots;
  const out = [];
  const step = (slots.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(slots[Math.round(i * step)]);
  return [...new Set(out)];
}

function joinNatural(arr, conj = 'y') {
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(', ') + ' ' + conj + ' ' + arr[arr.length - 1];
}

function bookingSummary(bk) {
  return `📋 ${bk.name} — ${bk.serviceName} ($${bk.servicePrice}) con ${bk.barberName}, ` +
         `${formatDate(bk.date)} a las ${formatTime(bk.time)}.\n¿Confirmo? (sí/no)`;
}

const WANTS_LIST = /(qu[eé] tienes|disponible|opciones|horarios|que hay|disponibilidad|ll[eé]name)/i;

/**
 * Core slot-filling step. Mutates `session.data.bk` and `session.state`.
 * `extracted` is the JSON object from the LLM extractor (any/all fields may be null).
 * `getSlots(barberId, date)` → Promise<string[]> of free 'HH:MM' slots.
 * Returns the bot reply string.
 */
async function decideBookingReply({ session, msg, extracted, services, barbers, getSlots }) {
  const bk = session.data.bk || (session.data.bk = {});
  extracted = extracted || {};

  // ── Merge (overwrite when the client provides a value; fill name once) ──
  if (!bk.name && extracted.name) bk.name = String(extracted.name).trim().slice(0, 40);
  if (extracted.service) {
    const s = matchService(extracted.service, services);
    if (s) { bk.serviceId = s.id; bk.serviceName = s.name; bk.serviceDuration = s.duration_minutes || 30; bk.servicePrice = s.price; }
  }
  if (extracted.barber) {
    const b = matchBarber(extracted.barber, barbers);
    if (b) { bk.barberId = b.id; bk.barberName = b.name; }
  }
  if (!bk.barberId && barbers.length === 1) { bk.barberId = barbers[0].id; bk.barberName = barbers[0].name; }
  if (extracted.date) { const d = resolveDateToken(extracted.date); if (d) bk.date = d; }
  if (extracted.time) { const tm = normalizeTime(extracted.time); if (tm) bk.time = tm; }

  // ── Ask for any missing core fields together (one message) ──
  const missing = [];
  if (!bk.name) missing.push('tu nombre');
  if (!bk.serviceId) missing.push('el servicio');
  if (!bk.barberId && barbers.length > 1) missing.push('con cuál barbero');
  if (missing.length) {
    let extra = '';
    if (!bk.serviceId) extra += '\n' + services.map(s => `• ${s.name} $${s.price}`).join('\n');
    if (!bk.barberId && barbers.length > 1) extra += '\n💈 ' + barbers.map(b => b.name).join(', ');
    return `Me falta ${joinNatural(missing)} 🙂${extra}`;
  }

  // ── Date ──
  if (!bk.date) {
    return `${bk.name ? '¡De una, ' + bk.name + '! ✂️ ' : ''}¿Qué día te queda bien?`;
  }

  const slots = await getSlots(bk.barberId, bk.date);
  if (!slots || slots.length === 0) {
    bk.date = null; bk.time = null;
    return `Uy, no tengo horarios ese día 😕 ¿Qué otro día te sirve?`;
  }

  // Client explicitly asked to see availability → show a few spread options
  if (WANTS_LIST.test(msg || '') && !bk.time) {
    return `Para el ${formatDate(bk.date)} tengo: ${spreadSlots(slots, 5).map(formatTime).join(', ')}. ¿Cuál prefieres?`;
  }

  // ── Time ──
  if (!bk.time) {
    return `Para el ${formatDate(bk.date)} ¿como a qué hora?`;
  }

  if (slots.includes(bk.time)) {
    session.state = 'confirm';
    return bookingSummary(bk);
  }

  // Requested time not free → offer 2-3 nearest, don't dump the list
  const reqTime = bk.time;
  bk.time = null;
  const near = nearestSlots(slots, reqTime, 3);
  if (near.length === 0) {
    return `Las ${formatTime(reqTime)} no está libre y no me quedan cercanas ese día 😕 ¿Otro día u hora?`;
  }
  return `Las ${formatTime(reqTime)} está ocupada 😕 pero tengo ${joinNatural(near.map(formatTime), 'o')}. ¿Cuál te sirve?`;
}

module.exports = {
  todayPR, formatDate, formatTime, resolveDateToken, normalizeTime,
  matchService, matchBarber, nearestSlots, spreadSlots, joinNatural,
  bookingSummary, decideBookingReply,
};
