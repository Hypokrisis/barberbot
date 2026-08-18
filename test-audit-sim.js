// Simulación de auditoria completa — Partes 1 y 2
// node test-audit-sim.js
const bl = require('./booking-logic');
const tomorrow = bl.tomorrowStr();
const today = bl.todayPR();

const services = [
  { id: 's1', name: 'Corte moderno', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 20, duration_minutes: 20 },
];
const barbers = [
  { id: 'b1', name: 'Loann' },
  { id: 'b2', name: 'Javier' },
  { id: 'b3', name: 'Pacheco' },
];

let DB = [];

// makeDeps ahora toma phone para aislar getActiveAppointments por teléfono,
// igual que hace el código real (filter por customer_phone + business_id).
function makeDeps(over, phone) {
  over = over || {};
  return {
    getSlots: async () => ['10:00','10:30','11:00','12:00'],
    getDayAvailability: async () => ({
      closed: false, open: '09:00', close: '18:00',
      available: ['10:00','10:30','11:00','12:00'], booked: []
    }),
    checkSlot: async (bid, date, time) => ({
      status: ['10:00','10:30','11:00','12:00'].includes(time) ? 'available' : 'outside_hours',
      open: '09:00', close: '18:00', available: ['10:00','10:30','11:00','12:00']
    }),
    getUpcoming: async () => [],
    getActiveAppointments: async () => DB.filter(a =>
      a.status === 'confirmed' &&
      a.appointment_date >= today &&
      (!phone || a.customer_phone === phone)
    ),
    commitCreate: async (bk) => {
      DB.push({ id: 'a' + DB.length, status: 'confirmed', customer_name: bk.name, customer_phone: phone || 'unknown', appointment_date: bk.date, start_time: bk.startTime, barber_id: bk.barberId, service_id: bk.serviceId });
      return { ok: true };
    },
    commitReschedule: async (id, date, time) => {
      const a = DB.find(x => x.id === id);
      if (a) { a.appointment_date = date; a.start_time = time; }
      return { ok: true };
    },
    commitCancel: async (id) => {
      const a = DB.find(x => x.id === id);
      if (a) a.status = 'cancelled';
      return { ok: true };
    },
    askGeneral: async () => 'El Corte moderno cuesta $25.',
    ...over,
  };
}

function makeBot(history, phone, depsOver) {
  phone = phone || '+17875551234';
  const session = { state: 'idle', data: {} };
  const deps = makeDeps(depsOver || {}, phone);
  return {
    session,
    send: function(msg, u) {
      return bl.respond({
        session,
        msg,
        understood: u || { intent: 'UNKNOWN' },
        ctx: { business: { name: 'TestBarbería' }, services, barbers, bookingLink: 'https://link.test', history: history || { hasHistory: false }, phone },
        deps,
      });
    },
  };
}

let FAIL = 0;
function check(label, cond, detail) {
  var icon = cond ? '  ✅' : '  ❌';
  var d = detail ? ' [' + detail + ']' : '';
  console.log(icon + ' ' + label + d);
  if (!cond) FAIL++;
}
function sec(t) { console.log('\n--- ' + t); }

(async function() {
  // ═══ PARTE 1: IDENTIDAD ═══
  console.log('\n═══ PARTE 1: IDENTIDAD ═══');

  // P1.1 — Cliente cuyo nombre = nombre de barbero
  sec('P1.1 — Nombre cliente = barbero ("soy Pacheco, corte moderno")');
  DB = [];
  {
    var bot = makeBot({ hasHistory: false });
    // Groq trata "Pacheco" como nombre, no barbero
    var r = await bot.send('soy Pacheco, quiero el corte moderno',
      { intent: 'NUEVA_CITA', name: 'Pacheco', service: 'Corte moderno', barber: null, date: null, time: null });
    var bk = bot.session.data.bk || {};
    check('P1.1a: name=Pacheco (nombre del cliente)', bk.name === 'Pacheco');
    check('P1.1b: barberId=b3 (Pacheco barbero, via recoverFromRawMessage)', bk.barberId === 'b3');
    check('P1.1c: serviceId=s1 (Corte moderno)', bk.serviceId === 's1');
    check('P1.1d: va a horarios (tiene name+service+barber)', r.includes('elige tu horario'));
  }

  // P1.2 — Multi-palabra, Groq devuelve null para todo
  // Escenario: cliente recurrente (CASO B), Groq no extrae nada. El sistema
  // pre-llena bk.name del historial y recoverFromRawMessage rescata service+barber.
  sec('P1.2 — Multi-palabra, Groq null → pre-fill historial + recoverFromRawMessage rescata');
  DB = [];
  {
    var bot = makeBot({ hasHistory: true, name: 'Loann Javier', activeAppointment: null });
    var r = await bot.send('quiero el corte moderno con Pacheco',
      { intent: 'NUEVA_CITA', name: null, service: null, barber: null, date: null, time: null });
    var bk = bot.session.data.bk || {};
    check('P1.2a: service=Corte moderno (substring match)', bk.serviceId === 's1');
    check('P1.2b: barber=Pacheco (word match, post name+service)', bk.barberId === 'b3');
    check('P1.2c: name=Loann Javier (del historial)', bk.name === 'Loann Javier');
    check('P1.2d: va a horarios sin pedir nada más', r.includes('elige tu horario'));
  }

  // P1.3 — Nombre compuesto coincide con 2 barberos
  sec('P1.3 — Nombre "Loann Javier" (= 2 barberos) se maneja sin falso positivo');
  DB = [];
  {
    // Caso A: cliente da nombre+barber explícito → correcto
    var bot = makeBot({ hasHistory: false });
    var r = await bot.send('soy Loann Javier, corte con Loann',
      { intent: 'NUEVA_CITA', name: 'Loann Javier', service: 'Corte moderno', barber: 'Loann', date: null, time: null });
    var bk = bot.session.data.bk || {};
    check('P1.3a: name=Loann Javier (nombre del cliente)', bk.name === 'Loann Javier');
    check('P1.3b: barber=Loann (b1, no confundido)', bk.barberId === 'b1');

    // Caso B: cliente solo da su nombre — recoverFromRawMessage NO debe confundirlo con barbero
    // Gate: solo escanea barber cuando name+serviceId ya están seteados. Sin service → skip.
    var bot2 = makeBot({ hasHistory: false });
    await bot2.send('soy Loann Javier',
      { intent: 'NUEVA_CITA', name: 'Loann Javier', service: null, barber: null, date: null, time: null });
    var bk2 = bot2.session.data.bk || {};
    var falsePos = bk2.barberId === 'b1' || bk2.barberId === 'b2';
    check('P1.3c: ⚠️ NO setea barbero del nombre del cliente', !falsePos,
      falsePos ? 'FALSO POSITIVO: barberId=' + bk2.barberId + ' seteado del nombre' : 'ok');
    check('P1.3d: name=Loann Javier está seteado', bk2.name === 'Loann Javier');
  }

  // P1.4 — Dos clientes mismo nombre, distinto teléfono
  // Cada bot tiene su propio phone → getActiveAppointments filtra por phone →
  // las citas están aisladas, REGLA #1 no se dispara cruzado.
  sec('P1.4 — 2 clientes mismo nombre, distinto teléfono → citas aisladas');
  DB = [];
  {
    var botA = makeBot({ hasHistory: false }, '+17875551111');
    var botB = makeBot({ hasHistory: false }, '+17875552222');
    await botA.send('soy Ana, corte moderno con Pacheco', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno', barber: 'Pacheco' });
    await botA.send('mañana a las 10', { intent: 'NUEVA_CITA', date: tomorrow, time: '10:00' });
    await botA.send('sí', { intent: 'CONFIRMAR' });
    await botB.send('soy Ana, corte moderno con Javier', { intent: 'NUEVA_CITA', name: 'Ana', service: 'Corte moderno', barber: 'Javier' });
    await botB.send('mañana a las 12', { intent: 'NUEVA_CITA', date: tomorrow, time: '12:00' });
    await botB.send('sí', { intent: 'CONFIRMAR' });
    check('P1.4a: 2 citas creadas (sin cross-REGLA#1)', DB.length === 2, 'DB.length=' + DB.length);
    check('P1.4b: cita A con Pacheco (b3)', DB[0] && DB[0].barber_id === 'b3');
    check('P1.4c: cita B con Javier (b2)', DB[1] && DB[1].barber_id === 'b2');
    check('P1.4d: sesión A independiente de B', botA.session !== botB.session);
  }

  // P1.5 — Mismo teléfono, 2 negocios distintos
  // P1.5b: Barbería B tiene 1 solo barbero (Carlos) → auto-set es correcto.
  // El check es que NO carga datos de Barbería A (bk.barberId no es b3 = Pacheco de A).
  sec('P1.5 — Mismo teléfono en 2 negocios → sesiones aisladas por business_id');
  DB = [];
  {
    var phone = '+17875559999';
    var ctx1 = { business: { name: 'Barbería A' }, services, barbers, bookingLink: 'https://a.test', history: { hasHistory: false }, phone };
    var barsB = [{ id: 'bx1', name: 'Carlos' }];
    var svcsB = [{ id: 'sx1', name: 'Corte clasico', price: 15, duration_minutes: 30 }];
    var ctx2 = { business: { name: 'Barbería B' }, services: svcsB, barbers: barsB, bookingLink: 'https://b.test', history: { hasHistory: false }, phone };
    var sess1 = { state: 'idle', data: {} };
    var sess2 = { state: 'idle', data: {} };
    var deps1 = makeDeps({}, phone);
    var deps2 = makeDeps({}, phone);

    await bl.respond({ session: sess1, msg: 'soy Pedro corte con Pacheco', understood: { intent: 'NUEVA_CITA', name: 'Pedro', service: 'Corte moderno', barber: 'Pacheco' }, ctx: ctx1, deps: deps1 });
    await bl.respond({ session: sess2, msg: 'soy Pedro', understood: { intent: 'NUEVA_CITA', name: 'Pedro', service: null, barber: null }, ctx: ctx2, deps: deps2 });

    var bk2b = sess2.data.bk || {};
    check('P1.5a: sesión A tiene barberId=b3 (Pacheco)', sess1.data.bk && sess1.data.bk.barberId === 'b3');
    // B auto-setea a Carlos (único barbero) — correcto. Solo verificamos que NO tiene datos de A (b3=Pacheco).
    check('P1.5b: sesión B NO contiene datos de A (barberId≠b3)', !bk2b.barberId || bk2b.barberId !== 'b3');
    check('P1.5c: sesiones son objetos distintos en memoria', sess1 !== sess2);
  }

  // ═══ PARTE 2: CONCURRENCIA ═══
  console.log('\n═══ PARTE 2: CONCURRENCIA ═══');

  // P2.1 — Dos clientes piden el mismo slot
  // Cada bot tiene su propio phone → getActiveAppointments aislado → REGLA #1 no
  // se dispara cruzado. El segundo commitCreate retorna {ok:false, reason:'taken'}.
  sec('P2.1 — Slot tomado al mismo tiempo → carrera perdida maneja bien');
  DB = [];
  {
    var phoneA = '+1A', phoneB = '+1B';
    var taken = 0;
    // commitCreate por bot — el primero inserta con su phone, el segundo retorna taken
    var makeRaceCreate = function(ph) {
      return async function(bk) {
        taken++;
        if (taken === 1) {
          DB.push({ id: 'a0', status: 'confirmed', customer_name: bk.name, customer_phone: ph, appointment_date: bk.date, start_time: bk.startTime, barber_id: bk.barberId, service_id: bk.serviceId });
          return { ok: true };
        }
        return { ok: false, reason: 'taken' };
      };
    };
    var botA = makeBot({ hasHistory: false }, phoneA, { commitCreate: makeRaceCreate(phoneA) });
    var botB = makeBot({ hasHistory: false }, phoneB, { commitCreate: makeRaceCreate(phoneB) });
    await botA.send('soy Mario corte Pacheco', { intent: 'NUEVA_CITA', name: 'Mario', service: 'Corte moderno', barber: 'Pacheco' });
    await botA.send('mañana a las 10', { intent: 'NUEVA_CITA', date: tomorrow, time: '10:00' });
    await botB.send('soy Luis corte Pacheco', { intent: 'NUEVA_CITA', name: 'Luis', service: 'Corte moderno', barber: 'Pacheco' });
    await botB.send('mañana a las 10', { intent: 'NUEVA_CITA', date: tomorrow, time: '10:00' });
    var rA = await botA.send('sí', { intent: 'CONFIRMAR' });
    var rB = await botB.send('sí', { intent: 'CONFIRMAR' });
    check('P2.1a: primer cliente OK', rA.includes('¡Listo'));
    check('P2.1b: segundo recibe mensaje de slot tomado', rB.includes('acaba de tomar'));
    check('P2.1c: segundo recibe horarios alternativos', rB.includes('elige tu horario'));
    check('P2.1d: estado de B = picking_slot', botB.session.state === 'picking_slot');
    check('P2.1e: solo 1 cita en DB', DB.length === 1);
  }

  // P2.2 — Mismo cliente "sí" dos veces rápido
  sec('P2.2 — Doble "sí" rápido → el motor no crea 2ª cita (guard en confirming)');
  DB = [];
  {
    var botDouble = makeBot({ hasHistory: false });
    await botDouble.send('soy Zoe corte Pacheco', { intent: 'NUEVA_CITA', name: 'Zoe', service: 'Corte moderno', barber: 'Pacheco' });
    await botDouble.send('mañana a las 10', { intent: 'NUEVA_CITA', date: tomorrow, time: '10:00' });
    var r1 = await botDouble.send('sí', { intent: 'CONFIRMAR' });
    var r2 = await botDouble.send('sí', { intent: 'CONFIRMAR' });
    check('P2.2a: primer sí crea cita', r1.includes('¡Listo'));
    check('P2.2b: segundo sí no crea 2ª (DB.length=1)', DB.length === 1, 'DB.length=' + DB.length);
    check('P2.2c: segundo sí en estado idle → no intenta confirmar', !r2.includes('¿Confirmo?'));
  }

  // P2.3 — Web crea cita mientras bot está en confirming
  // La entrada manual en DB DEBE incluir customer_phone del bot para que
  // getActiveAppointments (filtrado por phone) la detecte.
  sec('P2.3 — Web inserta cita mientras bot en confirming → REGLA #1 bloquea');
  DB = [];
  {
    var webPhone = '+17875551234'; // phone default de makeBot
    var botWeb = makeBot({ hasHistory: false }, webPhone);
    await botWeb.send('soy Kim corte Pacheco', { intent: 'NUEVA_CITA', name: 'Kim', service: 'Corte moderno', barber: 'Pacheco' });
    await botWeb.send('mañana a las 10', { intent: 'NUEVA_CITA', date: tomorrow, time: '10:00' });
    // Web inserta cita entre slot elegido y confirmación — con el mismo phone del cliente
    DB.push({ id: 'web1', status: 'confirmed', customer_name: 'Kim', customer_phone: webPhone, appointment_date: tomorrow, start_time: '11:00', barber_id: 'b3', service_id: 's1' });
    var r = await botWeb.send('sí', { intent: 'CONFIRMAR' });
    check('P2.3a: bot detecta cita de web y bloquea', r.includes('una a la vez'));
    check('P2.3b: DB sigue con 1 cita (no crea 2ª)', DB.length === 1);
    check('P2.3c: vuelve a idle', botWeb.session.state === 'idle');
  }

  // P2.4 — Dashboard cancela cita mientras cliente reagenda
  sec('P2.4 — Dashboard cancela cita, bot intenta reagendar → error manejado');
  DB = [{ id: 'ap1', status: 'confirmed', customer_name: 'Rosa', customer_phone: '+17', appointment_date: tomorrow, start_time: '10:00', barber_id: 'b1', service_id: 's1' }];
  {
    var botResh = makeBot(
      { hasHistory: true, name: 'Rosa', activeAppointment: DB[0] },
      '+17',
      { commitReschedule: async function() { return { ok: false }; } }
    );
    await botResh.send('reagendar', { intent: 'REAGENDAR' });
    await botResh.send('sí', { intent: 'CONFIRMAR' });
    await botResh.send('mañana a las 11', { intent: 'NUEVA_CITA', date: tomorrow, time: '11:00' });
    var r = await botResh.send('sí', { intent: 'CONFIRMAR' });
    check('P2.4a: informa error al reagendar (no crash, no mensaje vacío)', r.includes('error al reagendar') || r.includes('Hubo un error'));
    check('P2.4b: vuelve a idle (estado consistente)', botResh.session.state === 'idle');
    check('P2.4c: NO deja sesión en confirming', botResh.session.state !== 'confirming');
  }

  console.log('\n════════ RESULTADO PARTES 1-2 ════════');
  console.log(FAIL === 0 ? '✅ TODOS LOS CHECKS PASARON' : '❌ ' + FAIL + ' CHECK(S) FALLARON');
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(function(e) { console.error(e); process.exit(1); });
