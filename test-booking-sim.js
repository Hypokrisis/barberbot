// Simulación offline del NUEVO motor (booking-logic.respond).
// Groq (understood), disponibilidad y commits están mockeados.
// Verifica los 5 casos del rediseño + conteo de mensajes del bot.
// Run: node test-booking-sim.js
const bl = require('./booking-logic');

const business = { name: 'Annlo Barbería', slug: 'annlo' };
const bookingLink = 'https://spaceyreserve.netlify.app/book/annlo';
const services = [
  { id: 's1', name: 'Corte moderno', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 24, duration_minutes: 20 },
  { id: 's3', name: 'Tinte de pelo', price: 45, duration_minutes: 60 },
  { id: 's4', name: 'Cejas', price: 5, duration_minutes: 10 },
];
const barbers = [{ id: 'b1', name: 'Pepe' }, { id: 'b2', name: 'Pablo' }, { id: 'b3', name: 'Pacheco' }];

const today = bl.todayPR();
const addDays = (n) => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };
const tomorrow = addDays(1);
const day3 = addDays(2);

// Disponibilidad por barbero/fecha
const SLOTS = {
  b1: { [today]: ['15:00', '16:30'], [tomorrow]: ['10:00', '11:00', '14:00'], [day3]: ['09:00', '13:00'] },
  b2: { [tomorrow]: ['09:00', '12:00'] },
  b3: { [today]: ['14:30', '16:00'], [tomorrow]: ['09:00', '10:00', '11:00'] },
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
    askGeneral: async () => '(respuesta general de Groq)',
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
  // CASO 1 — Cliente nuevo da TODO en un mensaje (incluida la hora) → 2-3 mensajes
  DB = [];
  await run('CASO 1 — nuevo, todo en un mensaje (con hora libre)', { hasHistory: false }, [
    ['Hola, soy Ana, corte moderno con Pepe mañana a las 10', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno', barber: 'Pepe', date: 'tomorrow', time: '10:00' }],
    ['sí, confirmo', { intent: 'CONFIRMAR' }],
  ]);

  // CASO 2 — Cliente nuevo poco a poco → máximo 5
  DB = [];
  await run('CASO 2 — nuevo, poco a poco', { hasHistory: false }, [
    ['hola', { intent: 'UNKNOWN' }],
    ['soy Ana, quiero corte moderno', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno' }],
    ['con Pepe', { intent: 'NUEVA_CITA', barber: 'Pepe' }],
    ['mañana a las 11', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '11:00' }],
    ['dale', { intent: 'CONFIRMAR' }],
  ]);

  // CASO 3 — pide hora NO mostrada → está libre → confirma
  DB = [];
  await run('CASO 3 — pide hora libre fuera de la lista', { hasHistory: false }, [
    ['hola soy Leo, corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Leo', service: 'Corte moderno', barber: 'Pepe' }],
    ['mejor mañana a las 2pm', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '14:00' }],
    ['perfecto', { intent: 'CONFIRMAR' }],
  ]);

  // CASO 4 — pide hora OCUPADA → ofrece 2 cercanas → elige → confirma
  DB = [];
  await run('CASO 4 — pide hora ocupada → negocia 2 cercanas', { hasHistory: false }, [
    ['hola soy Mia, corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Mia', service: 'Corte moderno', barber: 'Pepe' }],
    ['mañana a las 12', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '12:00' }],
    ['las 11 entonces', { intent: 'NUEVA_CITA', time: '11:00' }],
    ['sí', { intent: 'CONFIRMAR' }],
  ]);

  // CASO 5 — Cliente conocido reagenda → máximo 4
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  const history5 = { hasHistory: true, name: 'Carlos', activeAppointment: { appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' } };
  const r5 = await run('CASO 5 — conocido reagenda', history5, [
    ['hola', { intent: 'UNKNOWN' }],
    ['quiero reagendar', { intent: 'REAGENDAR' }],
    ['sí', { intent: 'CONFIRMAR' }],
    ['mañana a las 11', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '11:00' }],
  ]);
  console.log('   → cita en DB tras reagendar:', JSON.stringify(DB[0].start_time), '(debe ser 11:00, NO duplicada — DB len ' + DB.length + ')');
})();
