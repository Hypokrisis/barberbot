// Offline simulation of the redesigned booking flow (uses the REAL booking-logic.js).
// The LLM extraction is mocked per turn. To prove the loop fix, the one-word
// replies are given an EMPTY extraction ({}) — simulating Groq missing them — so
// only the deterministic capture (awaiting + guessName/scan) can fill them.
// Run: node test-booking-sim.js
const bl = require('./booking-logic');

const services = [
  { id: 's1', name: 'Corte', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 15, duration_minutes: 20 },
];
const oneBarber = [{ id: 'b1', name: 'Annlo' }];
const GREETINGS = ['hola','hi','hello','buenas','hey','ola'];
const BOOKING_WORDS = ['cita','reservar','agendar','turno','reserva','book','nueva cita','hacer cita'];

const created = [];

function makeBot({ slots, barbers }) {
  const session = { state: 'idle', data: {} };
  let botMsgs = 0;
  const getSlots = async () => slots;

  async function decide(text, extraction) {
    return bl.decideBookingReply({ session, msg: text, extracted: extraction || {}, services, barbers, getSlots });
  }

  async function send(userText, extraction) {
    const m = userText.toLowerCase();
    if (session.state === 'idle') {
      const looks = bl.looksLikeBooking(userText, services);
      if (GREETINGS.includes(m) || BOOKING_WORDS.some(w => m.includes(w)) || looks) {
        session.state = 'booking'; session.data.bk = {};
        if (looks || bl.hasBookingContent(userText, services, barbers, GREETINGS, BOOKING_WORDS)) {
          botMsgs++; return await decide(userText, extraction);
        }
        session.data.awaiting = ['name','service','date','time'];
        const svcLine = services.map(s => `${s.name} $${s.price}`).join(' / ');
        botMsgs++; return `¡Saludos! 💈 Mándame en un solo mensaje: tu nombre, el servicio (${svcLine}) y el día y la hora. 📅`;
      }
    }
    if (session.state === 'booking') { botMsgs++; return await decide(userText, extraction); }
    if (session.state === 'confirm') {
      const norm = m.replace(/[áàä]/g,'a').replace(/[éèë]/g,'e').replace(/[íìï]/g,'i').replace(/[óòö]/g,'o').replace(/[úùü]/g,'u');
      if (/^(si|dale|ok|confirmo|listo|va)\b/.test(norm)) {
        const bk = session.data.bk; created.push({ name: bk.name, service: bk.serviceName, date: bk.date, time: bk.time });
        session.state = 'idle'; session.data = {};
        botMsgs++; return `✅ ¡Listo, ${bk.name}! Te esperamos el ${bl.formatDate(bk.date)} a las ${bl.formatTime(bk.time)}. 💈`;
      }
      session.state = 'booking'; botMsgs++; return `Claro, dime el dato correcto 🙂`;
    }
  }
  return { send, count: () => botMsgs };
}

async function runDialog(title, cfg, turns) {
  console.log('\n══════════════════════════════════════════');
  console.log(title);
  console.log('══════════════════════════════════════════');
  const bot = makeBot(cfg);
  for (const [userText, extraction] of turns) {
    console.log(`👤 ${userText}`);
    console.log(`🤖 ${await bot.send(userText, extraction)}`);
  }
  console.log(`   → mensajes del bot: ${bot.count()}`);
}

(async () => {
  // ── REPRO del transcript real: hola → cita → loann (NO debe loopear) ──
  await runDialog('REPRO — hola → cita → loann (Groq NO captura "loann")',
    { slots: ['09:00','10:00','15:00','15:30'], barbers: oneBarber },
    [
      ['hola', {}],
      ['cita', {}],
      ['loann', {}],            // extracción vacía → guessName debe capturarlo
      ['corte', {}],            // extracción vacía → matchService
      ['mañana 3pm', {}],       // extracción vacía → scanDate + parseLooseTime
      ['sí', {}],
    ]);

  // 1) "hola" → saludo que pide TODO junto
  await runDialog('TEST 1 — "hola" abre pidiendo todo junto',
    { slots: ['09:00','10:00'], barbers: oneBarber },
    [['hola', {}]]);

  // 2) "soy loann, corte mañana 3pm" → directo a confirmar (Groq sí extrae)
  await runDialog('TEST 2 — todo en el primer mensaje',
    { slots: ['09:00','15:00','15:30'], barbers: oneBarber },
    [
      ['soy loann, corte mañana 3pm', { name: 'loann', service: 'Corte', date: 'tomorrow', time: '15:00' }],
      ['sí', {}],
    ]);

  // 3) "cita" → pide todo → "loann, corte, mañana 3pm" (Groq extrae) → confirmar
  await runDialog('TEST 3 — "cita" → opener → datos completos',
    { slots: ['09:00','15:00'], barbers: oneBarber },
    [
      ['cita', {}],
      ['loann, corte, mañana 3pm', { name: 'loann', service: 'Corte', date: 'tomorrow', time: '15:00' }],
      ['sí', {}],
    ]);

  // 4) Respuestas de UNA palabra a cada pregunta (Groq falla todas → determinista)
  const before = created.length;
  await runDialog('TEST 4 — una palabra por respuesta, Groq vacío',
    { slots: ['09:00','12:00','12:30'], barbers: oneBarber },
    [
      ['hola', {}],
      ['loann', {}],
      ['barba', {}],
      ['mañana', {}],
      ['12pm', {}],
      ['confirmo', {}],
    ]);
  console.log(`   → cita creada: `, created[created.length - 1]);
  console.log(`   → ¿se creó 1 cita en test 4?  ${created.length - before === 1 ? 'SÍ' : 'NO'}`);

  // 5) Colisión nombre-cliente/barbero: cliente "loann santiago", barbero "Loann"
  const multiBarber = [{ id: 'b1', name: 'pepe' }, { id: 'b2', name: 'Loann' }, { id: 'b3', name: 'pablo' }];
  await runDialog('TEST 5 — colisión nombre/barbero (NO debe auto-elegir barbero "Loann")',
    { slots: ['09:00','15:00'], barbers: multiBarber },
    [
      // Groq devuelve barber='Loann' por error (es el nombre del cliente)
      ['hola, soy loann santiago, corte hoy 3pm', { name: 'loann santiago', service: 'Corte', barber: 'Loann', date: 'tomorrow', time: '15:00' }],
      // Debe preguntar "con cuál barbero" en vez de auto-elegir Loann; el cliente elige pepe
      ['pepe', {}],
      ['sí', {}],
    ]);
})();
