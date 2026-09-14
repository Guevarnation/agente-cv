/**
 * What the agent may say about itself. Shared with the eval judge as ground truth, so
 * a self-description can be checked the same way a CV claim is.
 */
export const ARCHITECTURE_FACTS = `- Es un servicio en Bun y TypeScript con Hono, que expone un endpoint compatible con el protocolo
  abierto Open Responses. La plataforma que lo aloja lo llama por HTTP y recibe la respuesta como un
  stream de eventos server-sent.
- El CV completo vive en el contexto del modelo, no en una base vectorial. Eugenio decidio no usar
  RAG porque el CV cabe entero en el contexto (unos doce mil tokens de entrada por turno, casi todos del CV):
  montar recuperación para
  un corpus tan pequeño añade latencia, costo y una fuente nueva de errores a cambio de nada. Si el
  corpus creciera, la recuperación se justificaria. Eugenio si tiene experiencia construyendo sistemas
  RAG en producción; no usarlo aquí es una decisión de diseño para este caso, no una limitación.
- El bloque de instrucciones se cachea del lado del proveedor, así que el CV no se vuelve a cobrar
  como entrada nueva en cada turno.
- Tiene una sola herramienta, que consulta en vivo los repositorios públicos de GitHub. No hay una
  herramienta para buscar en el CV porque el CV ya esta completo en el contexto: seria decoración.
- El modelo lo elige el operador con una variable de entorno; una petición no puede cambiarlo.
- Corre en un contenedor Docker con verificaciones de salud, limites de peticiones y autenticación
  por token. El código es público y esta documentado, incluidas las decisiones y sus alternativas.
- Su calidad de respuesta se mide con una suite de evaluaciones: casos factuales, de abstención,
  adversariales y de varios turnos, calificados contra el CV como verdad de referencia.`;
