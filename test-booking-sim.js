// Simulación offline del motor v4 (booking-logic.respond).
// Groq (understood), disponibilidad y commits están mockeados.
// Verifica los 5 casos del rediseño FINAL. Run: node test-booking-sim.js
const bl = require('./booking-logic');

const business = { name: 'Annlo Barber', slug: 'annlobarberia' };
const bookingLink = 'https://spaceyreserve.netlify.app/book/annlobarberia';
const services = [
  { id: 's1', name: 'Corte moderno', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 24, duration_minutes: 20 },
  { id: 's3', name: 'Tinte de pelo', price: 45, duration_minutes: 60 },
];
const barbers = [{ id: 'b1', name: 'Pepe' }, { id: 'b2', name: 'Pablo' }];

const today = bl.todayPR();
const addDays = (n) => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };
const tomorrow = addDays(1);
const day3 = addDays(2);

// Disponibilidad por barbero/fecha
const SLOTS = {
  b1: { [today]: ['15:00', '16:30'], [tomorrow]: ['10:00', '11:00', '14:00'], [day3]: ['09:00', '13:00'] },
  b2: { [tomorrow]: ['09:00', '12:00'] },
};
async function getSlots(barberId, date) { return (SLOTS[barberId] || {})[date] || []; }
async function getUpcoming(barberId, maxDays = 2, perDay = 2) {
  const out = [];
  const base = new Date(today + 'T12:00:00');
  for (let off = 0; off <= 13 && out.length < maxDays; off++) {
    const d = new Date(base); d.setDate(base.getDate() + off);
    const ds = d.toISOString().split('T')[0];
    const slots = await getSlots(barberId, ds);
    if (slots.length) {
      const pick = []; const step = Math.max(1, Math.floor(slots.length / perDay));
      for (let i = 0; i < slots.length && pick.length < perDay; i += step) pick.push(slots[i]);
      out.push({ date: ds, slots: pick });
    }
  }
  return out;
}

// "DB" en memoria para reagendar/cancelar
let DB = [];
function makeDeps() {
  return {
    getSlots, getUpcoming,
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
    send: (msg, understood) => bl.respond({ session, msg, understood: understood || { intent: 'UNKNOWN' }, ctx: { business, services, barbers, bookingLink, history: history || { hasHistory: false }, phone: '+17875551234' }, deps }),
  };
}

async function run(title, history, turns) {
  console.log('\n══════════════════════════════════════════\n' + title + '\n══════════════════════════════════════════');
  const bot = makeBot(history);
  let last = null, repeated = false, botMsgs = 0;
  for (const [msg, understood] of turns) {
    console.log(`👤 ${msg}`);
    const r = await bot.send(msg, understood);
    botMsgs++;
    if (r === last) repeated = true;
    last = r;
    console.log(`🤖 ${r}\n`);
  }
  console.log(`   → ${botMsgs} mensajes del bot · estado final: ${bot.session.state}` + (repeated ? ' · ⚠️ REPITIÓ' : ' · ✓ sin repeticiones'));
  return { botMsgs, repeated, state: bot.session.state, session: bot.session };
}

(async () => {
  // CASO 1 — Cliente nuevo da TODO en un mensaje (incluida la hora) → confirma y listo
  DB = [];
  await run('CASO 1 — NUEVO, todo en un mensaje (con hora libre)', { hasHistory: false }, [
    ['Hola, soy Ana, corte moderno con Pepe mañana a las 10', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno', barber: 'Pepe', date: 'tomorrow', time: '10:00' }],
    ['sí, confirmo', { intent: 'CONFIRMAR' }],
  ]);
  console.log('   → DB tras crear:', DB.length, 'cita(s) ·', DB[0] && `${DB[0].customer_name} ${DB[0].appointment_date} ${DB[0].start_time}`);

  // CASO 2 — Cliente nuevo da todo POCO A POCO
  DB = [];
  await run('CASO 2 — NUEVO, poco a poco', { hasHistory: false }, [
    ['hola', { intent: 'UNKNOWN' }],
    ['soy Ana, quiero corte moderno', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno' }],
    ['con Pepe', { intent: 'NUEVA_CITA', barber: 'Pepe' }],
    ['el primero', { intent: 'NUEVA_CITA', choice: 1 }],
    ['dale', { intent: 'CONFIRMAR' }],
  ]);
  console.log('   → DB tras crear:', DB.length, 'cita(s) ·', DB[0] && `${DB[0].customer_name} ${DB[0].appointment_date} ${DB[0].start_time}`);

  // CASO 3 — Cliente con cita activa escribe "hola" → muestra cita + opciones
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  const histActive = { hasHistory: true, name: 'Carlos', activeAppointment: { appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' } };
  await run('CASO 3 — CON CITA ACTIVA escribe "hola"', histActive, [
    ['hola', { intent: 'UNKNOWN' }],
  ]);

  // CASO 4 — Cliente con cita activa PIDE NUEVA CITA → bloquea y ofrece reagendar/cancelar
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  await run('CASO 4 — CON CITA ACTIVA pide otra cita (REGLA #1)', histActive, [
    ['quiero un corte mañana con Pablo', { intent: 'NUEVA_CITA', service: 'Corte moderno', barber: 'Pablo', date: 'tomorrow' }],
  ]);

  // CASO 5 — Reagendar completo → UPDATE en DB (no duplica)
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  await run('CASO 5 — REAGENDAR completo', histActive, [
    ['hola', { intent: 'UNKNOWN' }],
    ['quiero reagendar', { intent: 'REAGENDAR' }],
    ['mejor el día 3 a las 9', { intent: 'NUEVA_CITA', date: day3, time: '09:00' }],
    ['sí', { intent: 'CONFIRMAR' }],
  ]);
  console.log('   → DB len:', DB.length, '(debe ser 1, NO duplicada) · cita:', `${DB[0].appointment_date} ${DB[0].start_time}`, '(debe ser', day3, '09:00)');
  console.log('     status:', DB[0].status, '· id:', DB[0].id, '(mismo id ap1 = UPDATE, no INSERT)');

  // CASO 6 — RECURRENTE sin cita activa (+19393167853 = Loann, citas canceladas).
  // Debe saludar "¡Hola de nuevo, Loann!" AUNQUE Groq lea el saludo como
  // PREGUNTA_GENERAL (este era el bug: caía al fallback "✂️ Servicios:").
  DB = [];
  const histRecurring = { hasHistory: true, name: 'Loann', activeAppointment: null };
  const expect = (label, txt, ok) => console.log(`   ${ok ? '✅' : '❌'} ${label}` + (ok ? '' : ` — got: ${JSON.stringify(txt.slice(0, 40))}`));

  let r6a = await run('CASO 6a — RECURRENTE saluda (intent UNKNOWN)', histRecurring, [
    ['hola', { intent: 'UNKNOWN' }],
  ]);
  let firstA = r6a.session.data.lastReply;
  expect('Saludo empieza con "¡Hola de nuevo, Loann!"', firstA, firstA.startsWith('¡Hola de nuevo, Loann!'));

  let r6b = await run('CASO 6b — RECURRENTE saluda, Groq lo lee como PREGUNTA_GENERAL (el bug)', histRecurring, [
    ['hola buenas', { intent: 'PREGUNTA_GENERAL' }],
  ]);
  let firstB = r6b.session.data.lastReply;
  expect('Saludo empieza con "¡Hola de nuevo, Loann!"', firstB, firstB.startsWith('¡Hola de nuevo, Loann!'));
  expect('NO cae al fallback "✂️ Servicios:"', firstB, !firstB.startsWith('✂️ Servicios:'));
})();
