// Offline simulation of the redesigned booking flow.
// Uses the REAL decision logic (booking-logic.js). The LLM extraction and the
// availability lookup are mocked per turn so we can run dialogs deterministically.
// Run: node test-booking-sim.js
const bl = require('./booking-logic');

const services = [
  { id: 's1', name: 'Corte', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 15, duration_minutes: 20 },
];
const oneBarber = [{ id: 'b1', name: 'Annlo' }];

const created = [];
function mockCreate(bk, phone) { created.push({ ...bk, phone }); return { appt: { id: 'apt_' + created.length }, error: null, isGuest: false }; }

// Mimics index.js routing for the booking/confirm states + entry.
function makeBot({ slots, barbers }) {
  const session = { state: 'idle', data: {} };
  let botMsgs = 0;
  const getSlots = async () => slots;

  async function send(userText, extraction) {
    // entry: idle + booking intent
    if (session.state === 'idle') {
      session.state = 'booking'; session.data.bk = {};
      if (extraction && (extraction.name || extraction.service || extraction.date || extraction.time)) {
        const r = await bl.decideBookingReply({ session, msg: userText, extracted: extraction, services, barbers, getSlots });
        botMsgs++; return r;
      }
      const svcLine = services.map(s => `${s.name} $${s.price}`).join(' / ');
      botMsgs++; return `¡Saludos! 💈 Para tu cita mándame en un solo mensaje: tu nombre, el servicio (${svcLine}) y el día y hora.`;
    }
    if (session.state === 'booking') {
      const r = await bl.decideBookingReply({ session, msg: userText, extracted: extraction || {}, services, barbers, getSlots });
      botMsgs++; return r;
    }
    if (session.state === 'confirm') {
      const norm = userText.toLowerCase().replace(/[áàä]/g,'a').replace(/[éèë]/g,'e').replace(/[íìï]/g,'i').replace(/[óòö]/g,'o').replace(/[úùü]/g,'u');
      const yes = /^(si|dale|ok|confirmo|listo|va)\b/.test(norm);
      if (yes) {
        const bk = session.data.bk;
        mockCreate(bk, '+17875550000');
        session.state = 'idle'; session.data = {};
        botMsgs++; return `✅ ¡Listo, ${bk.name}! Te esperamos el ${bl.formatDate(bk.date)} a las ${bl.formatTime(bk.time)}. 💈`;
      }
      session.state = 'booking';
      botMsgs++; return `Claro, dime el dato correcto 🙂`;
    }
  }
  return { send, count: () => botMsgs, session };
}

async function runDialog(title, cfg, turns) {
  console.log('\n══════════════════════════════════════════');
  console.log(title);
  console.log('══════════════════════════════════════════');
  const bot = makeBot(cfg);
  for (const [userText, extraction] of turns) {
    console.log(`👤 ${userText}`);
    const reply = await bot.send(userText, extraction);
    console.log(`🤖 ${reply}`);
  }
  console.log(`\n   → mensajes del bot: ${bot.count()}`);
  return bot.count();
}

(async () => {
  // 1) Todo en el primer mensaje, hora libre (10:00)
  await runDialog('TEST 1 — cliente da todo de una (hora libre)',
    { slots: ['09:00','09:30','10:00','14:00','16:00'], barbers: oneBarber },
    [
      ['quiero cita, soy Carlos, corte mañana a las 10am', { name: 'Carlos', service: 'Corte', date: 'tomorrow', time: '10:00' }],
      ['sí', {}],
    ]);

  // 2) Solo "quiero cita" → el bot pide todo junto
  await runDialog('TEST 2 — solo "quiero cita"',
    { slots: ['09:00','10:00','10:30','11:00'], barbers: oneBarber },
    [
      ['quiero una cita', {}],
      ['soy Ana, corte, mañana a las 10:30', { name: 'Ana', service: 'Corte', date: 'tomorrow', time: '10:30' }],
      ['sí', {}],
    ]);

  // 3) Pide 3pm ocupada → ofrece cercanas (no lista)
  await runDialog('TEST 3 — 3pm ocupada → negocia cercanas',
    { slots: ['09:00','09:30','14:00','14:30','16:00','16:30'], barbers: oneBarber },
    [
      ['cita corte mañana 3pm, soy Luis', { name: 'Luis', service: 'Corte', date: 'tomorrow', time: '15:00' }],
      ['2:30', { time: '14:30' }],
      ['sí', {}],
    ]);

  // 4) Confirma → verifica creación + cuenta total
  const before = created.length;
  const n = await runDialog('TEST 4 — confirmación crea la cita',
    { slots: ['09:00','12:00','12:30'], barbers: oneBarber },
    [
      ['soy Pedro, barba, mañana 12pm', { name: 'Pedro', service: 'Barba', date: 'tomorrow', time: '12:00' }],
      ['confirmo', {}],
    ]);
  console.log(`   → appointments creadas en este test: ${created.length - before}`);
  console.log(`   → última cita guardada:`, created[created.length - 1] && { name: created[created.length-1].name, service: created[created.length-1].serviceName, date: created[created.length-1].date, time: created[created.length-1].time });
  console.log(`   → total mensajes salientes del bot: ${n} (el template duplicado queda suprimido)`);
})();
