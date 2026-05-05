/**
 * Circuit breaker compartilhado entre todos os caminhos de auto-recuperação
 * do bridge (process guards, startup recovery, disconnect recovery, etc).
 *
 * Histórico do bug: cada uma dessas paths tinha sua própria lógica de
 * retry/timer. Quando puppeteer crasha repetidamente (problema sistêmico
 * — Edge sem permissão, LocalAuth corrompido, WhatsApp Web mudou versão),
 * cada path tentava reconectar indefinidamente em paralelo, mantendo
 * `sessionState.status = 'initializing'` e congelando o usuário na tela
 * "Inicializando sessão do WhatsApp...". Os fixes pontuais (cap em uma
 * path) não impediam o loop em outras paths.
 *
 * Esse breaker centraliza: cada tentativa de recovery (qualquer origem)
 * "consome" 1 unidade do orçamento. Se exceder N tentativas em W ms,
 * trava (`isLocked`) e força os callers a desistirem (retornarem
 * `init_error` permanente). Reset acontece em:
 *   - sucesso real ('ready' event firing)
 *   - ação manual do usuário (POST /session/connect)
 */
export class RecoveryBudget {
  private attemptTimes: number[] = [];
  private locked = false;

  constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 60_000
  ) {}

  /**
   * Tenta consumir uma unidade. Retorna `true` se ainda há orçamento (caller
   * pode prosseguir com recovery), `false` se esgotou (caller deve desistir).
   */
  tryConsume(): boolean {
    if (this.locked) {
      return false;
    }

    const now = Date.now();
    this.attemptTimes = this.attemptTimes.filter(timestamp => now - timestamp < this.windowMs);

    if (this.attemptTimes.length >= this.maxAttempts) {
      this.locked = true;
      return false;
    }

    this.attemptTimes.push(now);
    return true;
  }

  /** Chamado em sucesso ou ação manual do usuário pra liberar o breaker. */
  reset(): void {
    this.attemptTimes = [];
    this.locked = false;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get attemptsInWindow(): number {
    return this.attemptTimes.length;
  }

  get maxAttemptsAllowed(): number {
    return this.maxAttempts;
  }

  get windowMsConfigured(): number {
    return this.windowMs;
  }
}
