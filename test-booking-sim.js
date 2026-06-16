// Simulación offline del motor v4.1 (booking-logic.respond).
// Groq (understood), disponibilidad y commits están mockeados.
// Cubre: flujos base, contexto de horarios, verificación real vs DB y filtro de
// mensajes. Run: node test-booking-sim.js
const bl = require('./booking-logic');

const business = { name: 'Annlo Barber', slug: 'annlobarberia' };
const bookingLink = 'https://spaceyreserve.netlify.app/book/annlobarberia';
const services = [
  { id: 's1', name: 'Corte moderno', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 24, duration_minutes: 20 },
];
const barbers = [{ id: 'b1', name: 'Pepe' }, { id: 'b2', name: 'Pablo' }];

const today = bl.todayPR();
const addDays = (n) => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };
const tomorrow = addDays(1);
const day3 = addDays(2);

// ── Mock de horarios + disponibilidad ────────────────────────────────────────
// Ventana 10:00–19:00 todos los días salvo los marcados CLOSED.
const CLOSED = new Set(); // "barberId|date"
function windowFor(barberId, date) {
  if (CLOSED.has(barberId + '|' + date)) return null;
  return { open: '10:00', close: '19:00' };
}
// Slots LIBRES por barbero/fecha (el resto de la ventana se considera ocupado).
const AVAILABLE = {
  b1: {
    [today]:    ['15:00', '16:30', '17:00', '18:00'],
    [tomorrow]: ['10:00', '11:00', '14:00', '18:00'],
    [day3]:     ['10:30', '13:00'],
  },
  b2: { [tomorrow]: ['10:00', '12:00'] },
};
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function genSlots(open, close) {
  const out = []; let [sh, sm] = open.split(':').map(Number); const end = toMin(close);
  while (sh * 60 + sm + 30 <= end) { out.push(`${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`); sm += 30; if (sm >= 60) { sh++; sm -= 60; } }
  return out;
}
async function getDayAvailability(barberId, date) {
  const win = windowFor(barberId, date);
  if (!win) return { closed: true, open: null, close: null, available: [], booked: [] };
  const all = genSlots(win.open, win.close);
  const availSet = new Set((AVAILABLE[barberId] || {})[date] || []);
  return { closed: false, open: win.open, close: win.close, available: all.filter(s => availSet.has(s)), booked: all.filter(s => !availSet.has(s)) };
}
async function checkSlot(barberId, date, time) {
  const day = await getDayAvailability(barberId, date);
  const base = { open: day.open, close: day.close, available: day.available };
  if (day.closed) return { status: 'closed', ...base };
  if (date === today) {
    const nowPR = new Date(Date.now() - 4 * 3600 * 1000);
    const nowMin = nowPR.getUTCHours() * 60 + nowPR.getUTCMinutes();
    if (toMin(time) <= nowMin + 15) return { status: 'past', ...base };
  }
  const tMin = toMin(time);
  if (tMin < toMin(day.open) || tMin + 30 > toMin(day.close)) return { status: 'outside_hours', ...base };
  if (day.available.includes(time)) return { status: 'available', ...base };
  if (day.booked.includes(time)) return { status: 'booked', ...base };
  return { status: 'unaligned', ...base };
}
async function getSlots(barberId, date) { return (await getDayAvailability(barberId, date)).available; }
async function getUpcoming(barberId, maxDays = 2, perDay = 2) {
  const out = [];
  const base = new Date(today + 'T12:00:00');
  const nowPR = new Date(Date.now() - 4 * 3600 * 1000);
  const nowMin = nowPR.getUTCHours() * 60 + nowPR.getUTCMinutes();
  for (let off = 0; off <= 13 && out.length < maxDays; off++) {
    const d = new Date(base); d.setDate(base.getDate() + off);
    const ds = d.toISOString().split('T')[0];
    let slots = await getSlots(barberId, ds);
    if (off === 0) slots = slots.filter(s => toMin(s) > nowMin + 15); // hoy: solo futuras (como index.js)
    if (slots.length) {
      const pick = []; const step = Math.max(1, Math.floor(slots.length / perDay));
      for (let i = 0; i < slots.length && pick.length < perDay; i += step) pick.push(slots[i]);
      out.push({ date: ds, slots: pick });
    }
  }
  return out;
}

let DB = [];
function makeDeps() {
  return {
    getSlots, getDayAvailability, checkSlot, getUpcoming,
    getActiveAppointments: async () => DB.filter(a => a.status === 'confirmed' && a.appointment_date >= today)
      .sort((a, b) => (a.appointment_date < b.appointment_date ? -1 : 1)),
    commitCreate: async (bk) => { DB.push({ id: 'new' + DB.length, status: 'confirmed', customer_name: bk.name, appointment_date: bk.date, start_time: bk.startTime, barber_id: bk.barberId, service_id: bk.serviceId }); return { ok: true }; },
    commitReschedule: async (id, date, time) => { const a = DB.find(x => x.id === id); if (a) { a.appointment_date = date; a.start_time = time; } return { ok: true }; },
    commitCancel: async (id) => { const a = DB.find(x => x.id === id); if (a) a.status = 'cancelled'; return { ok: true }; },
    askGeneral: async () => 'El Corte moderno cuesta $25 y la Barba $24 🙂',
  };
}
function makeBot(history) {
  const session = { state: 'idle', data: {} };
  const deps = makeDeps();
  return {
    session,
    send: (msg, u) => bl.respond({ session, msg, understood: u || { intent: 'UNKNOWN' }, ctx: { business, services, barbers, bookingLink, history: history || { hasHistory: false }, phone: '+17875551234' }, deps }),
  };
}

let FAILED = 0;
function check(label, cond) { console.log(`   ${cond ? '✅' : '❌'} ${label}`); if (!cond) FAILED++; }

async function run(title, history, turns) {
  console.log('\n══════════════════════════════════════════\n' + title + '\n══════════════════════════════════════════');
  const bot = makeBot(history);
  let last = null, repeated = false, n = 0;
  for (const [msg, u] of turns) {
    console.log(`👤 ${msg}`);
    const r = await bot.send(msg, u);
    n++; if (r === last) repeated = true; last = r;
    console.log(`🤖 ${r}\n`);
  }
  console.log(`   → ${n} msgs · estado: ${bot.session.state}` + (repeated ? ' · ⚠️ REPITIÓ' : ' · ✓ sin repeticiones'));
  if (repeated) FAILED++;
  return bot;
}

(async () => {
  // ── Regresión: flujos base ─────────────────────────────────────────────────
  DB = [];
  let b = await run('C1 — NUEVO, todo en un mensaje', { hasHistory: false }, [
    ['soy Ana, corte moderno con Pepe mañana a las 10', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno', barber: 'Pepe', date: 'tomorrow', time: '10:00' }],
    ['sí', { intent: 'CONFIRMAR' }],
  ]);
  check('cita creada en DB', DB.length === 1 && DB[0].start_time === '10:00');

  DB = [];
  b = await run('C2 — NUEVO, poco a poco + "el primero"', { hasHistory: false }, [
    ['hola', { intent: 'UNKNOWN' }],
    ['soy Ana, corte moderno', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno' }],
    ['con Pepe', { intent: 'NUEVA_CITA', barber: 'Pepe' }],
    ['el primero', { intent: 'NUEVA_CITA', choice: 1 }],
    ['dale', { intent: 'CONFIRMAR' }],
  ]);
  check('cita creada en DB', DB.length === 1);

  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  const histActive = { hasHistory: true, name: 'Carlos', activeAppointment: { appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' } };
  b = await run('C3 — CON CITA ACTIVA escribe "hola"', histActive, [['hola', { intent: 'UNKNOWN' }]]);
  check('muestra la cita activa', b.session.data.lastReply.startsWith('¡Hola de nuevo, Carlos!'));

  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  b = await run('C4 — CON CITA ACTIVA pide otra (regla #1)', histActive, [['quiero otro corte', { intent: 'NUEVA_CITA', service: 'Corte moderno' }]]);
  check('bloquea con "una cita activa a la vez"', b.session.data.lastReply.includes('una cita activa a la vez'));

  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  b = await run('C5 — REAGENDAR completo (UPDATE, no duplica)', histActive, [
    ['hola', { intent: 'UNKNOWN' }],
    ['reagendar', { intent: 'REAGENDAR' }],
    ['el día 3 a las 1pm', { intent: 'NUEVA_CITA', date: day3, time: '13:00' }],
    ['sí', { intent: 'CONFIRMAR' }],
  ]);
  check('UPDATE: 1 fila, id ap1, día3 13:00', DB.length === 1 && DB[0].id === 'ap1' && DB[0].appointment_date === day3 && DB[0].start_time === '13:00');

  const histRec = { hasHistory: true, name: 'Loann', activeAppointment: null };
  b = await run('C6 — RECURRENTE saluda leído como PREGUNTA_GENERAL', histRec, [['hola buenas', { intent: 'PREGUNTA_GENERAL' }]]);
  check('saluda "¡Hola de nuevo, Loann!"', b.session.data.lastReply.startsWith('¡Hola de nuevo, Loann!'));

  // ── Transcript: horarios reales ────────────────────────────────────────────
  DB = [];
  b = await run('C7 — "mañana a las 10pm" → FUERA DE HORARIO (no "ocupada")', { hasHistory: false }, [
    ['soy Ana corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno', barber: 'Pepe' }],
    ['mañana a las 10pm', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '22:00' }],
  ]);
  check('NO dice "ocupada"', !b.session.data.lastReply.includes('ocupada'));
  check('menciona el horario real (10:00 a 7:00)', b.session.data.lastReply.includes('trabaja ese día'));

  DB = [];
  b = await run('C8 — "mañana a las 6" → interpreta 18:00 y confirma 6:00 PM', { hasHistory: false }, [
    ['soy Leo corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Leo', service: 'Corte moderno', barber: 'Pepe' }],
    ['tienes para mañana a las 6?', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '18:00' }],
  ]);
  check('confirma 6:00 PM', b.session.data.lastReply.includes('6:00 PM') && b.session.data.lastReply.includes('¿Confirmo?'));

  DB = [];
  b = await run('C9 — "mañana 6pm" toma 18:00 aunque la lista tenga 5:00 PM', { hasHistory: false }, [
    ['soy Max corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Max', service: 'Corte moderno', barber: 'Pepe' }],
    ['mañana 6pm', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '18:00' }],
  ]);
  check('confirma 6:00 PM, NO 5:00 PM', b.session.data.lastReply.includes('6:00 PM') && !b.session.data.lastReply.includes('5:00 PM'));

  DB = [];
  b = await run('C10 — "mañana a la 1pm" (ocupada dentro de horario) → "ocupada"', { hasHistory: false }, [
    ['soy Sam corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Sam', service: 'Corte moderno', barber: 'Pepe' }],
    ['mañana a la 1pm', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '13:00' }],
  ]);
  check('dice "ocupada" (no fuera de horario)', b.session.data.lastReply.includes('ocupada'));

  DB = [];
  b = await run('C11 — AM/PM ambiguo → pregunta una vez', { hasHistory: false }, [
    ['soy Mia corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Mia', service: 'Corte moderno', barber: 'Pepe' }],
    ['mañana a las 6', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '06:00', ampm_ambiguous: true }],
  ]);
  check('pregunta AM o PM', /AM o las.*PM/.test(b.session.data.lastReply));

  // ── Filtro de mensajes ─────────────────────────────────────────────────────
  DB = [];
  b = await run('C12 — OFF-TOPIC en idle → mensaje fijo', { hasHistory: false }, [
    ['cuánto es 2+2?', { intent: 'FUERA_DE_CONTEXTO' }],
  ]);
  check('responde "Solo puedo ayudarte con citas"', b.session.data.lastReply.includes('Solo puedo ayudarte con citas'));

  DB = [];
  b = await run('C13 — OFF-TOPIC aparente EN FLUJO no corta (nah=NEGAR; mate=re-pregunta)', { hasHistory: false }, [
    ['soy Eli corte moderno con Pepe mañana a las 11', { intent: 'NUEVA_CITA', name: 'Eli', service: 'Corte moderno', barber: 'Pepe', date: 'tomorrow', time: '11:00' }],
    ['ayúdame con mate', { intent: 'FUERA_DE_CONTEXTO' }],
    ['nah', { intent: 'NEGAR' }],
  ]);
  check('mid-flujo NO suelta el mensaje fijo', !b.session.data.lastReply.includes('Solo puedo ayudarte con citas'));

  console.log('\n══════════════════════════════════════════');
  console.log(FAILED === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${FAILED} CHECK(S) FALLARON`);
  process.exit(FAILED === 0 ? 0 : 1);
})();
