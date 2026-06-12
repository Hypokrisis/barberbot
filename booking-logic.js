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
const DAY_WORDS = ['hoy','mañana','manana','domingo','lunes','martes','miércoles','miercoles','jueves','viernes','sábado','sabado','today','tomorrow'];

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

// Scan a free-form message for any day token → YYYY-MM-DD
function scanDate(msg) {
  for (const w of String(msg).toLowerCase().replace(/[.,!¡¿?]/g, ' ').split(/\s+/)) {
    const d = resolveDateToken(w);
    if (d) return d;
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

// Parse loose times like "3pm", "3 pm", "3:30pm", "15:00"
function parseLooseTime(msg) {
  const m = String(msg).toLowerCase();
  let mt = /(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(m);
  if (mt) {
    let h = +mt[1]; const min = mt[2]; const ap = mt[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  mt = /(\d{1,2})\s*(am|pm)/.exec(m);
  if (mt) {
    let h = +mt[1]; const ap = mt[2];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:00`;
  }
  return null;
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

// When the bot just asked for the name, treat a short reply as the name.
// Drops leading fillers ("soy", "me llamo"...) and rejects services/days/numbers.
const NAME_STOP = new Set([
  'cita','hola','hello','hi','buenas','buenos','hey','ola','reservar','agendar',
  'turno','reserva','book','gracias','ok','okay','si','sí','no','quiero','reagendar','cancelar',
]);
function guessName(msg, services) {
  const fillers = new Set(['soy','me','llamo','mi','nombre','es','el','la','yo','un','una','para','con','de']);
  let words = String(msg).trim().toLowerCase().replace(/[.,!¡¿?]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length && fillers.has(words[0])) words.shift();
  if (!words.length) return null;
  const w = words[0];
  if (/\d/.test(w)) return null;
  if (NAME_STOP.has(w)) return null;
  if (DAY_WORDS.includes(w)) return null;
  if (services.some(s => s.name.toLowerCase().split(/\s+/).includes(w))) return null;
  if (w.length < 2 || w.length > 20) return null;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// Map a reply during slot negotiation to one of the offered slots.
function matchOffered(msg, offered) {
  if (!offered || !offered.length) return null;
  const m = String(msg).toLowerCase().trim();
  if (m === '1' || m.includes('primera') || m.includes('primero')) return offered[0];
  if (m === '2' || m.includes('segunda') || m.includes('segundo')) return offered[1] || null;
  if (m === '3' || m.includes('tercera') || m.includes('tercero')) return offered[2] || null;
  const mt = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(m);
  if (mt) {
    const h = +mt[1]; const min = mt[2] ? +mt[2] : null; const ap = mt[3];
    for (const slot of offered) {
      const [sh, sm] = slot.split(':').map(Number);
      const h12 = sh % 12 || 12;
      const hourOk = ap ? ((ap === 'pm' ? sh >= 12 : sh < 12) && h12 === h) : (h12 === h || sh === h);
      const minOk = (min === null || min === sm);
      if (hourOk && minOk) return slot;
    }
  }
  return null;
}

function nearestSlots(slots, time, n = 3) {
  const target = hm(time);
  return slots
    .map(s => ({ s, d: Math.abs(hm(s) - target) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(x => x.s)
    .sort((a, b) => hm(a) - hm(b));
}

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

function titleCase(s) {
  return String(s).trim().split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ').slice(0, 40);
}
function setService(bk, s) { bk.serviceId = s.id; bk.serviceName = s.name; bk.serviceDuration = s.duration_minutes || 30; bk.servicePrice = s.price; }
function setBarber(bk, b) { bk.barberId = b.id; bk.barberName = b.name; }

function bookingSummary(bk) {
  return `📋 ${bk.name} — ${bk.serviceName} ($${bk.servicePrice}) con ${bk.barberName}, ` +
         `${formatDate(bk.date)} a las ${formatTime(bk.time)}.\n¿Confirmo? (sí/no)`;
}

// Does this first message carry booking data (vs a bare "hola"/"cita")?
function hasBookingContent(msg, services, barbers, GREETINGS, BOOKING_WORDS) {
  const m = String(msg).toLowerCase();
  if (/\d/.test(m)) return true;
  if (/(mañana|manana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|am|pm|:)/.test(m)) return true;
  if (services.some(s => m.includes(s.name.toLowerCase().split(/\s+/)[0]))) return true;
  if (barbers.some(b => m.includes(b.name.toLowerCase()))) return true;
  let rest = ' ' + m + ' ';
  [...(GREETINGS || []), ...(BOOKING_WORDS || []), 'quiero', 'una', 'un', 'para', 'por', 'favor', 'me', 'la', 'el']
    .forEach(w => { rest = rest.split(w).join(' '); });
  return rest.replace(/[^a-záéíóúñ]/gi, ' ').trim().length >= 4;
}

// Strict booking signal (used to ENTER the flow without a keyword): a time,
// a day word, or a named service. Avoids routing general questions into booking.
function looksLikeBooking(msg, services) {
  const m = String(msg).toLowerCase();
  if (/(\d{1,2}:\d{2}|\d{1,2}\s*(am|pm))/.test(m)) return true;
  if (/(mañana|manana|\bhoy\b|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo)/.test(m)) return true;
  if (services.some(s => m.includes(s.name.toLowerCase().split(/\s+/)[0]))) return true;
  return false;
}

// "con pepe" / "con el barbero pepe" → barbero EXPLÍCITO
function barberFromCon(msg, barbers) {
  const mt = /\bcon\s+(?:el\s+|la\s+)?(?:barber[oa]\s+)?([a-záéíóúñ]+)/i.exec(String(msg));
  if (!mt) return null;
  return matchBarber(mt[1], barbers);
}

// "soy X" / "me llamo X" / "mi nombre es X" → nombre del CLIENTE (1-2 palabras)
function clientNameFromSoy(msg, services) {
  const mt = /\b(?:soy|me llamo|mi nombre es)\s+(.+)/i.exec(String(msg));
  if (!mt) return null;
  const after = mt[1].replace(/[.,!¡¿?].*$/, ' ');
  const stop = new Set(['con','quiero','para','el','la','un','una','y','a','las','de','hoy','mañana','manana','lunes','martes','miercoles','miércoles','jueves','viernes','sabado','sábado','domingo']);
  const out = [];
  for (const w of after.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (/\d/.test(w) || stop.has(w)) break;
    if (services.some(s => s.name.toLowerCase().split(/\s+/).includes(w))) break;
    out.push(w);
    if (out.length >= 2) break;
  }
  return out.length ? out.join(' ') : null;
}

// Una palabra suelta que coincide EXACTO con el nombre de un barbero (posible colisión)
function looseBarberMatch(msg, barbers) {
  for (const w of String(msg).toLowerCase().replace(/[.,!¡¿?]/g, ' ').split(/\s+/).filter(Boolean)) {
    if (/\d/.test(w)) continue;
    const b = barbers.find(bb => bb.name.toLowerCase() === w);
    if (b) return b;
  }
  return null;
}

const WANTS_LIST = /(qu[eé] tienes|disponible|opciones|horarios|que hay|disponibilidad)/i;

/**
 * Core slot-filling step. Mutates `session.data.bk`, `session.data.awaiting`,
 * and `session.state`. `extracted` is the LLM JSON (any/all fields may be null).
 * `getSlots(barberId, date)` → Promise<string[]> of free 'HH:MM' slots.
 */
async function decideBookingReply({ session, msg, extracted, services, barbers, getSlots }) {
  const bk = session.data.bk || (session.data.bk = {});
  const awaiting = session.data.awaiting || [];
  extracted = extracted || {};

  // ── Respuesta a una desambiguación pendiente (cliente vs barbero) ──
  if (awaiting.includes('__disambig__')) {
    const nm = session.data.disambig || '';
    delete session.data.disambig;
    session.data.awaiting = [];
    if (/(barber|con\b|la cita)/i.test(msg)) { const b = matchBarber(nm, barbers); if (b) setBarber(bk, b); }
    else { bk.name = titleCase(nm); } // por defecto es el cliente (regla 1)
  }

  // ── Servicio / fecha / hora (no colisionan con nombres) ──
  if (extracted.service) { const s = matchService(extracted.service, services); if (s) setService(bk, s); }
  if (extracted.date) { const d = resolveDateToken(extracted.date); if (d) bk.date = d; }
  if (extracted.time) { const t = normalizeTime(extracted.time); if (t) bk.time = t; }
  if (!bk.time && awaiting.includes('time') && bk.offered) { const p = matchOffered(msg, bk.offered); if (p) bk.time = p; }
  if (!bk.date && awaiting.includes('date')) { const d = scanDate(msg); if (d) bk.date = d; }
  if (!bk.time && awaiting.includes('time')) { const t = parseLooseTime(msg); if (t) bk.time = t; }
  if (!bk.serviceId && awaiting.includes('service')) { const s = matchService(msg, services); if (s) setService(bk, s); }

  // ── NOMBRE y BARBERO por contexto — nunca confundir uno con el otro ──
  const conBarber = barberFromCon(msg, barbers);       // "con X"  → barbero
  const soyName   = clientNameFromSoy(msg, services);  // "soy X"  → cliente

  // Barbero: explícito "con X", o respuesta directa a "¿con cuál barbero?"
  if (!bk.barberId) {
    if (conBarber) setBarber(bk, conBarber);
    else if (awaiting.includes('barber') && !awaiting.includes('name')) { const b = matchBarber(msg, barbers); if (b) setBarber(bk, b); }
  }
  // Cliente: explícito "soy X", o respuesta directa a "¿tu nombre?" (aunque coincida con un barbero)
  if (!bk.name) {
    if (soyName) bk.name = titleCase(soyName);
    else if (awaiting.includes('name')) { const g = guessName(msg, services); if (g) bk.name = g; }
  }
  // Fallbacks del LLM, solo si NO chocan con el otro rol
  if (!bk.name && extracted.name && !matchBarber(extracted.name, barbers)) bk.name = titleCase(extracted.name);
  if (!bk.barberId && !conBarber && extracted.barber && !awaiting.includes('name')) {
    const b = matchBarber(extracted.barber, barbers);
    const collides = b && ((soyName && soyName.toLowerCase().includes(b.name.toLowerCase())) ||
                           (bk.name && bk.name.toLowerCase().includes(b.name.toLowerCase())));
    if (b && !collides) setBarber(bk, b);
  }
  // Un solo barbero → asignar siempre, sin preguntar
  if (!bk.barberId && barbers.length === 1) setBarber(bk, barbers[0]);

  // ── Ambigüedad real: una palabra = nombre de barbero, sin "soy"/"con", y aún no
  //    sabemos ni cliente ni barbero → preguntar UNA sola vez (nunca asumir en silencio) ──
  if (!bk.name && !bk.barberId && !soyName && !conBarber && barbers.length > 1 && !awaiting.includes('name')) {
    const collide = looseBarberMatch(msg, barbers);
    if (collide) {
      session.data.awaiting = ['__disambig__'];
      session.data.disambig = collide.name;
      return `¿${collide.name} es tu nombre, o quieres la cita con el barbero ${collide.name}? 🙂`;
    }
  }

  // ── Client explicitly asked to see options ──
  if (WANTS_LIST.test(msg) && bk.serviceId && bk.barberId && bk.date && !bk.time) {
    const slots = await getSlots(bk.barberId, bk.date);
    if (slots && slots.length) {
      bk.offered = spreadSlots(slots, 5);
      session.data.awaiting = ['time'];
      return `Para el ${formatDate(bk.date)} tengo: ${bk.offered.map(formatTime).join(', ')}. ¿Cuál prefieres?`;
    }
  }

  // ── Ask for everything still missing, together, in ONE message ──
  const missing = [];
  if (!bk.name) missing.push(['name', 'tu nombre']);
  if (!bk.serviceId) missing.push(['service', 'el servicio']);
  if (!bk.barberId && barbers.length > 1) missing.push(['barber', 'con cuál barbero']);
  if (!bk.date) missing.push(['date', 'el día']);
  if (!bk.time) missing.push(['time', 'a qué hora']);
  if (missing.length) {
    session.data.awaiting = missing.map(x => x[0]);
    delete bk.offered;
    let extra = '';
    if (!bk.serviceId) extra += '\n' + services.map(s => `• ${s.name} $${s.price}`).join('\n');
    if (!bk.barberId && barbers.length > 1) extra += '\n💈 ' + barbers.map(b => b.name).join(', ');
    return `Me falta ${joinNatural(missing.map(x => x[1]))} 🙂${extra}`;
  }

  // ── Everything gathered → availability ──
  session.data.awaiting = [];
  const slots = await getSlots(bk.barberId, bk.date);
  if (!slots || slots.length === 0) {
    bk.date = null; bk.time = null; delete bk.offered;
    session.data.awaiting = ['date'];
    return `Uy, no tengo horarios ese día 😕 ¿Qué otro día te sirve?`;
  }
  if (slots.includes(bk.time)) {
    delete bk.offered;
    session.state = 'confirm';
    return bookingSummary(bk);
  }
  // Requested time taken → offer 2-3 nearest (never the whole list)
  const reqTime = bk.time; bk.time = null;
  const near = nearestSlots(slots, reqTime, 3);
  bk.offered = near;
  session.data.awaiting = ['time'];
  if (near.length === 0) return `Las ${formatTime(reqTime)} no está libre y no me quedan cercanas ese día 😕 ¿Otro día u hora?`;
  return `Las ${formatTime(reqTime)} está ocupada 😕 pero tengo ${joinNatural(near.map(formatTime), 'o')}. ¿Cuál te sirve?`;
}

module.exports = {
  todayPR, formatDate, formatTime, resolveDateToken, scanDate, normalizeTime,
  parseLooseTime, matchService, matchBarber, guessName, matchOffered,
  nearestSlots, spreadSlots, joinNatural, bookingSummary, hasBookingContent,
  looksLikeBooking, decideBookingReply,
};
