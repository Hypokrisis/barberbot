// Offline simulation of the redesigned booking flow (uses the REAL booking-logic.js).
// LLM extraction is mocked per turn. The point is to verify the DETERMINISTIC
// context rules for name vs barber (so a customer named like a barber never gets
// confused). Run: node test-booking-sim.js
const bl = require('./booking-logic');

const services = [
  { id: 's1', name: 'Corte', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 15, duration_minutes: 20 },
];
// Negocio con VARIOS barberos, uno llamado "Loann" (colisiona con el cliente Loann)
const barbers = [{ id: 'b1', name: 'pepe' }, { id: 'b2', name: 'Loann' }, { id: 'b3', name: 'pablo' }];
const slots = ['09:00', '14:30', '15:00', '16:00'];
const created = [];

function makeBot() {
  const session = { state: 'idle', data: {} };
  let botMsgs = 0;
  const getSlots = async () => slots;
  const GREETINGS = ['hola', 'buenas', 'hey'];
  const BOOKING_WORDS = ['cita', 'reservar', 'agendar', 'turno', 'reserva'];

  async function decide(text, extraction) {
    return bl.decideBookingReply({ session, msg: text, extracted: extraction || {}, services, barbers, getSlots });
  }
  async function send(text, extraction) {
    const m = text.toLowerCase();
    if (session.state === 'idle') {
      const looks = bl.looksLikeBooking(text, services);
      if (GREETINGS.includes(m) || BOOKING_WORDS.some(w => m.includes(w)) || looks) {
        session.state = 'booking'; session.data.bk = {};
        if (looks || bl.hasBookingContent(text, services, barbers, GREETINGS, BOOKING_WORDS)) { botMsgs++; return await decide(text, extraction); }
        session.data.awaiting = ['name', 'service', 'date', 'time'];
        botMsgs++; return `Bienvenido 💈 Mándame en un solo mensaje: tu nombre, el servicio y el día y la hora.`;
      }
    }
    if (session.state === 'booking') { botMsgs++; return await decide(text, extraction); }
    if (session.state === 'confirm') {
      const norm = m.replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u');
      if (/^(si|dale|ok|confirmo|listo|va)\b/.test(norm)) {
        const bk = session.data.bk; created.push({ name: bk.name, service: bk.serviceName, barber: bk.barberName, date: bk.date, time: bk.time });
        session.state = 'idle'; session.data = {};
        botMsgs++; return `✅ ¡Listo, ${bk.name}! con ${created[created.length - 1].barber}. 💈`;
      }
      session.state = 'booking'; botMsgs++; return `Dime el dato correcto 🙂`;
    }
  }
  return { send, count: () => botMsgs };
}

async function runDialog(title, turns) {
  console.log('\n══════════════════════════════════════════');
  console.log(title);
  console.log('══════════════════════════════════════════');
  const bot = makeBot();
  for (const [text, ex] of turns) {
    console.log(`👤 ${text}`);
    console.log(`🤖 ${await bot.send(text, ex)}`);
  }
}

(async () => {
  await runDialog('1) "soy loann, corte con pepe mañana 3pm" → loann=cliente, pepe=barbero → confirma', [
    ['soy loann, corte con pepe mañana 3pm', { service: 'Corte', date: 'tomorrow', time: '15:00' }],
    ['sí', {}],
  ]);

  await runDialog('2) "soy loann, corte mañana 3pm" (varios barberos) → pregunta barbero, NO confunde a loann', [
    // Groq devuelve barber=\"Loann\" por error → debe ignorarse (es el cliente)
    ['soy loann, corte mañana 3pm', { service: 'Corte', barber: 'Loann', date: 'tomorrow', time: '15:00' }],
  ]);

  await runDialog('3) "cita" → "loann" → loann es el CLIENTE', [
    ['cita', {}],
    ['loann', {}],
  ]);

  await runDialog('4) "quiero corte con loann mañana 3pm" → loann=BARBERO, pregunta el nombre del cliente', [
    ['quiero corte con loann mañana 3pm', { service: 'Corte', date: 'tomorrow', time: '15:00' }],
  ]);

  await runDialog('5) Ambiguo: "corte mañana 3pm loann" (sin soy/con) → desambigua UNA vez', [
    ['corte mañana 3pm loann', { service: 'Corte', date: 'tomorrow', time: '15:00' }],
    ['es mi nombre', {}],
  ]);
})();
