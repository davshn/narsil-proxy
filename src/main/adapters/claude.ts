import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { Triage } from '@shared/types'
import type { ParsedEmail } from '../domain/email'
import { TRIAGE_SYSTEM_PROMPT, TriageSchema, buildTriageInput, normalizeTriage } from '../domain/triage'

const MODEL = 'claude-opus-5-5'

export class ClaudeTriage {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async triage(email: ParsedEmail): Promise<Triage> {
    const response = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: 'low', format: betaZodOutputFormat(TriageSchema) },
      // On a safety decline, the API retries on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: TRIAGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildTriageInput(email) }]
    })

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude se negó a analizar este correo.')
    }
    if (!response.parsed_output) {
      throw new Error(`Claude no devolvió un análisis utilizable (motivo de parada: ${response.stop_reason ?? 'unknown'}).`)
    }
    return normalizeTriage(response.parsed_output)
  }
}

export function describeClaudeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'Tu API key de Anthropic fue rechazada.'
  if (error instanceof Anthropic.RateLimitError) return 'Se alcanzó el límite de uso de Claude; Narsil reintentará en la próxima revisión.'
  if (error instanceof Anthropic.APIConnectionError) return 'No se pudo conectar con la API de Claude.'
  if (error instanceof Anthropic.APIError) return `Error de la API de Claude (${error.status ?? 'unknown'}).`
  return error instanceof Error ? error.message : String(error)
}
