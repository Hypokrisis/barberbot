// Simulación offline del motor SIMPLIFICADO (booking-logic.respond).
// Groq (understood), disponibilidad y commits están mockeados.
// Modelo nuevo: SOLO hoy y mañana por chat; cualquier otra fecha → link y fin.
// Run: node test-booking-sim.js
const bl = require('./booking-logic');

const business = { name: 'Annlo Barber', slug: 'annlobarberia' };
const bookingLink = 'https://spaceyreserve.netlify.app/book/annlobarberia';
const services = [
  { id: 's1', name: 'Corte moderno', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 24, duration_minutes: 20 },
];
const barbers = [{ id: 'b1', name: 'Pepe' }, { id: 'b2', name: 'Pablo' }, { id: 'b3', name: 'Pacheco' }];

const today = bl.todayPR();
const addDays = (n) => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };
const tomorrow = addDays(1);
const nextWeek = addDays(7); // fecha "lejana" para probar el corte al link

// ── Mock de horarios + disponibilidad (ventana 10:00–19:00) ───────────────────
function windowFor() { return { open: '10:00', close: '19:00' }; }
const AVAILABLE = {
  b1: { [today]: ['15:00', '16:30', '17:00', '18:00'], [tomorrow]: ['10:00', '11:00', '14:00', '18:00'] },
  b2: { [tomorrow]: ['10:00', '12:00', '13:00'] },
  b3: { [today]: ['15:00', '16:00', '17:00'],          [tomorrow]: ['10:00', '11:00', '12:00'] },
};
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function genSlots(open, close) {
  const out = []; let [sh, sm] = open.split(':').map(Number); const end = toMin(close);
  while (sh * 60 + sm + 30 <= end) { out.push(`${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`); sm += 30; if (sm >= 60) { sh++; sm -= 60; } }
  return out;
}
async function getDayAvailability(barberId, date) {
  const win = windowFor();
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
async function getUpcoming() { return []; } // ya no lo usa el motor; stub por compatibilidad

let DB = [];
function makeDeps(over = {}) {
  return {
    getSlots, getDayAvailability, checkSlot, getUpcoming,
    getActiveAppointments: async () => DB.filter(a => a.status === 'confirmed' && a.appointment_date >= today)
      .sort((a, b) => (a.appointment_date < b.appointment_date ? -1 : 1)),
    commitCreate: async (bk) => { DB.push({ id: 'new' + DB.length, status: 'confirmed', customer_name: bk.name, appointment_date: bk.date, start_time: bk.startTime, barber_id: bk.barberId, service_id: bk.serviceId }); return { ok: true }; },
    commitReschedule: async (id, date, time) => { const a = DB.find(x => x.id === id); if (a) { a.appointment_date = date; a.start_time = time; } return { ok: true }; },
    commitCancel: async (id) => { const a = DB.find(x => x.id === id); if (a) a.status = 'cancelled'; return { ok: true }; },
    askGeneral: async () => 'El Corte moderno cuesta $25 y la Barba $24 🙂',
    ...over,
  };
}
function makeBot(history, depsOver) {
  const session = { state: 'idle', data: {} };
  const deps = makeDeps(depsOver);
  return {
    session,
    send: (msg, u) => bl.respond({ session, msg, understood: u || { intent: 'UNKNOWN' }, ctx: { business, services, barbers, bookingLink, history: history || { hasHistory: false }, phone: '+17875551234' }, deps }),
  };
}

let FAILED = 0;
function check(label, cond) { console.log(`   ${cond ? '✅' : '❌'} ${label}`); if (!cond) FAILED++; }
function banner(t) { console.log('\n══════════════════════════════════════════\n' + t + '\n══════════════════════════════════════════'); }

(async () => {
  // ════════════════════════════════════════════════════════════════════════════
  // 5 ESCENARIOS DE VERIFICACIÓN (diálogos completos)
  // ════════════════════════════════════════════════════════════════════════════

  // V1 — "Quiero cita, soy Loann, corte con Pacheco, hoy" → horarios de hoy → elige → confirma → listo
  banner('V1 — Cita hoy de punta a punta (nombre+servicio+barbero+hoy)');
  DB = [];
  {
    const bot = makeBot({ hasHistory: false });
    let r;
    r = await bot.send('Quiero cita, soy Loann, corte con Pacheco, hoy',
      { intent: 'NUEVA_CITA', name: 'Loann', service: 'Corte moderno', barber: 'Pacheco', date: 'today' });
    console.log('👤 Quiero cita, soy Loann, corte con Pacheco, hoy\n🤖', r, '\n');
    check('muestra horarios de HOY numerados', r.includes('HOY') && /1\. /.test(r) && r.includes('elige tu horario'));
    check('NO muestra MAÑANA (pidió hoy)', !r.includes('MAÑANA'));
    r = await bot.send('1', { intent: 'NUEVA_CITA', choice: 1 });
    console.log('👤 1\n🤖', r, '\n');
    check('pide confirmación con resumen', r.includes('¿Confirmo? (sí/no)') && r.includes('Pacheco'));
    r = await bot.send('sí', { intent: 'CONFIRMAR' });
    console.log('👤 sí\n🤖', r, '\n');
    check('crea la cita en DB', DB.length === 1 && DB[0].status === 'confirmed');
    check('mensaje final PASO 4 (✅ + reagendar/cancelar)', r.startsWith('✅ ¡Listo, Loann!') && r.includes('🔄 Reagendar · ❌ Cancelar'));
    check('vuelve a idle', bot.session.state === 'idle');
  }

  // V2 — Cliente pide una fecha de la semana que viene → link y la sesión TERMINA
  banner('V2 — Fecha lejana (semana que viene) → link y fin limpio');
  DB = [];
  {
    const bot = makeBot({ hasHistory: false });
    const r = await bot.send('soy Ana, corte con Pepe, el martes que viene',
      { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno', barber: 'Pepe', date: nextWeek });
    console.log('👤 soy Ana, corte con Pepe, el martes que viene\n🤖', r, '\n');
    check('responde con el mensaje del link', r.includes('mira la disponibilidad y reserva aquí') && r.includes(bookingLink));
    check('NO crea cita', DB.length === 0);
    check('sesión termina en idle', bot.session.state === 'idle');
  }

  // V3 — "horarios" → muestra HOY y MAÑANA juntos
  banner('V3 — "horarios" → muestra hoy y mañana juntos');
  DB = [];
  {
    const bot = makeBot({ hasHistory: false });
    let r = await bot.send('soy Tom, corte con Pepe', { intent: 'NUEVA_CITA', name: 'Tom', service: 'Corte moderno', barber: 'Pepe' });
    console.log('👤 soy Tom, corte con Pepe\n🤖', r, '\n');
    check('sin fecha → ya muestra HOY y MAÑANA', r.includes('HOY') && r.includes('MAÑANA'));
    r = await bot.send('horarios', { intent: 'PREGUNTA_GENERAL' });
    console.log('👤 horarios\n🤖', r, '\n');
    check('"horarios" muestra HOY y MAÑANA juntos', r.includes('HOY') && r.includes('MAÑANA') && r.includes('elige tu horario'));
  }

  // V4 — Reagendar con la misma regla hoy/mañana
  banner('V4 — Reagendar: solo hoy/mañana (y fecha lejana → link)');
  const histActive = { hasHistory: true, name: 'Carlos', activeAppointment: { appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' } };
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  {
    const bot = makeBot(histActive);
    let r = await bot.send('reagendar', { intent: 'REAGENDAR' });
    console.log('👤 reagendar\n🤖', r, '\n');
    check('pregunta "¿La cambiamos?"', r.includes('¿La cambiamos?'));
    r = await bot.send('sí', { intent: 'CONFIRMAR' });
    console.log('👤 sí\n🤖', r, '\n');
    check('ofrece SOLO hoy/mañana', r.includes('HOY') && r.includes('MAÑANA') && r.includes('elige tu horario'));
    // fecha lejana durante el reagendado → link
    let rFar = await bot.send('mejor el viernes que viene', { intent: 'REAGENDAR', date: nextWeek });
    console.log('👤 mejor el viernes que viene\n🤖', rFar, '\n');
    check('fecha lejana al reagendar → link', rFar.includes('mira la disponibilidad y reserva aquí'));
  }
  // Reagendado exitoso a mañana
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  {
    const bot = makeBot(histActive);
    await bot.send('reagendar', { intent: 'REAGENDAR' });
    await bot.send('sí', { intent: 'CONFIRMAR' });
    let r = await bot.send('mañana a las 11', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '11:00' });
    console.log('👤 mañana a las 11\n🤖', r, '\n');
    check('confirma mañana 11:00 AM', r.includes('11:00 AM') && r.includes('¿Confirmo? (sí/no)'));
    r = await bot.send('sí', { intent: 'CONFIRMAR' });
    console.log('👤 sí\n🤖', r, '\n');
    check('UPDATE: 1 fila, mañana 11:00', DB.length === 1 && DB[0].id === 'ap1' && DB[0].appointment_date === tomorrow && DB[0].start_time === '11:00');
    check('mensaje final PASO 4', r.startsWith('✅ ¡Listo') && r.includes('🔄 Reagendar · ❌ Cancelar'));
  }

  // V5 — Cliente con cita activa escribe CUALQUIER cosa → siempre reagendar/cancelar
  banner('V5 — Cita activa: cualquier mensaje → siempre reagendar/cancelar');
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  {
    const bot = makeBot(histActive);
    for (const [m, u] of [
      ['hola', { intent: 'UNKNOWN' }],
      ['cuánto cuesta el corte?', { intent: 'PREGUNTA_GENERAL' }],
      ['quiero otra cita nueva', { intent: 'NUEVA_CITA', service: 'Corte moderno' }],
    ]) {
      const r = await bot.send(m, u);
      console.log('👤', m, '\n🤖', r, '\n');
      check(`"${m}" → muestra la cita + reagendar/cancelar`, r.includes('Tienes una cita activa') && r.includes('*reagendar*') && r.includes('*cancelar*'));
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // REGRESIÓN — garantías que NO deben romperse
  // ════════════════════════════════════════════════════════════════════════════

  // R1 — Cancelar por WhatsApp
  banner('R1 — Cancelar: confirma y marca cancelled');
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  {
    const bot = makeBot(histActive);
    let r = await bot.send('cancelar', { intent: 'CANCELAR' });
    console.log('👤 cancelar\n🤖', r, '\n');
    check('pide confirmación de cancelación', r.includes('¿Seguro que quieres cancelar?'));
    r = await bot.send('sí', { intent: 'CONFIRMAR' });
    console.log('👤 sí\n🤖', r, '\n');
    check('marca la cita cancelled', DB[0].status === 'cancelled');
    check('mensaje de cancelada', r.includes('Cita cancelada'));
  }

  // R2 — Carrera perdida al CREAR (23505) → re-ofrece hoy/mañana, no error seco
  banner('R2 — Carrera al crear (23505) → re-ofrece, no error seco');
  DB = [];
  {
    const bot = makeBot({ hasHistory: false }, { commitCreate: async () => ({ ok: false, reason: 'taken' }) });
    await bot.send('soy Zoe corte con Pepe hoy', { intent: 'NUEVA_CITA', name: 'Zoe', service: 'Corte moderno', barber: 'Pepe', date: 'today' });
    await bot.send('1', { intent: 'NUEVA_CITA', choice: 1 });
    const r = await bot.send('sí', { intent: 'CONFIRMAR' });
    console.log('🤖', r, '\n');
    check('NO dice "no pude guardar"', !r.includes('no pude guardar'));
    check('avisa que se tomó y re-ofrece', r.includes('acaba de tomar') && r.includes('elige tu horario'));
    check('conserva bk y vuelve a picking_slot', bot.session.state === 'picking_slot' && bot.session.data.bk.barberId === 'b1');
  }

  // R3 — Carrera perdida al REAGENDAR (23505) → re-ofrece, conserva la cita
  banner('R3 — Carrera al reagendar (23505) → re-ofrece, conserva apptId');
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Carlos', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  {
    const bot = makeBot(histActive, { commitReschedule: async () => ({ ok: false, reason: 'taken' }) });
    await bot.send('reagendar', { intent: 'REAGENDAR' });
    await bot.send('sí', { intent: 'CONFIRMAR' });
    await bot.send('mañana a las 11', { intent: 'NUEVA_CITA', date: 'tomorrow', time: '11:00' });
    const r = await bot.send('sí', { intent: 'CONFIRMAR' });
    console.log('🤖', r, '\n');
    check('NO dice "error al reagendar"', !r.includes('error al reagendar'));
    check('re-ofrece y conserva apptId', r.includes('elige tu horario') && bot.session.state === 'rescheduling' && bot.session.data.reschedule.apptId === 'ap1');
  }

  // R4 — REGLA #1: aparece cita activa a mitad → al confirmar NO crea 2ª
  banner('R4 — Cita activa que aparece a mitad → no crea 2ª (REGLA #1)');
  DB = [];
  {
    const bot = makeBot({ hasHistory: false });
    await bot.send('soy Ivy corte con Pepe hoy', { intent: 'NUEVA_CITA', name: 'Ivy', service: 'Corte moderno', barber: 'Pepe', date: 'today' });
    await bot.send('1', { intent: 'NUEVA_CITA', choice: 1 });
    DB.push({ id: 'web1', status: 'confirmed', customer_name: 'Ivy', appointment_date: tomorrow, start_time: '14:00', barber_id: 'b1', service_id: 's1' });
    const r = await bot.send('sí', { intent: 'CONFIRMAR' });
    console.log('🤖', r, '\n');
    check('bloquea con "una a la vez"', r.includes('una a la vez'));
    check('NO crea 2ª cita (sigue 1 en DB)', DB.length === 1);
  }

  // R5 — Hora fuera de la lista de hoy/mañana → link
  banner('R5 — Hora que no está en la lista → link');
  DB = [];
  {
    const bot = makeBot({ hasHistory: false });
    await bot.send('soy Leo corte con Pepe hoy', { intent: 'NUEVA_CITA', name: 'Leo', service: 'Corte moderno', barber: 'Pepe', date: 'today' });
    const r = await bot.send('a las 9pm', { intent: 'NUEVA_CITA', time: '21:00' });
    console.log('👤 a las 9pm\n🤖', r, '\n');
    check('hora fuera de la lista → link', r.includes('mira la disponibilidad y reserva aquí'));
  }

  // R6 — Fecha inexistente ("32 de junio") → link (ya no "no existe")
  banner('R6 — Fecha inexistente → link');
  DB = [];
  {
    const bot = makeBot({ hasHistory: false });
    const r = await bot.send('soy Ivo corte con Pepe el 32 de junio', { intent: 'NUEVA_CITA', name: 'Ivo', service: 'Corte moderno', barber: 'Pepe', date: '2026-06-32' });
    console.log('👤 ... el 32 de junio\n🤖', r, '\n');
    check('fecha inexistente → link', r.includes('mira la disponibilidad y reserva aquí'));
  }

  // R7 — Recolección parcial sigue funcionando (pide lo que falta)
  banner('R7 — Recolección: pide solo lo que falta');
  DB = [];
  {
    const bot = makeBot({ hasHistory: false });
    const r = await bot.send('soy Ana, corte moderno', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno' });
    console.log('👤 soy Ana, corte moderno\n🤖', r, '\n');
    check('pide el barbero que falta', r.includes('Me falta') && r.includes('barbero'));
  }

  console.log('\n══════════════════════════════════════════');
  console.log(FAILED === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${FAILED} CHECK(S) FALLARON`);
  process.exit(FAILED === 0 ? 0 : 1);
})();
