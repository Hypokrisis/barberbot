// booking-logic.js — Motor de conversación del bot (rediseño FINAL v4).
// Pure/inyectable: no importa Supabase, Twilio ni Groq. Toda la I/O entra por
// `deps` y la interpretación del mensaje entra por `understood` (salida de Groq).
// 100% testeable offline (ver test-booking-sim.js).
//
// PASO 0 (en index.js): el número de WhatsApp identifica al cliente en
// appointments y produce `history`:
//   CASO A → history.activeAppointment  (cita activa futura)
//   CASO B → history.hasHistory sin activeAppointment (recurrente sin cita)
//   CASO C → !history.hasHistory  (cliente nuevo)
//
// Estados (5, nada más):
//   idle         — sin nada en proceso
//   collecting   — juntando nombre + servicio + barbero
//   picking_slot — eligiendo horario para una cita NUEVA
//   confirming   — esperando sí/no (pendingAction: create | reschedule | cancel)
//   rescheduling — eligiendo nuevo horario para una cita EXISTENTE
//
// REGLA IRROMPIBLE #1: un número = una cita activa máximo. Si tiene cita activa
// y pide una nueva → se le ofrece reagendar o cancelar primero (NUNCA se crea otra).

// ── Helpers de fecha/hora (PR = UTC-4, sin DST) ───────────────────────────────
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

function shortDate(dateStr) {
  const m = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getDate()} ${m[d.getMonth()]}`;
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

// "Hoy" / "Mañana" / "Miércoles" para el mensaje de disponibilidad
function displayDay(dateStr) {
  const t = todayPR();
  if (dateStr === t) return 'Hoy';
  const tm = new Date(t + 'T12:00:00'); tm.setDate(tm.getDate() + 1);
  if (dateStr === tm.toISOString().split('T')[0]) return 'Mañana';
  const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  return days[new Date(dateStr + 'T12:00:00').getDay()];
}

const WEEKDAYS = {
  'domingo': 0, 'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3,
  'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6,
};

// ¿La terna y-m-d corresponde a una fecha real del calendario? (sin rollover)
function isRealDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
// Token YYYY-MM-DD con día/mes que NO existen (ej "2026-06-32" = "32 de junio").
function isInvalidDateToken(token) {
  if (!token) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(token).trim());
  return m ? !isRealDate(+m[1], +m[2], +m[3]) : false;
}

// "today" | "tomorrow" | día-semana-es | YYYY-MM-DD → YYYY-MM-DD (o null)
function resolveDateToken(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  // YYYY-MM-DD: solo si es una fecha real (no "2026-06-32", que JS rodaría a julio).
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (ymd) return isRealDate(+ymd[1], +ymd[2], +ymd[3]) ? t : null;
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

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function addDuration(time, dur) {
  const e = toMin(time) + (dur || 30);
  return `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
}

function daysFromToday(dateStr) {
  return Math.round((new Date(dateStr + 'T12:00:00') - new Date(todayPR() + 'T12:00:00')) / 86400000);
}
function limitDateStr() {
  const d = new Date(todayPR() + 'T12:00:00'); d.setDate(d.getDate() + 30);
  return d.toISOString().split('T')[0];
}

// ── Matching servicio / barbero ───────────────────────────────────────────────
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
      // Prefijo: "pache" → "Pacheco". Más preciso que includes y prioritario.
      || barbers.find(b => { const bn = b.name.toLowerCase(); return bn.startsWith(n) || n.startsWith(bn); })
      || barbers.find(b => { const bn = b.name.toLowerCase(); return bn.includes(n) || n.includes(bn); })
      // Coincidencia por nombre de pila (cualquier palabra del nombre empieza con n).
      || barbers.find(b => b.name.toLowerCase().split(/\s+/).some(w => w.startsWith(n)))
      || null;
}
// Match ESTRICTO (exacto o prefijo en cualquier dirección, ≥3 letras) para
// rescatar un nombre suelto desde el mensaje crudo cuando Groq no lo extrajo.
// A diferencia de matchBarber, NO usa "includes" — evita que "nada"/"como"
// casen por substring con un barbero. Se usa solo sobre palabras sueltas.
function matchStrict(word, items) {
  const w = String(word || '').toLowerCase().trim().replace(/[^\p{L}\p{N}]/gu, '');
  if (w.length < 3) return null;
  return items.find(it => it.name.toLowerCase() === w)
      || items.find(it => { const n = it.name.toLowerCase(); return n.startsWith(w) || w.startsWith(n); })
      || items.find(it => it.name.toLowerCase().split(/\s+/).some(p => p.length >= 3 && (p.startsWith(w) || w.startsWith(p))))
      || null;
}

// ── Helpers de slots ──────────────────────────────────────────────────────────
function spreadSlots(slots, n = 4) {
  if (slots.length <= n) return slots.slice();
  const out = [];
  const step = (slots.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(slots[Math.round(i * step)]);
  return [...new Set(out)];
}
function nearestSlots(slots, time, n = 2) {
  const target = toMin(time);
  return slots
    .map(s => ({ s, d: Math.abs(toMin(s) - target) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(x => x.s)
    .sort((a, b) => toMin(a) - toMin(b));
}

function joinNatural(arr, conj = 'y') {
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(', ') + ' ' + conj + ' ' + arr[arr.length - 1];
}
function titleCase(s) {
  return String(s).trim().split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ').slice(0, 40);
}
// Saludo "pelado": el mensaje es SOLO un saludo, sin pregunta ni datos. Se usa
// para que un "hola" muestre el mensaje propio de cada caso (CASO A → su cita;
// CASO C → la bienvenida) en vez de enrutarse a askGeneral, que en planes sin
// Groq devuelve un welcome de reserva y mezclaba textos de dos casos distintos.
function isGreeting(t) {
  const s = String(t || '').trim().toLowerCase().replace(/[\s!.,¡?¿…]+$/u, '');
  return /^(hola+|ola|buenas|buenos d[ií]as|buen d[ií]a|buenas tardes|buenas noches|hey+|ey+|hi|hello|holi+|saludos|qu[eé] tal|qu[eé] lo que|klk|wepa+|qu[eé] m[aá]s)$/u.test(s);
}
// Frase-meta "tengo preguntas/dudas" SIN una pregunta concreta todavía. Sirve
// para invitar a preguntar y ESPERAR, en vez de empujar el flujo de datos.
function wantsToAsk(t) {
  const s = String(t || '').trim().toLowerCase();
  if (/[?¿]/.test(s)) return false; // ya trae una pregunta real
  return /\b(tengo|teng|tngo|hacer|puedo|quiero|kiero|podr[ií]a|ten[ií]a|hay|es)\b[^?]*\b(pregunta|preguntas|duda|dudas|preguntar|consulta|consultas|consultar)\b/u.test(s)
      || /^(pregunta|preguntas|duda|dudas|consulta|consultas)$/u.test(s);
}
// Recordatorio fijo de opciones (UX). SIEMPRE idéntico para que el cliente lo
// reconozca; el resto del mensaje puede variar para evitar repetición literal.
const OPTIONS_REMINDER = '💬 Cualquier momento puedes decir: *cita* · *reagendar* · *cancelar* · o preguntar algo';

// ════════════════════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════
//
// respond({ session, msg, understood, ctx, deps })
//   session   — { state, data }  (se muta)
//   msg       — texto crudo del cliente
//   understood— { intent, name, service, barber, date, time, choice }  (salida de Groq)
//   ctx       — { business, services, barbers, bookingLink, history, phone }
//   deps      — { getSlots, getUpcoming, getActiveAppointments,
//                 commitCreate, commitReschedule, commitCancel, askGeneral }
//
async function respond({ session, msg, understood, ctx, deps }) {
  const { services, barbers, bookingLink, history } = ctx;
  const d = session.data || (session.data = {});
  const I = (understood && understood.intent) || 'UNKNOWN';
  const rawNum = /^\d+$/.test(msg.trim()) ? parseInt(msg.trim(), 10) : null;            // "1", "2"
  // Punto 3: si Groq devolvió una hora explícita, NUNCA la tratamos como "choice"
  // por índice. La hora manda y se verifica contra la DB.
  const choiceNum = rawNum || (understood.time ? null : (Number.isInteger(understood.choice) ? understood.choice : null));

  // ── utilidades locales ──────────────────────────────────────────────────────
  function reword(t) {
    const swaps = [
      ['¿Cuál te queda bien?', '¿Cuál prefieres?'],
      ['¿cuál te sirve?', '¿cuál te conviene?'],
      ['Me falta', 'Todavía me falta'],
    ];
    for (const [a, b] of swaps) if (t.includes(a)) return t.split(a).join(b);
    return 'Como te decía 🙂 ' + t;
  }
  // out(text, state, opts) — opts.reminder=false omite el recordatorio de opciones.
  // El recordatorio se omite SIEMPRE en mensajes finales (✅) y en prompts de sí/no,
  // y se OPTA por omitir en bienvenidas/confirmaciones cortas. El anti-repetición
  // (REGLA #3) opera sobre el CUERPO (sin el recordatorio fijo), por eso lastReply
  // guarda el cuerpo y el recordatorio se pega al final después.
  function out(text, state, opts) {
    if (state !== undefined) session.state = state;
    if (text === d.lastReply) text = reword(text);     // REGLA #3: nunca repetir literal
    d.lastReply = text;
    const isFinal = /^✅/.test(text);
    const isYesNo = /\(sí\/no\)|\*sí\* o \*no\*/.test(text);
    const omit = (opts && opts.reminder === false) || isFinal || isYesNo;
    return omit ? text : `${text}\n\n${OPTIONS_REMINDER}`;
  }
  // El link aparece máximo 2 veces por conversación (REGLA #7)
  function linkOnce() {
    if ((d.linkCount || 0) >= 2) return bookingLink; // tras el tope, igual damos el link cuando es la única salida
    d.linkCount = (d.linkCount || 0) + 1;
    return bookingLink;
  }
  function resetData() {
    d.bk = null; d.offered = null; d.negotiation = 0;
    d.pendingAction = null; d.reschedule = null; d.cancelApptId = null;
  }
  function setService(bk, s) { bk.serviceId = s.id; bk.serviceName = s.name; bk.servicePrice = s.price; bk.serviceDuration = s.duration_minutes || 30; }
  function setBarber(bk, b) { bk.barberId = b.id; bk.barberName = b.name; }
  function svcListText() { return services.map(s => `- ${s.name} — $${s.price}`).join('\n'); }
  function barberListText() { return barbers.map(b => `- ${b.name}`).join('\n'); }

  function mergeUnderstood() {
    const bk = d.bk || (d.bk = {});
    if (understood.name && !bk.name) bk.name = titleCase(understood.name);
    if (!bk.name && history && history.name) bk.name = titleCase(history.name);
    if (understood.service) { const s = matchService(understood.service, services); if (s) setService(bk, s); }
    if (understood.barber)  { const b = matchBarber(understood.barber, barbers);   if (b) setBarber(bk, b); }
    const wd = resolveDateToken(understood.date); if (wd) bk.wantDate = wd;
    const wt = normalizeTime(understood.time);    if (wt) { bk.wantTime = wt; bk.wantTimeAmbiguous = !!understood.ampm_ambiguous; }
    return bk;
  }

  // ── Textos de bienvenida / saludo (CASO A / B / C) ──────────────────────────
  // Menú de capacidades que cierra los saludos (CASO C y B).
  function capabilitiesText() {
    return `También puedo ayudarte a:\n📅 Agendar una cita\n🔄 Reagendar tu cita\n❌ Cancelar tu cita\n❓ Responder preguntas sobre *${ctx.business.name}*`;
  }
  function welcomeText() {
    // CASO C — cliente nuevo
    return `¡Bienvenido a *${ctx.business.name}*! 💈\n` +
           `Para tu cita dime:\n- Tu nombre\n- El servicio que quieres\n- El barbero que prefieres\n- El día y hora aproximada\n\n` +
           `✂️ *Servicios:*\n${svcListText()}\n\n` +
           `💈 *Equipo:*\n${barberListText()}\n\n` +
           `${capabilitiesText()}\n\n` +
           `📅 O reserva directo: ${linkOnce()}`;
  }
  function recurringText() {
    // CASO B — recurrente sin cita activa (nombre ya conocido → no se pide)
    return `¡Hola de nuevo, ${history.name}! 👋\n¿Qué necesitas hoy?\n\n` +
           `${capabilitiesText()}\n\n` +
           `✂️ *Servicios:*\n${svcListText()}\n\n` +
           `💈 *Equipo:*\n${barberListText()}\n\n` +
           `📅 O reserva: ${linkOnce()}`;
  }
  function activeApptText(a) {
    // CASO A — cliente con cita activa
    const sv = services.find(s => s.id === a.service_id);
    const ba = barbers.find(b => b.id === a.barber_id);
    return `¡Hola de nuevo, ${history.name}! 👋\nTienes una cita activa:\n` +
           `✂️ ${sv ? sv.name : 'tu servicio'} con ${ba ? ba.name : 'tu barbero'}\n` +
           `📅 ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)}\n\n` +
           `¿Qué necesitas?\n🔄 Reagendar\n❌ Cancelar\n📅 Nueva cita\n❓ Preguntar algo`;
  }

  // Construye y muestra disponibilidad. Mueve a picking_slot / rescheduling.
  // Máx 3 días hacia adelante × hasta 3 horarios por día. Solo cupos reales.
  // `lead` opcional: frase introductoria (ej "Ese día no abre 😕").
  async function offerSlots(forReschedule, lead) {
    const bk = d.bk;
    const nextState = forReschedule ? 'rescheduling' : 'picking_slot';
    const head = lead ? `${lead}\n\n` : '';
    if (!bk || !bk.barberId) {
      return out(`Para ver horarios dime con qué barbero 🙂`, 'collecting');
    }
    const up = await deps.getUpcoming(bk.barberId, 3, 3); // hasta 3 días × 3 = 9
    if (!up || !up.length) {
      return out(`${head}${bk.barberName} no tiene espacios próximos 😕\n📅 Reserva en el calendario: ${linkOnce()}`, nextState);
    }
    d.offered = [];
    const blocks = [];
    up.forEach((g) => {
      for (const t of g.slots) d.offered.push({ date: g.date, time: t });
      blocks.push(`${displayDay(g.date).toUpperCase()} — ${g.slots.map(formatTime).join(', ')}`);
    });
    d.negotiation = 0;
    return out(
      `${head}📅 *${bk.barberName}* tiene espacio:\n${blocks.join('\n')}\n\n` +
      `¿Cuál te queda bien?\nSi quieres otra hora, dímela y te verifico 😊\n` +
      `📅 O elige aquí: ${linkOnce()}`,
      nextState
    );
  }

  // Slot elegido → resumen de CONFIRMACIÓN (igual para nueva cita y reagendar).
  async function commitChosen(slot, forReschedule) {
    const bk = d.bk;
    bk.date = slot.date; bk.time = slot.time;
    d.pendingAction = forReschedule ? 'reschedule' : 'create';
    return out(
      `📋 ${bk.name} — ${bk.serviceName} ($${bk.servicePrice}) con ${bk.barberName}\n` +
      `📅 ${formatDate(bk.date)} a las ${formatTime(bk.time)}\n` +
      `¿Confirmo? (sí/no)`,
      'confirming'
    );
  }

  // AM/PM genuinamente ambiguo → ofrecer las dos interpretaciones como opciones
  // y dejar que el cliente elija. NUNCA asumir (decisión del usuario).
  function ampmAsk(date, forReschedule) {
    const t = normalizeTime(understood.time);
    const [h, m] = t.split(':').map(Number);
    const base = h % 12;
    const amT = `${String(base).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const pmT = `${String(base + 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    d.offered = [{ date, time: amT }, { date, time: pmT }];
    d.negotiation = 0;
    return out(`¿Te refieres a las ${formatTime(amT)} o las ${formatTime(pmT)}? 🙂`,
      forReschedule ? 'rescheduling' : 'picking_slot', { reminder: false });
  }

  // CHOKEPOINT (Punto 4): toda hora puntual se verifica contra la DB aquí antes
  // de confirmar. checkSlot distingue ocupada / fuera de horario / cerrado / pasada.
  async function confirmSlot(date, time, forReschedule) {
    const bk = d.bk;
    const nextState = forReschedule ? 'rescheduling' : 'picking_slot';
    if (daysFromToday(date) > 30) {
      return out(`Solo puedo agendar hasta el *${formatDate(limitDateStr())}* 😊 ¿Qué otra fecha te sirve?`, nextState);
    }
    const chk = await deps.checkSlot(bk.barberId, date, time);
    if (chk.status === 'available') return await commitChosen({ date, time }, forReschedule);

    // No disponible: NO se confirma nada (Punto 3). Se ofrece y el cliente re-elige.
    d.negotiation = (d.negotiation || 0) + 1;
    if (d.negotiation > 2) {
      resetData();
      return out(`No logramos cuadrar la hora 😕 Mejor elige directo en el calendario: ${linkOnce()}`, 'idle');
    }
    const within = chk.available || [];
    const near = within.length ? nearestSlots(within, time, 2) : [];

    // Sin cupos ese día (cerrado / pasada / vacío) → mostrar próximos días reales.
    if (chk.status === 'closed' || chk.status === 'past' || within.length === 0) {
      const lead = chk.status === 'closed' ? `Ese día ${bk.barberName} no abre 😕`
                 : chk.status === 'past'   ? `Esa hora ya pasó ⌛`
                 : `No me quedan espacios ese día 😕`;
      return await offerSlots(forReschedule, lead);
    }
    // Hay cupos ese día → ofrecer los más cercanos, con el motivo correcto.
    d.offered = near.map(x => ({ date, time: x }));
    let lead;
    if (chk.status === 'outside_hours') {
      lead = `${bk.barberName} trabaja ese día de ${formatTime(chk.open)} a ${formatTime(chk.close)} 😊`;
    } else if (chk.status === 'booked') {
      lead = `Las ${formatTime(time)} está ocupada 😕`;
    } else { // unaligned (dentro de horario pero no cae en slot de 30 min)
      lead = `No tengo exactamente las ${formatTime(time)} 😕`;
    }
    return out(`${lead} Tengo ${joinNatural(near.map(formatTime), 'o')}, ¿cuál te sirve?`, nextState);
  }

  // Interpreta la elección de horario (compartido entre picking_slot y rescheduling)
  async function pickSlot(forReschedule) {
    const bk = d.bk;
    const offered = d.offered || [];

    // Día por defecto para "hora sin día": el PRIMER día disponible mostrado; si
    // no hay lista, el primer día próximo con cupo. NUNCA "hoy" a ciegas (BUG 1:
    // "1pm" durante reagendar caía en hoy → "esa hora ya pasó").
    async function defaultDate() {
      if (offered[0] && offered[0].date) return offered[0].date;
      const up = await deps.getUpcoming(bk.barberId, 1, 1);
      return (up[0] && up[0].date) || todayPR();
    }

    // FIX 1: día objetivo cuando el cliente dio una HORA. Si Groq trajo un día
    // resoluble (ya en YYYY-MM-DD), ese manda. Si NO, NUNCA asumimos a ciegas:
    //  1) si todo lo ofrecido es de un mismo día → ese es el día en contexto;
    //  2) si el barbero solo tiene UN día próximo con cupo real → ese;
    //  3) varios días posibles → null (hay que preguntar cuál).
    async function resolveTargetDate() {
      const fromToken = resolveDateToken(understood.date);
      if (fromToken) return fromToken;
      const offDates = [...new Set(offered.map(o => o.date).filter(Boolean))];
      if (offDates.length === 1) return offDates[0];
      const up = await deps.getUpcoming(bk.barberId, 3, 3);
      const days = (up || []).filter(g => g.slots && g.slots.length);
      if (days.length === 1) return days[0].date;
      return null;
    }

    // FIX 1: pregunta "¿para qué día?" con los días REALES del barbero (no asume).
    // Cada opción guarda la MISMA hora pedida, así "2" o el nombre del día confirman.
    async function askWhichDay(time) {
      const up = await deps.getUpcoming(bk.barberId, 3, 3);
      const days = (up || []).filter(g => g.slots && g.slots.length);
      if (!days.length) return await offerSlots(forReschedule);
      if (days.length === 1) return await confirmSlot(days[0].date, time, forReschedule);
      d.offered = days.map(g => ({ date: g.date, time }));
      d.negotiation = 0;
      const opts = days.map((g, i) => `${i + 1}. ${displayDay(g.date)}`).join('\n');
      return out(
        `¿Para qué día las ${formatTime(time)}? 😊\n${opts}\n(responde el número o el día)`,
        forReschedule ? 'rescheduling' : 'picking_slot'
      );
    }

    // FIX 1: respuesta a "¿para qué día?" — lo ofrecido son VARIOS días con una
    // misma hora y el cliente da un día → confirmar esa hora en el día elegido.
    {
      const offDates = [...new Set(offered.map(o => o.date))];
      const offTimes = [...new Set(offered.map(o => o.time))];
      if (understood.date && !understood.time && offDates.length > 1 && offTimes.length === 1) {
        const dt = resolveDateToken(understood.date);
        const hit = dt && offered.find(o => o.date === dt);
        if (hit) return await confirmSlot(hit.date, hit.time, forReschedule);
      }
    }

    // 0. AM/PM ambiguo → preguntar una vez (sin asumir).
    if (understood.time && understood.ampm_ambiguous) {
      const date = resolveDateToken(understood.date) || await defaultDate();
      return ampmAsk(date, forReschedule);
    }
    // 1. Elección por posición ("1", "el primero") — re-verifica vs DB (Punto 4).
    if (choiceNum && choiceNum >= 1 && choiceNum <= offered.length) {
      const sel = offered[choiceNum - 1];
      return await confirmSlot(sel.date, sel.time, forReschedule);
    }
    // 2. Hora explícita → verificar vs DB. El día: el que dijo el cliente; si no
    //    dio día resoluble, resolveTargetDate decide sin asumir a ciegas (FIX 1).
    //    Si hay varios días posibles → preguntamos cuál en vez de elegir el primero.
    if (understood.time) {
      const t = normalizeTime(understood.time);
      const targetDate = await resolveTargetDate();
      if (!targetDate) return await askWhichDay(t);
      return await confirmSlot(targetDate, t, forReschedule);
    }
    // 3. Día específico → lista NUMERADA con TODOS los cupos de ese día (BUG 3).
    if (understood.date) {
      const targetDate = resolveDateToken(understood.date);
      if (targetDate && daysFromToday(targetDate) > 30) {
        return out(`Solo puedo agendar hasta el *${formatDate(limitDateStr())}* 😊 ¿Qué otra fecha te sirve?`);
      }
      const day = targetDate ? await deps.getDayAvailability(bk.barberId, targetDate) : null;
      if (day && !day.closed && day.available.length) {
        d.offered = day.available.map(t => ({ date: targetDate, time: t }));
        const lines = day.available.map((t, i) => `${i + 1}. ${formatTime(t)}`).join('\n');
        return out(
          `📅 *${bk.barberName}* el ${formatDate(targetDate).toLowerCase()}:\n${lines}\n\n` +
          `¿Cuál prefieres? (responde el número o la hora)`,
          forReschedule ? 'rescheduling' : 'picking_slot'
        );
      }
      d.negotiation = (d.negotiation || 0) + 1;
      if (d.negotiation > 2) { resetData(); return out(`Mejor elige en el calendario: ${linkOnce()}`, 'idle'); }
      return await offerSlots(forReschedule, day && day.closed ? `Ese día ${bk.barberName} no abre 😕` : null);
    }
    // 4. Sin hora/día/elección (ej "qué horarios tienes"):
    //    - Si YA le mostramos horarios → NO repetir el bloque (regla irrompible
    //      "nunca repetir el mismo mensaje"); pedir un día/hora específico.
    //    - Si aún no hay nada mostrado → mostrar los próximos días del barbero.
    if (offered.length) {
      return out(`Ya te mostré los horarios disponibles 🙂\n¿Hay algún día o hora específica que prefieras?`);
    }
    return await offerSlots(forReschedule);
  }

  // Red de seguridad determinista: Groq (llama-3.1-8b) a veces NO extrae un
  // barbero/servicio cuando el cliente responde SOLO con el nombre (ej: el bot
  // pide "¿con qué barbero?" y el cliente escribe "pacheco" a secas → Groq
  // devolvía barber:null). Si el mensaje es UNA sola palabra y rellena justo el
  // dato que falta, lo casamos aquí sin depender de Groq. Gated para evitar
  // falsos positivos: el barbero solo se rescata cuando nombre+servicio ya están
  // (así una palabra suelta no es el nombre del cliente).
  function recoverSingleWord(bk) {
    if (String(msg).trim().split(/\s+/).length !== 1) return; // solo palabras sueltas
    if (bk.name && bk.serviceId && !bk.barberId && barbers.length > 1) {
      const b = matchStrict(msg, barbers); if (b) setBarber(bk, b);
    } else if (bk.name && !bk.serviceId) {
      const s = matchStrict(msg, services); if (s) setService(bk, s);
    }
  }

  // Pide lo que falte (nombre/servicio/barbero) o pasa a ofrecer horarios.
  async function advanceCollecting() {
    const bk = d.bk || (d.bk = {});
    if (!bk.barberId && barbers.length === 1) setBarber(bk, barbers[0]);
    recoverSingleWord(bk);

    const missing = [];
    if (!bk.name) missing.push('tu nombre');
    if (!bk.serviceId) missing.push('el servicio');
    if (!bk.barberId && barbers.length > 1) missing.push('el barbero');

    if (missing.length) {
      // REGLA: pedir SOLO lo que falta, en UN mensaje.
      let extra = '';
      if (!bk.serviceId) extra += `\n\n✂️ *Servicios:*\n${svcListText()}`;
      if (!bk.barberId && barbers.length > 1) extra += `\n\n💈 *Equipo:*\n${barberListText()}`;
      return out(`Me falta ${joinNatural(missing)} 🙂${extra}`, 'collecting');
    }

    // Todo recolectado. ¿Pidió día+hora concretos? Verificar SIEMPRE contra la DB.
    if (bk.wantDate && bk.wantTime) {
      const wd = bk.wantDate, wt = bk.wantTime, amb = bk.wantTimeAmbiguous;
      bk.wantDate = null; bk.wantTime = null; bk.wantTimeAmbiguous = false;
      if (amb) return ampmAsk(wd, false);          // AM/PM ambiguo → preguntar una vez
      return await confirmSlot(wd, wt, false);     // chokepoint: verifica vs DB
    }
    return await offerSlots(false);
  }

  // ── Acciones sobre la cita existente ────────────────────────────────────────
  // REAGENDAR: 1) muestra la cita y pregunta si la cambiamos, 2) al confirmar →
  // muestra horarios (offerSlots). El UPDATE ocurre tras elegir + confirmar.
  async function startReschedule() {
    const appts = await deps.getActiveAppointments();
    if (!appts.length) {
      resetData();
      return out(`No tienes citas activas 😊 ¿Quieres agendar una nueva? Dime tu nombre, el servicio y el barbero.`, 'idle');
    }
    const a = appts[0]; // la más próxima (vienen ordenadas asc)
    const sv = services.find(s => s.id === a.service_id);
    const ba = barbers.find(b => b.id === a.barber_id);
    if (!ba) {
      resetData();
      return out(`Tu cita es con un barbero que ya no está disponible 😕 Reagéndala en el calendario: ${linkOnce()}`, 'idle');
    }
    d.bk = { name: a.customer_name };
    if (sv) setService(d.bk, sv);
    setBarber(d.bk, ba);
    d.reschedule = { apptId: a.id };
    d.pendingAction = 'reschedule_start';
    return out(
      `Tienes ${sv ? sv.name : 'tu servicio'} con ${ba.name} el ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)}.\n¿La cambiamos? (sí/no)`,
      'confirming'
    );
  }

  // CANCELAR: pide confirmación clara.
  async function startCancel() {
    const appts = await deps.getActiveAppointments();
    if (!appts.length) { resetData(); return out(`No tienes citas activas para cancelar 😊`, 'idle'); }
    const a = appts[0];
    const sv = services.find(s => s.id === a.service_id);
    const ba = barbers.find(b => b.id === a.barber_id);
    d.bk = { name: a.customer_name };
    d.cancelApptId = a.id;
    d.pendingAction = 'cancel';
    return out(
      `⚠️ ¿Seguro que quieres cancelar?\n` +
      `✂️ ${sv ? sv.name : 'Servicio'} · 💈 ${ba ? ba.name : 'Barbero'}\n` +
      `📅 ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)}`,
      'confirming', { reminder: false }
    );
  }

  async function showAppointment() {
    const appts = await deps.getActiveAppointments();
    if (!appts.length) return out(`No tienes citas activas 😊 ¿Quieres agendar una?`);
    const a = appts[0];
    const sv = services.find(s => s.id === a.service_id);
    const ba = barbers.find(b => b.id === a.barber_id);
    return out(`📅 Tu próxima cita:\n✂️ ${sv ? sv.name : 'Servicio'} · 💈 ${ba ? ba.name : 'Barbero'}\n📅 ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ORDEN DE EVALUACIÓN
  // ══════════════════════════════════════════════════════════════════════════

  // 1) CONFIRMING — yes/no apretado. Va primero para que "sí"/"no" no se
  //    malinterpreten como intención global.
  if (session.state === 'confirming') {
    const action = d.pendingAction;
    let affirm = I === 'CONFIRMAR' || rawNum === 1;
    let negate = I === 'NEGAR' || rawNum === 2;
    if (action === 'cancel') affirm = affirm || I === 'CANCELAR';
    if (action === 'reschedule_start') affirm = affirm || I === 'REAGENDAR';

    if (affirm) {
      if (action === 'reschedule_start') return await offerSlots(true); // → horarios
      if (action === 'create') {
        const bk = d.bk;
        // FIX 4 — REGLA #1 defendida en el chokepoint: si apareció una cita activa
        // mientras el cliente armaba esta (p.ej. reservó por web/dashboard a mitad
        // del flujo), NO creamos una segunda. El guard de idle/CASO A se evaluó al
        // inicio y no se revalida; aquí es el último punto antes de insertar.
        const existing = await deps.getActiveAppointments();
        if (existing && existing.length) {
          resetData();
          return out(`Vi que ya tienes una cita activa 😊 Solo puedes tener una a la vez. ¿Quieres *cambiarla* o *cancelarla*?`, 'idle');
        }
        const endTime = addDuration(bk.time, bk.serviceDuration);
        const r = await deps.commitCreate({ name: bk.name, serviceId: bk.serviceId, barberId: bk.barberId, date: bk.date, startTime: bk.time, endTime });
        // Carrera perdida: el slot se ocupó entre que lo mostramos y confirmó. NO
        // reseteamos el bk (conserva barbero/servicio): re-ofrecemos horarios para
        // que re-elija, en vez de soltar un error seco. (Backstop: índice único DB.)
        if (!r.ok && r.reason === 'taken') {
          const takenTime = bk.time;
          d.pendingAction = null;
          return await offerSlots(false, `Uy, alguien acaba de tomar las ${formatTime(takenTime)} 😕`);
        }
        const { name, date, time } = bk;
        resetData();
        if (!r.ok) return out(`Uy, no pude guardar la cita 😕 Intenta de nuevo en un momento.`, 'idle');
        return out(`✅ ¡Listo, ${name}! Te esperamos el ${formatDate(date)} a las ${formatTime(time)} 💈`, 'idle');
      }
      if (action === 'reschedule') {
        const bk = d.bk;
        const endTime = addDuration(bk.time, bk.serviceDuration);
        const r = await deps.commitReschedule(d.reschedule.apptId, bk.date, bk.time, endTime);
        // Carrera perdida en reagendar: el slot se ocupó entre mostrar y confirmar.
        // NO reseteamos (conserva bk Y d.reschedule.apptId): re-ofrecemos horarios
        // para re-elegir, en vez de un error seco. (Backstop: índice único DB.)
        if (!r.ok && r.reason === 'taken') {
          const takenTime = bk.time;
          d.pendingAction = null;
          return await offerSlots(true, `Uy, alguien acaba de tomar las ${formatTime(takenTime)} 😕`);
        }
        const { name, date, time } = bk;
        resetData();
        if (!r.ok) return out(`Hubo un error al reagendar 😕 Intenta de nuevo en un momento.`, 'idle');
        return out(`✅ ¡Listo, ${name}! Te esperamos el ${formatDate(date)} a las ${formatTime(time)} 💈`, 'idle');
      }
      if (action === 'cancel') {
        const r = await deps.commitCancel(d.cancelApptId);
        resetData();
        if (!r.ok) return out(`Hubo un error al cancelar 😕 Intenta de nuevo.`, 'idle');
        return out(`✅ Cita cancelada. ¡Hasta la próxima! 👋`, 'idle');
      }
    }
    if (negate) {
      if (action === 'create') return out(`Claro, dime el dato correcto (servicio, día u hora) 🙂`, 'collecting');
      if (action === 'reschedule' || action === 'reschedule_start') { resetData(); return out(`¡Perfecto! Tu cita se mantiene igual 💈`, 'idle'); }
      // cancel negativo
      resetData();
      return out(`¡Perfecto, te esperamos! 💈`, 'idle');
    }
    // FIX 2: corrección de día/hora durante la confirmación de un horario. Si el
    // cliente menciona un día o una hora DISTINTOS a los que se confirman, es una
    // corrección (no un sí/no): re-verificamos contra el horario real del barbero
    // ese día y volvemos a confirmar. (No aplica a cancelar.)
    if ((action === 'reschedule' || action === 'create') && d.bk && (understood.date || understood.time)) {
      const newDate = resolveDateToken(understood.date) || d.bk.date;
      const newTime = normalizeTime(understood.time) || d.bk.time;
      if (newDate !== d.bk.date || newTime !== d.bk.time) {
        d.pendingAction = null;
        return await confirmSlot(newDate, newTime, action === 'reschedule');
      }
    }
    // Ambiguo: preguntar UNA vez más, distinto. NUNCA ejecutar lo opuesto.
    if (action === 'cancel') return out(`Solo para estar seguro 🙂 ¿cancelo tu cita? Responde *sí* o *no*.`);
    if (action === 'reschedule_start') return out(`¿Quieres cambiar tu cita? Responde *sí* o *no* 🙂`);
    if (action === 'reschedule') return out(`¿Confirmo el cambio a las ${formatTime(d.bk.time)}? Responde *sí* o *no* 🙂`);
    // create: si cambió un detalle (otra hora/día/servicio/barbero) → re-evaluar
    if (understood.time || understood.date || understood.service || understood.barber) {
      mergeUnderstood();
      return await advanceCollecting();
    }
    return out(`¿Confirmo la cita? Responde *sí* o *no*.`);
  }

  // ── Guardas previas al ruteo por estado (confirming ya retornó arriba) ───────
  const hasData = !!(understood.service || understood.name || understood.barber || understood.time || understood.date);

  // BUG 3 — Fecha inexistente (ej "32 de junio" → 2026-06-32, que JS rodaría a
  // julio en silencio). No la aceptamos; pedimos de nuevo sin perder el estado.
  if (isInvalidDateToken(understood.date)) {
    return out(`Esa fecha no existe 😅 ¿qué día quieres decir?`);
  }

  // BUG 1 — "tengo preguntas/dudas" sin una pregunta concreta todavía → invitar
  // a preguntar y ESPERAR, en vez de empujar el flujo de datos (servicio/barbero).
  if (wantsToAsk(msg) && !hasData) {
    return out(`Claro, dime qué quieres saber 😊`);
  }

  // 2) INTENTS GLOBALES (reagendar/cancelar/ver cita EXISTENTE) — prioridad sobre
  //    el estado. EXCEPCIÓN BUG 4: si el cliente está creando una cita NUEVA
  //    (collecting/picking_slot), un "quiero otra hora" que Groq lee como
  //    REAGENDAR NO debe botarlo con "no tienes citas activas"; debe caer al flujo
  //    actual (pickSlot/collecting) y re-elegir horario sin perder el contexto.
  const inCreateFlow = session.state === 'collecting' || session.state === 'picking_slot';
  if (!inCreateFlow) {
    // FIX 3: si YA estamos eligiendo nuevo horario (rescheduling), un mensaje que
    // Groq lee como REAGENDAR (p.ej. una hora suelta "2:30") NO reinicia el flujo
    // — cae a pickSlot(true) y se trata como elección de horario en el día actual.
    if (I === 'REAGENDAR' && session.state !== 'rescheduling') return await startReschedule();
    if (I === 'CANCELAR')  return await startCancel();
    if (I === 'VER_CITA')  return await showAppointment();
  }

  // 3) IDLE — aquí aplica el PASO 0 (CASO A / B / C)
  if (session.state === 'idle') {
    const active = history && history.activeAppointment;

    // Filtro de relevancia: en reposo, un mensaje claramente ajeno a la barbería
    // se corta UNA vez. (En flujos activos no se llega aquí; allí un mensaje corto
    // se interpreta como respuesta al flujo antes de descartarlo.)
    if (I === 'FUERA_DE_CONTEXTO' && !hasData) {
      return out(`Solo puedo ayudarte con citas en *${ctx.business.name}* 😊\n📅 Reserva aquí: ${linkOnce()}`);
    }

    // ── CASO A: cliente con cita activa ──────────────────────────────────────
    if (active) {
      // Acuse del recordatorio ("confirmo" sobre una cita ya existente)
      if (I === 'CONFIRMAR') {
        return out(`✅ ¡Perfecto! Te esperamos a las ${formatTime(active.start_time)} 💈`);
      }
      // BUG 5 — Pregunta general REAL va PRIMERO, ANTES que hasData: aunque Groq
      // extrajo por error un día/hora de "¿hasta qué hora abren los sábados?", si
      // la intención es PREGUNTA_GENERAL SIEMPRE se responde (nunca el bloqueo de
      // "una cita activa"). Un saludo pelado no es pregunta → cae al mensaje limpio.
      if (I === 'PREGUNTA_GENERAL' && !isGreeting(msg)) {
        const ans = await deps.askGeneral(msg);
        return out(`${ans}\n\n¿Algo más con tu cita? (reagendar / cancelar)`);
      }
      // REGLA #1: pide nueva cita o manda datos de reserva → no se crea otra.
      if (I === 'NUEVA_CITA' || hasData) {
        return out(`Solo puedes tener una cita activa a la vez 😊 ¿Quieres *cambiar* la que tienes o *cancelarla* primero?`);
      }
      // Saludo / cualquier otra cosa → mostrar la cita y las opciones (ya trae menú).
      return out(activeApptText(active), undefined, { reminder: false });
    }

    // ── Sin cita activa ──────────────────────────────────────────────────────
    // CASO B — recurrente sin cita activa (nombre conocido). Se reconoce SIEMPRE
    // primero, aunque Groq lea el saludo como PREGUNTA_GENERAL: el saludo de
    // CASO B ya incluye los servicios con precios, así que también responde la
    // pregunta informativa del cliente conocido.
    if (history && history.hasHistory) {
      if (hasData) { mergeUnderstood(); return await advanceCollecting(); }
      return out(recurringText(), 'collecting', { reminder: false });
    }

    // CASO C — cliente nuevo
    // Pregunta general informativa REAL (sin datos de cita) → responder y
    // retomar. Un saludo pelado cae a la bienvenida completa de abajo.
    if (I === 'PREGUNTA_GENERAL' && !hasData && !isGreeting(msg)) {
      const ans = await deps.askGeneral(msg);
      return out(`${ans}\n\n¿Puedo ayudarte con algo más? 🙂`);
    }
    if (hasData) { mergeUnderstood(); return await advanceCollecting(); }
    return out(welcomeText(), 'collecting', { reminder: false });
  }

  // 4) COLLECTING
  if (session.state === 'collecting') {
    // Pregunta informativa a mitad de la recolección → responder sin perder lo
    // ya recolectado, y retomar (complemento de BUG 1: tras "tengo preguntas").
    if (I === 'PREGUNTA_GENERAL' && !hasData && !isGreeting(msg)) {
      const ans = await deps.askGeneral(msg);
      return out(`${ans}\n\n¿Seguimos con tu cita? 🙂`);
    }
    mergeUnderstood();
    return await advanceCollecting();
  }

  // 5) PICKING_SLOT (cita nueva)
  if (session.state === 'picking_slot') {
    return await pickSlot(false);
  }

  // 6) RESCHEDULING (cita existente)
  if (session.state === 'rescheduling') {
    return await pickSlot(true);
  }

  // Fallback — nunca debería llegar aquí
  resetData();
  return out(`Dime tu nombre, el servicio y el barbero para agendar 🙂`, 'idle');
}

module.exports = {
  respond,
  // helpers expuestos para tests / index.js
  todayPR, formatDate, formatTime, shortDate, displayDay, resolveDateToken, normalizeTime,
  addDuration, matchService, matchBarber, matchStrict, spreadSlots, nearestSlots, joinNatural, titleCase,
  isGreeting, wantsToAsk, isInvalidDateToken, isRealDate,
};
