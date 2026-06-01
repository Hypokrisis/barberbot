const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const WebSocket = require('ws');

// ── Environment validation ───────────────────────────────────────────────────
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'GEMINI_API_KEY'
];

const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingEnvVars.forEach(v => console.error(`   - ${v}`));
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket }
});
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── In-memory conversation state ─────────────────────────────────────────────
const sessions = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { history: [], state: 'idle', data: {} };
  return sessions[phone];
}

function dayName(d) {
  return ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][d];
}

async function getBusinessInfo(businessId) {
  const { data: business } = await supabase
    .from('businesses').select('*').eq('id', businessId).single();
  const { data: barbers } = await supabase
    .from('barbers').select('id,name,phone_e164').eq('business_id', businessId).eq('is_active', true);
  const { data: services } = await supabase
    .from('services').select('id,name,duration_minutes,price').eq('business_id', businessId).eq('is_active', true);
  return { business, barbers, services };
}

async function getAvailableSlots(barberId, date) {
  // Get barber schedule for day of week
  const d = new Date(date);
  const dow = d.getDay();
  const { data: schedule } = await supabase
    .from('schedules')
    .select('start_time,end_time')
    .eq('barber_id', barberId)
    .eq('day_of_week', dow)
    .eq('is_active', true)
    .single();

  if (!schedule) return [];

  // Get existing appointments
  const { data: appointments } = await supabase
    .from('appointments')
    .select('start_time,end_time')
    .eq('barber_id', barberId)
    .eq('appointment_date', date)
    .neq('status', 'cancelled');

  // Generate 30-min slots
  const slots = [];
  let [sh, sm] = schedule.start_time.split(':').map(Number);
  const [eh, em] = schedule.end_time.split(':').map(Number);
  const endMins = eh * 60 + em;

  while (sh * 60 + sm + 30 <= endMins) {
    const slotStart = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
    const nextSm = sm + 30;
    const nextSh = sh + Math.floor(nextSm / 60);
    const slotEnd = `${String(nextSh).padStart(2,'0')}:${String(nextSm % 60).padStart(2,'0')}`;

    const busy = appointments?.some(a => a.start_time.slice(0,5) === slotStart);
    if (!busy) slots.push(slotStart);

    sm += 30;
    if (sm >= 60) { sh++; sm -= 60; }
  }
  return slots;
}

async function createAppointment(data) {
  const { data: appt, error } = await supabase
    .from('appointments')
    .insert({
      business_id: data.businessId,
      barber_id: data.barberId,
      service_id: data.serviceId,
      customer_name: data.customerName,
      customer_phone: data.customerPhone,
      appointment_date: data.date,
      start_time: data.startTime,
      end_time: data.endTime,
      status: 'confirmed'
    })
    .select()
    .single();
  return { appt, error };
}

async function sendWhatsApp(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${to}`,
    body
  });
}

async function sendConfirmationTemplate(to, params) {
  // Use the approved appointment_confirmation template
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${to}`,
    contentSid: process.env.TEMPLATE_CONFIRMATION_SID,
    contentVariables: JSON.stringify(params)
  });
}

// ── AI conversation handler ───────────────────────────────────────────────────
async function handleMessage(phone, message, businessId) {
  const session = getSession(phone);
  const { business, barbers, services } = await getBusinessInfo(businessId);

  const systemPrompt = `Eres el asistente virtual de ${business.name}, una barbería en ${business.city}, Puerto Rico.
Tu trabajo es ayudar a los clientes a hacer citas por WhatsApp.

Barberos disponibles:
${barbers.map(b => `- ${b.name} (ID: ${b.id})`).join('\n')}

Servicios disponibles:
${services.map(s => `- ${s.name}: $${s.price}, ${s.duration_minutes} min (ID: ${s.id})`).join('\n')}

Flujo para hacer una cita:
1. Pregunta el nombre del cliente
2. Pregunta qué servicio quiere
3. Pregunta qué barbero prefiere (o dice "cualquiera")
4. Pregunta la fecha deseada (formato YYYY-MM-DD)
5. Muestra los horarios disponibles y pregunta cuál prefiere
6. Confirma todos los datos y crea la cita

Estado actual de la conversación:
${JSON.stringify(session.data)}

Cuando tengas todos los datos necesarios para crear la cita, responde EXACTAMENTE con este JSON (sin texto extra):
{"action":"create_appointment","customerName":"...","serviceId":"...","barberId":"...","date":"YYYY-MM-DD","startTime":"HH:MM"}

Si el cliente quiere ver horarios disponibles, responde con:
{"action":"get_slots","barberId":"...","date":"YYYY-MM-DD"}

Para todo lo demás, responde normalmente en español de manera amigable y concisa.`;

  // Add message to history
  session.history.push({ role: 'user', parts: [{ text: message }] });

  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const chat = model.startChat({
    history: session.history.slice(0, -1),
    systemInstruction: systemPrompt
  });

  const result = await chat.sendMessage(message);
  const responseText = result.response.text();

  // Check if AI returned an action
  try {
    const trimmed = responseText.trim();
    if (trimmed.startsWith('{')) {
      const action = JSON.parse(trimmed);

      if (action.action === 'get_slots') {
        const slots = await getAvailableSlots(action.barberId, action.date);
        if (slots.length === 0) {
          const reply = `No hay horarios disponibles para esa fecha. ¿Quieres probar con otra fecha?`;
          session.history.push({ role: 'model', parts: [{ text: reply }] });
          return reply;
        }
        const reply = `Horarios disponibles para el ${action.date}:\n${slots.map((s,i) => `${i+1}. ${s}`).join('\n')}\n\n¿Cuál prefieres?`;
        session.data.availableSlots = slots;
        session.data.selectedDate = action.date;
        session.data.selectedBarberId = action.barberId;
        session.history.push({ role: 'model', parts: [{ text: reply }] });
        return reply;
      }

      if (action.action === 'create_appointment') {
        // Calculate end time based on service duration
        const service = services.find(s => s.id === action.serviceId);
        const [h, m] = action.startTime.split(':').map(Number);
        const endMin = h * 60 + m + (service?.duration_minutes || 30);
        const endTime = `${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}`;

        const { appt, error } = await createAppointment({
          businessId,
          barberId: action.barberId,
          serviceId: action.serviceId,
          customerName: action.customerName,
          customerPhone: phone,
          date: action.date,
          startTime: action.startTime,
          endTime
        });

        if (error) {
          const reply = `Hubo un error al crear la cita. Por favor intenta de nuevo.`;
          session.history.push({ role: 'model', parts: [{ text: reply }] });
          return reply;
        }

        // Reset session
        sessions[phone] = { history: [], state: 'idle', data: {} };

        const barber = barbers.find(b => b.id === action.barberId);
        const reply = `✅ ¡Cita confirmada!\n\n👤 ${action.customerName}\n✂️ ${service?.name}\n💈 Barbero: ${barber?.name}\n📅 ${action.date}\n⏰ ${action.startTime}\n\n¡Te esperamos en ${business.name}!`;
        return reply;
      }
    }
  } catch (e) {
    // Not a JSON action, normal response
  }

  session.history.push({ role: 'model', parts: [{ text: responseText }] });
  return responseText;
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const { Body, From } = req.body;
  const phone = From.replace('whatsapp:', '');

  console.log(`Message from ${phone}: ${Body}`);

  try {
    // Get business from twilio settings
    const { data: twilioSettings, error: settingsError } = await supabase
      .from('twilio_settings')
      .select('business_id')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (settingsError || !twilioSettings) {
      console.error('Twilio settings error:', settingsError);
      await sendWhatsApp(phone, 'Servicio no disponible en este momento.');
      return res.sendStatus(200);
    }

    const reply = await handleMessage(phone, Body, twilioSettings.business_id);
    await sendWhatsApp(phone, reply);
  } catch (err) {
    console.error('Error:', err);
    await sendWhatsApp(phone, 'Ocurrió un error. Por favor intenta de nuevo.');
  }

  res.sendStatus(200);
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('✅ BarberBot started successfully');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});
