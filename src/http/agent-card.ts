import { CV } from "../cv.ts";

/**
 * A2A agent card. The platform imports the whole registration from it, using the interface whose
 * protocolBinding is Open Responses v1. `origin` comes from the request so the URL is always real.
 */
export function agentCard(origin: string) {
  return {
    name: `CV de ${CV.profile.fullName}`,
    description:
      "Agente conversacional que responde preguntas sobre el perfil profesional, la experiencia, las habilidades y los proyectos de Eugenio Guevara.",
    version: "1.0.0",
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    promptSuggestions: [
      "¿Quién es Eugenio y a qué se dedica?",
      "Cuéntame de su experiencia con IA y RAG",
      "¿Qué construyó en YEYAR?",
      "¿Qué tecnologías domina en backend?",
      "¿Tiene experiencia en AWS y despliegues?",
      "Muéstrame sus repositorios de GitHub",
      "What is his experience with real-time systems?",
    ],
    skills: [],
    supportedInterfaces: [
      {
        url: `${origin.replace(/\/+$/, "")}/v1`,
        protocolBinding: "https://openresponses.org/v1",
        protocolVersion: "2026-04-24",
      },
    ],
  };
}
