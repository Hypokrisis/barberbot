# Guion de prueba del bot — checklist de onboarding

Checklist **genérico y reutilizable** para validar el bot de WhatsApp de **cualquier
barbería** registrada en Spacey, antes de entregárselo al dueño.

El bot es **multi-tenant**: un solo bot sirve a todas las barberías, ruteando por el
número de Twilio que recibe el mensaje. Por eso este guion sirve igual para cualquier
negocio — solo cambian los datos específicos del negocio que estés probando.

## Antes de empezar — ajusta estos 3 datos al negocio

| Marcador en el guion | Reemplázalo por |
|---|---|
| `[BARBERO]` | las primeras letras del nombre de un barbero **real** de ese negocio (ej. `pache` para "Pacheco") — sirve para probar el match parcial de nombre |
| `[SERVICIO]` | un servicio real del negocio (ej. `corte moderno`) |
| `[DÍA/HORA]` | un día y hora que ese barbero **realmente** trabaje y tenga libre |

> Escribe **un mensaje por línea**, tal cual aparece (incluidos los "errores" a
> propósito como `el 32 de junio` o `pache`). Al lado va lo que el bot **debe**
> responder y qué valida.

---

## FASE 0 — Limpiar estado (empezar de cero)

| Tú escribes | El bot debe responder | Valida |
|---|---|---|
| `reset` | reinicia (o lo ignora si ya estaba limpio) | — |
| `¿cuándo es mi cita?` | "No tienes citas activas" → sigue a FASE 1. **Si muestra una cita vieja** → escribe `cancela` y luego `sí` para limpiarla. | estado limpio |

---

## FASE 1 — Preguntas (BUG 1 + recordatorio de opciones)

| Tú escribes | El bot debe responder | Valida |
|---|---|---|
| `hola` | Bienvenida con servicios + equipo + menú. **Sin** la línea de recordatorio (ya tiene menú). | saludo limpio |
| `tengo preguntas` | **"Claro, dime qué quieres saber 😊"** y espera. **NO** te pide nombre/servicio. Debajo aparece `💬 Cualquier momento puedes decir…` | **BUG 1** + recordatorio |
| `¿cuánto cuesta el [SERVICIO]?` | Te da el/los precios y retoma. | pregunta respondida |

---

## FASE 2 — Crear cita (BUG 2 → BUG 3 → BUG 4)

| Tú escribes | El bot debe responder | Valida |
|---|---|---|
| `quiero una cita, soy [TuNombre], [SERVICIO] con [BARBERO]` | Reconoce al barbero (¡con solo las primeras letras!) y muestra **horarios reales** de él. | **BUG 2** (nombre parcial) |
| `el 32 de junio` | **"Esa fecha no existe 😅 ¿qué día quieres decir?"** — no la acepta. | **BUG 3** (fecha inválida) |
| `no me sirve ninguna` | Te invita a decir otro día/hora (sigue en el flujo, no te bota). | transición |
| `quiero otra hora` | Sigue mostrando/pidiendo horarios de **esta misma cita**. **NO** debe decir *"No tienes citas activas"*. | **BUG 4** (crítico) |
| `[DÍA/HORA]` | Verifica contra la DB y pide **confirmar**: "¿Confirmo? (sí/no)". Sin recordatorio (es un sí/no). | verificación real |
| `sí` | **"✅ ¡Listo, [TuNombre]! Te esperamos el …"** Sin recordatorio (confirmación final). | cita creada |

---

## FASE 3 — Ya con cita activa (BUG 5 + bug original del saludo)

| Tú escribes | El bot debe responder | Valida |
|---|---|---|
| `¿hasta qué hora abren los sábados?` | **Responde la pregunta** del horario. **NO** debe decir *"solo puedes tener una cita activa"*. | **BUG 5** (crítico) |
| `hola` | Muestra **solo** tu cita activa limpia (Reagendar / Cancelar / Nueva cita / Preguntar). **Sin** mezclar "dime tu nombre". | bug original v4.3.2 |
| `quiero otra cita más` | Te dice que **solo una cita activa a la vez** y ofrece cambiar o cancelar. | regla #1 |

---

## FASE 4 — Reagendar (UPDATE, no duplica)

| Tú escribes | El bot debe responder | Valida |
|---|---|---|
| `reagendar` | Muestra tu cita y pregunta **"¿La cambiamos? (sí/no)"**. | inicio reagendar |
| `sí` | Te muestra horarios del barbero. | — |
| `[OTRO DÍA/HORA]` | Verifica y pide confirmar el cambio. | — |
| `sí` | **"✅ ¡Listo…"** con la **nueva** fecha/hora. | reagendado |
| `¿cuándo es mi cita?` | Muestra **una sola** cita, con la fecha **nueva**. | no se duplicó |

---

## FASE 5 — Cancelar

| Tú escribes | El bot debe responder | Valida |
|---|---|---|
| `quiero cancelar` | **"⚠️ ¿Seguro que quieres cancelar?"** con los datos. Sin recordatorio (es confirmación). | inicio cancelar |
| `sí` | **"✅ Cita cancelada. ¡Hasta la próxima! 👋"** | cancelada (status=cancelled) |
| `¿cuándo es mi cita?` | "No tienes citas activas…" | limpieza confirmada |

---

## FASE 6 — Off-topic (filtro de relevancia)

| Tú escribes | El bot debe responder | Valida |
|---|---|---|
| `cuánto es 2+2` | "Solo puedo ayudarte con citas en [Nombre del negocio] 😊" | filtro fuera de contexto |
| `buenas, ¿a qué hora abren?` | Responde el horario (un saludo + pregunta de disponibilidad **nunca** se filtra). | filtro no sobre-bloquea |

---

## Qué vigilar en TODO el recorrido

- 🟢 El **recordatorio** `💬 Cualquier momento puedes decir: *cita* · *reagendar* · *cancelar* · o preguntar algo`
  aparece al final de los mensajes normales…
- 🔴 …pero **NO** en: la bienvenida, los `✅ ¡Listo!` / `✅ Cita cancelada`, ni en los
  `¿Confirmo? (sí/no)` / `¿La cambiamos?`.
- El bot **nunca repite** el mismo bloque de horarios literal (la 2ª vez lo reformula
  con "Como te decía 🙂…").
- El **link de reservas** siempre es el de ESE negocio (su propio `whatsapp_booking_link`
  o `/book/<su-slug>`) — nunca el de otra barbería.

---

## Nota importante sobre la prueba en vivo

Los tests automatizados (`test-booking-sim.js`) usan intents **simulados**; en producción
quien clasifica cada frase es **Groq**. Por eso lo más valioso de esta corrida en vivo es
confirmar que Groq etiqueta bien las frases reales — sobre todo:

- **BUG 4** → `quiero otra hora` debe leerse como cambio de horario del flujo actual, no
  como "reagendar" global.
- **BUG 5** → la pregunta con palabra de tiempo (`sábados`) debe leerse como pregunta, no
  como intención de nueva cita.

Si el bot responde raro en algún paso, copia el hilo exacto (lo que escribiste + lo que
respondió) para diagnosticar.

---

## Mapa de bugs validados por este guion

| Bug | Síntoma original | Dónde se prueba |
|---|---|---|
| Saludo con cita activa mezclaba CASO A/C | "hola" → bienvenida + cita pegadas | FASE 3 |
| BUG 1 | "tengo preguntas" empujaba a pedir datos | FASE 1 |
| BUG 2 | nombre parcial no matcheaba ("pache" ✗ Pacheco) | FASE 2 |
| BUG 3 | fechas inválidas se aceptaban ("32 de junio") | FASE 2 |
| BUG 4 | "otra hora" botaba al cliente al crear cita | FASE 2 |
| BUG 5 | pregunta con palabra de tiempo se bloqueaba | FASE 3 |
| Multi-tenant | link de reservas caía a un negocio fijo | "Qué vigilar" |
