// Offline simulation (uses the REAL booking-logic.js). LLM extraction, getSlots
// and getUpcoming are mocked. Verifies: questions answered mid-flow, OFFER instead
// of ask, no identical repeats. Run: node test-booking-sim.js
const bl = require('./booking-logic');

const services = [
  { id: 's1', name: 'Corte moderno', price: 25, duration_minutes: 30 },
  { id: 's2', name: 'Barba', price: 24, duration_minutes: 20 },
  { id: 's3', name: 'tinte de pelo', price: 45, duration_minutes: 60 },
  { id: 's4', name: 'Cejas', price: 5, duration_minutes: 10 },
];
// Solo barberos CON horario (Loann queda fuera, como en producción tras el filtro)
const barbers = [{ id: 'b1', name: 'pepe' }, { id: 'b2', name: 'pablo' }, { id: 'b3', name: 'Pacheco' }];

const today = bl.todayPR();
const tomorrow = (() => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; })();
const SLOTS = {
  Pacheco: { [today]: ['14:30', '16:00'], [tomorrow]: ['09:00', '10:00', '11:00'] },
  pepe: { [tomorrow]: ['09:00', '11:00'] },
  pablo: { [today]: ['10:00', '12:00'], [tomorrow]: ['09:00'] },
};
const nameOf = (id) => (barbers.find(b => b.id === id) || {}).name;
async function getSlots(barberId, date) { return (SLOTS[nameOf(barberId)] || {})[date] || []; }
async function getUpcoming(barberId) {
  const out = [];
  for (let off = 0; off <= 5 && out.length < 2; off++) {
    const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + off);
    const ds = d.toISOString().split('T')[0];
    const s = await getSlots(barberId, ds);
    if (s.length) out.push({ date: ds, slots: s.slice(0, 2) });
  }
  return out;
}

const seen = [];
function makeBot() {
  const session = { state: 'idle', data: {} };
  const GREET = ['hola', 'buenas', 'hey']; const BW = ['cita', 'reservar', 'agendar'];
  async function decide(t, ex) { return bl.decideBookingReply({ session, msg: t, extracted: ex || {}, services, barbers, getSlots, getUpcoming }); }
  async function send(t, ex) {
    const m = t.toLowerCase();
    if (session.state === 'idle') {
      const looks = bl.looksLikeBooking(t, services);
      if (GREET.some(g => m.split(/\s+/).includes(g)) || BW.some(w => m.includes(w)) || looks) {
        session.state = 'booking'; session.data.bk = {};
        if (looks || bl.hasBookingContent(t, services, barbers, GREET, BW)) return await decide(t, ex);
        session.data.awaiting = ['name', 'service', 'date', 'time'];
        return `Bienvenido 💈 Mándame en un mensaje: tu nombre, el servicio y el día y la hora.`;
      }
    }
    if (session.state === 'booking') return await decide(t, ex);
    if (session.state === 'confirm') {
      const n = m.replace(/[áéíóú]/g, c => 'aeiou'['áéíóú'.indexOf(c)]);
      if (/^(si|dale|ok|confirmo|listo|va)\b/.test(n)) {
        const bk = session.data.bk; const r = `✅ ¡Listo, ${bk.name}! ${bk.serviceName} con ${bk.barberName}, ${bl.formatDate(bk.date)} ${bl.formatTime(bk.time)}.`;
        session.state = 'idle'; session.data = {}; return r;
      }
      session.state = 'booking'; return `Dime el dato correcto 🙂`;
    }
  }
  return { send, repeated: () => seen };
}

async function run(title, turns) {
  console.log('\n══════════════════════════════════════════\n' + title + '\n══════════════════════════════════════════');
  const bot = makeBot(); let last = null; let repeat = false;
  for (const [t, ex] of turns) {
    console.log(`👤 ${t}`);
    const r = await bot.send(t, ex);
    if (r === last) repeat = true;
    last = r;
    console.log(`🤖 ${r}`);
  }
  console.log(repeat ? '   ⚠️  REPITIÓ un mensaje idéntico' : '   ✓ sin repeticiones idénticas');
}

(async () => {
  await run('REPRO del transcript: buenas soy Loann... que dia tienes → con pacheco → elige', [
    ['buenas soy Loann quiero el corte moderno y que dia tienes', { service: 'Corte moderno' }],
    ['quiero con pacheco', {}],
    ['que dias tienes', {}],
    ['mañana a las 9', {}],
    ['sí', {}],
  ]);

  await run('1) "¿qué horarios tiene pepe mañana?" → ofrece los horarios de pepe', [
    ['¿qué horarios tiene pepe mañana?', {}],
  ]);

  await run('2) "¿cuánto cuesta el tinte?" a mitad del flujo → responde y retoma', [
    ['soy carlos, corte moderno con pacheco', { service: 'Corte moderno' }],
    ['¿cuánto cuesta el tinte?', {}],
  ]);

  await run('3) Da todo menos hora + pregunta disponibilidad → ofrece y cierra al siguiente', [
    ['soy carlos, corte moderno con pepe mañana, qué horas tienes', { service: 'Corte moderno' }],
    ['a las 9', {}],
    ['sí', {}],
  ]);
})();
