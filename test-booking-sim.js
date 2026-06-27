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
    [day3]:     ['10:00', '13:00', '14:30'],
  },
  // b2 (Pablo) NO trabaja hoy → su primer día disponible es mañana (para BUG 1/2).
  b2: { [tomorrow]: ['10:00', '12:00', '13:00'] },
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
  check('muestra la cita activa', b.session.data.lastReply.startsWith('¡Hola de nuevo, Carlos!') && b.session.data.lastReply.includes('Tienes una cita activa:'));
  check('CASO A lista el menú (🔄 Reagendar)', b.session.data.lastReply.includes('🔄 Reagendar') && b.session.data.lastReply.includes('❓ Preguntar algo'));

  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  b = await run('C4 — CON CITA ACTIVA pide otra (regla #1)', histActive, [['quiero otro corte', { intent: 'NUEVA_CITA', service: 'Corte moderno' }]]);
  check('bloquea con "una cita activa a la vez"', b.session.data.lastReply.includes('una cita activa a la vez'));

  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  b = await run('C5 — REAGENDAR con paso de confirmación (UPDATE, no duplica)', histActive, [
    ['hola', { intent: 'UNKNOWN' }],
    ['reagendar', { intent: 'REAGENDAR' }],           // → "¿La cambiamos? (sí/no)"
    ['sí', { intent: 'CONFIRMAR' }],                  // → muestra horarios
    ['el día 3 a las 1pm', { intent: 'NUEVA_CITA', date: day3, time: '13:00' }],
    ['sí', { intent: 'CONFIRMAR' }],                  // → UPDATE
  ]);
  check('reagendar pidió confirmar el cambio', b.session.state === 'idle');
  check('UPDATE: 1 fila, id ap1, día3 13:00', DB.length === 1 && DB[0].id === 'ap1' && DB[0].appointment_date === day3 && DB[0].start_time === '13:00');

  const histRec = { hasHistory: true, name: 'Loann', activeAppointment: null };
  b = await run('C6 — RECURRENTE saluda leído como PREGUNTA_GENERAL', histRec, [['hola buenas', { intent: 'PREGUNTA_GENERAL' }]]);
  check('saluda "¡Hola de nuevo, Loann!"', b.session.data.lastReply.startsWith('¡Hola de nuevo, Loann!'));
  check('CASO B lista el menú de capacidades', b.session.data.lastReply.includes('También puedo ayudarte a:'));

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

  // ── Copy del spec final ────────────────────────────────────────────────────
  DB = [];
  b = await run('C14 — Bienvenida (CASO C) con el formato del spec', { hasHistory: false }, [
    ['hola', { intent: 'UNKNOWN' }],
  ]);
  check('empieza con "¡Bienvenido a Annlo Barber!"', b.session.data.lastReply.startsWith('¡Bienvenido a *Annlo Barber*!'));
  check('incluye las 4 líneas que debe pedir', /- Tu nombre[\s\S]*- El servicio[\s\S]*- El barbero[\s\S]*- El día y hora/.test(b.session.data.lastReply));
  check('CASO C lista el menú de capacidades', b.session.data.lastReply.includes('También puedo ayudarte a:') && b.session.data.lastReply.includes('🔄 Reagendar tu cita'));

  DB = [];
  b = await run('C15 — Horarios en formato "tiene espacio / HOY — ..."', { hasHistory: false }, [
    ['soy Tom corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Tom', service: 'Corte moderno', barber: 'Pepe' }],
  ]);
  check('encabezado "tiene espacio:"', b.session.data.lastReply.includes('tiene espacio:'));
  check('día con separador "—"', /(HOY|MAÑANA|[A-ZÁÉÍÓÚ]+) — /.test(b.session.data.lastReply));

  DB = [];
  b = await run('C16 — Pregunta general (CASO C) → respuesta + seguimiento', { hasHistory: false }, [
    ['cuál es la dirección?', { intent: 'PREGUNTA_GENERAL' }],
  ]);
  check('cierra con "¿Puedo ayudarte con algo más?"', b.session.data.lastReply.includes('¿Puedo ayudarte con algo más?'));

  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  b = await run('C17 — Reagendar: primer paso pregunta "¿La cambiamos?"', histActive, [
    ['quiero reagendar', { intent: 'REAGENDAR' }],
  ]);
  check('pregunta "¿La cambiamos?"', b.session.data.lastReply.includes('¿La cambiamos?'));

  // BUG del transcript: cita activa + "hola" que Groq lee como PREGUNTA_GENERAL.
  // Antes enrutaba a askGeneral (welcome de reserva) y lo pegaba al footer de
  // CASO A → un solo mensaje mezclando "dime tu nombre" (CASO C) + "¿Algo más
  // con tu cita?" (CASO A). Ahora un saludo muestra SOLO la cita (CASO A limpio).
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  b = await run('C17b — BUG: cita activa + "hola" leído como PREGUNTA_GENERAL → CASO A limpio', histActive, [
    ['hola', { intent: 'PREGUNTA_GENERAL' }],
  ]);
  check('muestra la cita activa (CASO A)', b.session.data.lastReply.includes('Tienes una cita activa:'));
  check('NO enruta a askGeneral ni mezcla welcome', !/dime tu nombre/i.test(b.session.data.lastReply) && !b.session.data.lastReply.includes('Corte moderno cuesta'));

  // ── Bugs del transcript en vivo ────────────────────────────────────────────
  // Pablo (b2) no trabaja hoy → su primer día disponible es mañana.
  const histB2 = { hasHistory: true, name: 'Rita', activeAppointment: { appointment_date: tomorrow, start_time: '10:00', barber_id: 'b2', service_id: 's1' } };

  DB = [{ id: 'ap2', status: 'confirmed', customer_name: 'Rita', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b2', service_id: 's1' }];
  b = await run('C18 — BUG1: reschedule "1pm" sin día → primer día disponible, no hoy', histB2, [
    ['reagendar', { intent: 'REAGENDAR' }],            // ¿la cambiamos?
    ['sí', { intent: 'CONFIRMAR' }],                   // → horarios (Pablo: mañana)
    ['1pm', { intent: 'NUEVA_CITA', time: '13:00' }],  // hora SIN día
  ]);
  check('NO dice "ya pasó"', !b.session.data.lastReply.includes('ya pasó'));
  check('confirma 1:00 PM en el primer día disponible', b.session.data.lastReply.includes('1:00 PM') && b.session.data.lastReply.includes('¿Confirmo?'));

  DB = [{ id: 'ap2', status: 'confirmed', customer_name: 'Rita', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b2', service_id: 's1' }];
  b = await run('C19 — "qué horarios tienes" tras mostrarlos → NO repite el bloque', histB2, [
    ['reagendar', { intent: 'REAGENDAR' }],
    ['sí', { intent: 'CONFIRMAR' }],                      // → muestra horarios (1er bloque)
    ['qué horarios tienes', { intent: 'PREGUNTA_GENERAL' }],
  ]);
  check('responde "Ya te mostré los horarios disponibles"', b.session.data.lastReply.includes('Ya te mostré los horarios disponibles'));
  check('NO re-vuelca el bloque ("tiene espacio:")', !b.session.data.lastReply.includes('tiene espacio:'));
  check('pide día/hora específica', b.session.data.lastReply.includes('día o hora específica'));

  // Refuerzo de la regla irrompible: dos "qué horarios" seguidos nunca dan texto idéntico.
  DB = [{ id: 'ap2', status: 'confirmed', customer_name: 'Rita', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b2', service_id: 's1' }];
  {
    const bot = makeBot(histB2);
    await bot.send('reagendar', { intent: 'REAGENDAR' });
    await bot.send('sí', { intent: 'CONFIRMAR' });
    const m1 = await bot.send('qué horarios tienes', { intent: 'PREGUNTA_GENERAL' });
    const m2 = await bot.send('y qué horarios tienes', { intent: 'PREGUNTA_GENERAL' });
    check('C19b — dos consultas seguidas NO devuelven texto idéntico', m1 !== m2);
  }

  DB = [];
  b = await run('C20 — BUG3: "para el día 3 qué tienes" → lista numerada de ese día', { hasHistory: false }, [
    ['soy Gus corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Gus', service: 'Corte moderno', barber: 'Pepe' }],
    ['para el día 3 qué tienes', { intent: 'NUEVA_CITA', date: day3 }],
  ]);
  check('lista numerada (1. / 2. / 3.)', /1\. .*\n2\. .*\n3\. /.test(b.session.data.lastReply));
  check('pide "número o la hora"', b.session.data.lastReply.includes('responde el número o la hora'));
  check('encabezado con barbero (Pepe)', b.session.data.lastReply.includes('Pepe'));

  // ════════════════════════════════════════════════════════════════════════════
  // BUGS DE LA PRUEBA REAL (5) + MEJORA DE UX (recordatorio fijo de opciones)
  // ════════════════════════════════════════════════════════════════════════════

  // BUG 1 — "tengo preguntas" en CASO B → invita y espera (no pide servicio/barbero).
  console.log('\n══════════════════════════════════════════\nC21 — BUG1: "tengo preguntas" → invita y espera\n══════════════════════════════════════════');
  {
    const bot = makeBot(histRec); // CASO B (recurrente, sin cita)
    let r;
    r = await bot.send('hola', { intent: 'PREGUNTA_GENERAL' });        console.log('👤 hola\n🤖', r, '\n');
    r = await bot.send('tengo preguntas', { intent: 'PREGUNTA_GENERAL' }); console.log('👤 tengo preguntas\n🤖', r, '\n');
    check('invita "dime qué quieres saber"', r.includes('dime qué quieres saber'));
    check('NO empuja datos ("Me falta")', !r.includes('Me falta'));
    r = await bot.send('cuánto cuesta el corte', { intent: 'PREGUNTA_GENERAL' }); console.log('👤 cuánto cuesta el corte\n🤖', r, '\n');
    check('responde la pregunta de seguimiento', r.toLowerCase().includes('cuesta'));
  }

  // BUG 2 — nombre parcial de barbero: "pache" → Pacheco (startsWith).
  console.log('\n══════════════════════════════════════════\nC22 — BUG2: "pache" coincide con Pacheco\n══════════════════════════════════════════');
  {
    const bp = [{ id: 'b1', name: 'Pacheco' }, { id: 'b2', name: 'Luis' }];
    console.log('matchBarber("pache") →', (bl.matchBarber('pache', bp) || {}).name);
    check('"pache" → Pacheco', (bl.matchBarber('pache', bp) || {}).name === 'Pacheco');
    check('"pach" → Pacheco', (bl.matchBarber('pach', bp) || {}).name === 'Pacheco');
    check('"luis" sigue funcionando', (bl.matchBarber('luis', bp) || {}).name === 'Luis');
  }

  // BUG 3 — fecha inexistente "32 de junio" (2026-06-32) → la rechaza.
  DB = [];
  b = await run('C23 — BUG3: "32 de junio" (fecha inexistente) → la rechaza', { hasHistory: false }, [
    ['soy Ivo corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Ivo', service: 'Corte moderno', barber: 'Pepe' }],
    ['el 32 de junio', { intent: 'NUEVA_CITA', date: '2026-06-32' }],
  ]);
  check('responde "Esa fecha no existe"', b.session.data.lastReply.includes('Esa fecha no existe'));
  check('NO confirma ninguna cita', !b.session.data.lastReply.includes('¿Confirmo?'));
  check('isInvalidDateToken(2026-06-32)=true, (2026-06-30)=false', bl.isInvalidDateToken('2026-06-32') === true && bl.isInvalidDateToken('2026-06-30') === false);

  // BUG 4 — "quiero otra hora" creando una cita NUEVA no se va a REAGENDAR.
  DB = [];
  console.log('\n══════════════════════════════════════════\nC24 — BUG4: "quiero otra hora" creando cita NUEVA no bota al cliente\n══════════════════════════════════════════');
  {
    const bot = makeBot({ hasHistory: false });
    let r;
    r = await bot.send('soy Noa corte moderno con Pepe', { intent: 'NUEVA_CITA', name: 'Noa', service: 'Corte moderno', barber: 'Pepe' });
    console.log('👤 soy Noa corte moderno con Pepe\n🤖', r, '\n');
    r = await bot.send('no', { intent: 'NEGAR' });            console.log('👤 no\n🤖', r, '\n');
    r = await bot.send('quiero otra hora', { intent: 'REAGENDAR' }); console.log('👤 quiero otra hora\n🤖', r, '\n');
    check('NO dice "No tienes citas activas"', !r.includes('No tienes citas activas'));
    check('sigue en el flujo de creación (picking_slot)', bot.session.state === 'picking_slot');
  }

  // BUG 5 — pregunta con palabra de tiempo en CASO A → responde, no bloquea.
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  b = await run('C25 — BUG5: cita activa + "¿hasta qué hora abren los sábados?" → responde', histActive, [
    ['hasta qué hora abren los sábados?', { intent: 'PREGUNTA_GENERAL', date: 'saturday', time: '18:00' }],
  ]);
  check('NO bloquea con "una cita activa"', !b.session.data.lastReply.includes('una cita activa'));
  check('responde la pregunta (askGeneral)', b.session.data.lastReply.toLowerCase().includes('cuesta'));

  // UX — recordatorio fijo: presente en "Me falta X"; ausente en bienvenida y
  // confirmación final. (Se asierta sobre el TEXTO ENVIADO, no sobre lastReply,
  // que guarda solo el cuerpo sin el recordatorio para el anti-repetición.)
  const REM = 'Cualquier momento puedes decir';

  DB = [];
  console.log('\n══════════════════════════════════════════\nC26 — UX: "Me falta X" incluye el recordatorio fijo\n══════════════════════════════════════════');
  {
    const bot = makeBot({ hasHistory: false });
    const r = await bot.send('soy Ana corte moderno', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno' });
    console.log('👤 soy Ana corte moderno\n🤖', r, '\n');
    check('mensaje pide lo que falta (barbero)', r.includes('Me falta') || r.includes('barbero'));
    check('INCLUYE el recordatorio fijo', r.includes(REM));
  }

  DB = [];
  console.log('\n══════════════════════════════════════════\nC27 — UX: bienvenida NO lleva recordatorio (ya tiene menú)\n══════════════════════════════════════════');
  {
    const bot = makeBot({ hasHistory: false });
    const r = await bot.send('hola', { intent: 'UNKNOWN' });
    console.log('👤 hola\n🤖', r, '\n');
    check('bienvenida (CASO C) NO incluye recordatorio', !r.includes(REM));
  }

  DB = [];
  console.log('\n══════════════════════════════════════════\nC27b — UX: confirmación final "✅ ¡Listo!" NO lleva recordatorio\n══════════════════════════════════════════');
  {
    const bot = makeBot({ hasHistory: false });
    await bot.send('soy Eva corte moderno con Pepe mañana a las 10', { intent: 'NUEVA_CITA', name: 'Eva', service: 'Corte moderno', barber: 'Pepe', date: 'tomorrow', time: '10:00' });
    const r = await bot.send('sí', { intent: 'CONFIRMAR' });
    console.log('👤 sí\n🤖', r, '\n');
    check('confirmación final empieza con "✅ ¡Listo"', r.startsWith('✅ ¡Listo'));
    check('confirmación final NO incluye recordatorio', !r.includes(REM));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // BUGS DE LA PRUEBA REAL #2 (CSV Twilio 2026-06-19) — reagendar: pidió LUNES y
  // se quedaba en SÁBADO. Tres fixes: día con día+hora, corrección en confirming,
  // y hora suelta que no reinicia. (Groq mockeado YA devuelve la fecha YYYY-MM-DD
  // absoluta, que es lo que el FIX del prompt garantiza en producción.)
  // ════════════════════════════════════════════════════════════════════════════

  // C28 — FIX1: "para el lunes a la 1pm" reagendando → confirma DAY3, NO el 1er día.
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  b = await run('C28 — FIX1: día+hora reagendando confirma el DÍA pedido (no el primero)', histActive, [
    ['reagendar', { intent: 'REAGENDAR' }],
    ['sí', { intent: 'CONFIRMAR' }],
    ['lo quiero para el lunes a la 1pm', { intent: 'REAGENDAR', date: day3, time: '13:00' }],
  ]);
  check('confirma en el día pedido (day3) a la 1:00 PM', b.session.data.lastReply.includes(bl.formatDate(day3)) && b.session.data.lastReply.includes('1:00 PM') && b.session.data.lastReply.includes('¿Confirmo?'));
  check('NO cayó en hoy (el bug original lo mandaba al 1er día)', !b.session.data.lastReply.includes(bl.formatDate(today)));

  // C29 — FIX1B: hora SIN día y varios días con cupo → pregunta "¿para qué día?",
  // nunca asume; al responder el día, confirma esa hora en ese día.
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  console.log('\n══════════════════════════════════════════\nC29 — FIX1B: hora sin día (varios días) → pregunta el día, no asume\n══════════════════════════════════════════');
  {
    const bot = makeBot(histActive);
    await bot.send('reagendar', { intent: 'REAGENDAR' });
    await bot.send('sí', { intent: 'CONFIRMAR' });
    let r = await bot.send('a las 10', { intent: 'REAGENDAR', time: '10:00' });
    console.log('👤 a las 10\n🤖', r, '\n');
    check('pregunta "¿Para qué día?"', r.includes('¿Para qué día'));
    check('NO confirma a ciegas', !r.includes('¿Confirmo?'));
    r = await bot.send('el lunes', { intent: 'REAGENDAR', date: day3 });
    console.log('👤 el lunes\n🤖', r, '\n');
    check('tras elegir el día confirma day3 a las 10:00 AM', r.includes(bl.formatDate(day3)) && r.includes('10:00 AM') && r.includes('¿Confirmo?'));
  }

  // C30 — FIX2: en confirming, "el lunes" (día distinto) es una CORRECCIÓN, no se
  // ignora; re-verifica ese día y vuelve a confirmar. (CSV: "Lunes" se ignoraba.)
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  console.log('\n══════════════════════════════════════════\nC30 — FIX2: corrección de día en confirming (no la ignora)\n══════════════════════════════════════════');
  {
    const bot = makeBot(histActive);
    await bot.send('reagendar', { intent: 'REAGENDAR' });
    await bot.send('sí', { intent: 'CONFIRMAR' });
    let r = await bot.send('mañana a las 10', { intent: 'REAGENDAR', date: tomorrow, time: '10:00' });
    console.log('👤 mañana a las 10\n🤖', r, '\n');
    check('confirmando mañana 10:00 AM', r.includes(bl.formatDate(tomorrow)) && r.includes('10:00 AM') && r.includes('¿Confirmo?'));
    r = await bot.send('el lunes', { intent: 'REAGENDAR', date: day3 });
    console.log('👤 el lunes\n🤖', r, '\n');
    check('acepta la corrección → confirma day3 10:00 AM', r.includes(bl.formatDate(day3)) && r.includes('10:00 AM') && r.includes('¿Confirmo?'));
    check('ya NO confirma mañana', !r.includes(bl.formatDate(tomorrow)));
  }

  // C31 — FIX3: durante rescheduling, una hora suelta que Groq lee como REAGENDAR
  // NO reinicia el flujo; usa el día en contexto. (CSV: "2:30" volvía a "¿La cambiamos?")
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  console.log('\n══════════════════════════════════════════\nC31 — FIX3: hora suelta en rescheduling no reinicia\n══════════════════════════════════════════');
  {
    const bot = makeBot(histActive);
    await bot.send('reagendar', { intent: 'REAGENDAR' });
    await bot.send('sí', { intent: 'CONFIRMAR' });
    await bot.send('mañana a la 1pm', { intent: 'REAGENDAR', date: tomorrow, time: '13:00' }); // ocupada → acota a mañana
    let r = await bot.send('2pm', { intent: 'REAGENDAR', time: '14:00' });
    console.log('👤 2pm\n🤖', r, '\n');
    check('NO reinicia ("¿La cambiamos?" ausente)', !r.includes('¿La cambiamos?'));
    check('usa el día en contexto (mañana) y confirma 2:00 PM', r.includes(bl.formatDate(tomorrow)) && r.includes('2:00 PM') && r.includes('¿Confirmo?'));
  }

  // C32 — BUG transcript en vivo: Groq NO extrae un barbero suelto ("pacheco") y
  // el bot se quedaba pegado en "Todavía me falta el barbero". La red de seguridad
  // determinista (recoverSingleWord) lo rescata aunque understood.barber sea null.
  console.log('\n══════════════════════════════════════════\nC32 — BUG: barbero suelto que Groq no extrajo (understood.barber=null)\n══════════════════════════════════════════');
  {
    const bp = [{ id: 'b1', name: 'Pepe' }, { id: 'b2', name: 'Pablo' }, { id: 'b3', name: 'Pacheco' }];
    const AV = { b3: { [tomorrow]: ['10:00', '11:00'] } };
    const dayAvail = async (id, date) => {
      const set = new Set((AV[id] || {})[date] || []);
      const all = genSlots('10:00', '19:00');
      return { closed: false, open: '10:00', close: '19:00', available: all.filter(s => set.has(s)), booked: all.filter(s => !set.has(s)) };
    };
    const upcoming = async (id) => { const s = (AV[id] || {})[tomorrow] || []; return s.length ? [{ date: tomorrow, slots: s.slice(0, 2) }] : []; };
    const session = { state: 'idle', data: {} };
    const ctx = { business, services, barbers: bp, bookingLink, history: { hasHistory: true, name: 'Loann', activeAppointment: null }, phone: '+17875551234' };
    const deps = { ...makeDeps(), getDayAvailability: dayAvail, getUpcoming: upcoming, getSlots: async (id, d) => (await dayAvail(id, d)).available };
    const send = (msg, u) => bl.respond({ session, msg, understood: u || { intent: 'UNKNOWN' }, ctx, deps });
    let r;
    r = await send('quiero agendar una cita', { intent: 'NUEVA_CITA' });        console.log('👤 quiero agendar una cita\n🤖', r, '\n');
    r = await send('dame el corte moderno', { intent: 'NUEVA_CITA', service: 'Corte moderno' }); console.log('👤 dame el corte moderno\n🤖', r, '\n');
    check('tras el servicio pide el barbero', r.includes('barbero'));
    // Groq falla aquí: barber:null pese a que "pacheco" está en la lista
    r = await send('pacheco', { intent: 'NUEVA_CITA', barber: null });           console.log('👤 pacheco\n🤖', r, '\n');
    check('NO se queda pegado en "me falta el barbero"', !/falta.*barbero/i.test(r));
    check('avanza a ofrecer horarios de Pacheco', r.includes('Pacheco') && (session.state === 'picking_slot' || r.includes('tiene espacio')));
    // matchStrict directo: rescata "pacheco" pero NO falsos positivos
    check('matchStrict("pacheco") → Pacheco', (bl.matchStrict('pacheco', bp) || {}).name === 'Pacheco');
    check('matchStrict("nada") → null (no falso positivo por includes)', bl.matchStrict('nada', bp) === null);
  }

  // C33 — FIX1: el slot se ocupó entre mostrar y confirmar (commitCreate → 23505).
  // El bot NO dice "no pude guardar"; re-ofrece horarios conservando barbero/servicio.
  DB = [];
  console.log('\n══════════════════════════════════════════\nC33 — FIX1: carrera perdida (23505) → re-ofrece, no error seco\n══════════════════════════════════════════');
  {
    const session = { state: 'idle', data: {} };
    const deps = { ...makeDeps(), commitCreate: async () => ({ ok: false, reason: 'taken' }) };
    const ctx = { business, services, barbers, bookingLink, history: { hasHistory: false }, phone: '+17875551234' };
    const send = (msg, u) => bl.respond({ session, msg, understood: u || { intent: 'UNKNOWN' }, ctx, deps });
    let r = await send('soy Zoe corte moderno con Pepe mañana a las 10', { intent: 'NUEVA_CITA', name: 'Zoe', service: 'Corte moderno', barber: 'Pepe', date: 'tomorrow', time: '10:00' });
    console.log('👤 soy Zoe ... mañana a las 10\n🤖', r, '\n');
    r = await send('sí', { intent: 'CONFIRMAR' });
    console.log('👤 sí\n🤖', r, '\n');
    check('NO dice "no pude guardar"', !r.includes('no pude guardar'));
    check('avisa que el turno se tomó', r.includes('acaba de tomar'));
    check('re-ofrece horarios y vuelve a picking_slot', r.includes('tiene espacio') && session.state === 'picking_slot');
    check('conserva barbero/servicio (bk intacto)', session.data.bk && session.data.bk.barberId === 'b1' && session.data.bk.serviceId === 's1');
  }

  console.log('\n══════════════════════════════════════════');
  console.log(FAILED === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${FAILED} CHECK(S) FALLARON`);
  process.exit(FAILED === 0 ? 0 : 1);
})();
