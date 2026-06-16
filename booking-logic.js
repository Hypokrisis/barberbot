// booking-logic.js — Motor de conversación del bot (rediseño limpio v3).
// Pure/inyectable: no importa Supabase, Twilio ni Groq. Toda la I/O entra por
// `deps` y la interpretación del mensaje entra por `understood` (salida de Groq).
// Esto lo hace 100% testeable offline (ver test-booking-sim.js).
//
// Estados (5, nada más):
//   idle        — sin nada en proceso
//   collecting  — juntando nombre + servicio + barbero
//   picking_slot— eligiendo horario para una cita NUEVA
//   confirming  — esperando sí/no (pendingAction: create | cancel | reschedule_start)
//   rescheduling— eligiendo nuevo horario para una cita EXISTENTE

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

// "today" | "tomorrow" | día-semana-es | YYYY-MM-DD → YYYY-MM-DD (o null)
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
      || barbers.find(b => b.name.toLowerCase().includes(n) || n.includes(b.name.toLowerCase()))
      || null;
}

// ── Helpers de slots ──────────────────────────────────────────────────────────
function spreadSlots(slots, n = 6) {
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

// ════════════════════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════
//
// respond({ session, msg, understood, ctx, deps })
//   session   — { state, data }  (se muta)
//   msg       — texto crudo del cliente
//   understood— { intent, name, service, barber, date, time }  (salida de Groq)
//   ctx       — { business, services, barbers, bookingLink, history, phone }
//   deps      — { getSlots, getUpcoming, getActiveAppointments,
//                 commitCreate, commitReschedule, commitCancel, askGeneral }
//
async function respond({ session, msg, understood, ctx, deps }) {
  const { services, barbers, bookingLink, history } = ctx;
  const d = session.data || (session.data = {});
  const I = (understood && understood.intent) || 'UNKNOWN';
  const numChoice = /^\d+$/.test(msg.trim()) ? parseInt(msg.trim(), 10) : null;

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
  function out(text, state) {
    if (state !== undefined) session.state = state;
    if (text === d.lastReply) text = reword(text);
    d.lastReply = text;
    return text;
  }
  // El link aparece máximo 2 veces por conversación (bienvenida + disponibilidad)
  function linkOnce() {
    if ((d.linkCount || 0) >= 2) return '';
    d.linkCount = (d.linkCount || 0) + 1;
    return bookingLink;
  }
  function resetData() {
    d.bk = null; d.offered = null; d.negotiation = 0;
    d.pendingAction = null; d.reschedule = null; d.cancelApptId = null;
  }
  function setService(bk, s) { bk.serviceId = s.id; bk.serviceName = s.name; bk.servicePrice = s.price; bk.serviceDuration = s.duration_minutes || 30; }
  function setBarber(bk, b) { bk.barberId = b.id; bk.barberName = b.name; }
  function svcListText() { return services.map(s => `• ${s.name} — $${s.price}`).join('\n'); }
  function barberListText() { return barbers.map(b => `• ${b.name}`).join('\n'); }

  function mergeUnderstood() {
    const bk = d.bk || (d.bk = {});
    if (understood.name && !bk.name) bk.name = titleCase(understood.name);
    if (!bk.name && history && history.name) bk.name = titleCase(history.name);
    if (understood.service) { const s = matchService(understood.service, services); if (s) setService(bk, s); }
    if (understood.barber)  { const b = matchBarber(understood.barber, barbers);   if (b) setBarber(bk, b); }
    const wd = resolveDateToken(understood.date); if (wd) bk.wantDate = wd;
    const wt = normalizeTime(understood.time);    if (wt) bk.wantTime = wt;
    return bk;
  }

  function welcomeText() {
    const equipo = barbers.length ? `\n\n💈 *Equipo:*\n${barberListText()}` : '';
    return `¡Bienvenido! 💈 Soy el asistente de *${ctx.business.name}*.\n\n` +
           `✂️ *Servicios:*\n${svcListText()}${equipo}\n\n` +
           `Dime en un mensaje: tu nombre, el servicio y el barbero que prefieres.\n\n` +
           `📅 O reserva directo: ${linkOnce()}`;
  }

  // Construye y muestra disponibilidad. Mueve a picking_slot / rescheduling.
  async function offerSlots(forReschedule) {
    const bk = d.bk;
    const up = await deps.getUpcoming(bk.barberId, 3, 2); // hasta 3 días × 2 = 6
    const nextState = forReschedule ? 'rescheduling' : 'picking_slot';
    if (!up || !up.length) {
      return out(`${bk.barberName} no tiene espacios próximos 😕\n📅 Reserva en el calendario: ${linkOnce() || bookingLink}`, nextState);
    }
    d.offered = [];
    const lines = [];
    for (const g of up) {
      for (const t of g.slots) d.offered.push({ date: g.date, time: t });
      lines.push(`- ${displayDay(g.date)} — ${g.slots.map(formatTime).join(', ')}`);
    }
    d.negotiation = 0;
    return out(
      `📅 ${bk.barberName} tiene espacio:\n${lines.join('\n')}\n\n` +
      `¿Cuál te queda bien? Si ninguna te funciona, dime la hora que prefieres y te verifico 😊\n` +
      `📅 O elige en el calendario: ${linkOnce() || bookingLink}`,
      nextState
    );
  }

  // Resumen → estado confirming(create). Para reschedule hace UPDATE directo.
  async function commitChosen(slot, forReschedule) {
    const bk = d.bk;
    bk.date = slot.date; bk.time = slot.time;
    if (forReschedule) {
      const endTime = addDuration(bk.time, bk.serviceDuration);
      const r = await deps.commitReschedule(d.reschedule.apptId, bk.date, bk.time, endTime);
      const { name, serviceName, barberName, date, time } = bk;
      resetData();
      if (!r.ok) return out(`Hubo un error al reagendar 😕 Intenta de nuevo en un momento.`, 'idle');
      return out(`✅ ¡Cita reagendada, ${name}!\n💈 ${barberName} · ${formatDate(date)} a las ${formatTime(time)}\n¡Te esperamos! 💈`, 'idle');
    }
    d.pendingAction = 'create';
    return out(`📋 ${bk.name} — ${bk.serviceName} ($${bk.servicePrice}) con ${bk.barberName}, ${formatDate(bk.date)} a las ${formatTime(bk.time)}.\n¿Confirmo? (sí/no)`, 'confirming');
  }

  // Interpreta la elección de horario (compartido entre picking_slot y rescheduling)
  async function pickSlot(forReschedule) {
    const bk = d.bk;
    const offered = d.offered || [];

    // 1. Elección numérica (aceptada, no exigida)
    if (numChoice && numChoice >= 1 && numChoice <= offered.length) {
      return await commitChosen(offered[numChoice - 1], forReschedule);
    }
    // 2. Hora que coincide con una de las ofrecidas
    if (understood.time) {
      const t = normalizeTime(understood.time);
      const wantDate = resolveDateToken(understood.date);
      const hit = offered.find(o => o.time === t && (!wantDate || o.date === wantDate));
      if (hit) return await commitChosen(hit, forReschedule);
    }
    // 3. Hora libre pedida fuera de la lista → verificar
    if (understood.time) {
      const t = normalizeTime(understood.time);
      const targetDate = resolveDateToken(understood.date) || (offered[0] && offered[0].date) || todayPR();
      if (daysFromToday(targetDate) > 30) {
        return out(`Solo puedo agendar hasta el *${formatDate(limitDateStr())}* 😊 ¿Qué otra fecha te sirve?`);
      }
      const slots = await deps.getSlots(bk.barberId, targetDate);
      if (slots.includes(t)) return await commitChosen({ date: targetDate, time: t }, forReschedule);
      // ocupada → negociar (máximo 2 rondas)
      d.negotiation = (d.negotiation || 0) + 1;
      if (d.negotiation > 2) {
        resetData();
        return out(`No logramos cuadrar la hora 😕 Mejor elige directo en el calendario: ${linkOnce() || bookingLink}`, 'idle');
      }
      const near = nearestSlots(slots, t, 2);
      if (!near.length) return await offerSlots(forReschedule);
      d.offered = near.map(x => ({ date: targetDate, time: x }));
      return out(`Las ${formatTime(t)} está ocupada 😕 Tengo ${joinNatural(near.map(formatTime), 'o')}, ¿cuál te sirve?`);
    }
    // 4. Solo fecha (sin hora) → mostrar ese día
    if (understood.date) {
      const targetDate = resolveDateToken(understood.date);
      if (targetDate && daysFromToday(targetDate) > 30) {
        return out(`Solo puedo agendar hasta el *${formatDate(limitDateStr())}* 😊 ¿Qué otra fecha te sirve?`);
      }
      const slots = targetDate ? await deps.getSlots(bk.barberId, targetDate) : [];
      if (slots.length) {
        const pick = spreadSlots(slots, 6);
        d.offered = pick.map(x => ({ date: targetDate, time: x }));
        return out(`📅 ${displayDay(targetDate)}: ${pick.map(formatTime).join(', ')}\n¿Cuál te queda bien?`);
      }
      d.negotiation = (d.negotiation || 0) + 1;
      if (d.negotiation > 2) { resetData(); return out(`Mejor elige en el calendario: ${linkOnce() || bookingLink}`, 'idle'); }
      return await offerSlots(forReschedule);
    }
    // 5. No entendido → re-preguntar (dedupe garantiza que no repita literal)
    return out(`¿Cuál de esos horarios te queda bien? También puedes decirme una hora y te verifico 🙂`);
  }

  // Pide lo que falte (nombre/servicio/barbero) o pasa a ofrecer horarios.
  async function advanceCollecting() {
    const bk = d.bk || (d.bk = {});
    if (!bk.barberId && barbers.length === 1) setBarber(bk, barbers[0]);

    const missing = [];
    if (!bk.name) missing.push('tu nombre');
    if (!bk.serviceId) missing.push('el servicio');
    if (!bk.barberId && barbers.length > 1) missing.push('el barbero');

    if (missing.length) {
      let extra = '';
      if (!bk.serviceId) extra += `\n\n✂️ Servicios:\n${svcListText()}`;
      if (!bk.barberId && barbers.length > 1) extra += `\n\n💈 Equipo:\n${barberListText()}`;
      return out(`Me falta ${joinNatural(missing)} 🙂${extra}`, 'collecting');
    }

    // Todo recolectado. ¿Pidió día+hora concretos? Verificar e ir directo a confirmar.
    if (bk.wantDate && bk.wantTime) {
      if (daysFromToday(bk.wantDate) > 30) {
        bk.wantDate = null;
        return out(`Solo puedo agendar hasta el *${formatDate(limitDateStr())}* 😊 ¿Qué fecha te sirve?`, 'picking_slot');
      }
      const slots = await deps.getSlots(bk.barberId, bk.wantDate);
      if (slots.includes(bk.wantTime)) {
        const chosen = { date: bk.wantDate, time: bk.wantTime };
        bk.wantDate = null; bk.wantTime = null;
        return await commitChosen(chosen, false);
      }
      // pidió hora puntual no disponible → negociar con las más cercanas
      const near = nearestSlots(slots, bk.wantTime, 2);
      const wt = bk.wantTime; bk.wantTime = null;
      if (near.length) {
        d.offered = near.map(x => ({ date: bk.wantDate, time: x }));
        d.negotiation = 1;
        session.state = 'picking_slot';
        return out(`Las ${formatTime(wt)} está ocupada 😕 Tengo ${joinNatural(near.map(formatTime), 'o')}, ¿cuál te sirve?`);
      }
      bk.wantDate = null;
    }
    return await offerSlots(false);
  }

  // ── Acciones globales (prioridad: funcionan desde cualquier estado) ──────────
  async function startReschedule() {
    const appts = await deps.getActiveAppointments();
    if (!appts.length) {
      resetData();
      return out(`No tienes citas activas 😊 ¿Quieres agendar una nueva? Dime tu nombre, el servicio y el barbero.`, 'idle');
    }
    const a = appts[0]; // la más próxima (vienen ordenadas asc)
    const sv = services.find(s => s.id === a.service_id);
    const ba = barbers.find(b => b.id === a.barber_id);
    d.bk = { name: a.customer_name };
    if (sv) setService(d.bk, sv);
    if (ba) setBarber(d.bk, ba);
    d.reschedule = { apptId: a.id };
    d.pendingAction = 'reschedule_start';
    return out(`Tienes: ${sv ? sv.name : 'tu servicio'} con ${ba ? ba.name : 'tu barbero'} el ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)}. ¿La cambiamos? (sí/no)`, 'confirming');
  }

  async function startCancel() {
    const appts = await deps.getActiveAppointments();
    if (!appts.length) { resetData(); return out(`No tienes citas activas para cancelar 😊`, 'idle'); }
    const a = appts[0];
    const sv = services.find(s => s.id === a.service_id);
    const ba = barbers.find(b => b.id === a.barber_id);
    d.bk = { name: a.customer_name };
    d.cancelApptId = a.id;
    d.pendingAction = 'cancel';
    return out(`⚠️ ¿Seguro que quieres cancelar?\n✂️ ${sv ? sv.name : 'Servicio'} · 💈 ${ba ? ba.name : 'Barbero'}\n🗓 ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)}\n\nResponde *sí* o *no*.`, 'confirming');
  }

  async function showAppointment() {
    const appts = await deps.getActiveAppointments();
    if (!appts.length) return out(`No tienes citas activas 😊 ¿Quieres agendar una?`);
    const a = appts[0];
    const sv = services.find(s => s.id === a.service_id);
    const ba = barbers.find(b => b.id === a.barber_id);
    return out(`📅 Tu próxima cita:\n✂️ ${sv ? sv.name : 'Servicio'} · 💈 ${ba ? ba.name : 'Barbero'}\n🗓 ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ORDEN DE EVALUACIÓN
  // ══════════════════════════════════════════════════════════════════════════

  // 1) CONFIRMING — yes/no apretado. Va primero para que "sí"/"no" no se
  //    malinterpreten como intención global.
  if (session.state === 'confirming') {
    const action = d.pendingAction;
    let affirm = I === 'CONFIRMAR' || numChoice === 1;
    let negate = I === 'NEGAR' || numChoice === 2;
    if (action === 'cancel') affirm = affirm || I === 'CANCELAR';
    if (action === 'reschedule_start') affirm = affirm || I === 'REAGENDAR';

    if (affirm) {
      if (action === 'create') {
        const bk = d.bk;
        const endTime = addDuration(bk.time, bk.serviceDuration);
        const r = await deps.commitCreate({ name: bk.name, serviceId: bk.serviceId, barberId: bk.barberId, date: bk.date, startTime: bk.time, endTime });
        const { name, date, time } = bk;
        resetData();
        if (!r.ok) return out(`Uy, no pude guardar la cita 😕 Intenta de nuevo en un momento.`, 'idle');
        return out(`✅ ¡Listo, ${name}! Te esperamos el ${formatDate(date)} a las ${formatTime(time)}. 💈`, 'idle');
      }
      if (action === 'cancel') {
        const name = d.bk && d.bk.name;
        const r = await deps.commitCancel(d.cancelApptId);
        resetData();
        if (!r.ok) return out(`Hubo un error al cancelar 😕 Intenta de nuevo.`, 'idle');
        return out(`Listo${name ? ', ' + name : ''}, tu cita quedó *cancelada*. Cuando quieras agendar otra, aquí estoy 👋`, 'idle');
      }
      if (action === 'reschedule_start') {
        return await offerSlots(true);
      }
    }
    if (negate) {
      if (action === 'create') { return out(`Claro, dime el dato correcto (servicio, día u hora) 🙂`, 'collecting'); }
      const name = d.bk && d.bk.name;
      resetData();
      return out(`¡Perfecto${name ? ', ' + name : ''}! Tu cita se mantiene igual. 💈`, 'idle');
    }
    // No fue claro:
    if (action === 'cancel') return out(`Solo para estar seguro 🙂 ¿cancelo tu cita? Responde *sí* o *no*.`);
    if (action === 'reschedule_start') return out(`¿Quieres cambiar tu cita? Responde *sí* o *no* 🙂`);
    // create: si cambió un detalle (otra hora/día/servicio/barbero) → re-evaluar
    if (understood.time || understood.date || understood.service || understood.barber) {
      mergeUnderstood();
      return await advanceCollecting();
    }
    return out(`¿Confirmo la cita? Responde *sí* o *no*.`);
  }

  // 2) INTENTS GLOBALES — prioridad absoluta sobre el estado actual.
  if (I === 'REAGENDAR') return await startReschedule();
  if (I === 'CANCELAR')  return await startCancel();
  if (I === 'VER_CITA')  return await showAppointment();

  // 3) IDLE
  if (session.state === 'idle') {
    const hasData = !!(understood.service || understood.name || understood.barber || understood.time || understood.date);

    // Acuse de recibo del recordatorio (cliente con cita responde "confirmo")
    if (I === 'CONFIRMAR' && history && history.activeAppointment) {
      const a = history.activeAppointment;
      const ba = barbers.find(b => b.id === a.barber_id);
      return out(`✅ ¡Perfecto, ${history.name}! Tu cita está confirmada.\n💈 ${ba ? ba.name : 'Tu barbero'} te espera el ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)}. ¡Nos vemos! 🙌`);
    }

    // Pregunta general sin datos de cita → responder y quedarse en idle
    if (I === 'PREGUNTA_GENERAL' && !hasData) {
      return await deps.askGeneral(msg);
    }

    if (history && history.hasHistory) {
      if (hasData) { mergeUnderstood(); return await advanceCollecting(); }
      // Saludo de cliente conocido → reconocer y esperar su petición
      let greet = `¡Hola de nuevo, ${history.name}! 👋`;
      if (history.activeAppointment) {
        const a = history.activeAppointment;
        const ba = barbers.find(b => b.id === a.barber_id);
        greet += `\nTienes una cita el ${formatDate(a.appointment_date)} a las ${formatTime(a.start_time)} con ${ba ? ba.name : 'tu barbero'}.`;
      }
      greet += `\n\n¿Qué necesitas? Puedes decirme lo que quieras 🙂`;
      return out(greet, 'idle');
    }

    // Cliente nuevo
    if (hasData) { mergeUnderstood(); return await advanceCollecting(); }
    return out(welcomeText(), 'collecting');
  }

  // 4) COLLECTING
  if (session.state === 'collecting') {
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
  todayPR, formatDate, formatTime, displayDay, resolveDateToken, normalizeTime,
  addDuration, matchService, matchBarber, spreadSlots, nearestSlots, joinNatural, titleCase,
};
